---
title: Redis源码之主从复制(4)
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: 9025979a
date: 2019-11-13 02:34:55
---
在上一篇文章，主要介绍了主从复制流程中 slave 的状态机流转，本篇文章中，将做相应的 master 逻辑的相关分析。

<!--more---->

## 主从建链与握手阶段

> slave 在向 master 发起 TCP 建链，以及复制握手过程中，master 一直把 slave 当成一个普通的 client 来处理。也就是说，不为 slave 保存状态，只是收到 slave 发来的命令进而处理并回复而已。

### PING 命令处理

握手过程中，首先 slave 会发过来一个 PING 命令，master 使用 **pingCommand** 函数来进行处理。回复字符串 **+PONG**，还是权限错误，视情况而定。

### AUTH 命令处理

可能会有一个鉴权过程，master 收到 slave 发来 AUTH 命令，使用 **authCommand** 函数进行处理，代码大概如下，

```c
void authCommand(client *c) {
    if (!server.requirepass) { // 未设置 auth passwd
        addReplyError(c,"Client sent AUTH, but no password is set");
    } else if (!time_independent_strcmp(c->argv[1]->ptr, server.requirepass)) {
      c->authenticated = 1;
      addReply(c,shared.ok);
    } else {
      c->authenticated = 0;
      addReplyError(c,"invalid password");
    }
}
```

client 的 **authenticated** 属性表明 server 是否设置了鉴权。

### REPLCONF 命令处理

接下来就是 REPLCONF 命令，相应处理函数为 **replconfCommand**，用于保存 slave 告知的端口号、地址和能力等。该函数代码逻辑基本如下，

首先进行必要的参数校验，命令格式为 `REPLCONF <option> <value> <option> <value> ...`，可以看出，后面的参数值是成对出现的，加上 REPLCONF 本身，参数个数肯定是奇数个，那么偶数个就肯定是有问题的。

```c
if ((c->argc % 2) == 0) {
    /* Number of arguments must be odd to make sure that every
     * option has a corresponding value. */
    addReply(c,shared.syntaxerr);
    return;
}
```

接着，匹配到各选项分别处理，目前支持的选项有 listening-port、ip-address、capa、ack 和 getack，不支持的选项在报错后会返回，代码处理如下，

```c
for (j = 1; j < c->argc; j+=2) {
    if (!strcasecmp(c->argv[j]->ptr,"listening-port")) {
        long port;

        if ((getLongFromObjectOrReply(c,c->argv[j+1],
                &port,NULL) != C_OK))
            return;
        c->slave_listening_port = port;
    } else if (!strcasecmp(c->argv[j]->ptr,"ip-address")) {
        sds ip = c->argv[j+1]->ptr;
        if (sdslen(ip) < sizeof(c->slave_ip)) {
            memcpy(c->slave_ip,ip,sdslen(ip)+1);
        } else {
            addReplyErrorFormat(c,"REPLCONF ip-address provided by "
                "slave instance is too long: %zd bytes", sdslen(ip));
            return;
        }
    } else if (!strcasecmp(c->argv[j]->ptr,"capa")) {
        /* Ignore capabilities not understood by this master. */
        if (!strcasecmp(c->argv[j+1]->ptr,"eof"))
            c->slave_capa |= SLAVE_CAPA_EOF;
    } else if {
        .....
    }
    } else {
        addReplyErrorFormat(c,"Unrecognized REPLCONF option: %s",
            (char*)c->argv[j]->ptr);
        return;
    }
}
```

## 主从复制阶段

接下来，slave 会向 master 发送 SYNC/PSYNC 命令，请求进行完全重同步或者部分重同步。master 为 slave 保存的状态记录在 client 的 **replstate** 属性中。

 从 master 的角度看，slave 需要经历的如下状态：**SLAVE_STATE_WAIT_BGSAVE_START** → **SLAVE_REPL_WAIT_BGSAVE_END** → **SLAVE_REPL_SEND_BULK** → **SLAVE_REPL_ONLINE**。状态转换图在前一篇文章开头画过，这里不做赘述。

### SYNC/PSYNC 命令处理

SYNC/PSYNC 命令的处理函数为 **syncCommand**。

#### 前置 check

首先，需要做一些必要的 check。

