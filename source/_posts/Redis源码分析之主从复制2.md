---
title: Redis 源码之主从复制(2)
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: 8f9133db
date: 2019-09-05 00:19:55
---
repl backlog 是一个由 master 维护的固定长度的环形 buffer，默认大小 **1M**，在配置文件中可以通过 **repl-backlog-size** 项进行配置。可以把它看成一个 FIFO 的队列，当队列中元素过多时，最早进入队列的元素被弹出（数据被覆盖）。它为了解决上一篇博客中提到的旧版本主从复制存在的问题而存在的。

<!--more---->

与之相关的，在 `redisServer` 中涉及到很多以 **repl** 为前缀的变量，这个只列举几个，

```c
// 所有 slave 共享一份 backlog, 只针对部分复制
char *repl_backlog;

// backlog 环形 buffer 的长度
long long repl_backlog_size;

// backlog 中有效数据大小, 开始时 <repl_backlog_size，但 buffer 满后一直 =repl_backlog_size
long long repl_backlog_histlen;

// backlog 中的最新数据末尾位置(从这里写数据到 backlog)
long long repl_backlog_idx;

// 最老数据首字节位置，全局范围内（而非积压队列内）的偏移量(从这里读 backlog 数据)
long long repl_backlog_off;
```

### 创建 backlog

```c
void syncCommand(client *c) {
  	// ...
  	if (listLength(server.slaves) == 1 && server.repl_backlog == NULL)
        createReplicationBacklog();
    return;
}
```

可以看到，在 **SYNC** 和 **PSYNC** 命令的实现函数 `syncCommand` 末尾，只有当实例只有一个 slave，且 repl_backlog 为空时，会调用 `createReplicationBacklog` 函数去创建 backlog。这也是为了避免不必要的内存浪费。

```c
void createReplicationBacklog(void) {
    serverAssert(server.repl_backlog == NULL);
    // 默认大小为 1M
    server.repl_backlog = zmalloc(server.repl_backlog_size);
    server.repl_backlog_histlen = 0;
    server.repl_backlog_idx = 0;

    // 确保之前使用过 backlog 的 slave 引发错误的 PSYNC 操作
    server.master_repl_offset++;

    // 尽管没有数据
    // 但事实上，第一个字节的逻辑位置是 master_repl_offset 的下一个字节
    server.repl_backlog_off = server.master_repl_offset+1;
}
```

### 写数据到 backlog

将数据放入 repl backlog 是通过 **feedReplicationBacklog** 函数实现的。

```c
void feedReplicationBacklog(void *ptr, size_t len) {
    unsigned char *p = ptr;

    // 全局复制偏移量更新
    server.master_repl_offset += len;

    // 环形 buffer ，每次写尽可能多的数据，并在到达尾部时将 idx 重置到头部
    while(len) {
        // repl_backlog 剩余长度
        size_t thislen = server.repl_backlog_size - server.repl_backlog_idx;
        if (thislen > len) thislen = len;

        // 从 repl_backlog_idx 开始，copy thislen 的数据
        memcpy(server.repl_backlog+server.repl_backlog_idx,p,thislen);

        // 更新 idx ，指向新写入的数据之后
        server.repl_backlog_idx += thislen;

        // 如果 repl_backlog 写满了，则环绕回去从 0 开始
        if (server.repl_backlog_idx == server.repl_backlog_size)
            server.repl_backlog_idx = 0;
        len -= thislen;
        p += thislen;

        // 更新 repl_backlog_histlen
        server.repl_backlog_histlen += thislen;
    }
    // repl_backlog_histlen 不可能超过 repl_backlog_size，因为之后环形写入时会覆盖开头位置的数据
    if (server.repl_backlog_histlen > server.repl_backlog_size)
        server.repl_backlog_histlen = server.repl_backlog_size;

    server.repl_backlog_off = server.master_repl_offset -
                              server.repl_backlog_histlen + 1;
}
```

