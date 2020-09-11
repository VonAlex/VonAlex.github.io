---
title: Redis 源码之启动流程
tags: redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: 35a9decf
date: 2018-12-08 01:07:25
---
说说 redis 的启动流程。

<!--more---->

首先要找到**启动函数**，我们知道 C 程序从 `main` 函数开始，所以，就找到了“梦想”开始的地方 `server.c` -> `main`。
这里主要讲启动过程中的主要部分，所以并不会一一涉及到。

## 大概启动流程
### initServerConfig 函数

整个代码中最重要的结构体莫过于 `struct redisServer server`，它以一个全局变量的形式出现。本函数主要是对它的成员进行赋值操作，这些成员基本上是可以通过 redis.conf 文件来配置。

####  大部分成员赋初值

比如：

| server 字段          | 含义                                 |
| -------------------- | ------------------------------------ |
| runid                | 节点标识占用 40B                     |
| port                 | 启动端口默认为 6379                  |
| tcp_backlog          | 默认 511B                            |
| aof_fsync            | 默认 aof 每秒刷盘，但是 aof 默认关闭 |
| aof_filename         | 默认 aof 文件名为 appendonly.aof     |
| rdb_filename         | 默认 rdb 文件名为 dump.rdb           |
| cluster_node_timeout | 默认 15s，默认 cluster 模式关闭      |

#### 默认 rdb 触发条件

```c
appendServerSaveParams(60 * 60,1);  /* save after 1 hour and 1 change */
appendServerSaveParams(300,100);    /* save after 5 minutes and 100 changes */
appendServerSaveParams(60,10000);   /* save after 1 minute and 10000 changes */
```

#### Replication related

包含对 backlog 的相关设置。

#### Double constants initialization

浮点数据精度设置。

#### client output buffer limit

一共有三种类型，如下：

```c
clientBufferLimitsConfig clientBufferLimitsDefaults[CLIENT_TYPE_OBUF_COUNT] = {
    {0, 0, 0},                         /* normal */
    {1024*1024*256, 1024*1024*64, 60}, /* slave */
    {1024*1024*32, 1024*1024*8, 60}    /* pubsub */
};
```

#### redis 命令表

初始化 redis 命令表放到 `server.commands`中，这主要是在 `populateCommandTable` 函数中完成的。

**注意**：考虑到在 redis.conf 配置文件中可以使用 rename-command 来对 Command 进行重命名（通常是为了安全考虑而禁用某些命令），因此命令表保存了**两份**，即 `server.commands` 和 `server.orig_commands`。

同时还对一些经常查询的命令单独提出来，分别放到以下变量中，

```c
struct redisCommand *delCommand, *multiCommand, *lpushCommand, *lpopCommand,
                    *rpopCommand, *sremCommand, *execCommand;
```

#### Slow log

默认时间为 **10ms**。

### sentinel 模式

以下方式进行该模式的开启：

```c
int checkForSentinelMode(int argc, char **argv) {
    int j;

    if (strstr(argv[0],"redis-sentinel") != NULL) return 1;
    for (j = 1; j < argc; j++)
        if (!strcmp(argv[j],"--sentinel")) return 1;
    return 0;
}
```

使用命令行参数 `--sentinel`，或者直接使用二进制文件 `redis-sentinel`。

**如果开启**了该模式，那么进行相应的初始，没开启就跳过。

```c
if (server.sentinel_mode) {
    initSentinelConfig(); // sentinel 默认端口 26379
    initSentinel(); // sentinel 变量赋初值
}
```

### 命令行参数解析并载入配置文件

主要还是获得配置文件的**绝对路径** `server.configfile = getAbsolutePath(configfile)`。

配置文件的载入有专门的函数

```c
void loadServerConfig(char *filename, char *options){}
```

载入配置文件后，会覆盖之前对于 server 的某些默认配置。实际上，当 redis-server 启动后，一些配置可以通过 `config get` 命令查看，也可以通过 `config set` 命令进行修改，修改后 `config rewrite` 刷盘。