```c
/* ignore SYNC if already slave or in monitor mode */
if (c->flags & CLIENT_SLAVE) return;

// 本节点是其他节点的 slave，但是还没有同步好数据，
// 此时不能为本节点的 slave 进行数据同步(因为数据不全)
if (server.masterhost && server.repl_state != REPL_STATE_CONNECTED) {
    addReplyError(c,"Can't SYNC while not connected with my master");
    return;
}

/* 因为 master 接下来需要为该 slave 进行后台 RDB 数据转储了，
 * 同时需要将前台接收到的其他 client 命令请求缓存到该 slave client 的输出缓存中，
 * 这就需要一个完全清空的输出缓存，才能为该 slave 保存从执行 BGSAVE 开始的命令流。
 *
 * 在 master 收到 slave 发来的 SYNC(PSYNC)命令之前，两者之间的交互信息都是比较短的，
 * 因此，在网络正常的情况下，slave client 中的输出缓存应该是很容易就发送给该 slave，并清空的。
 * 所以，如果不为空，说明可能有问题 */
if (clientHasPendingReplies(c)) {
    addReplyError(c,"SYNC and PSYNC are invalid with pending output");
    return;
}
```

#### 完全重同步 or 部分重同步

下面就开始进入正题，SYNC/PSYNC 命令进行了区别对待。

```c
// slave 发来 psync 命令
if (!strcasecmp(c->argv[0]->ptr,"psync")) {
    if (masterTryPartialResynchronization(c) == C_OK) {
        server.stat_sync_partial_ok++;
        return; /* No full resync needed, return. */
    } else {
        char *master_runid = c->argv[1]->ptr;

        /* Increment stats for failed PSYNCs, but only if the
         * runid is not "?", as this is used by slaves to force a full
         * resync on purpose when they are not albe to partially
         * resync. */
        if (master_runid[0] != '?') server.stat_sync_partial_err++;
    }
// slave 发来 sync 命令
} else {
    /* If a slave uses SYNC, we are dealing with an old implementation
     * of the replication protocol (like redis-cli --slave). Flag the client
     * so that we don't expect to receive REPLCONF ACK feedbacks. */
    c->flags |= CLIENT_PRE_PSYNC; // 老版本实例
}
```

从上面代码可以看出，当需要进行**部分重同步**时，函数会直接返回，否则，开始着手处理**完全重同步**的情况，此时 master 要执行一次 rdb 。

处理 PSYNC 命令的函数是 **masterTryPartialResynchronization**，该函数通过返回值来进行区分是否进行部分重同步，`C_OK` 表示部分重同步，`C_ERR` 表示完全重同步，下面进行具体分析。

首先，把自己的 runid 与 slave 发来的 **master_runid** 相匹配，如果不匹配，说明是一个新的 slave，此时需要进行**完全重同步**，代码如下。

```c
char *master_runid = c->argv[1]->ptr;
... ...

if (strcasecmp(master_runid, server.runid)) {

    // slave 通过发送 runid 为 `？` 来触发一次完全重同步。
    if (master_runid[0] != '?') {
        serverLog(LL_NOTICE,"Partial resynchronization not accepted: "
            "Runid mismatch (Client asked for runid '%s', my runid is '%s')",
            master_runid, server.runid);
    } else {
        serverLog(LL_NOTICE,"Full resync requested by slave %s",
            replicationGetSlaveName(c));
    }
    goto need_full_resync;
}
```

然后，取出 slave 的复制偏移量 **psync_offset**，master 据此来判断是否可以进行完全重同步，关于复制偏移量的问题，前面的文章已经提过。

```c
if (getLongLongFromObjectOrReply(c,c->argv[2],&psync_offset,NULL) !=
    C_OK) goto need_full_resync;
if (!server.repl_backlog ||
    psync_offset < server.repl_backlog_off ||
    psync_offset > (server.repl_backlog_off + server.repl_backlog_histlen))
{
    serverLog(LL_NOTICE,
        "Unable to partial resync with slave %s for lack of backlog (Slave request was: %lld).", replicationGetSlaveName(c), psync_offset);
    if (psync_offset > server.master_repl_offset) {
        serverLog(LL_WARNING,
            "Warning: slave %s tried to PSYNC with an offset that is greater than the master replication offset.", replicationGetSlaveName(c));
    }
    goto need_full_resync;
}
```

