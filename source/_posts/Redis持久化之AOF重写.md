---
title: Redis 持久化之 AOF 重写
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: d15eb256
date: 2019-01-20 01:55:11
---
> 因为 AOF 持久化是通过保存被执行的写命令来记录数据库状态的，所以随着服务器运行时间的流逝，AOF 文件中的内容会原来越多，文件的体积也会越来越大，若不加以控制，体积过大的 AOF 文件很可能对 Redis 服务器、甚至整个宿主计算机造成影响，并且其体积越大，使用 AOF 文件来进行数据还原所需要的时间就越长。

<!--more---->

为防止 aofrewrite 过程阻塞服务器，Redis 服务器会 `fork` 一个子进程执行该过程，且任何时刻只能有一个子进程做这件事。

## server 相关变量

为了保证 AOF 的连续性，父进程把 aofrewrite 期间的写命令缓存起来，等子进程重写之后再追加到新的 AOF 文件。如果 aofrewrite 期间写命令写入量较大的话，子进程结束后，父进程的追加就涉及到**大量的写磁盘操作**，造成服务性能下降。

Redis 通过在父子进程间建立 pipe，把 aofrewrite 期间的写命令通过 pipe 同步给子进程，这样一来，追加写盘的操作也就转嫁给了子进程。Redis server 中与之相关的变量主要有以下几个，主要三个 pipe。

```c
int aof_pipe_write_data_to_child;
int aof_pipe_read_data_from_parent;
int aof_pipe_write_ack_to_parent;
int aof_pipe_read_ack_from_child;
int aof_pipe_write_ack_to_child;
int aof_pipe_read_ack_from_parent;
int aof_stop_sending_diff; /*If true stop sending accumulated diffs to child process. */
sds aof_child_diff;        /* AOF diff accumulator child side. */
```

## 实现原理

aofrewrite 的入口逻辑在 `rewriteAppendOnlyFileBackground` 函数。

```c
int rewriteAppendOnlyFileBackground(void) {
    ...
    if (server.aof_child_pid != -1 || server.rdb_child_pid != -1) return C_ERR;
    ...
}
```

要确保没有后台进程做 aofrewrite 或者 rdb，才会考虑做本次的 aofrewrite。

### pipe 初始化

```c
int rewriteAppendOnlyFileBackground(void) {
   ...
   if (aofCreatePipes() != C_OK) return C_ERR;
   ...
}
```

```c
int aofCreatePipes(void) {
    int fds[6] = {-1, -1, -1, -1, -1, -1};
    int j;

    if (pipe(fds) == -1) goto error; /* parent -> children data. */
    if (pipe(fds+2) == -1) goto error; /* children -> parent ack. */
    if (pipe(fds+4) == -1) goto error; /* children -> parent ack. */
    /* Parent -> children data is non blocking. */
    if (anetNonBlock(NULL,fds[0]) != ANET_OK) goto error;
    if (anetNonBlock(NULL,fds[1]) != ANET_OK) goto error;

    /* 注册读事件处理函数，负责处理子进程要求停止数据传输的消息 */
    if (aeCreateFileEvent(server.el, fds[2], AE_READABLE, aofChildPipeReadable, NULL) == AE_ERR) goto error;

    server.aof_pipe_write_data_to_child = fds[1];
    server.aof_pipe_read_data_from_parent = fds[0];
    server.aof_pipe_write_ack_to_parent = fds[3];
    server.aof_pipe_read_ack_from_child = fds[2];
    server.aof_pipe_write_ack_to_child = fds[5];
    server.aof_pipe_read_ack_from_parent = fds[4];
    server.aof_stop_sending_diff = 0; /* 是否停止管道传输标记位 */
    return C_OK;

error:
    serverLog(LL_WARNING,"Error opening /setting AOF rewrite IPC pipes: %s",
        strerror(errno));
    for (j = 0; j < 6; j++) if(fds[j] != -1) close(fds[j]);
    return C_ERR;
}
```

在 `aofCreatePipes` 函数中，对 pipe 进行初始化，pipe 各变量的用处从名字也可以看出来，一共有三条 pipe，每条 pipe 一来一回，占用两个 fd。