以上函数中许多关键变量的更新逻辑比较抽象，下面画个图以辅助理解。![n8Qbyd.jpg](https://s2.ax1x.com/2019/09/08/n8Qbyd.jpg)

master_repl_offset 为全局复制偏移量，它的初始值是随机的，假设等于 2。

在一个空的 repl_backlog 中插入 **abcdef** 时，各变量做如下更新：
master_repl_offset = 2 + 6 = 8
repl_backlog_idx = 0 + 6 = 6 ≠ 10
repl_backlog_histlen = 0 + 6 = 6 < 10
repl_backlog_off = 8 - 6 + 1 = 3 （**最老数据 a 在全局范围内的 offset 为 3**）


接着，插入数据 **ghijkl**，从上图可以看出， repl_backlog  满了，因此前面有 2 个数据被覆盖了。各变量做如下更新：
master_repl_offset = 8 + 6 = 14
repl_backlog_idx = 6 + 4 = 10 → 0 + 2 = 2 (分两步)
repl_backlog_histlen = 6 + 4 = 10 → 10 + 2 = 12 > 10 → 10
repl_backlog_off = 14 - 10 + 1 = 5 （**最老的数据 c 在全局范围内的偏离量为 5**）


接着，插入数据 **mno**，各变量做如下更新,
master_repl_offset = 14 + 3 = 17
repl_backlog_idx = 2 + 3 = 5
repl_backlog_histlen = 10 + 3 = 13 > 10 → 10
repl_backlog_off = 17 - 10 + 1 = 8 （**最老的数据 f 在全局范围内的偏离量为 8**）


### 从 backlog 读数据

当 slave 连上 master 后，会通过 PSYNC 命令将自己的复制偏移量发送给 master，格式为 `PSYNC <psync_runid> <psync_offset>`。当首次建立连接时，psync_runid 值为 **?**，psync_offset 值为 **-1**。这部分的实现逻辑在 `slaveTryPartialResynchronization` 函数，下一篇博客会有详解。

master 根据收到的 psync_offset 值来判断是进行**部分重同步**还是**完全重同步**，以下只看部分重同步的逻辑，完整逻辑在后面的博客中分析。

```c
int masterTryPartialResynchronization(client *c) {
		// ...
  	if (getLongLongFromObjectOrReply(c,c->argv[2],&psync_offset,NULL) !=
       C_OK) goto need_full_resync;
    psync_len = addReplyReplicationBacklog(c,psync_offset);
  	// ...
}
```

读取 backlog 数据的逻辑在 `addReplyReplicationBacklog` 函数中实现。

```c
long long addReplyReplicationBacklog(client *c, long long offset) {
  	// ....
  	if (server.repl_backlog_histlen == 0) {
        serverLog(LL_DEBUG, "[PSYNC] Backlog history len is zero");
        return 0;
    }
    // ...
  	// 计算需要跳过的数据长度
    skip = offset - server.repl_backlog_off;

    //  将 j 指向 backlog 中最老的数据（在 backlog 中的位置）
    j = (server.repl_backlog_idx +
        (server.repl_backlog_size-server.repl_backlog_histlen)) %
        server.repl_backlog_size;

    // 加上要跳过的 offset
  	j = (j + skip) % server.repl_backlog_size;
    // 要发送数据的总长度
  	len = server.repl_backlog_histlen - skip;
    serverLog(LL_DEBUG, "[PSYNC] Reply total length: %lld", len);
    while(len) {
        long long thislen =
            ((server.repl_backlog_size - j) < len) ?
            (server.repl_backlog_size - j) : len;

        serverLog(LL_DEBUG, "[PSYNC] addReply() length: %lld", thislen);
        // 从 backlog 的 j 这个位置开始发送数据
        addReplySds(c,sdsnewlen(server.repl_backlog + j, thislen));
        len -= thislen;
        // j 切换到 0 (有可能数据还没发送完)
        j = 0;
    }
    return server.repl_backlog_histlen - skip;
}
```

不好理解的是从 backlog 中的哪里开始发送数据给 slave，上面代码中有两处计算逻辑，我认为主要是第一处，可以分情况进行拆解。
1）当 backlog 中有效数据充满了整个 backlog 时，即 backlog 被完全利用，计算退化成
`j = server.repl_backlog_idx % server.repl_backlog_size`，由于 repl_backlog_idx 不可能大于server.repl_backlog_size，所以计算结果就等于 **server.repl_backlog_idx**，它是读写数据的分割点。
2）当 backlog 中尚有未使用的空间时，repl_backlog_idx 等于 server.repl_backlog_histlen，计算退化成 `server.repl_backlog_size % server.repl_backlog_size = 0`。
我觉得这部分逻辑完全可以简化点，不然还真不好理解。然后，后面就是加上 skip offset 的计算。

另外，发送数据时需要注意，上面所说的第 1）种情况下，idx 在 backlog 中间，分两次发送，即

![n8wK1I.jpg](https://s2.ax1x.com/2019/09/08/n8wK1I.jpg)

这时，会在 master 上看到日志如下日志，
**Partial resynchronization request from xxx accepted. Sending xxx bytes of backlog starting from offset xxx.**