以上出现的两种需要进行完全重同步的情况，都会进入 **need_full_resync** 的逻辑，最后返回 `C_ERR`。

```c
need_full_resync:
    /* We need a full resync for some reason... Note that we can't
     * reply to PSYNC right now if a full SYNC is needed. The reply
     * must include the master offset at the time the RDB file we transfer
     * is generated, so we need to delay the reply to that moment. */
    return C_ERR;
```

否则，表示需要进行部分重同步，进行相应变量的初始化，返回`C_OK`。

```c
c->flags |= CLIENT_SLAVE;
c->replstate = SLAVE_STATE_ONLINE;
c->repl_ack_time = server.unixtime;
c->repl_put_online_on_ack = 0;

listAddNodeTail(server.slaves,c);

// 这里不能用输出缓存，因为输出缓存只能用于累积命令流。
// 之前 master 向 slave 发送的信息很少，因此内核的输出缓存中应该会有空间，
// 所以，这里直接的 write 操作一般不会出错。

// 回复 slave +CONTINUE
buflen = snprintf(buf,sizeof(buf),"+CONTINUE\r\n");
if (write(c->fd,buf,buflen) != buflen) {
    freeClientAsync(c);
    return C_OK;
}
// 将积压队列中 psync_offset 之后的数据复制到客户端输出缓存中
psync_len = addReplyReplicationBacklog(c,psync_offset);

/* Note that we don't need to set the selected DB at server.slaveseldb
 * to -1 to force the master to emit SELECT, since the slave already
 * has this state from the previous connection with the master. */

// 更新当前状态正常的 slave 数量
refreshGoodSlavesCount();
return C_OK; /* The caller can return, no full resync needed. */
```

**addReplyReplicationBacklog** 函数的逻辑也已经在前面讲过。

#### 完全重同步过程

首先，一些变量的更新，将 **replstate** 更新为 **SLAVE_STATE_WAIT_BGSAVE_START** 状态。

```c
server.stat_sync_full++;

/* Setup the slave as one waiting for BGSAVE to start. The following code
    * paths will change the state if we handle the slave differently. */
c->replstate = SLAVE_STATE_WAIT_BGSAVE_START;
if (server.repl_disable_tcp_nodelay)
    anetDisableTcpNoDelay(NULL, c->fd); /* Non critical if it fails. */
c->repldbfd = -1;
c->flags |= CLIENT_SLAVE;
listAddNodeTail(server.slaves,c);
```

完全重同步时，master 需要做一次 rdb。后台 rdb 数据生成时需要做 `fork`，这对性能是有所牺牲的，所以要先看下是否有现成的 rdb 数据可以复用。分以下 3 种清理，

【1】如果后台有 rdb 任务在执行，并且使用的是**有硬盘复制**的方式（将 rdb 数据保存在本地临时文件），然后发送给 slave。

```c
/* CASE 1: BGSAVE is in progress, with disk target. */
if (server.rdb_child_pid != -1 &&
    server.rdb_child_type == RDB_CHILD_TYPE_DISK)
{
    /* Ok a background save is in progress. Let's check if it is a good
     * one for replication, i.e. if there is another slave that is
     * registering differences since the server forked to save. */
    client *slave;
    listNode *ln;
    listIter li;

    listRewind(server.slaves,&li);
    while((ln = listNext(&li))) {
        slave = ln->value;
        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_END) break;
    }

    /* To attach this slave, we check that it has at least all the
     * capabilities of the slave that triggered the current BGSAVE. */
    if (ln && ((c->slave_capa & slave->slave_capa) == slave->slave_capa)) {

        /* Perfect, the server is already registering differences for
         * another slave. Set the right state, and copy the buffer. */
        copyClientOutputBuffer(c,slave);
        replicationSetupSlaveForFullResync(c,slave->psync_initial_offset);
        serverLog(LL_NOTICE,"Waiting for end of BGSAVE for SYNC");
    } else {

        /* No way, we need to wait for the next BGSAVE in order to
         * register differences. */
        serverLog(LL_NOTICE,"Can't attach the slave to the current BGSAVE. Waiting for next BGSAVE for SYNC");
    }
}
```

