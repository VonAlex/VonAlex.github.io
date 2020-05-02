---
title: Redis 源码之主从复制(1)
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: a4bc6018
date: 2019-09-03 00:43:41
---
在分布式系统中，为了解决单点问题，通常会把数据集复制多个副本部署到其他机器，以满足故障恢复和负载均衡等需求。redis 为我们提供的复制功能，实现了相同数据的多个副本，这也是其实现 HA 的基础。

<!--more---->

参与 redis 复制功能的节点被分成两个角色，主节点（**master**）和从节点（**slave**），复制的数据流是单向的，即 **master → slave**。
默认情况下，每个 redis 实例都是 master，mater 与 slave 的关系为 **1:n**（也可以没有 slave），但一个 slave 只能有一个 master。

redis 的复制功能涉及同步（**sync**）和命令传播（**command propagate**）两个阶段。
**同步**阶段用于将 slave 的数据库状态更新至 master 当前所处的数据库状态，即追数据阶段；
**命令传播**阶段则用于当 master 数据库状态改变，导致主从节点数据库状态不一致时，使之重新回到一致状态。

### 同步阶段

在 **2.8** 版本以前，slave 对 master 的同步，是通过 slave 向 master 发送 **SYNC** 命令完成的。

1）slave 向 master 发送 **SYNC**；
2）master 收到 SYNC 后，执行 **BGSAVE** 命令，生成包含当前数据库状态的 RDB 文件，同时自身使用一个 buffer 记录从现在开始执行的所有改变其数据库状态的命令，RDB 生成完毕后将其发送给 slave；
3）slave 收到 RDB 文件后，载入数据，将自己的数据库状态更新至 master 执行 BGSAYE 时的状态；
4）master 将 buffer 累积的命令发给 slave；
5）slave 解析 master 发来的命令并执行，将数据追至与 master 当前所处的状态一致。

如果以上任一一步因为网络或者其他原因而**中断**，当 slave 再次连上 master 时，master 仍然需要重新做一个 BGSAVE，而这个命令是通过 `fork` 子进程来做的，频繁执行会影响性能，且复制效率低下。

为解决以上问题，redis 从 **2.8** 版本开始，引入新的同步命令 **PSYNC** 以支持断点续传。
要支持断点续传，就需要记录上次同步的位置，借助了以下三个变量：

1）master/slave 的复制偏移量(replication offset)；
2）master 的复制积压缓冲区(replication backlog)；
3）服务器的运行 ID(run ID)。

具体细节可以参考《**redis 设计与实现**》这本书的第 15 章。

### 命令传播阶段

在 `redisServer` 结构体中有一个 `dirty` 变量记录了自上一次成功执行 save 或者 bgsave 之后，数据库状态改变的次数。通过比较执行命令前后 的 `dirty` 值，就可以知道当前命令执行后数据库状态是否发生了改变，只有改变了才需要做 **command propagate**。

```c
void call(client *c, int flags) {
		...
    dirty = server.dirty;
    start = ustime();
    c->cmd->proc(c);
    duration = ustime()-start;
    dirty = server.dirty-dirty;
    if (dirty < 0) dirty = 0;
    ...
    if (dirty) propagate_flags |= (PROPAGATE_AOF|PROPAGATE_REPL);
    ...
    if (propagate_flags != PROPAGATE_NONE)
      	propagate(c->cmd,c->db->id,c->argv,c->argc,propagate_flags);
    ...
}

void propagate(struct redisCommand *cmd, int dbid, robj **argv, int argc,
               int flags)
{
    if (server.aof_state != AOF_OFF && flags & PROPAGATE_AOF)
        feedAppendOnlyFile(cmd,dbid,argv,argc);
    if (flags & PROPAGATE_REPL)
        replicationFeedSlaves(server.slaves,dbid,argv,argc);
}
```

对于主从复制的命令传播，在 `replicationFeedSlaves` 函数中实现。

```c
void replicationFeedSlaves(list *slaves, int dictid, robj **argv, int argc) {
    listNode *ln;
    listIter li;
    int j, len;
    char llstr[LONG_STR_SIZE];

    // 如果 backlog buffer 为空，且没有 slave，直接返回
    if (server.repl_backlog == NULL && listLength(slaves) == 0) return;
    serverAssert(!(listLength(slaves) != 0 && server.repl_backlog == NULL));

    // 如果 dictid 与上一次 repl 选择的不一致，需要插入一条 select 命令
    if (server.slaveseldb != dictid) {
        robj *selectcmd;
        ......
    }
    server.slaveseldb = dictid;

    // 将命令以 redis 协议的格式写入 replication backlog
    if (server.repl_backlog) {
        char aux[LONG_STR_SIZE+3];

        /* Add the multi bulk reply length. */
        aux[0] = '*';
        len = ll2string(aux+1,sizeof(aux)-1,argc);
        aux[len+1] = '\r';
        aux[len+2] = '\n';
        feedReplicationBacklog(aux,len+3);

        for (j = 0; j < argc; j++) {
            // $..CRLF
            long objlen = stringObjectLen(argv[j]);
            aux[0] = '$';
            len = ll2string(aux+1,sizeof(aux)-1,objlen);
            aux[len+1] = '\r';
            aux[len+2] = '\n';
            feedReplicationBacklog(aux,len+3);
            feedReplicationBacklogWithObject(argv[j]);
            feedReplicationBacklog(aux+len+1,2); // CRLF
        }
    }

    /* 将命令发送给所有的 slave. */
    listRewind(server.slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = ln->value;

        /* Don't feed slaves that are still waiting for BGSAVE to start */
        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) continue;
        // 以 redis 协议的格式发送给 slave
        addReplyMultiBulkLen(slave,argc);
        for (j = 0; j < argc; j++)
            addReplyBulk(slave,argv[j]);
    }
}
```

以上便是主从同步的两个阶段，更多相关代码详解请看后面的博客分析。
