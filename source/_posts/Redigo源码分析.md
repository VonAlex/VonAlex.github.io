---
title: Redigo 源码分析
tags:
  - redis
  - sdk
categories: 源码系列
index_img: /images/gopher.png
abbrlink: 1bcb9a09
date: 2019-06-23 16:08:54
---
使用 golang 开发项目时经常会使用到 redis 服务，这时就需要一个趁手的 sdk，所以就在 github 中找了一个 star 较多的项目，这就是本篇的主角 **redigo**，同时这也是redis 的[官方推荐](https://redis.io/clients#go)。

不过在使用过程中遇到了一些小问题，因此就去了解了一下源码，以下作为一个笔记。

<!--more---->

redigo 项目代码量较少，且注释明确，适合阅读学习。
redigo 主要完成了以下功能:

- 与 redis server 建立连接

- 按照 [RESP](https://redis.io/topics/protocol) 协议进行命令组装
- 向 Redis server 发送组装好的命令
- 接收 Redis server 返回的数据
- 将返回数据解析成 go 的数据类型
- 提供连接池的使用方式

## 1. 代码结构

```shell
redis
├── conn.go  // 实现 redis.go 中定义的接口，完成以上主要功能
├── conn_test.go
├── doc.go
├── go17.go
├── log.go
├── pool.go // pool 相关代码
├── pool_test.go
├── pre_go17.go
├── pubsub.go
├── pubsub_test.go
├── redis.go // 定义接口
├── reply.go // 返回数据的类型转换
├── reply_test.go
├── scan.go
├── scan_test.go
├── script.go // lua 脚本相关代码
├── script_test.go
├── test_test.go
└── zpop_example_test.go
```

项目主体主要有以上代码组成。

## 2. 创建连接

代码位于文件 `conn.go`，要创建的连接是一个自定义的数据结构 `conn`，如下，

```go
// conn is the low-level implementation of Conn
type conn struct {
    // Shared
    mu      sync.Mutex
    pending int // 命令计数
    err     error
    conn    net.Conn

    // Read
    readTimeout time.Duration
    br          *bufio.Reader

    // Write
    writeTimeout time.Duration
    bw           *bufio.Writer

    // Scratch space for formatting argument length.
    // '*' or '$', length, "\r\n"
    lenScratch [32]byte

    // Scratch space for formatting integers and floats.
    numScratch [40]byte
}
```

创建连接所需要的参数统一封装到结构体 `dialOptions` 中，如下，

```go
type dialOptions struct {
    readTimeout  time.Duration
    writeTimeout time.Duration
    dial         func(network, addr string) (net.Conn, error)
    db           int
    password     string
    dialTLS      bool
    skipVerify   bool
    tlsConfig    *tls.Config
}
```

其中包含各种超时设置，创建连接使用的函数，以及 TLS 等。
参数设置则封装了一系列 `Dialxxxx` 函数，如 `DialWriteTimeout`,

```go
// DialWriteTimeout specifies the timeout for writing a single command.
func DialWriteTimeout(d time.Duration) DialOption {
    return DialOption{func(do *dialOptions) {
      do.writeTimeout = d
    }}
}
```

同时需要结合如下结构体完成，

```go
type DialOption struct {
  	f func(*dialOptions)
}
```

创建连接时使用的是 `Dial` 函数

```go
// Dial connects to the Redis server at the given network and
// address using the specified options.
func Dial(network, address string, options ...DialOption) (Conn, error) {
    do := dialOptions{
      dial: net.Dial,
    }
    for _, option := range options { // 设置
      option.f(&do)
    }

    netConn, err := do.dial(network, address)
    if err != nil {
      return nil, err
    }

    // TLS 相关
    // ...

    c := &conn{
      conn:         netConn,
      bw:           bufio.NewWriter(netConn),
      br:           bufio.NewReader(netConn),
      readTimeout:  do.readTimeout,
      writeTimeout: do.writeTimeout,
    }

    if do.password != "" {
      if _, err := c.Do("AUTH", do.password); err != nil {
        netConn.Close()
        return nil, err
      }
    }

    if do.db != 0 {
      if _, err := c.Do("SELECT", do.db); err != nil {
        netConn.Close()
        return nil, err
      }
    }
    return c, nil
}
```

还有一个类似的 `DialURL` 函数就不分析了。

## 3. 请求与接收

非 pipeline 的形式，都是通过 `Do` 函数去触发这个流程的。

```go
func (c *conn) Do(cmd string, args ...interface{}) (interface{}, error) {
    c.mu.Lock() // 需要更新 pending 变量，加锁串行
    pending := c.pending
    c.pending = 0
    c.mu.Unlock()

    if cmd == "" && pending == 0 {
      return nil, nil
    }

    if c.writeTimeout != 0 {
      c.conn.SetWriteDeadline(time.Now().Add(c.writeTimeout)) // 设置写超时
    }

    if cmd != "" {
      if err := c.writeCommand(cmd, args); err != nil { // 将要发送的命令以 RESP 协议写到写buf里
        return nil, c.fatal(err)
      }
    }

    if err := c.bw.Flush(); err != nil { // buff flush，发送命令
      return nil, c.fatal(err)
    }

    if c.readTimeout != 0 {
      c.conn.SetReadDeadline(time.Now().Add(c.readTimeout)) // 设置写超时
    }

    if cmd == "" {
      reply := make([]interface{}, pending)
      for i := range reply {
        r, e := c.readReply()
        if e != nil {
          return nil, c.fatal(e)
        }
        reply[i] = r
      }
      return reply, nil
    }

    var err error
    var reply interface{}
    for i := 0; i <= pending; i++ {
      var e error
      if reply, e = c.readReply(); e != nil { // 解析返回值
        return nil, c.fatal(e)
      }
      if e, ok := reply.(Error); ok && err == nil {
        err = e
      }
    }
    return reply, err
}
```

### 3.1 发送命令

发送命令前必须以 RESP 协议序列化，主要用到以下函数，

```go
func (c *conn) writeCommand(cmd string, args []interface{}) (err error) {
    c.writeLen('*', 1+len(args)) // +1 是将 cmd 加上，将参数个数写入 buf， 如*3\r\n
    err = c.writeString(cmd)
    for _, arg := range args {
      if err != nil {
        break
      }
      switch arg := arg.(type) {
      case string:
        err = c.writeString(arg)
      case []byte:
        err = c.writeBytes(arg)
      case int:
        err = c.writeInt64(int64(arg))
      case int64:
        err = c.writeInt64(arg)
      case float64:
        err = c.writeFloat64(arg)
      case bool:
        if arg {
          err = c.writeString("1")
        } else {
          err = c.writeString("0")
        }
      case nil:
        err = c.writeString("")
      default:
        var buf bytes.Buffer
        fmt.Fprint(&buf, arg)
        err = c.writeBytes(buf.Bytes())
      }
    }
    return err
}
```

```go
 // 用来写参数长度和参数个数，通过前缀传入 * 还是 $ 决定,如 *3\r\n 或者 $3\r\n
func (c *conn) writeLen(prefix byte, n int) error {
    c.lenScratch[len(c.lenScratch)-1] = '\n'
    c.lenScratch[len(c.lenScratch)-2] = '\r'
    i := len(c.lenScratch) - 3
    for {
      c.lenScratch[i] = byte('0' + n%10)
      i -= 1
      n = n / 10
      if n == 0 {
        break
      }
    }
    c.lenScratch[i] = prefix
    _, err := c.bw.Write(c.lenScratch[i:])
    return err
}
```

循环复用 `lenScratch` 数组，是个好的设计，不会产生很多小的字符串。

拼接完了参数个数部分，在再拼接参数部分，项目中实现了一系列`writexxx` 函数，对不同的类型有不同的拼接方式，以 string 类型为例，

```go
 // 用来拼接每个参数，比如 GET，写成 $3\r\nGET\r\n
func (c *conn) writeString(s string) error {
	c.writeLen('$', len(s))
	c.bw.WriteString(s)
	_, err := c.bw.WriteString("\r\n")
	return err
}
```

按照 RESP 协议的格式将命令拼接完以后需要发出去，通过 `bufio` 的 `Flush` 完成。
另外，redigo 还支持 pipeline 的返回方式发送请求，使用到的函数是 `Send` 和 `Flush`。在 `Send`中只是把命令写到 bufio 的 buff 里了，`Flush` 才会发到对端。

### 3.2 响应解析

发送命令成功后， redis server 那边处理完请求后，同样以 RESP 的格式回复。
解析函数是 `readReply`，对照着 RESP 协议看下就好了，还是很简单的。
multi bulk reply 可以反复调用 bulk reply 解析函数去递归完成解析。

### 3.3 关闭连接

使用完毕连接以后，需要手动 close 掉，如下，

```go
func (c *conn) Close() error {
    c.mu.Lock()
    err := c.err
    if c.err == nil {
      c.err = errors.New("redigo: closed")
      err = c.conn.Close()
    }
    c.mu.Unlock()
    return err
}
```

## 4. pool 的分析

很多人在用 redigo 的时候会使用其连接池，因为使用该 sdk 时间较长，发现了 pool 的实现有两个版本。

### 4.1 老版本 pool

主要数据结构为 `pool`，即

```go
type Pool struct {

    // Dial is an application supplied function for creating and configuring a
    // connection.
    //
    // The connection returned from Dial must not be in a special state
    // (subscribed to pubsub channel, transaction started, ...).
    Dial func() (Conn, error)

    // TestOnBorrow is an optional application supplied function for checking
    // the health of an idle connection before the connection is used again by
    // the application. Argument t is the time that the connection was returned
    // to the pool. If the function returns an error, then the connection is
    // closed.
    // 检测连接的可用性，从外部注入。如果返回 error 则直接关闭连接
    TestOnBorrow func(c Conn, t time.Time) error

    // Maximum number of idle connections in the pool.
    // 最大闲置连接数量
    MaxIdle int

    // Maximum number of connections allocated by the pool at a given time.
    // When zero, there is no limit on the number of connections in the pool.
    // 最大活动连接数,如果为 0，则表示没有限制
    MaxActive int

    // Close connections after remaining idle for this duration. If the value
    // is zero, then idle connections are not closed. Applications should set
    // the timeout to a value less than the server's timeout.
    // 闲置过期时间，在get函数中会有逻辑删除过期的连接
    // 如果不设置，连接就不会过期
    IdleTimeout time.Duration

    // If Wait is true and the pool is at the MaxActive limit, then Get() waits
    // for a connection to be returned to the pool before returning.
    // 设置如果活动连接达到上限 再获取时候是等待还是返回错误
    // 如果是 false 系统会返回redigo: connection pool exhausted
    // 如果是 true 会让协程等待直到有连接释放出来
    Wait bool

    // mu protects fields defined below.（主要是与状态相关）
    mu     sync.Mutex
    cond   *sync.Cond
    closed bool
    active int

    // Stack of idleConn with most recently used at the front.
    idle list.List
}
```

该版本中使用了条件变量 `Cond`来协调多协程获取连接池中的连接
`idle` 使用的是 go 标准库 container 中的 list 数据结构，其中存放的是池中的连接，每个连接的数据结构如下，

```go
type idleConn struct {
    c Conn
    t time.Time
}
```

`pooledConnection` 结构实现了 `Conn` 接口的所有方法。

```go
type pooledConnection struct {
    p     *Pool // pool
    c     Conn  // 当前连接
    state int
}

```

#### 4.1.1 从 pool 获取连接

```go
func (p *Pool) Get() Conn {
    c, err := p.get()
    if err != nil {
      return errorConnection{err}
    }
    return &pooledConnection{p: p, c: c}
}
```

当从连接池获取不到时就创建一个连接，所以还是重点看如何从连接池获取一个连接。

```go
func (p *Pool) get() (Conn, error) {
    p.mu.Lock()

    // Prune stale connections.(将过期连接的清理放到每次的 get 中)
    // 如果 idletime 没有设置，连接就不会过期，因此也就不必清理
    if timeout := p.IdleTimeout; timeout > 0 {
      for i, n := 0, p.idle.Len(); i < n; i++ {
        e := p.idle.Back() // 取出最后一个连接
        if e == nil {
          break
        }
        ic := e.Value.(idleConn)
        if ic.t.Add(timeout).After(nowFunc()) { // 没有过期，立刻终止检查
          break
        }
        p.idle.Remove(e)
        p.release() // 需要操作 active 变量
        p.mu.Unlock()
        ic.c.Close() // 关闭连接
        p.mu.Lock()
      }
    }

    for {
      // Get idle connection.
        for i, n := 0, p.idle.Len(); i < n; i++ {
          e := p.idle.Front() // 从最前面取一个连接
          if e == nil {       // idle 里是空的，先退出循环吧
            break
          }
          ic := e.Value.(idleConn)
          p.idle.Remove(e)
          test := p.TestOnBorrow
          p.mu.Unlock()
          if test == nil || test(ic.c, ic.t) == nil { // 返回这个连接
            return ic.c, nil
          }
          ic.c.Close() // 取出来的连接不可用
          p.mu.Lock()
          p.release()
        }

        // Check for pool closed before dialing a new connection.

        if p.closed {
          p.mu.Unlock()
          return nil, errors.New("redigo: get on closed pool")
        }

        // Dial new connection if under limit.
        if p.MaxActive == 0 || p.active < p.MaxActive {
          dial := p.Dial
          p.active += 1
          p.mu.Unlock()
          c, err := dial()
          if err != nil {
            p.mu.Lock()
            p.release()
            p.mu.Unlock()
            c = nil
          }
          return c, err
        }

        // 到达连接池最大连接数了，要不要等呢？
        if !p.Wait { // 不wait的话就直接返回连接池资源耗尽的错误
          p.mu.Unlock()
          return nil, ErrPoolExhausted
        }

        if p.cond == nil {
          p.cond = sync.NewCond(&p.mu)
        }
        p.cond.Wait() // wait 等待 release 和 put 后有新的连接可用
      }
}
```

当有设置 IdleTimeout 时，那么到了每次 `get` 连接的时候都会从队尾拿一个连接，检查时间是否过期，如果过期，那么把它删掉，然后 `release`，这个操作一直持久直至找到一个没有过期的连接。

然后从**队首**拿一个连接，拿到后检查可用后返回，不可用的连接处理方式同上面的过期连接。

如果这个 pool 的状态已经是 close 了，那么直接返回。把这个检查放在这里，使 closed pool 仍然可以清理一些过期连接，减少内存占用。

如果 pool 没有设置 MaxActive，或者当前 pool 中的 active 没到阈值，那么可以使用 `dial`函数创建一个新连接，active 值加 1。

如果逻辑走到这里还没有取到连接，说明现在 pool 里的连接都被用了，如果不想 `wait`，那么直接返回 pool 资源耗尽的错误(`ErrPoolExhausted`)，否则使用 pool 的条件变量 `cond`进行`Wait`。我们都知道在 `Wait`中 会先解锁，然后陷入阻塞等待唤醒。

`cond`唤醒在 `release` 函数和`put`函数中，如下，

```go
// release decrements the active count and signals waiters. The caller must
// hold p.mu during the call.
func (p *Pool) release() {
    p.active -= 1
    if p.cond != nil {
      p.cond.Signal() // 通知 wait 的请求返回连接
    }
}
```

#### 4.1.2 向 pool return 连接

用完连接后要还回去，在调用连接的 `Close` 函数中会使用 `put`。

```go
func (p *Pool) put(c Conn, forceClose bool) error {
    err := c.Err()
    p.mu.Lock()
    if !p.closed && err == nil && !forceClose {
      p.idle.PushFront(idleConn{t: nowFunc(), c: c}) // 放回头部
      if p.idle.Len() > p.MaxIdle {
        c = p.idle.Remove(p.idle.Back()).(idleConn).c // 如果连接池中数量超过了 maxidle，那么从后面删除一个
      } else {
        c = nil
      }
    }

    if c == nil {
      if p.cond != nil {
        p.cond.Signal() // 通知
      }
      p.mu.Unlock()
      return nil
    }

    p.release()
    p.mu.Unlock()
    return c.Close()
}
```

将没有出错的连接并且不是别强制关闭的连接放回到 idle list 中，注意，这里是放到**队头**！如果 list 长度大于最大闲置连接数(MaxIdle)，那么从队尾取连接 `remove`掉。

`Signal` 唤醒条件变量。

### 4.2 新版本 pool

在版本的 pool 里，自己实现了一个 list，取代 golang 的官方库 list。

```go
type idleList struct { // 只记录头尾
	count       int // list 长度
	front, back *poolConn
}

type poolConn struct { // 双链表节点
	c          Conn
	t          time.Time
	created    time.Time
	next, prev *poolConn
}
```

同时实现了几个双链表的操作，`pushFront`、`popFront` 和 `popBack`。
新版本的 pool 里去掉了条件变量，换上了 channel。

```go
chInitialized uint32 // set to 1 when field ch is initialized
ch           chan struct{} // limits open connections when p.Wait is true
idle         idleList      // idle connections
waitCount    int64         // total number of connections waited for.
waitDuration time.Duration // total time waited for new connections.
```

pool 里的连接个数使用了buffer channel 进行控制，大小为 `MaxActive`。
在第一次从 pool 中获取连接时，进行 channel 来初始化，即

```go
func (p *Pool) lazyInit() {
    // Fast path.
    if atomic.LoadUint32(&p.chInitialized) == 1 {
      return
    }
    // Slow path.
    p.mu.Lock()
    if p.chInitialized == 0 {
      p.ch = make(chan struct{}, p.MaxActive)
      if p.closed {
        close(p.ch)
      } else {
        for i := 0; i < p.MaxActive; i++ {
          p.ch <- struct{}{}
        }
      }
      atomic.StoreUint32(&p.chInitialized, 1)
    }
    p.mu.Unlock()
}
```

#### 4.2.1 从 pool 获取连接

```go
func (p *Pool) get(ctx context.Context) (*poolConn, error) {

	// Handle limit for p.Wait == true.
    var waited time.Duration
    if p.Wait && p.MaxActive > 0 {
      p.lazyInit()

      // wait indicates if we believe it will block so its not 100% accurate
      // however for stats it should be good enough.
      wait := len(p.ch) == 0
      var start time.Time
      if wait {
        start = time.Now()
      }
      if ctx == nil {
        <-p.ch
      } else {
        select {
        case <-p.ch:
        case <-ctx.Done():
          return nil, ctx.Err()
        }
      }
      if wait {
        waited = time.Since(start)
      }
    }

    p.mu.Lock()

    if waited > 0 {
      p.waitCount++
      p.waitDuration += waited
    }

    // Prune stale connections at the back of the idle list.
    if p.IdleTimeout > 0 {
      n := p.idle.count
      // 清理过期的 conn
      for i := 0; i < n && p.idle.back != nil && p.idle.back.t.Add(p.IdleTimeout).Before(nowFunc()); i++ {
        pc := p.idle.back
        p.idle.popBack()
        p.mu.Unlock()
        pc.c.Close()
        p.mu.Lock()
        p.active--
      }
    }

    // Get idle connection from the front of idle list.
    for p.idle.front != nil {
      pc := p.idle.front
      p.idle.popFront() // 从前面获取一个连接
      p.mu.Unlock()
      if (p.TestOnBorrow == nil || p.TestOnBorrow(pc.c, pc.t) == nil) &&
        (p.MaxConnLifetime == 0 || nowFunc().Sub(pc.created) < p.MaxConnLifetime) {
        return pc, nil
      }
      pc.c.Close()
      p.mu.Lock()
      p.active--
    }

    // Check for pool closed before dialing a new connection.
    if p.closed {
      p.mu.Unlock()
      return nil, errors.New("redigo: get on closed pool")
    }

    // Handle limit for p.Wait == false.
    if !p.Wait && p.MaxActive > 0 && p.active >= p.MaxActive {
      p.mu.Unlock()
      return nil, ErrPoolExhausted
    }

   // 新建连接，更新 active
    p.active++
    p.mu.Unlock()
    c, err := p.dial(ctx)
    if err != nil {
      c = nil
      p.mu.Lock()
      p.active--
      if p.ch != nil && !p.closed {
        p.ch <- struct{}{} // 连接创建不成功，将这个名额还给 channel
      }
      p.mu.Unlock()
    }
    return &poolConn{c: c, created: nowFunc()}, err
}
```

可以看到只有在连接池满了愿意等待时，才回初始化 buffer channel，即调用 `lazyInit` 函数，省去了不必要的内存占用，可以借鉴。
当连接池已满，则 channel 为空，此时取连接的流程会阻塞在 `<-p.ch`，这跟上一版本的 `cond.Wait()` 有相同的作用。
有相同的清理过期连接的逻辑，以及连接创建逻辑。

#### 4.2.2 从 pool 获取连接

```go
func (p *Pool) put(pc *poolConn, forceClose bool) error {
    p.mu.Lock()
    if !p.closed && !forceClose {
      pc.t = nowFunc()
      p.idle.pushFront(pc)          // 访问头部
      if p.idle.count > p.MaxIdle { // 超出了 MaxIdle 的数量的话，从后面踢掉最后面的一个
        pc = p.idle.back
        p.idle.popBack()
      } else {
        pc = nil
      }
    }

    if pc != nil {
      p.mu.Unlock()
      pc.c.Close()
      p.mu.Lock()
      p.active--
    }

    if p.ch != nil && !p.closed {
      p.ch <- struct{}{} // 放回池子
    }
    p.mu.Unlock()
    return nil
}
```

`ch` 控制着 pool 中连接的数量，当取走一个时，需要 `<-ch`，当还回一个时，需要 `ch <- struct{}{}`。
另外，还要考虑到某些失败的情况，是否需要将配额还回 `ch`。

### 4.3 分析

从上面的代码可以看出，不管哪个版本的 pool，获得连接是从**队首**获取，还连接也是从**队首**还，淘汰过期连接或者多出的连接是从**队尾**淘汰。
另外，新版本的 pool 实现比老版本更加符合 golang 的语言风格。
从某种角度讲，这种 pool 的管理方式会造成**某些连接过热**的情况，即负载均衡不均，尤其是过期时间设置不合理的情况下，需慎重使用。