代码中，在 master 所有 slave 中找到一个处于 **SLAVE_STATE_WAIT_BGSAVE_END** 状态的 slaveX。
将 slaveX 输出缓存内容 copy 一份给当前的 client，然后调用函数 **replicationSetupSlaveForFullResync**，将 client 状态设置为 **SLAVE_STATE_WAIT_BGSAVE_END**，并发送 **+FULLRESYNC** 回复，代码如下，

```c
int replicationSetupSlaveForFullResync(client *slave, long long offset) {
    char buf[128];
    int buflen;

    slave->psync_initial_offset = offset;
    slave->replstate = SLAVE_STATE_WAIT_BGSAVE_END;

    /* We are going to accumulate the incremental changes for this
     * slave as well. Set slaveseldb to -1 in order to force to re-emit
     * a SELECT statement in the replication stream. */
    server.slaveseldb = -1;

    /* Don't send this reply to slaves that approached us with
     * the old SYNC command. */
    if (!(slave->flags & CLIENT_PRE_PSYNC)) {
        buflen = snprintf(buf,sizeof(buf),"+FULLRESYNC %s %lld\r\n",
                          server.runid,offset);
        if (write(slave->fd,buf,buflen) != buflen) {
            return C_ERR;
        }
    }
    return C_OK;
}
```

这个函数主要做了以下 4 件事：

- 设置 slave 的 **psync_initial_offset** 属性，方便后面再进来的 slave，可以最大限度的复用。
- 设置 slave 的当前状态为 **WAIT_BGSAVE_END**，表明 slave 可以从这个点来累积前台发过来的命令流，并等待 rdb 转储完成。
- 设置 slave 的 **slaveseldb** 属性为 -1，这样可以在开始累积命令流时，强制增加一条 SELECT 命令到客户端输出缓存中，以免第一条命令没有选择数据库。
- 给 slave 一个 **+FULLRESYNC** 的回复。

该函数应当在以下 2 个时刻立即被调用：

- 由复制而发起的一次成功的 bgsave 之后；
- 找到了一个可以复用的 slave 之后。

如果找不到一个可以复用的 slave，那么 master 需要在当前的 bgsave 操作完成之后，再执行一次。

【2】如果后台有 rdb 任务在执行，并且使用的是**无硬盘复制**的方式。

此时，当前 slave 无法重用 rdb 数据，必须在当前的 bgsave 操作完成之后，再执行一次。代码如下，

```c
/* CASE 2: BGSAVE is in progress, with socket target. */
else if (server.rdb_child_pid != -1 &&
            server.rdb_child_type == RDB_CHILD_TYPE_SOCKET)
{
    /* There is an RDB child process but it is writing directly to
     * children sockets. We need to wait for the next BGSAVE
     * in order to synchronize. */
    serverLog(LL_NOTICE,"Current BGSAVE has socket target. Waiting for next BGSAVE for SYNC");
}
```

【3】如果后台没有 rdb 任务在执行。

若当前 slave 使用的是**无磁盘化复制**，那么暂时先不进行 bgsave，把它推迟到 **replicationCron** 函数，这是**为了等待更多的 slave，以减少执行 bgsave 的次数**，因为使用 diskless 的方式进行主从复制，后来的 slave 不能 attach 到已有 slave 上，只能重新做 bgsave。

若当前 slave 使用的是**有磁盘化复制**，调用 **startBgsaveForReplication** 函数开始一次新的 bgsave，需要注意的是这里要避开后台的 aofrewite。代码如下，

```c
/* CASE 3: There is no BGSAVE is progress. */
else {
    if (server.repl_diskless_sync && (c->slave_capa & SLAVE_CAPA_EOF)) {

        /* Diskless replication RDB child is created inside
         * replicationCron() since we want to delay its start a
         * few seconds to wait for more slaves to arrive. */
        if (server.repl_diskless_sync_delay)
            serverLog(LL_NOTICE,"Delay next BGSAVE for diskless SYNC");
    } else {

        /* Target is disk (or the slave is not capable of supporting
         * diskless replication) and we don't have a BGSAVE in progress,
         * let's start one. */
        if (server.aof_child_pid == -1) {
            startBgsaveForReplication(c->slave_capa); // 直接进行 bgsave
        } else {
            serverLog(LL_NOTICE,
                "No BGSAVE in progress, but an AOF rewrite is active. "
                "BGSAVE for replication delayed");
        }
    }
}
```