pipe 1 用于父进程向子进程发送缓存的新数据。子进程在 aofrewrite 时，会定期从该管道中读取数据并缓存起来，并在最后将缓存的数据写入重写的新 AOF 文件，这两个 fd 都设置为非阻塞式的。

pipe 2 负责子进程向父进程发送结束信号。父进程监听 **fds[2]** 读事件，回调函数为 **aofChildPipeReadable**。父进程不断地接收客户端命令，但是子进程不可能无休止地等待父进程的数据，因此，子进程在遍历完数据库所有数据之后，从 pipe 1 中执行一段时间的读取操作后，就会向 pipe 2 中发送一个特殊标记 "**!**"，父进程收到子进程的 "**!**" 后，就会置 **server.aof_stop_sending_diff**  为 1，表示不再向父进程发送缓存数据了。

pipe 3 负责父进程向子进程发送应答信号。父进程收到子进程的 "**!**" 后，会通过该管道也向子进程应答一个 "**!**"，表示已收到了停止信号。

详细过程后面会细说。

### 父进程处理逻辑

#### rewriteAppendOnlyFileBackground 函数

接着上面的逻辑，server  `fork` 出一个子进程，两个进程分别做各有不同的处理，下面先看父进程的一些主要处理（代码有删减）。

```c
int rewriteAppendOnlyFileBackground(void) {
    ...
    if ((childpid = fork()) == 0) {
        ... ...
    } else {
        server.aof_rewrite_scheduled = 0;
        server.aof_child_pid = childpid;
        updateDictResizePolicy();
        server.aof_selected_db = -1;
        replicationScriptCacheFlush();
        return C_OK;
    }
    ...
}
```

**server.aof_rewrite_scheduled** 置零，防止在 `serverCron` 函数中重复触发 aofrewrite，这时因为 `serverCron` 中有如下逻辑，

```c
int rewriteAppendOnlyFileBackground(void) {
    ...
    if (server.rdb_child_pid == -1 && server.aof_child_pid == -1 &&
        server.aof_rewrite_scheduled)
    {
        rewriteAppendOnlyFileBackground();
    }
    ...
}
```

这里，`updateDictResizePolicy` 函数所做的操作是很重要的，如下，

```c
void updateDictResizePolicy(void) {
    if (server.rdb_child_pid == -1 && server.aof_child_pid == -1)
        dictEnableResize();
    else
        dictDisableResize();
}
```