### initServer 函数

不同于 `initServerConfig` 函数，该函数主要初始化一些 redis-server 运行中的成员。

#### 信号处理

通过 redis 来复习下信号处理。

```c
// 忽略SIGHUP和SIGPIPE信号
signal(SIGHUP, SIG_IGN);
signal(SIGPIPE, SIG_IGN);
```

```c
void setupSignalHandlers(void) {
    struct sigaction act;
    sigemptyset(&act.sa_mask);
    act.sa_flags = 0;
    act.sa_handler = sigShutdownHandler;
    sigaction(SIGTERM, &act, NULL);
    sigaction(SIGINT, &act, NULL);
    return;
}
```

主要是程序退出的善后工作。

#### 系统日志

```c
if (server.syslog_enabled) {
    openlog(server.syslog_ident, LOG_PID | LOG_NDELAY | LOG_NOWAIT,
            server.syslog_facility);
}
```

前提是使用到了系统的 rsyslog。

#### createSharedObjects 函数

该函数把一些常用的字符串保存起来，目的就是为了减少不断申请释放时CPU时间，内存碎片等等。

比如 `shared.ok = createObject(OBJ_STRING,sdsnew("+OK\r\n"))`。

**额外说明的是**，这里还初始化了一个很大的共享数字对象，0 到 999。因此在设置 value 时可以使用这些数字可以减少内存的使用。

```c
#define OBJ_SHARED_INTEGERS 10000

for (j = 0; j < OBJ_SHARED_INTEGERS; j++) { // 10000 个数字
    shared.integers[j] = createObject(OBJ_STRING,(void*)(long)j);
    shared.integers[j]->encoding = OBJ_ENCODING_INT;
}
```

`struct sharedObjectsStruct shared` 也是一个全局变量。

#### adjustOpenFilesLimit 函数

该函数根据配置文件中配置的最大 client 数量增大可以打开的最多文件数。

#### 创建 eventLoop

```c
 server.el = aeCreateEventLoop(server.maxclients+CONFIG_FDSET_INCR)
```

这里假设 io 多路复用使用的是 epoll，这也是用的最多的。

#### 初始化数据库对象

```c
server.db = zmalloc(sizeof(redisDb)*server.dbnum);
```

数据库对象 `struct redisDb`，有 16 个。

#### 监听 port 端口

```c
if (server.port != 0 &&
    listenToPort(server.port,server.ipfd,&server.ipfd_count) == C_ERR)
    exit(1);
```

监听 `server.port`，并把返回的 fd 存储在  `server.ipfd` 中，有报错就返回。

#### 创建系统 cron 定时器

```c
if(aeCreateTimeEvent(server.el, 1, serverCron, NULL, NULL) == AE_ERR) {
    serverPanic("Can't create the serverCron time event.");
    exit(1);
}
```

注册定时时间，绑定回调函数 `serverCron`，在该函数中我们可以看到，执行周期为 `1000/server.hz` ms，因此每秒会执行`server.hz`（该值用户可配）。