最后，如果有必要的话，创建 backlog。

```c
if (listLength(server.slaves) == 1 && server.repl_backlog == NULL)
    createReplicationBacklog();
```

```c
void createReplicationBacklog(void) {
    serverAssert(server.repl_backlog == NULL);
    server.repl_backlog = zmalloc(server.repl_backlog_size);
    server.repl_backlog_histlen = 0;
    server.repl_backlog_idx = 0;

    // 避免之前使用过 backlog 的 slave 引发错误的 PSYNC 操作
    server.master_repl_offset++;

    // 尽管没有数据，但事实上，第一个字节的逻辑位置是 master_repl_offset 的下一个字节
    server.repl_backlog_off = server.master_repl_offset+1;
}
```

#### 执行 bgsave 操作

接上一小节，bgsave 操作的处理函数为 **startBgsaveForReplication**。
首先根据传入的参数，针对有无磁盘化复制调用不同的处理函数，即，

```c
int retval;
int socket_target = server.repl_diskless_sync && (mincapa & SLAVE_CAPA_EOF);
listIter li;
listNode *ln;

serverLog(LL_NOTICE,"Starting BGSAVE for SYNC with target: %s",
    socket_target ? "slaves sockets" : "disk");

if (socket_target)
    retval = rdbSaveToSlavesSockets();
else
    retval = rdbSaveBackground(server.rdb_filename);
```

参数 **mincapa**，表示 slave 的"能力"，即是否能接受无硬盘复制的 rdb 数据。
如果选项`server.repl_diskless_sync` 为真，且 **mincapa** 中包含 **SLAVE_CAPA_EOF**，说明可以为该 slave 直接发送无硬盘复制的 rdb 数据，调用 **rdbSaveToSlavesSockets** 函数，在后台将 rdb 数据通过 socket 发送给所有状态为 **SLAVE_STATE_WAIT_BGSAVE_START** 的 slave。
否则，调用**rdbSaveBackground** 函数，在后台将 rdb 数据转储到本地文件。

如果以上的 rdb 处理函数调用失败，从 slave 列表中删除处于 **SLAVE_STATE_WAIT_BGSAVE_START** 状态的 slave，并在 slave 中加入 **CLIENT_CLOSE_AFTER_REPLY** 标识，以便在回复错误消息后关闭连接。代码逻辑如下，

```c
if (retval == C_ERR) {
    serverLog(LL_WARNING,"BGSAVE for replication failed");
    listRewind(server.slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = ln->value;

        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
            slave->flags &= ~CLIENT_SLAVE;
            listDelNode(server.slaves,ln);
            addReplyError(slave,
                "BGSAVE failed, replication can't continue");
            slave->flags |= CLIENT_CLOSE_AFTER_REPLY;
        }
    }
    return retval;
}
```

如果使用的是有磁盘复制，那么从 slave 列表中找到处于 **SLAVE_STATE_WAIT_BGSAVE_START** 状态的 slave，调用 **replicationSetupSlaveForFullResync** 函数，把 slave 状态置为 **SLAVE_STATE_WAIT_BGSAVE_END**，并回复 **+FULLRESYNC**，这个前面说过。代码如下，

```c
/* If the target is socket, rdbSaveToSlavesSockets() already setup
 * the salves for a full resync. Otherwise for disk target do it now.*/
if (!socket_target) {
    listRewind(server.slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = ln->value;

        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
                replicationSetupSlaveForFullResync(slave,
                        getPsyncInitialOffset());
        }
    }
}
```

最后调用函数 **replicationScriptCacheFlush** 清空 lua 脚本缓存。

### 累积命令流过程

当 master 收到 client 发来的命令后，会调用 **call** 函数执行相应的命令处理函数。在代码中 **PROPAGATE_REPL** 标识表示需要将命令同步给 slave，有如下逻辑，

