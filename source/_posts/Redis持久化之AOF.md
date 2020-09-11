---
title: Redis 持久化之 AOF
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: fd3e9e30
date: 2019-01-14 16:09:40
---
除了 RDB 持久化功能之外，Redis 还提供了 AOF（Append Only File）持久化功能。与 RDB 持久化通过保存数据库中的键值对来记录数据库状态不同，AOF 持久化是通过保存 Redis 服务器所执行的写命令来记录数据库状态的。

<!--more---->

## 简介

AOF 文件中记录了 Redis 服务器所执行的写命令，以此来保存数据库的状态。AOF 文件本质上是一个 redo log，通过它可以恢复数据库状态。

随着执行命令的增多，AOF 文件的大小会不断增大，这会导致几个问题，比如，磁盘占用增加，重启加载过慢等。因此， Redis 提供了 AOF 重写机制来控制 AOF 文件大小，下面会细说。

AOF 文件中写入的所有命令以 Redis 的命令请求协议格式去保存，即 [RESP](http://redisdoc.com/topic/protocol.html) 格式。

有两种方式可以实现 AOF 功能的开关，如下，

- 在 redis 配置文件 **redis.conf** 中有配置项 appendonly， yes 打开 AOF 功能，no 关闭 AOF 功能。
- 使用客户端命令`config set appendonly yes/no` 。

## server 相关变量

与 AOF 相关的 server 成员变量很多，这里只选择几个进行简要说明。先看后面的章节，之后再回头看本章节，也是个不错的主意。
```c
int aof_state;                  /* AOF_(ON|OFF|WAIT_REWRITE) */
int aof_fsync;                  /* Kind of fsync() policy */
char *aof_filename;             /* Name of the AOF file */
int aof_no_fsync_on_rewrite;    /* Don't fsync if a rewrite is in prog. */
int aof_rewrite_perc;           /* Rewrite AOF if % growth is > M and... */
off_t aof_rewrite_min_size;     /* the AOF file is at least N bytes. */
off_t aof_rewrite_base_size;    /* AOF size on latest startup or rewrite. */
off_t aof_current_size;         /* AOF current size. */
int aof_rewrite_scheduled;      /* Rewrite once BGSAVE terminates. */
pid_t aof_child_pid;            /* PID if rewriting process */
list *aof_rewrite_buf_blocks;   /* Hold changes during an AOF rewrite. */
sds aof_buf;                   /* AOF buffer, written before entering the event loop */
int aof_fd;                     /* File descriptor of currently selected AOF file */
int aof_selected_db;            /* Currently selected DB in AOF */
time_t aof_flush_postponed_start; /* UNIX time of postponed AOF flush */
time_t aof_last_fsync;            /* UNIX time of last fsync() */
time_t aof_rewrite_time_last;     /* Time used by last AOF rewrite run. */
time_t aof_rewrite_time_start;    /* Current AOF rewrite start time. */
int aof_lastbgrewrite_status;     /* C_OK or C_ERR */
unsigned long aof_delayed_fsync;  /* delayed AOF fsync() counter */
int aof_rewrite_incremental_fsync;/* fsync incrementally while rewriting? */
int aof_last_write_status;        /* C_OK or C_ERR */
int aof_last_write_errno;         /* Valid if aof_last_write_status is ERR */
int aof_load_truncated;           /* Don't stop on unexpected AOF EOF. */
```

### aof_fsync

表示 AOF 刷盘策略，后面会细说

### aof_child_pid

由于 aofrewrite 是个耗时操作，因此会 fork 一个子进程去做这件事， aof_child_pid 就标识了子进程的 pid。

### aof_buf

该变量保存着所有等待写入到 AOF 文件的协议文本。

### aof_rewrite_buf_blocks

该变量用来保存 aofrewrite 期间，server 处理过的需要写入 AOF 文件的协议文本。这个变量采用 list 结构，是考虑到分配到一个非常大的空间并不总是可能的，也可能产生大量的复制工作。

### aof_rewrite_scheduled

可取值有 0 和 1。

取 1 时，表示此时有子进程正在做 aofrewrite 操作，本次任务后延，等到 `serverCron` 执行时，合适的情况再执行。或者是执行了 `config set appendonly yes`, 想把 AOF 功能打开，此时执行的 aofrewrite 失败了，aof_state 仍然处于 **AOF_WAIT_REWRITE** 状态，此时 **aof_rewrite_scheduled** 也会置为 1，等下次再执行 aofrewrite。

### aof_state

表示 AOF 功能现在的状态，可取值如下，

```c
#define AOF_OFF 0             /* AOF is off */
#define AOF_ON 1              /* AOF is on */
#define AOF_WAIT_REWRITE 2    /* AOF waits rewrite to start appending */
```

**AOF_OFF** 表示 AOF 功能处于关闭状态，开关在上一节已经说过，默认 AOF 功能是关闭的。AOF 功能从 off switch 到 on 后，**aof_state** 会从 **AOF_OFF**  变为 **AOF_WAIT_REWRITE**，`startAppendOnly` 函数完成该逻辑。在 aofrewrite 一次之后，该变量才会从 **AOF_WAIT_REWRITE**  变为 **AOF_ON**。

可以看到从 ON 切换到 OFF 时，要经历一个中间状态 **AOF_WAIT_REWRITE**，那为何要这么设计呢？再来分析一下 `startAppendOnly` 函数的逻辑（代码去掉了打印日志的部分）。

```c
server.aof_fd = open(server.aof_filename,O_WRONLY|O_APPEND|O_CREAT,0644);
serverAssert(server.aof_state == AOF_OFF);
if (server.aof_fd == -1) {
    char *cwdp = getcwd(cwd,MAXPATHLEN);
    return C_ERR;
}
if (server.rdb_child_pid != -1) {
    server.aof_rewrite_scheduled = 1;
} else if (rewriteAppendOnlyFileBackground() == C_ERR) {
    close(server.aof_fd);
    return C_ERR;
}
server.aof_state = AOF_WAIT_REWRITE;
```

【1】打开 aof 文件，默认名为 appendonly.aof，没有的话就新建空文件，失败则返回。

【2】切换后，需要做一次 aofrewrite，将 server 中现有的数据转换成协议文本，写到 AOF 文件。但是，这里要**注意**，如果此时有子进程在做 bgrdb，那么此次 aofrewrite 需要任务延缓，即 **aof_rewrite_scheduled** 置为 1。

【3】将 **aof_state** 置为 **AOF_WAIT_REWRITE** 状态。

而做完第一次 aofrewrite 后，**AOF_WAIT_REWRITE** 转换成 **AOF_ON**，如下，

```c
void backgroundRewriteDoneHandler(int exitcode, int bysignal) {
    ...
    if (server.aof_state == AOF_WAIT_REWRITE)
        server.aof_state = AOF_ON;
    ...
}
```

仔细分析源码发现，在 AOF 持久化的命令追加阶段（后面章节细讲），有如下逻辑,

```c
void feedAppendOnlyFile(struct redisCommand *cmd, int dictid, robj **argv, int argc) {
    ...
    if (server.aof_state == AOF_ON)
        server.aof_buf = sdscatlen(server.aof_buf,buf,sdslen(buf));
    if (server.aof_child_pid != -1)
        aofRewriteBufferAppend((unsigned char*)buf,sdslen(buf));
    ...
}
```

很明显，刚开启 AOF 时， **aof_state** 为 **AOF_WAIT_REWRITE** ，处理好的协议文本 buf 无法写入 **aof_buf** 变量 ，但必须写入 **aof_rewrite_buf_blocks**  变量（数据在 aofrewrite 的最后阶段会被写进 AOF 文件）。

这里是否将命令 append 到 **aof_state** 的判断至关重要，如果修改条件为 `server.aof_state != AOF_OFF` ，**考虑如下情况**。

AOF 状态刚打开，尚未完成第一次 aofrewrite，也即，一边 Child 进程数据库中现有数据还未写进 AOF 文件，另一边 Parent 进程仍然持续处理 client 请求，于是，Parent 进程在指定的数据刷盘策略下，将 **aof_buf**  刷盘。如果这时宕机了，当 server 重启后，加载 AOF 文件，在内存中塞入数据，实际上对于用户来说，这部分数据算是脏数据了，因为 AOF 并没有成功打开，未开启 AOF 状态时，数据都在内存中，宕机后，数据会全部丢掉。增加这个中间状态就是为了应对这种情况。所以， **AOF_WAIT_REWRITE** 状态存在的时间范围起始于 `startAppendOnly` ，到完成第一次 aofrewrite 后切成 **AOF_ON** 。aofrewrite 后再发生宕机，丢失的数据就少多了。

**这只是我个人的理解，不一定正确，欢迎大家斧正。**

另外，如果开启了 AOF，在 redis 启动 加载 AOF 文件时，**aof_state** 也会暂时设置成 **AOF_OFF**，加载完毕之后设置为 **AOF_ON**。

### aof_pipe_*

为了提高 aofrewrite 效率，Redis 通过在父子进程间建立管道，把 aofrewrite 期间的写命令通过管道同步给子进程，追加写盘的操作也就转交给了子进程。aof_pipe_* 变量就是这部分会用到的管道。

## AOF 持久化

### 命令追加

AOF 功能开启后，每次导致数据库状态发生变化的命令都会经过**函数** `feedAppendOnlyFile` 累积到 **aof_buf** 变量中。如果后台有正在执行的 aofrewrite 任务，还会写一份数据到 **aof_rewrite_buf_blocks** 变量中。

#### feedAppendOnlyFile 函数

在该函数中，首先要将数据库切换到当前数据库（ **aof_selected_db** 更新），在 buf 中插入一条 **SELECT** 命令。

```c
sds buf = sdsempty();
if (dictid != server.aof_selected_db) {
    char seldb[64];
    snprintf(seldb,sizeof(seldb),"%d",dictid);
    buf = sdscatprintf(buf,"*2\r\n$6\r\nSELECT\r\n$%lu\r\n%s\r\n", (unsigned        long)strlen(seldb),seldb);
    server.aof_selected_db = dictid;
}
```

然后在对需要加入 buf 的命令进行分类处理。

【1】带有过期时间的命令，调用函数 `catAppendOnlyExpireAtCommand` 进行协议文本 buf 组装。**EXPIRE**/**PEXPIRE**/**EXPIREAT** 这三个命令直接调用该函数，而 **SETEX**/**PSETEX** 这两个命令需要在调用之前加入一个 **SET** 命令。即，

```c
tmpargv[0] = createStringObject("SET",3);
tmpargv[1] = argv[1];
tmpargv[2] = argv[3];
buf = catAppendOnlyGenericCommand(buf,3,tmpargv);

decrRefCount(tmpargv[0]);
buf = catAppendOnlyExpireAtCommand(buf,cmd,argv[1],argv[2]);
```

【2】普通命令，直接调用函数 `catAppendOnlyGenericCommand` 进行协议文本 buf 组装。

#### catAppendOnlyExpireAtCommand 函数

该函数其实就是将所有与过期时间相关的命令转成 **PEXPIREAT** 命令，细化到毫秒。最后调用普通命令组装 buf 函数 `catAppendOnlyGenericCommand`。

```c
// 构建 PEXPIREAT 命令
argv[0] = createStringObject("PEXPIREAT",9);
argv[1] = key;
argv[2] = createStringObjectFromLongLong(when);

// 调用 aof 公共函数
buf = catAppendOnlyGenericCommand(buf, 3, argv);
```

#### catAppendOnlyGenericCommand 函数

该函数用来把 redis 命令转换成 RESP 协议文本。

```c
sds catAppendOnlyGenericCommand(sds dst, int argc, robj **argv) {
    char buf[32];
    int len, j;
    robj *o;

    // 比如 *3\r\n
    buf[0] = '*';
    len = 1+ll2string(buf+1,sizeof(buf)-1,argc);
    buf[len++] = '\r';
    buf[len++] = '\n';
    dst = sdscatlen(dst,buf,len);

    for (j = 0; j < argc; j++) {
        o = getDecodedObject(argv[j]);
        buf[0] = '$';
        len = 1+ll2string(buf+1,sizeof(buf)-1,sdslen(o->ptr));
        buf[len++] = '\r';
        buf[len++] = '\n';
        dst = sdscatlen(dst,buf,len);
        dst = sdscatlen(dst,o->ptr,sdslen(o->ptr));
        dst = sdscatlen(dst,"\r\n",2);
        decrRefCount(o);
    }
    return dst;
}
```

可以看到，定义了一个 buf 数组，反复使用，通过 len 精确控制 append 到 dst 后的长度。

#### aofRewriteBufferAppend 函数

**aof_rewrite_buf_blocks** 变量是一个 list 结构，其中每一个元素都是一个大小为 10M 的 block

```c
#define AOF_RW_BUF_BLOCK_SIZE (1024*1024*10)    /* 10 MB per block */
typedef struct aofrwblock {
    unsigned long used, free;
    char buf[AOF_RW_BUF_BLOCK_SIZE];
} aofrwblock;
```

这个函数做了两件事情。

一是，将 `catAppendOnlyGenericCommand` 获得的协议文本 buf 存到 **aof_rewrite_buf_blocks** 变量，首先拿出来 list 最后一个 block，如果装不下，那先把最后一个 block 填满，剩下的再申请内存。

```c
listNode *ln = listLast(server.aof_rewrite_buf_blocks); // 指向最后一个缓存块
aofrwblock *block = ln ? ln->value : NULL;
while(len) {
    if (block) { // 如果已经有至少一个缓存块，那么尝试将内容追加到这个缓存块里面
        unsigned long thislen = (block->free < len) ? block->free : len;
        if (thislen) {  /* The current block is not already full. */
            memcpy(block->buf+block->used, s, thislen);
            block->used += thislen;
            block->free -= thislen;
            s += thislen;
            len -= thislen;
        }
    }
    if (len) {  // 最后一个缓存块没有放得下本次 data，那再申请一个 block
        int numblocks;
        block = zmalloc(sizeof(*block));
        block->free = AOF_RW_BUF_BLOCK_SIZE;
        block->used = 0;
        listAddNodeTail(server.aof_rewrite_buf_blocks,block);
        ... ...
    }
}
```

二是，给 **aof_pipe_write_data_to_child** 这个 fd 注册写事件，回调函数为 `aofChildWriteDiffData`。

```c
/* Install a file event to send data to the rewrite child if there is
     * not one already. */
if (aeGetFileEvents(server.el,server.aof_pipe_write_data_to_child) == 0) {
    aeCreateFileEvent(server.el, server.aof_pipe_write_data_to_child,
                      AE_WRITABLE, aofChildWriteDiffData, NULL);
}
```

这个属于 aof 重写的逻辑，后面章节会细说，这里先留个心。

#### 何时进行命令追加

也就是说，什么时候会调用`feedAppendOnlyFile` 呢？有以下两个时机。

##### propagate 函数

大家都知道，Redis 中命令执行的流程，即 `processCommand` -> `call` 。在 `call` 函数中会把某些命令写入 AOF 文件。如何判断某个命令是否需要写入 AOF 呢？

在 server 结构体中维持了一个 **dirty** 计数器，**dirty** 记录的是服务器状态进行了多少次修改，每次做完 save/bgsave 执行完成后，会将 **dirty** 清 0，而使得服务器状态修改的命令一般都需要写入 AOF 文件和主从同步（排除某些特殊情况）。

```c
dirty = server.dirty;
c->cmd->proc(c);
dirty = server.dirty-dirty;
...
if (propagate_flags != PROPAGATE_NONE)
    propagate(c->cmd,c->db->id,c->argv,c->argc,propagate_flags);
```

在 `propagate` 函数中就会调用到 `feedAppendOnlyFile`。

```c
void propagate(struct redisCommand *cmd, int dbid, robj **argv, int argc,
               int flags)
{
    if (server.aof_state != AOF_OFF && flags & PROPAGATE_AOF)
        feedAppendOnlyFile(cmd,dbid,argv,argc);
    if (flags & PROPAGATE_REPL)
        replicationFeedSlaves(server.slaves,dbid,argv,argc);
}
```

##### propagateExpire 函数

当内存中带有过期时间的 key 过期时，会向 AOF 写入 **del** 命令。

```c
void propagateExpire(redisDb *db, robj *key) {
    ...
    if (server.aof_state != AOF_OFF)
        feedAppendOnlyFile(server.delCommand,db->id,argv,2);
    replicationFeedSlaves(server.slaves,db->id,argv,2);
    ...
}
```

`propagateExpire` 函数在一些检查 key 是否过期时会调用。

### 文件的写入与同步

上一步中，将需要写入 AOF 文件的数据先写到了 **aof_buf**  变量中，那么，接下来说一下如何将 **aof_buf** 的内容写进 AOF 文件。

#### 同步策略

> 为了提高文件的写入效率，在现代操作系统中，当用户调用 `write`  函数试，将一些数据写入到文件的时候，操作系统通常会将写入的数据保存在一个内存缓冲区里，等到缓冲区的空间被填满，或者超过了指定的时限后，才真正地将缓冲区中的数据写入磁盘。
>
> 这种做法虽然提高了效率，但也为写入数据带来了安全问题，因为如果计算机宕机，那么保存在内存缓冲区里面的写入数据将会丢失。
>
> 为此，系统提供了  `fsync` 和 `fdatasync` 两个同步函数，它们可以强制让操作系统立即将缓存区中的数据写入到硬盘里面，从而确保写入数据的安全性。

要知道，这两个系统调用函数都是阻塞式的，针对如何协调文件写入与同步的关系，该版本 Redis 支持 3 种同步策略，可在配置文件中使用 **appendfsync** 项进行配置，有如下取值，

- always。每次有新命令追加到  AOF文件 时就执行一次同步，,安全性最高，但是性能影响最大。

- everysec。每秒执行一次同步。宕机只会丢失一秒钟的命令。这算是一个折中方案。

- no。将数据同步操作完全交由操作系统处理，性能最好，但是数据可靠性最差。宕机将丢失同步 AOF 文件后的所有写命令。

在 Redis 源码中， 当程序运行在 Linux 系统上时，执行的是 `fdatasync` 函数，而在其他系统上，则会执行 `fsync` 函数，即，

```c
#ifdef __linux__
#define aof_fsync fdatasync
#else
#define aof_fsync fsync
#endif
```

**注**：以下叙述均以 `fsync` 代称。

#### 如何写入文件

写入文件的逻辑在 `flushAppendOnlyFile` 函数中实现。下面分两部分来看主要代码。

##### 文件写入**，`write` **系统调用

```c
...

// aof 缓存区内没有数据需要写入 disk，无需处理
if (sdslen(server.aof_buf) == 0) return;

// 如果 sync policy 设置成 everysec，
// sync_in_progress 表示是否有 fsync 任务在后台
if (server.aof_fsync == AOF_FSYNC_EVERYSEC)
    sync_in_progress = bioPendingJobsOfType(BIO_AOF_FSYNC) != 0;

// force=0(非强制写入)时，如果后台有 fsync 任务，推迟此次写入，但推迟时间不超过 2s
if (server.aof_fsync == AOF_FSYNC_EVERYSEC && !force) {
    if (sync_in_progress) {
        if (server.aof_flush_postponed_start == 0) { // 首次推迟 write，一次推迟 2s
            server.aof_flush_postponed_start = server.unixtime;
            return;
        } else if (server.unixtime - server.aof_flush_postponed_start < 2) {
            return;
        }

        // 否则，通过，继续写，因为我们不能等待超过 2s
        server.aof_delayed_fsync++;
        serverLog(LL_NOTICE,"Asynchronous AOF fsync is taking too long (disk is busy?). Writing the AOF buffer without waiting for fsync to complete, this may slow down Redis.");
    }
}
...
// 将 aof 缓冲区的内容写到系统缓存区
nwritten = write(server.aof_fd, server.aof_buf, sdslen(server.aof_buf));
...
// 执行了 write 操作，所以要清零延迟 flush 的时间
server.aof_flush_postponed_start = 0;
```

首先会判断 **aof_buf** 是否为空，如果是，那么不需要执行下面的逻辑，直接返回。

如果同步策略为 everysec，那么需要查看是否有  **fsync** 任务在后台，调用  **fsync** 使用的是 Redis 中 bio ，如果对这个还不了解，可以参考我之前的文章  《 [Redis Bio 详解](http://tech-happen.site/de55b491.html) 》。为什么要做这个判断呢？

> 当 `fsync` 和 `write` 同一个 fd 时，`write` 必然阻塞。 当系统 IO 非常繁忙时， `fsync`() 可能会阻塞， 即使系统 IO 不繁忙， `fsync` 也会因为数据量大而慢。

因此对于 everysec 策略，需要尽量保证 `fsync` 和 `write` 不同时操作同一个 fd。no 策略完全把 `fsync` 交给了操作系统，操作系统什么时候  `fsync` ，无从得知。always 策略则是每次都要主从调用 `fsync`，也没必要做判断。因此，这里的判断，只针对  everysec 策略有效。

对于 everysec 策略，如果有  `fsync`  在执行，那么本次  `write`  **推迟 2 秒钟**，等到下次在进入本函数时，如果推迟时间超过 2 秒，那么更新 **aof_delayed_fsync** 值（info 里可以查到），打印日志 ” **Asynchronous AOF fsync is taking too long (disk is busy?). Writing the AOF buffer without waiting for fsync to complete, this may slow down Redis.** “ ，之后进行 `write` 系统调用。当然了，系统也提供了 force 选项，去跳过这项是否要推迟 `write` 的检查。

`write` 之后，将 **aof_flush_postponed_start** 推迟开始计时值清零，迎接下次检查。

所以说，AOF 执行 everysec 策略时，如果恰好有 `fsync` 在长时间的执行，Redis 意外关闭会丢失最多两秒的数据。如果  `fsync`  运行正常，只有当操作系统 crash 时才会造成最多 1 秒的数据丢失。

##### 收尾工作， `write` 结果处理

`write` 调用结果可能是正常的，也可能是异常的，那么需要做不同的处理。首先主要看异常处理，

```c
if (nwritten != (signed)sdslen(server.aof_buf)) {
    ...
    /* Log the AOF write error and record the error code. */
    if (nwritten == -1) {
        ...
    } else { // 如果仅写了一部分，发生错误
    // 将追加的内容截断，删除了追加的内容，恢复成原来的文件
        if (ftruncate(server.aof_fd, server.aof_current_size) == -1) {
            ...
        } else {
            nwritten = -1;
        }
        server.aof_last_write_errno = ENOSPC;
    }

    // 如果是写入的策略为每次写入就同步，无法恢复这种策略的写，因为我们已经告知使用者，已经将写的数据同步到磁盘了，因此直接退出程序
    if (server.aof_fsync == AOF_FSYNC_ALWAYS) {
        ...
        exit(1);
    } else {
        // 设置执行write操作的状态
        server.aof_last_write_status = C_ERR;
        if (nwritten > 0) {
            // 只能更新当前的 AOF 文件的大小
            server.aof_current_size += nwritten;
            // 删除 AOF 缓冲区写入的字节
            sdsrange(server.aof_buf,nwritten,-1);
        }
        return; /* We'll try again on the next call... */
    }
} else {
    /* Successful write(2). If AOF was in error state, restore the
     * OK state and log the event.
     */
    if (server.aof_last_write_status == C_ERR) {
        serverLog(LL_WARNING, "AOF write error looks solved, Redis can write again.");
        server.aof_last_write_status = C_OK;
    }
}
```

写入异常的判断，`nwritten != (signed)sdslen(server.aof_buf)`，`write` 的数据量与 **aof_buf** 的大小不同。当完全没写入时，打个日志就算了；当仅写入了一部分数据时，使用 `ftruncate` 函数把 AOF 文件的内容恢复成原来的大小，以备下次重新写入，**nwritten** 置为 -1。使用 `ftruncate` 的原因是怕操作系统执行了 `fsync`，因此需要把 AOF 文件的大小恢复。

如果执行的是 always 同步策略，那么需要返回会客户端错误。对于其他策略，更新 `aof_last_write_status` ，以便知道上一次做 `write` 的结果，对于未完全写入的情况，如果上面执行的 `ftruncate` 失败，此时 `nwritten > 0`，需要更新 **aof_current_size**，从 **aof_buf** 中减去已经写入的，防止下次有重复数据写入，然后返回。

如果写入成功，那么视情况更新 `aof_last_write_status`，表示此次 `write` 成功。

下面主要是正常情况的处理。

```c
/* nwritten = -1 时走不到这个步骤 */
server.aof_current_size += nwritten; // 正常 write，更新 aof_current_size

/* Re-use AOF buffer when it is small enough. The maximum comes from the
 * arena size of 4k minus some overhead (but is otherwise arbitrary).
 */
if ((sdslen(server.aof_buf)+sdsavail(server.aof_buf)) < 4000) {
    sdsclear(server.aof_buf);
} else {
    sdsfree(server.aof_buf);
    server.aof_buf = sdsempty();
}

/* Don't fsync if no-appendfsync-on-rewrite is set to yes and there are
 * children doing I/O in the background. */
if (server.aof_no_fsync_on_rewrite && (server.aof_child_pid != -1 || server.rdb_child_pid != -1)) return;

/* Perform the fsync if needed. */
if (server.aof_fsync == AOF_FSYNC_ALWAYS) {
    /* aof_fsync is defined as fdatasync() for Linux in order to avoid
         * flushing metadata. */
    latencyStartMonitor(latency);
    aof_fsync(server.aof_fd); /* Let's try to get this data on the disk */
    latencyEndMonitor(latency);
    latencyAddSampleIfNeeded("aof-fsync-always",latency);
    server.aof_last_fsync = server.unixtime;
} else if ((server.aof_fsync == AOF_FSYNC_EVERYSEC &&
            server.unixtime > server.aof_last_fsync)) {
    if (!sync_in_progress) aof_background_fsync(server.aof_fd); // 如果没有正在执行同步，那么创建一个后台任务
    server.aof_last_fsync = server.unixtime;
}
```

**aof_buf** 清空，然后根据不同策略进行同步。always 策略时，主动调用 `fsync`; everysec 策略，则创建 fsync bio 任务。

另外，有配置项 no-appendfsync-on-rewrite 去决定，当子进程在做 aofrewrite/bgsave 时是否要进行 `fsync`。

#### 何时进行文件写入

也就是，什么时候会调用 `flushAppendOnlyFile` 函数，有以下三个时机。

##### beforeSleep 函数

> Redis 的服务器进程就是一个事件循环，这个循环中的文件事件负责接收客户端请求，以及向客户端发送命令回复，而时间事件则负责像 `serverCron` 函数这样需要定时运行的函数。

对于 Redis 的事件机制可以参考我之前的文章 《[Redis 中的事件](http://tech-happen.site/85f7b0b4.html)》。

因为服务器在处理文件事件时可能会执行写命令，使得一些内容被追加到 **aof_buf** 缓冲区里面，所以在服务器每次结束一个事件循环之前，都会调用 `flushAppendOnlyFile` 函数，考虑是否需要将  **aof_buf** 缓冲区中的内容写入和同步到 AOF 文件里面。即，

```c
void beforeSleep(struct aeEventLoop *eventLoop) {
    ...
    /* Write the AOF buffer on disk */
    flushAppendOnlyFile(0);
    ...
}
```

这里的调用是非强制写入（force = 0）。

##### serverCron 函数

Redis 中的时间事件，定期执行  `serverCron` 函数（从 Redis 2.8 开始，用户可以通过修改  **hz**  选项来调整  `serverCron`的每秒执行次数），做一些杂事，比如更新服务器各项统计信息、关闭清理客户端、做 AOF 和 RDB 等。

```c
  /* AOF postponed flush: Try at every cron cycle if the slow fsync completed. */
if (server.aof_flush_postponed_start) flushAppendOnlyFile(0);
```

如果上次 AOF 写入推迟了，那么再次尝试非强制写入。

```c
run_with_period(1000) {
    if (server.aof_last_write_status == C_ERR)
        flushAppendOnlyFile(0);
}
```

每秒钟检查，如果上次写入 AOF 文件失败了，再次尝试非强制写入。因为需要及时去处理 `aof_buf`，以及重置 AOF 写入状态的变量 **aof_last_write_status**，每秒做检查，这个频率是足够的。

##### stopAppendOnly 函数

当 AOF 功能要关闭时，会调用 `stopAppendOnly` 函数，尝试一次强制写入，即尽最大努力去保存最多的数据。

```c
void stopAppendOnly(void) {
    serverAssert(server.aof_state != AOF_OFF);
    flushAppendOnlyFile(1);
    aof_fsync(server.aof_fd);
    close(server.aof_fd);
}
```

强制写入，并刷盘。

## AOF 文件载入

当 Redis 服务器进程启动时，需要调用 `loadDataFromDisk` 函数去加载数据。

```c
void loadDataFromDisk(void) {
    long long start = ustime();
    if (server.aof_state == AOF_ON) { // 开启了 aof
        if (loadAppendOnlyFile(server.aof_filename) == C_OK)
            serverLog(LL_NOTICE,"DB loaded from append only file: %.3f seconds",(float)(ustime()-start)/1000000);
    } else {
        if (rdbLoad(server.rdb_filename) == C_OK) {
            serverLog(LL_NOTICE,"DB loaded from disk: %.3f seconds",
                (float)(ustime()-start)/1000000);
        } else if (errno != ENOENT) {
            serverLog(LL_WARNING,"Fatal error loading the DB: %s. Exiting.",strerror(errno));
            exit(1);
        }
    }
}
```

可以看到，如果开启了 AOF 功能，就会调用 `loadAppendOnlyFile` 函数，加载 AOF 文件中的数据到内存中。否则，会去调用 `rdbLoad` 函数，加载 RDB 文件。加载 AOF 文件的设计很有意思。

```c
FILE *fp = fopen(filename,"r");
struct redis_stat sb;
int old_aof_state = server.aof_state;
long loops = 0;
off_t valid_up_to = 0; /* Offset of the latest well-formed command loaded. */

// 检查文件的正确性, 存在，并且不为空
if (fp && redis_fstat(fileno(fp),&sb) != -1 && sb.st_size == 0) {
    server.aof_current_size = 0;
    fclose(fp);
    return C_ERR;
}
if (fp == NULL) {
    serverLog(LL_WARNING,"Fatal error: can't open the append log file for reading: %s",strerror(errno));
    exit(1);
}
// 暂时关掉 AOF, 防止向该 filename 中写入新的 AOF 数据
server.aof_state = AOF_OFF;
```

首先，空文件没有必要再去加载了，提前返回。

然后，暂时关闭 AOF 功能，这是为了防止在加载 AOF 文件的过程中，又有新的数据写进来

```c
fakeClient = createFakeClient(); // 创建一个不带网络连接的伪客户端
startLoading(fp);                // 标记正在 load db，loading = 1

// 读 AOF 文件
while(1) {
    int argc, j;
    unsigned long len;
    robj **argv;
    char buf[128];
    sds argsds;
    struct redisCommand *cmd;
    ... ...
        // 如执行命令 SET keytest val，那么写入 AOF 文件中的格式为
        // *3\r\n$3\r\nSET\r\n$7\r\nkeytest\r\n$3\r\nval\r\n
        if (fgets(buf,sizeof(buf),fp) == NULL) { // 按行读取 AOF 文件，*3
            if (feof(fp))
                break;
            else
                goto readerr;
        }

    if (buf[0] != '*') goto fmterr; // 判断协议是否正确
    if (buf[1] == '\0') goto readerr; // 数据完整判断
    argc = atoi(buf+1);
    if (argc < 1) goto fmterr;

    argv = zmalloc(sizeof(robj*)*argc);
    fakeClient->argc = argc;
    fakeClient->argv = argv;

    for (j = 0; j < argc; j++) {
        if (fgets(buf,sizeof(buf),fp) == NULL) { // 依次读到 $3, $7, $3
            fakeClient->argc = j; /* Free up to j-1. */
            freeFakeClientArgv(fakeClient);
            goto readerr;
        }
        if (buf[0] != '$') goto fmterr;
        len = strtol(buf+1,NULL,10); // 参数长度
        argsds = sdsnewlen(NULL,len);
        if (len && fread(argsds,len,1,fp) == 0) { // 依次读到 SET/ keytest/ val
            sdsfree(argsds);
            fakeClient->argc = j; /* Free up to j-1. */
            freeFakeClientArgv(fakeClient);
            goto readerr;
        }
        argv[j] = createObject(OBJ_STRING,argsds);
        if (fread(buf,2,1,fp) == 0) { // 读到 \r\n
            fakeClient->argc = j+1; /* Free up to j. */
            freeFakeClientArgv(fakeClient);
            goto readerr; /* discard CRLF */
        }
    }

    /* Command lookup */
    cmd = lookupCommand(argv[0]->ptr);
    if (!cmd) {
        serverLog(LL_WARNING,"Unknown command '%s' reading the append only file", (char*)argv[0]->ptr);
        exit(1);
    }

    /* Run the command in the context of a fake client */
    cmd->proc(fakeClient);

    /* The fake client should not have a reply */
    serverAssert(fakeClient->bufpos == 0 && listLength(fakeClient->reply) == 0);
    /* The fake client should never get blocked */
    serverAssert((fakeClient->flags & CLIENT_BLOCKED) == 0);

    /* Clean up. Command code may have changed argv/argc so we use the
         * argv/argc of the client instead of the local variables. */
    freeFakeClientArgv(fakeClient);
    if (server.aof_load_truncated) valid_up_to = ftello(fp);
}
```

上面这部分是加载 AOF 文件的关键，以 `SET keytest val` 命令对应的 AOF 文件内容 `*3\r\n$3\r\nSET\r\n$7\r\nkeytest\r\n$3\r\nval\r\n` 为例，可以更好地理解上面的逻辑。由于 AOF 文件中存储的数据与客户端发送的请求格式相同完全符合 Redis 的通信协议，因此 Redis Server 创建伪客户端 **fakeClient**，将解析后的 AOF 文件数据像客户端请求一样调用各种指令，`cmd->proc(fakeClient)`，将 AOF 文件中的数据重现到 Redis Server 数据库中。

完成以上逻辑后，进行一些收尾工作，如改回 AOF 状态为 ON，释放伪客户端等，并处理一些异常情况，这里就不展开细讲了。

## 参考

1. [Copy On Write 机制了解一下](https://juejin.im/post/5bd96bcaf265da396b72f855)
2. [Redis · 原理介绍 · 利用管道优化aofrewrite](http://mysql.taobao.org/monthly/2018/12/06/)