那为什么是这个频率呢？redis 中对于事件处理在之前的一篇博客中写过，可以参考下 [Redis 中的事件](http://tech-happen.site/85f7b0b4.html)，这里也可以简单回顾下。

时间事件处理函数 `ae.c`-> `processTimeEvents` 中，会根据时间事件的回调返回值来决定这时一个周期事件还是一次性事件，即

```c
{
    int retval;

    id = te->id;
    retval = te->timeProc(eventLoop, id, te->clientData);
    processed++;
    if (retval != AE_NOMORE) {
        aeAddMillisecondsToNow(retval,&te->when_sec,&te->when_ms);
    } else {
        te->id = AE_DELETED_EVENT_ID;
    }
}
```

#### 监听/接收用户请求

```c
for (j = 0; j < server.ipfd_count; j++) {
    if (aeCreateFileEvent(server.el, server.ipfd[j], AE_READABLE, // 监听可读事件
                          acceptTcpHandler,NULL) == AE_ERR)
    {
        serverPanic(
            "Unrecoverable error creating server.ipfd file event.");
    }
}
```

接收用户请求（用户连接会从这里进来），监听可读事件，注册回调函数 `acceptTcpHandler`。

#### cluster 初始化

如果开启了 cluster mode，会进行相应的初始化。

```c
if (server.cluster_enabled) clusterInit();
```

#### 其他环境初始化

```c
replicationScriptCacheInit();
scriptingInit(1);
slowlogInit();
latencyMonitorInit();
bioInit();
```

### 设置进程名

这个函数很实用的，方便 ps 看到良好格式的进程名。一起来复习下。

```c
void redisSetProcTitle(char *title) {
#ifdef USE_SETPROCTITLE
    char *server_mode = "";
    if (server.cluster_enabled) server_mode = " [cluster]";
    else if (server.sentinel_mode) server_mode = " [sentinel]";

    setproctitle("%s %s:%d%s",
        title,
        server.bindaddr_count ? server.bindaddr[0] : "*",
        server.port,
        server_mode);
#else
    UNUSED(title);
#endif
}
```

### 加载持久化数据

如果不是以 sentinel 模式启动的，那么会加载持久化的数据，处理函数为 `loadDataFromDisk`。

如果开启了 aof，那么就加载 aof 文件，否则加载 rdb 文件。

##### loadAppendOnlyFile

该函数用来记载  aof 文件，主要流程就是创建一个伪客户端，从 aof  文件中解析出来命令，让 server 重新执行一遍。

```c
if (buf[0] != '*') goto fmterr;   // 判断协议是否正确
if (buf[1] == '\0') goto readerr; // 判断数据完整判断
argc = atoi(buf+1);
if (argc < 1) goto fmterr;

argv = zmalloc(sizeof(robj*)*argc); // argc 个 robj 对象
fakeClient->argc = argc;
fakeClient->argv = argv;

for (j = 0; j < argc; j++) {
    if (fgets(buf,sizeof(buf),fp) == NULL) { // 每行最多 128B
        fakeClient->argc = j; /* Free up to j-1. */
        freeFakeClientArgv(fakeClient);
        goto readerr;
    }
    if (buf[0] != '$') goto fmterr;
    len = strtol(buf+1,NULL,10); // 命令的长度
    argsds = sdsnewlen(NULL,len);
    if (len && fread(argsds,len,1,fp) == 0) {
        sdsfree(argsds);
        fakeClient->argc = j; /* Free up to j-1. */
        freeFakeClientArgv(fakeClient);
        goto readerr;
    }
    argv[j] = createObject(OBJ_STRING,argsds);
    if (fread(buf,2,1,fp) == 0) { // \r\n
        fakeClient->argc = j+1; /* Free up to j. */
        freeFakeClientArgv(fakeClient);
        goto readerr; /* discard CRLF */
    }
}

cmd = lookupCommand(argv[0]->ptr);
if (!cmd) {
    serverLog(LL_WARNING,"Unknown command '%s' reading the append only file", (char*)argv[0]->ptr);
    exit(1);
}

// 用 fakeClient 执行命令
cmd->proc(fakeClient);
```

以上函数就是 aof 文件解析过程。

附上一段 redis 协议数据，方便分析函数。

```c
*3
$3
SET
$2
xx
$2
yy
*3
```

  **注意**：在加载 aof 文件过程中，会暂时关闭 aof。

##### rdbLoad

该函数用来加载 rdb 文件。与 aof 加载不同的是，解析 rdb 文件后直接放入内存中。

### 事件循环初始化

```c
// 进入事件循环之前执行 beforeSleep() 函数
aeSetBeforeSleepProc(server.el,beforeSleep);
// 开始事件循环
aeMain(server.el);
// 服务器关闭，删除事件循环
aeDeleteEventLoop(server.el);
```

## 小结
画了一个流程图，可以很好的体现以上流程。
![redis server setup](http://ww1.sinaimg.cn/large/71ca8e3cly1fxz66ssdg9j209a0pdac8.jpg)