```c
void call(client *c, int flags) {
    ......
   /* Propagate the command into the AOF and replication link */
    if (flags & CMD_CALL_PROPAGATE &&
        (c->flags & CLIENT_PREVENT_PROP) != CLIENT_PREVENT_PROP)
    {
        ......
        /* Check if the command operated changes in the data set. If so
         * set for replication / AOF propagation. */
        if (dirty) propagate_flags |= (PROPAGATE_AOF|PROPAGATE_REPL);

        ......

        /* If the client forced AOF / replication of the command, set
         * the flags regardless of the command effects on the data set. */
        if (c->flags & CLIENT_FORCE_REPL) propagate_flags |= PROPAGATE_REPL;

        ......

        /* Call propagate() only if at least one of AOF / replication
         * propagation is needed. */
        if (propagate_flags != PROPAGATE_NONE)
            propagate(c->cmd,c->db->id,c->argv,c->argc,propagate_flags);
    }
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

现在来看重点处理函数 **replicationFeedSlaves**，现在分析如下。

首先，必要的 check。

```c
// 如果 backlog 为空，且本节点没有 slave，那么下面的逻辑就没必要走了
if (server.repl_backlog == NULL && listLength(slaves) == 0) return;
```

如果有必要的话，将 SELECT 命令添加到 backlog 和所有状态不是 **SLAVE_STATE_WAIT_BGSAVE_START** 的 slave 输出缓存中，其他命令也是如此，代码大概如下，

```c
/* Write the command to the replication backlog if any. */
if (server.repl_backlog) {
    char aux[LONG_STR_SIZE+3];

    /* Add the multi bulk reply length. */
    // *..CRLF
    aux[0] = '*';
    len = ll2string(aux+1,sizeof(aux)-1,argc);
    aux[len+1] = '\r';
    aux[len+2] = '\n';
    feedReplicationBacklog(aux,len+3);// argc 转换成字符串的长度 + 3，即 * 以及 CRLF

    for (j = 0; j < argc; j++) {
        long objlen = stringObjectLen(argv[j]);

        /* We need to feed the buffer with the object as a bulk reply
         * not just as a plain string, so create the $..CRLF payload len
         * and add the final CRLF */
        aux[0] = '$';
        len = ll2string(aux+1,sizeof(aux)-1,objlen);
        aux[len+1] = '\r';
        aux[len+2] = '\n';
        feedReplicationBacklog(aux,len+3);
        feedReplicationBacklogWithObject(argv[j]);
        feedReplicationBacklog(aux+len+1,2); // CRLF
    }
}

/* Write the command to every slave. */
listRewind(server.slaves,&li);
while((ln = listNext(&li))) {
    client *slave = ln->value;

    /* Don't feed slaves that are still waiting for BGSAVE to start */
    if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) continue;

    /* Feed slaves that are waiting for the initial SYNC (so these commands
        * are queued in the output buffer until the initial SYNC completes),
        * or are already in sync with the master. */

    /* Add the multi bulk length. */
    addReplyMultiBulkLen(slave,argc);

    /* Finally any additional argument that was not stored inside the
        * static buffer if any (from j to argc). */
    for (j = 0; j < argc; j++)
        addReplyBulk(slave,argv[j]);
}
```

向 slave 输出缓存追加命令流时，调用的是 addReply 类的函数。

## bgsave 收尾阶段

当完成 bgsave 后，无论是有无磁盘复制，都要调用 **updateSlavesWaitingBgsave** 函数进行最后的处理，主要是为了前面说过的**被推迟的 bgsave**。

```c
void updateSlavesWaitingBgsave(int bgsaveerr, int type) {.....}
```

遍历 slave 列表，如果 slave 的复制状态处于 **SLAVE_STATE_WAIT_BGSAVE_START**，那么调用 **startBgsaveForReplication** 函数，开始一次新的 bgsave。

```c
if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
    startbgsave = 1;
    mincapa = (mincapa == -1) ? slave->slave_capa :
                                (mincapa & slave->slave_capa);