也就是说，在后台有子进程做 aofrewrite 或 rdb 时，就不要做 dict rehash 了。现在大多数操作系统都采用**写时复制（copy-on-write）来优化子进程的使用效率**，所以在子进程存在期间，应该避免不必要的内存写入，否则会引起大量的内存 copy，影响性能。COW 的知识可以参考文档 《[Copy On Write机制了解一下](https://juejin.im/post/5bd96bcaf265da396b72f855)》。

另外，**server.aof_selected_db** 置为 -1，是为了在子进程进行数据库扫描时插入 select 命令，以便选择正确的数据库。

####aofRewriteBufferAppend 函数

在上一篇博客中说过，在 `feedAppendOnlyFile` 函数 append 写命令时，如果当前有子进程在做 aofrewrite 时，需要将写命令写到 **server.aof_rewrite_buf_blocks** 中一份。该变量是一个链表，其中每个节点最大10MB。

```c
void feedAppendOnlyFile(struct redisCommand *cmd, int dictid, robj **argv, int argc) {
    ...
    if (server.aof_child_pid != -1)
        aofRewriteBufferAppend((unsigned char*)buf,sdslen(buf));
}
```

```c
void aofRewriteBufferAppend(unsigned char *s, unsigned long len) {
    ... ...
    /* Install a file event to send data to the rewrite child if there is
     * not one already. */
    if (aeGetFileEvents(server.el,server.aof_pipe_write_data_to_child) == 0) {
        aeCreateFileEvent(server.el, server.aof_pipe_write_data_to_child,
            AE_WRITABLE, aofChildWriteDiffData, NULL);
    }
}
```

为 **server.aof_pipe_write_data_to_child** 注册写事件，回调函数为 `aofChildWriteDiffData`。

```c
void aofChildWriteDiffData(aeEventLoop *el, int fd, void *privdata, int mask) {
    listNode *ln;
    aofrwblock *block;
    ssize_t nwritten;
    UNUSED(el);
    UNUSED(fd);
    UNUSED(privdata);
    UNUSED(mask);

    while(1) {
        ln = listFirst(server.aof_rewrite_buf_blocks);
        block = ln ? ln->value : NULL;
        if (server.aof_stop_sending_diff || !block) {
            aeDeleteFileEvent(server.el,server.aof_pipe_write_data_to_child,
                              AE_WRITABLE);
            return;
        }
        if (block->used > 0) {
            nwritten = write(server.aof_pipe_write_data_to_child,
                             block->buf,block->used);
            if (nwritten <= 0) return;
            memmove(block->buf,block->buf+nwritten,block->used-nwritten);
            block->used -= nwritten;
        }
        if (block->used == 0) listDelNode(server.aof_rewrite_buf_blocks,ln);
    }
}
```

当子进程告诉父进程不要发数据（**server.aof_stop_sending_diff = 1**）或者 **server.aof_rewrite_buf_blocks** 为空时，删除写事件。

否则，往 pipe1 中写入数据，然后写入的数据从 **server.aof_rewrite_buf_blocks** 删掉。

### 子进程处理逻辑

```c
int rewriteAppendOnlyFileBackground(void) {
    ...
    char tmpfile[256];
    closeListeningSockets(0);               /* child 关闭不必要的 socket */
    redisSetProcTitle("redis-aof-rewrite"); /* 修改进程名为 redis-aof-rewrite */
    snprintf(tmpfile,256,"temp-rewriteaof-bg-%d.aof", (int) getpid());
    ...
}
```

首先做一些必要的处理，临时 AOF 文件名为 **temp-rewriteaof-bg-%d.aof**。

然后进入正式的处理函数 `rewriteAppendOnlyFile`，以下贴上主要代码（有删减）。

```c
int rewriteAppendOnlyFile(char *filename) {
    ...
    snprintf(tmpfile,256,"temp-rewriteaof-%d.aof", (int) getpid());
    fp = fopen(tmpfile,"w");
    server.aof_child_diff = sdsempty(); /* 初始化 aof_child_diff */
    ...
}
```

**aof_child_diff**  变量中存放在 aofwrite 期间，子进程接收到父进程通过 pipe 传过来的缓存数据。

然后就是扫描数据库的操作。

```c
int rewriteAppendOnlyFile(char *filename) {
    ...
    rio aof;
    for (j = 0; j < server.dbnum; j++) {
        redisDb *db = server.db+j;
        dict *d = db->dict;
        if (dictSize(d) == 0) continue; // skip empty database
        di = dictGetSafeIterator(d);
        while((de = dictNext(di)) != NULL) {
            ... ...
            if (aof.processed_bytes > processed+1024*10) { // 10K
                processed = aof.processed_bytes;
                aofReadDiffFromParent();
            }
        }
        dictReleaseIterator(di);
        di = NULL;
    }
    if (fflush(fp) == EOF) goto werr;
    if (fsync(fileno(fp)) == -1) goto werr;
    ...
}
```

以上逻辑里，子进程会挨个 db 扫描每一个 key，根据 key 的类型使用不同的函数进行数据重写，带过期时间的数据，都需要 append 一个 **PEXPIREAT** 命令。

有一点需要注意，前面说到利用 pipe 优化 aofwrite，可以看到上面的逻辑，每遍历一个 db，如果 rio 写入的数据量超过了 **10K**，那么就通过 pipe 从父进程读一次数据，将数据累加到 **server.aof_child_diff**。

```c
ssize_t aofReadDiffFromParent(void) {
    char buf[65536]; /* Default pipe buffer size on most Linux systems. */
    ssize_t nread, total = 0;

    while ((nread = read(server.aof_pipe_read_data_from_parent,buf,sizeof(buf))) > 0) {
        server.aof_child_diff = sdscatlen(server.aof_child_diff,buf,nread);
        total += nread;
    }
    return total;
}
```

因为，有客户端可能不断有流量打到父进程，子进程不可能一直等父进程，所以要有一个结束的时刻， Redis 中做了如下决定。

```c
int rewriteAppendOnlyFile(char *filename) {
    ...
    int nodata = 0;
    mstime_t start = mstime();
    while(mstime()-start < 1000 && nodata < 20) {
        /* 在1ms之内，查看从父进程读数据的 fd 是否变成可读的，若不可读则aeWait()函数返回0 */
        if (aeWait(server.aof_pipe_read_data_from_parent, AE_READABLE, 1) <= 0)
        {
            nodata++;
            continue;
        }
        // 当管道的读端可读时，清零nodata
        nodata = 0;
        aofReadDiffFromParent();
    }
    ...
}
```

1ms 超时等待父进程从 pipe 传来数据，如果在 1ms 内有 20 次父进程没传来数据，那么就放弃 **ReadDiffFromParent**。由于 **server.aof_pipe_read_data_from_parent** 在初始化时设置为非阻塞，因此 `aeWait` 调用返回很快。

```c
if (write(server.aof_pipe_write_ack_to_parent,"!",1) != 1) goto werr;
```

接着通过 pipe2 告诉父进程（发特殊符号 ！）不要再发来缓存数据了。

还记得前面初始化时，父进程一直在监听 **server.aof_pipe_read_ack_from_child** 的可读事件吧？当收到 “**!**” 后，父进程调用处理函数 `aofChildPipeReadable`。

```c
void aofChildPipeReadable(aeEventLoop *el, int fd, void *privdata, int mask) {
    char byte;
    if (read(fd,&byte,1) == 1 && byte == '!') {
        serverLog(LL_NOTICE,"AOF rewrite child asks to stop sending diffs.");
        server.aof_stop_sending_diff = 1;
        if (write(server.aof_pipe_write_ack_to_child,"!",1) != 1) {
            serverLog(LL_WARNING,"Can't send ACK to AOF child: %s",
                strerror(errno));
        }
    }
    /* Remove the handler since this can be called only one time during a
     * rewrite. */
    aeDeleteFileEvent(server.el,server.aof_pipe_read_ack_from_child,AE_READABLE);
}
```

可以看到  `server.aof_stop_sending_diff` 置为 1，表示不再给子进程发送缓存数据，接着删除 **server.aof_pipe_read_ack_from_child** 上可读事件，给子进程回复一个 “**!**”。

现在回来看子进程的行为。

```c
int rewriteAppendOnlyFile(char *filename) {
    ...
    if (syncRead(server.aof_pipe_read_ack_from_parent,&byte,1,5000) != 1 || byte != '!')
        goto werr;
    ...
}
```

子进程阻塞 5s 等待父进程发来确认标记 **“!”**，之后就开始做自己的收尾工作，如下：

```c
int rewriteAppendOnlyFile(char *filename) {
    ...
    aofReadDiffFromParent(); /* 最后一次从父进程累计写入的缓冲区的差异 */

    /* 将子进程aof_child_diff 中保存的差异数据写到 AOF 文件中 */
    if (rioWrite(&aof,server.aof_child_diff,sdslen(server.aof_child_diff)) == 0)
        goto werr;

    /* Make sure data will not remain on the OS's output buffers */
    if (fflush(fp) == EOF) goto werr;
    if (fsync(fileno(fp)) == -1) goto werr;
    if (fclose(fp) == EOF) goto werr;

    /* 原子性修改临时文件的名字为 temp-rewriteaof-bg-<pid>.aof */
    if (rename(tmpfile,filename) == -1) {
        unlink(tmpfile);
        return C_ERR;
    }
    ...
}
```

最后再读取一次 pipe 中的数据，将子进程进行 aofrewrite 期间，**aof_child_diff** 从父进程累积的数据刷盘，最后进行 `rename` 系统调用。

经过以上的逻辑处理，server 交给子进程的 aofrewrite 工作就完成了，最终得到一个文件 **temp-rewriteaof-bg-<pid>.aof**，成功返回 0，否则返回1。

### 父进程的收尾工作

子进程在执行完 aofrewrite 后退出，父进程 `wait3` 到子进程的退出状态后，进行 aofrewrite 的收尾工作。在 `serverCron` 函数里，有如下逻辑，

```c
int serverCron(struct aeEventLoop *eventLoop, long long id, void *clientData) {
    ...
    if ((pid = wait3(&statloc,WNOHANG,NULL)) != 0) { /* wait3 等待所有子进程 */
        int exitcode = WEXITSTATUS(statloc);
        int bysignal = 0;

        if (WIFSIGNALED(statloc)) bysignal = WTERMSIG(statloc);

        if (pid == -1) {
            serverLog(LL_WARNING,"wait3() returned an error: %s. "
                      "rdb_child_pid = %d, aof_child_pid = %d",
                      strerror(errno),
                      (int) server.rdb_child_pid,
                      (int) server.aof_child_pid);
        } else if (pid == server.rdb_child_pid) {
            backgroundSaveDoneHandler(exitcode,bysignal);
        } else if (pid == server.aof_child_pid) { /* aof 子进程结束 */
            backgroundRewriteDoneHandler(exitcode,bysignal);
        } else {
            if (!ldbRemoveChild(pid)) {
                serverLog(LL_WARNING,
                          "Warning, detected child with unmatched pid: %ld",
                          (long)pid);
            }
        }
        updateDictResizePolicy(); /* 更新 dict resize 为可用状态 */
    }
    ...
}
```

`wait3` 函数表示父进程等待所有子进程的返回值， **WNOHANG** 选项表示没有子进程 exit 时立即返回，man 中对该选项有如下说明， ”**WNOHANG     return immediately if no child has exited**“。

可以看到如果等到 aofwrite 的子进程 exit，那么使用 `backgroundRewriteDoneHandler` 函数进行处理，主要如下（代码有删减），

```c
void backgroundRewriteDoneHandler(int exitcode, int bysignal) {
    ...
    snprintf(tmpfile,256,"temp-rewriteaof-bg-%d.aof", (int)server.aof_child_pid);
    newfd = open(tmpfile,O_WRONLY|O_APPEND);
    if (aofRewriteBufferWrite(newfd) == -1) {
        close(newfd);
        goto cleanup;
    }
    ...
}
```

打开子进程生成的临时文件 **temp-rewriteaof-bg-<pid>.aof**，调用 `aofRewriteBufferWrite`，将服务器缓存的剩下的新数据写入该临时文件中，这样该 AOF 临时文件就完全与当前数据库状态一致了。

那么，下面还有两件事要做，一是将临时 AOF 文件改名，二是切换 fd。

```c
void backgroundRewriteDoneHandler(int exitcode, int bysignal) {
    ...
    if (server.aof_fd == -1) {
        /* AOF disabled */
        oldfd = open(server.aof_filename,O_RDONLY|O_NONBLOCK);
    } else {
        /* AOF enabled */
        oldfd = -1; /* We'll set this to the current AOF filedes later. */
    }
    if (rename(tmpfile,server.aof_filename) == -1) {
        close(newfd);
        if (oldfd != -1) close(oldfd);
        goto cleanup;
    }

    if (server.aof_fd == -1) {
        /* AOF disabled, we don't need to set the AOF file descriptor
         * to this new file, so we can close it. */
        close(newfd);
    } else {
        /* AOF enabled, replace the old fd with the new one. */
        oldfd = server.aof_fd;
        server.aof_fd = newfd;
        if (server.aof_fsync == AOF_FSYNC_ALWAYS)
            aof_fsync(newfd);
        else if (server.aof_fsync == AOF_FSYNC_EVERYSEC)
            aof_background_fsync(newfd);
        server.aof_selected_db = -1; /* Make sure SELECT is re-issued */
        aofUpdateCurrentSize();
        server.aof_rewrite_base_size = server.aof_current_size;

        /* Clear regular AOF buffer since its contents was just written to
         * the new AOF from the background rewrite buffer. */
        sdsfree(server.aof_buf);
        server.aof_buf = sdsempty();
    }
    ...  ...
    /* Asynchronously close the overwritten AOF. */
    if (oldfd != -1) bioCreateBackgroundJob(BIO_CLOSE_FILE,(void*)(long)oldfd,NULL,NULL);
    ...
}
```

如上，首先将临时 AOF 文件改名，然后就是 oldfd 和 newfd 的处理了，分**两种情况**：

当 AOF 功能关闭时，打开原来的 AOF 文件，获得 oldfd，这里并不关心该操作是否是成功的，如果失败了，那么 oldfd 值为 -1，`close(newfd)`。

当 AOF 功能开启时，oldfd 直接置为 -1，将 **aof_fd** 切换成 newfd，根据不同的数据刷盘策略进行 AOF 刷盘，更新相应的参数。

然后是关闭 oldfd 的逻辑，由于 oldfd 可能是对旧 AOF 文件的最后一个引用，直接 `close` 可能会阻塞 server，因此创建后台任务去关闭文件。

最后进行清理工作，如下，

```c
void backgroundRewriteDoneHandler(int exitcode, int bysignal) {
    ...
    cleanup:
        aofClosePipes();
        aofRewriteBufferReset();
        aofRemoveTempFile(server.aof_child_pid);
        server.aof_child_pid = -1;
        server.aof_rewrite_time_last = time(NULL)-server.aof_rewrite_time_start;
        server.aof_rewrite_time_start = -1;
        /* Schedule a new rewrite if we are waiting for it to switch the AOF ON. */
        if (server.aof_state == AOF_WAIT_REWRITE)
            server.aof_rewrite_scheduled = 1;
    ...
}
```

以上， 父进程就完成了收尾工作，写命令就 `write` 到 newfd 了。

### 时序图

可以将以上父子进程的交互整理出时序图如下，

![](http://ww1.sinaimg.cn/large/71ca8e3cly1fznp1jin66j20kk0jh77k.jpg)

上图参考 [Redis · 原理介绍 · 利用管道优化aofrewrite](http://mysql.taobao.org/monthly/2018/12/06/)

## 何时重写

有两个时刻可以触发 AOF 重写。

【1】手动执行 `BGREWRITEAOF` 命令。

【2】自动执行，在 `serverCron` 函数中根据一定逻辑进行判定。

```c
int serverCron(struct aeEventLoop *eventLoop, long long id, void *clientData) {
    ...
          /* Trigger an AOF rewrite if needed */
    if (server.rdb_child_pid == -1 && server.aof_child_pid == -1 &&
        server.aof_rewrite_perc &&
        server.aof_current_size > server.aof_rewrite_min_size) /* 默认 64M */
    {
        long long base = server.aof_rewrite_base_size ? server.aof_rewrite_base_size : 1;
        long long growth = (server.aof_current_size*100/base) - 100;
        if (growth >= server.aof_rewrite_perc) {
            rewriteAppendOnlyFileBackground();
        }
     }
}
```

也就是说 AOF 文件大小超过了 **server.aof_rewrite_min_size**，并且增长率大于 **server.aof_rewrite_perc** 时就会触发，增长率计算的基数 **server.aof_rewrite_base_size** 是上次 aofrewrite 结束后 AOF 文件的大小。

## 附录

几个解释。

> **阻塞模式**下，进程或是线程执行到这些函数时必须等待某个事件的发生，如果事件没有发生，进程或线程就被阻塞(死等在被阻塞的地方)，函数不会立即返回。
>
> **非阻塞non-block模式**下，进程或线程执行此函数时不必非要等待事件的发生，一旦执行肯定返回，以返回值的不同来反映函数的执行情况，如果事件发生则与阻塞方式相同，若事件没有发生则返回一个代码来告知事件未发生，而进程或线程继续执行，所以非阻塞模式效率较高。