```

如果 slave 的复制状态处于 **SLAVE_STATE_WAIT_BGSAVE_END**，说明该 slave 正在等待 rdb 数据处理完成，此时需要根据有无磁盘化复制，区别对待处理。

### 无磁盘复制

```c
if (type == RDB_CHILD_TYPE_SOCKET) {
    serverLog(LL_NOTICE,
        "Streamed RDB transfer with slave %s succeeded (socket). Waiting for REPLCONF ACK from slave to enable streaming",
            replicationGetSlaveName(slave));

    /* Note: we wait for a REPLCONF ACK message from slave in
     * order to really put it online (install the write handler
     * so that the accumulated data can be transfered). However
     * we change the replication state ASAP, since our slave
     * is technically online now. */
    slave->replstate = SLAVE_STATE_ONLINE;
    slave->repl_put_online_on_ack = 1;
    slave->repl_ack_time = server.unixtime; /* Timeout otherwise. */
}
```

将 slave 的复制状态置为 **SLAVE_STATE_ONLINE**，属性 **repl_put_online_on_ack** 置为 1。
⚠ **注意**，在收到该 slave 第一个 `replconf ack <offset>` 命令之后，master 才真正调用 **putSlaveOnline** 函数将该 slave置为 **REDIS_REPL_ONLINE** 状态，并且开始发送缓存的命令流。

```c
void replconfCommand(client *c) {
    .....
    else if (!strcasecmp(c->argv[j]->ptr,"ack")) {

        /* REPLCONF ACK is used by slave to inform the master the amount
         * of replication stream that it processed so far. It is an
         * internal only command that normal clients should never use. */
        long long offset;

        if (!(c->flags & CLIENT_SLAVE)) return;
        if ((getLongLongFromObject(c->argv[j+1], &offset) != C_OK))
            return;
        if (offset > c->repl_ack_off)
            c->repl_ack_off = offset;
        c->repl_ack_time = server.unixtime;

        /* If this was a diskless replication, we need to really put
         * the slave online when the first ACK is received (which
         * confirms slave is online and ready to get more data). */
        if (c->repl_put_online_on_ack && c->replstate == SLAVE_STATE_ONLINE)
            putSlaveOnline(c);

        /* Note: this command does not reply anything! */
        return;
    }
    ......
}
```

之所以这样设计，与这两种复制方式有关。

当使用**有磁盘复制**方式时，master 会先把 rdb 数据的长度以 `$<len>/r/n` 的格式发送给 slave，slave 在解析到 len 后，从 socket 中读取到特定长度的 rdb 数据。
当使用**无磁盘复制**方式时，master 预先无法获知 rdb 数据的长度，那 slave 如何判断 rdb 数据是否读完了呢？在发送 rdb 数据之前，master 会先以 `$EOF:<40 bytes delimiter>` 的格式发送一个 40 字节的魔数，当 rdb 数据发送完后，再次发送这个魔数，这样 slave 就可以检测到 rdb 数据发送结束了。

如果 master 发送完 rdb 数据后，直接将 slave 状态置为 **SLAVE_STATE_ONLINE** ，接着发送缓存的命令流。
当采用**无磁盘复制**方式时，slave 最后读到的数据很有可能包含了命令流数据。因此，需要等到 slave 发送的第一个 `replconf ack <offset>` 命令之后，master 再把 slave 状态置为 **SLAVE_STATE_ONLINE**。

可以参考作者的解释 [https://github.com/antirez/redis/commit/bb7fea0d5ca7b3a53532338e8654e409014c1194](https://github.com/antirez/redis/commit/bb7fea0d5ca7b3a53532338e8654e409014c1194)。

### 有磁盘复制

```c
if (bgsaveerr != C_OK) {
    freeClient(slave);
        serverLog(LL_WARNING,"SYNC failed. BGSAVE child returned an error");
        continue;
}

if ((slave->repldbfd = open(server.rdb_filename,O_RDONLY)) == -1 ||
    redis_fstat(slave->repldbfd,&buf) == -1) {
    freeClient(slave);
    serverLog(LL_WARNING,"SYNC failed. Can't open/stat DB after BGSAVE: %s", strerror(errno));
    continue;
}

slave->repldboff = 0;
slave->repldbsize = buf.st_size;
slave->replstate = SLAVE_STATE_SEND_BULK;
slave->replpreamble = sdscatprintf(sdsempty(),"$%lld\r\n",
    (unsigned long long) slave->repldbsize);

aeDeleteFileEvent(server.el,slave->fd,AE_WRITABLE);
if (aeCreateFileEvent(server.el, slave->fd, AE_WRITABLE, sendBulkToSlave, slave) == AE_ERR) {
    freeClient(slave);
    continue;
}
```

如果前面做 bgsave 出错了，那么这里会释放掉 client。
否则，打开生成的 rdb 文件，将 fd 保存到 **repldbfd** 属性中，状态置为 **SLAVE_STATE_SEND_BULK**，这表示要把 rdb 数据发送给 slave 了，将 rdb 大小写入 **replpreamble** 属性。
重新注册 slave 上的写事件，回调函数为 **sendBulkToSlave**，该函数做以下分析，

```c
/* Before sending the RDB file, we send the preamble as configured by the
 * replication process. Currently the preamble is just the bulk count of
 * the file in the form "$<length>\r\n". */
if (slave->replpreamble) {
    nwritten = write(fd,slave->replpreamble,sdslen(slave->replpreamble));
    if (nwritten == -1) {
        serverLog(LL_VERBOSE,"Write error sending RDB preamble to slave: %s",
            strerror(errno));
        freeClient(slave);
        return;
    }
    server.stat_net_output_bytes += nwritten;
    sdsrange(slave->replpreamble,nwritten,-1);
    if (sdslen(slave->replpreamble) == 0) {
        sdsfree(slave->replpreamble);
        slave->replpreamble = NULL;
        /* fall through sending data. */
    } else {
        return;
    }
}
```

如果 **replpreamble** 属性不为空，说明是第一次触发该回调，那么先把这个 rdb 数据的长度信息发送给 slave。
否则，进入发送实际 rdb 数据阶段。从 rdb 文件中读取数据，然后发送给 slave，代码中使用 repldboff 属性记录累积发送过多少数据。
默认一次发送的数据量为 **PROTO_IOBUF_LEN**，大小为 16K。

```c
/* If the preamble was already transfered, send the RDB bulk data. */
lseek(slave->repldbfd,slave->repldboff,SEEK_SET);
buflen = read(slave->repldbfd,buf,PROTO_IOBUF_LEN); // 读 16k 数据
if (buflen <= 0) {
    serverLog(LL_WARNING,"Read error sending DB to slave: %s",
        (buflen == 0) ? "premature EOF" : strerror(errno));
    freeClient(slave);
    return;
}
if ((nwritten = write(fd,buf,buflen)) == -1) {
    if (errno != EAGAIN) {
        serverLog(LL_WARNING,"Write error sending DB to slave: %s",
            strerror(errno));
        freeClient(slave);
    }
    return;
}
slave->repldboff += nwritten;
server.stat_net_output_bytes += nwritten;
```

当 rdb 数据完全发送完以后，关闭 rdb 文件 fd，删除 fd 的写事件，重置 repldbfd。

```c
if (slave->repldboff == slave->repldbsize) { // 发送完 rdb 文件，删除可读事件
    close(slave->repldbfd);
    slave->repldbfd = -1;
    aeDeleteFileEvent(server.el,slave->fd,AE_WRITABLE);
    putSlaveOnline(slave);
}
```

最后调用 **putSlaveOnline** 函数，将 slave 的复制状态置为 **SLAVE_STATE_ONLINE**，重新注册 fd 的写事件，回调函数为 **sendReplyToClient**，向 slave 发送累积的命令流。

```c
void putSlaveOnline(client *slave) {
    slave->replstate = SLAVE_STATE_ONLINE;
    slave->repl_put_online_on_ack = 0;
    slave->repl_ack_time = server.unixtime; /* Prevent false timeout. */
    if (aeCreateFileEvent(server.el, slave->fd, AE_WRITABLE,
        sendReplyToClient, slave) == AE_ERR) {
        serverLog(LL_WARNING,"Unable to register writable event for slave bulk transfer: %s", strerror(errno));
        freeClient(slave);
        return;
    }
    refreshGoodSlavesCount();
    serverLog(LL_NOTICE,"Synchronization with slave %s succeeded",
        replicationGetSlaveName(slave));
}
```

设置 slave 属性 **repl_put_online_on_ack ** 为 0，表示该 **slave 已完成初始同步，接下来进入命令传播阶段**。
最后，调用 **refreshGoodSlavesCount** 函数，更新当前状态正常的 slave 数量。

---

到此，主从复制过程中 master 的逻辑就已经讲完了。
