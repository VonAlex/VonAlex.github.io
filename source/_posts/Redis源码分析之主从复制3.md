---
title: Redis 源码之主从复制(3)
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: 968a029a
date: 2019-09-05 00:20:55
---

redis 代码中主从复制流程的核心部分在于**状态机的流转**。

<!--more---->

单机模式下以  **SLAVEOF** 命令触发；
cluster 模式下以 **REPLICATE** 命令触发，且 cluster 模式下不支持 **SLAVEOF** 命令。

在该过程中，master 与 slave 各有不同的流转逻辑，交互频繁，本文以下内容试图介绍 slave 的处理逻辑,以下流程图可以辅助理解。
![nGjlXd.png](https://s2.ax1x.com/2019/09/09/nGjlXd.png)

代码中在 `redisServer` 结构体里定义的很多 **repl** 前缀的变量都用于此过程，如`repl_transfer_fd`。
各变量的作用在源码注释里已经写得非常详细了，不做赘述。

## 单机模式下的主从复制

redis 实例以单机模式启动，即在 <span id="inline-blue"> redis.conf </span> 中配置 **cluster-enabled no**。

### 触发方式

有以下三种方式可触发主从复制流程。
① <span id="inline-blue">redis.conf </span> 中配置 `slaveof <masterip> <masterport>`；
② redis-server 命令启动服务时指定参数 `--slaveof [masterip] [masterport]`；
③ 对一个实例执行 `slaveof [masterip] [masterport]` 命令。

①② 逻辑相似，直接标记 `server.repl_state` 为 **REPL_STATE_CONNECT** 状态，以 ① 为例简要说明，加载配置文件时有如下逻辑，

```c
void loadServerConfigFromString(char *config) {
    ....
    else if (!strcasecmp(argv[0],"slaveof") && argc == 3) {
        slaveof_linenum = linenum;
        server.masterhost = sdsnew(argv[1]);
        server.masterport = atoi(argv[2]);
        server.repl_state = REPL_STATE_CONNECT;
    }
....
}
```

而 ③ 在标记 `REPL_STATE_CONNECT` 状态前需要做一些检查。
首先，检查实例是否开启了 cluster 模式，如果开启了，那么直接返回，不支持这个命令。
接着，通过检查 `slaveof` 命令后面的参数来判断使用的是哪个命令，代码如下，

```c
void slaveofCommand(client *c) {
    /* cluster 模式开启后，禁用 slaveof 命令 */
    if (server.cluster_enabled) {
        addReplyError(c,"SLAVEOF not allowed in cluster mode.");
        return;
    }

   // SLAVEOF NO ONE
    if (!strcasecmp(c->argv[1]->ptr,"no") &&
        !strcasecmp(c->argv[2]->ptr,"one")) {
        if (server.masterhost) { // 如果之前有 master
            replicationUnsetMaster();
            sds client = catClientInfoString(sdsempty(),c);
            serverLog(LL_NOTICE,"MASTER MODE enabled (user request from '%s')", client);
            sdsfree(client);
        }
    } else {
        long port;
        // 从参数中获得 port
        if ((getLongFromObjectOrReply(c, c->argv[2], &port, NULL) != C_OK))
            return;
        // 如果现在的 master 已经是要设置的，那么就不必再做操作了，直接返回吧
        if (server.masterhost && !strcasecmp(server.masterhost,c->argv[1]->ptr)
            && server.masterport == port) {
            serverLog(LL_NOTICE,"SLAVE OF would result into synchronization with the master we are already connected with. No operation performed.");
            addReplySds(c,sdsnew("+OK Already connected to specified master\r\n"));
            return;
        }
        replicationSetMaster(c->argv[1]->ptr, port);
        sds client = catClientInfoString(sdsempty(),c);
        serverLog(LL_NOTICE,"SLAVE OF %s:%d enabled (user request from '%s')",
            server.masterhost, server.masterport, client);
        sdsfree(client);
    }
    addReply(c,shared.ok);
}
```


#### SLAVEOF NO ONE 命令

该命令会取消现有的主从关系，使 slave 变为 master，主要函数如下，

```c
void replicationUnsetMaster(void) {
    // 已经是 master 了，无需继续操作
    if (server.masterhost == NULL) return;

    sdsfree(server.masterhost);
    server.masterhost = NULL;

    if (server.master) {
        if (listLength(server.slaves) == 0) {
            // 继承 master 的 repl offset
            server.master_repl_offset = server.master->reploff;
            freeReplicationBacklog();
        }
        freeClient(server.master);
    }
    replicationDiscardCachedMaster();
    cancelReplicationHandshake();
    server.repl_state = REPL_STATE_NONE;
}
```

这里主要涉及到一些与 master 相关的变量的内存释放。
如果该实例有 master，且不是其他实例的 master，即 `listLength(server.slaves) == 0`，也就是说未形成链式结构，那么记录下原 master 的  replication offset。在某些特定条件下，副本的数据新鲜度可以通过 replication offset 来比较，有时由于网络等原因暂时断开了，隔了一段时间又重新连上原 master，有了这个偏移量可以减少做完全重同步的可能性(我是这么理解的)。
**freeClient** 函数会释放掉原来的 master，做一些内存释放，一些标志位重置等。

接下来的 `replicationDiscardCachedMaster` 函数中会释放掉 `server.cached_master`，因为这里缓存以前的 mater 已经没用了，不知道下次要连的是哪个 master，或者自己以后成为一个 master，避免不必要的内存浪费。

`cancelReplicationHandshake` 函数则会取消一个正在进行尝试 handshake 的主从复制过程。
最后重置状态机为 **REPL_STATE_NONE**。

#### SLAVEOF host port 命令

通过执行该命令，可以将当前实例变成某个实例的 slave。
如果指定的主从关系已经存在，那本次命令没必要继续执行了，直接返回；否则，通过 `replicationSetMaster` 函数设置新的主从关系，代码如下，
```c
void replicationSetMaster(char *ip, int port) {
    sdsfree(server.masterhost);
    server.masterhost = sdsnew(ip);
    server.masterport = port;
    // 如果原来有 master了，需要释放掉
    if (server.master) freeClient(server.master);
    disconnectAllBlockedClients();

    // 释放掉所有的 slave，让它们重新连
    disconnectSlaves();
    replicationDiscardCachedMaster();
    freeReplicationBacklog();

    cancelReplicationHandshake();
    server.repl_state = REPL_STATE_CONNECT;
    server.master_repl_offset = 0;
    server.repl_down_since = 0;
}
```
在以上函数中，
先保存下要连接的 ip 和 port，方便后面进行建立网络连接。
如果，该节点之前有 master 了，那么需要释放掉原来的 master，跟上面一节的逻辑类似，前面详细说过了。
**disconnectAllBlockedClients** 函数会 unlock 已经 lock 在这个实例上的 client，并返回 **-UNBLOCKED** 开头的错误。这是因为该实例已经改变了角色，block 已经没什么意义。比如当一个实例从 master 变为 slave，那么由于 list 选项而阻塞在该实例上的 client 就不安全了，**因为数据随着从新的 slave 同步数据，该实例的数据集可能会发生变化**。
**disconnectSlaves** 函数释放掉所有的 slave，重新同步新的数据。
释放掉 `server.cached_master`，同样因为数据集变化了，cache 的数据并不能用了。
释放掉 `server.repl_backlog`，理由同上。
`cancelReplicationHandshake` 函数在上面讲过了。
将 `server.repl_state` 置为 **REPL_STATE_CONNECT** 状态，复制偏离量归零等。
最后返回 OK，也就是这个命令的返回值`+OK\r\n`。

### 主从建立连接

redis 中有很多 cron 任务，其中就有一个负责 replication 的，即每秒执行一次的 **replicationCron** 函数。

```c
 run_with_period(1000) replicationCron();
```

在上一步中，状态机已经流转到 **REPL_STATE_CONNECT** 状态，这里直接就进入到主从建连的逻辑。

```c
void replicationCron(void) {
	......
    // 开始一段新的主从关系
    if (server.repl_state == REPL_STATE_CONNECT) {
        serverLog(LL_NOTICE,"Connecting to MASTER %s:%d",
            server.masterhost, server.masterport);
        if (connectWithMaster() == C_OK) {
            serverLog(LL_NOTICE,"MASTER <-> SLAVE sync started");
        }
    }
  ......
}
```
使用`server.masterhost` 和 `server.masterport` 向 master 发起 connect 请求， fd 设置为**非阻塞**。成功后，为 fd 的读写事件注册 `syncWithMaster` 回调函数，用于处理 master 与 slave 之间的 handshake 过程。这部分逻辑在 **connectWithMaster** 函数中实现，代码如下，

```c
int connectWithMaster(void) {
    int fd;

    // 连接 master，获得 fd
    fd = anetTcpNonBlockBestEffortBindConnect(NULL, server.masterhost,server.masterport,NET_FIRST_BIND_ADDR);
    if (fd == -1) {
        serverLog(LL_WARNING,"Unable to connect to MASTER: %s",
            strerror(errno));
        return C_ERR;
    }
    // 为 fd 设置读写事件回调 syncWithMaster
    if (aeCreateFileEvent(server.el,fd,AE_READABLE|AE_WRITABLE,syncWithMaster,NULL) == AE_ERR)
    {
        close(fd);
        serverLog(LL_WARNING,"Can't create readable event for SYNC");
        return C_ERR;
    }

    server.repl_transfer_lastio = server.unixtime;
    server.repl_transfer_s = fd;

    // 状态机更新
    server.repl_state = REPL_STATE_CONNECTING;
    return C_OK;
}
```

`server.repl_transfer_lastio` 用于记录上一次 fd 读事件的时刻，`server.repl_transfer_s` 记录主从复制使用到的 socket fd。

更新状态机为 **REPL_STATE_CONNECTING**。

### 主从 handshake 过程

#### 发送 ping

主从建连成功后，通过 fd 的读写事件触发  `syncWithMaster` 回调函数。

如果该事件在用户把本实例用 **SLAVEOF NO ONE** 变成 master 后出触发，那么没有执行下去的必要，判断逻辑如下，

```c
if (server.repl_state == REPL_STATE_NONE) {
    close(fd);
    return;
}
```
下面是同步发送 PING 的代码逻辑，更新状态机为 **REPL_STATE_RECEIVE_PONG**。
```c
if (server.repl_state == REPL_STATE_CONNECTING) {
    serverLog(LL_NOTICE,"Non blocking connect for SYNC fired the event.");

    /* 为了等待 pong 的返回，删除 fd 上的可写事件，但保留可读事件 */
    aeDeleteFileEvent(server.el,fd,AE_WRITABLE);
    server.repl_state = REPL_STATE_RECEIVE_PONG;

    /* 同步发送 ping，这里不检查是否 err，因为已经有超时限制做保证 */
    err = sendSynchronousCommand(SYNC_CMD_WRITE,fd,"PING",NULL);
    if (err) goto write_error;
    return;
}
```
`sendSynchronousCommand` 函数通过 flag 标识读写命令，此处写命令标识为 **SYNC_CMD_WRITE**。

#### 验证 AUTH
使用 **sendSynchronousCommand** 函数同步读取 master 对 PING 的回复。
```c
if (server.repl_state == REPL_STATE_RECEIVE_PONG) {
    /* 读取上面发送的 ping 命令的 response */
    err = sendSynchronousCommand(SYNC_CMD_READ,fd,NULL);
    if (err[0] != '+' && strncmp(err,"-NOAUTH",7) != 0 &&
        strncmp(err,"-ERR operation not permitted",28) != 0)
    {
        serverLog(LL_WARNING,"Error reply to PING from master: '%s'",err);
        sdsfree(err);
        goto error;
    } else {
        serverLog(LL_NOTICE,
          "Master replied to PING, replication can continue...");
    }
    sdsfree(err);
    server.repl_state = REPL_STATE_SEND_AUTH;
}
```
回复只可能有 3 种情况：**+PONG**，**-NOAUTH** 和 **-ERR operation not permitted**（老版本的 redis 主节点）。如果不是，直接进入错误处理代码流程。

**注意**：这里的读操作会更新变量 `server.repl_transfer_lastio`。

调整状态机为 **REDIS_REPL_SEND_AUTH**。这里没有 `return`，直接往下执行，进入鉴权的逻辑，

```c
if (server.repl_state == REPL_STATE_SEND_AUTH) {
    if (server.masterauth) {
        err = sendSynchronousCommand(SYNC_CMD_WRITE,fd,"AUTH",server.masterauth,NULL);
        if (err) goto write_error;
        server.repl_state = REPL_STATE_RECEIVE_AUTH;
        return;
    } else {
     	 server.repl_state = REPL_STATE_SEND_PORT;
    }
}
```

如果配置文件中没有设置 **masterauth** 选项，那么状态机置为 **REPL_STATE_SEND_PORT**。
否则，需要发送 `AUTH` 命令鉴权。状态机置为 **REPL_STATE_RECEIVE_AUTH**。

```c
/* Receive AUTH reply. */
if (server.repl_state == REPL_STATE_RECEIVE_AUTH) {
    err = sendSynchronousCommand(SYNC_CMD_READ,fd,NULL);
    if (err[0] == '-') {
        serverLog(LL_WARNING,"Unable to AUTH to MASTER: %s",err);
        sdsfree(err);
        goto error;
    }
    sdsfree(err);
    server.repl_state = REPL_STATE_SEND_PORT;
}
```

验证 auth 通过后，状态机置为 **REPL_STATE_SEND_PORT**，否则，直接跳到的 err 处理流程。

#### 发送 REPLCONF 命令

slave 将发送一连串的 `REPLCONF` 命令，以告知 master 自己的一些信息。
`slave-announce-ip` 和 `slave-announce-port` 主要是针对转发或者 NAT 场景下，master 无法通过 socket 连接获得对端信息时使用。

首先发送自己的 port 信息，`REPLCONF listening-port <port>`，状态机置为 **REPL_STATE_RECEIVE_PORT**，返回，等下一次事件触发。
接着，同步读取 master 的回复，即使返回错误也没有关系，状态机置为 **REPL_STATE_SEND_IP**。
代码如下，
```c
/* Set the slave port, so that Master's INFO command can list the
 * slave listening port correctly. */
if (server.repl_state == REPL_STATE_SEND_PORT) {
    sds port = sdsfromlonglong(server.slave_announce_port ?
                               server.slave_announce_port : server.port);
    err = sendSynchronousCommand(SYNC_CMD_WRITE,fd,"REPLCONF",
                                 "listening-port",port, NULL);
    sdsfree(port);
    if (err) goto write_error;
    sdsfree(err);
    server.repl_state = REPL_STATE_RECEIVE_PORT;
    return;
}

if (server.repl_state == REPL_STATE_RECEIVE_PORT) {
    err = sendSynchronousCommand(SYNC_CMD_READ,fd,NULL);
    if (err[0] == '-') {
      	serverLog(LL_NOTICE,"(Non critical) Master does not understand "
                "REPLCONF listening-port: %s", err);
    }
    sdsfree(err);
    server.repl_state = REPL_STATE_SEND_IP;
```
如果没有配置 `slave-announce-ip` 时，直接将状态机调跳转到 **REPL_STATE_SEND_CAPA**，跳过发送 REPLCONF ip-address 的步骤。
```c
if (server.repl_state == REPL_STATE_SEND_IP &&
    server.slave_announce_ip == NULL)
{
  server.repl_state = REPL_STATE_SEND_CAPA;
}
```

发送 REPLCONF ip-address，接收回复，将状态机置为 **REPL_STATE_SEND_CAPA**。
```c
/* REPLCONF ip-address <ip>  */
if (server.repl_state == REPL_STATE_SEND_IP) {
    err = sendSynchronousCommand(SYNC_CMD_WRITE,fd,"REPLCONF",
                                 "ip-address",server.slave_announce_ip, NULL);
    if (err) goto write_error;
    sdsfree(err);
    server.repl_state = REPL_STATE_RECEIVE_IP;
    return;
}

/* Receive REPLCONF ip-address reply. */
if (server.repl_state == REPL_STATE_RECEIVE_IP) {
    err = sendSynchronousCommand(SYNC_CMD_READ,fd,NULL);
    if (err[0] == '-') {
      serverLog(LL_NOTICE,"(Non critical) Master does not understand "
                "REPLCONF ip-address: %s", err);
    }
    sdsfree(err);
    server.repl_state = REPL_STATE_SEND_CAPA;
}
```

状态机置为  **REPL_STATE_SEND_CAPA**，告知 master 自己的能力，现在只有 eof，表示支持无磁盘化主从复制，以后可能会有更多，格式为 ` REPLCONF capa X capa Y capa Z ...`。

```c
if (server.repl_state == REPL_STATE_SEND_CAPA) {
    err = sendSynchronousCommand(SYNC_CMD_WRITE,fd,"REPLCONF",
                                 "capa","eof",NULL);
    if (err) goto write_error;
    sdsfree(err);
    server.repl_state = REPL_STATE_RECEIVE_CAPA;
    return;
}
if (server.repl_state == REPL_STATE_RECEIVE_CAPA) {
    err = sendSynchronousCommand(SYNC_CMD_READ,fd,NULL);
    /* Ignore the error if any, not all the Redis versions support
           * REPLCONF capa. */
    if (err[0] == '-') {
      	serverLog(LL_NOTICE,"(Non critical) Master does not understand "
                "REPLCONF capa: %s", err);
    }
    sdsfree(err);
    server.repl_state = REPL_STATE_SEND_PSYNC;
}

```
状态机置为 **REPL_STATE_SEND_PSYNC**。

#### 尝试做部分重同步

为解决旧版本 redis 在处理断线情况下完全复制的低效问题， 从 2.8 版本开始，使用 PSYNC 命令代替 SYNC 命令来执行复制时的同步操作，这个点在前面的博客讲过了。

为高效起见，首先尝试做部分重同步，试探逻辑在函数 **slaveTryPartialResynchronization** 中。
```c
if (server.repl_state == REPL_STATE_SEND_PSYNC) {
    if (slaveTryPartialResynchronization(fd,0) == PSYNC_WRITE_ERROR) {
        err = sdsnew("Write error sending the PSYNC command.");
        goto write_error;
    }
    server.repl_state = REPL_STATE_RECEIVE_PSYNC;
    return;
}
```

**slaveTryPartialResynchronization** 里包含了读写两部分，其中写的部分在上半部，当第二个参数为 0 时，发送 PSYNC 命令，命令格式为 `PSYNC <runid> <offset>`。
发送 PSYNC 时，分两种情况，首次连接或非首次连接。首次连接时，runid 未知，用 `?` 代替，offset 置为初始值 -1。
代码逻辑如下，
```c
if (!read_reply) {
	server.repl_master_initial_offset = -1;

    if (server.cached_master) { // 重连
        psync_runid = server.cached_master->replrunid;
        snprintf(psync_offset,sizeof(psync_offset),"%lld", server.cached_master->reploff+1);
        serverLog(LL_NOTICE,"Trying a partial resynchronization (request %s:%s).", psync_runid, psync_offset);
    } else { // 首次连接 master
        serverLog(LL_NOTICE,"Partial resynchronization not possible (no cached master)");
        psync_runid = "?";
        memcpy(psync_offset,"-1",3); /* psync ? -1 */
    }

    reply = sendSynchronousCommand(SYNC_CMD_WRITE,fd,"PSYNC",psync_runid,psync_offset,NULL);
    if (reply != NULL) {
        serverLog(LL_WARNING,"Unable to send PSYNC to master: %s",reply);
        sdsfree(reply);
        /* 发送出错了，需要删掉 fd 上的可读事件 */
        aeDeleteFileEvent(server.el,fd,AE_READABLE);
        return PSYNC_WRITE_ERROR;
    }
    return PSYNC_WAIT_REPLY;
}
```
发送出错后，需要删掉 fd 上的可读事件。
回到 **syncWithMaster** 函数中，状态机置为 **REPL_STATE_RECEIVE_PSYNC**。

代码逻辑走到这一步，如果状态机的状态不是 **REPL_STATE_RECEIVE_PSYNC**，一定是哪里出错了，进入错误处理流程，即，

```c
/* If reached this point, we should be in REPL_STATE_RECEIVE_PSYNC. */
if (server.repl_state != REPL_STATE_RECEIVE_PSYNC) {
    serverLog(LL_WARNING,"syncWithMaster(): state machine error, "
        "state should be RECEIVE_PSYNC but is %d", server.repl_state);
    goto error;
}
```

接着去读取 master 的给的回复信息，
```c
psync_result = slaveTryPartialResynchronization(fd,1);
```

可能会读到三种，`+FULLRESYNC`、`+CONTINUE`以及`-ERR`。

```c
reply = sendSynchronousCommand(SYNC_CMD_READ,fd,NULL);
if (sdslen(reply) == 0) {
  // 为了保活，master 可能在收到 PSYNC 后且回复前发送空行
  sdsfree(reply);
  return PSYNC_WAIT_REPLY;
}
/* 删除 fd 可读事件，方便后面为 f'd重新注册新的回调 */
aeDeleteFileEvent(server.el,fd,AE_READABLE);
```
【1】`+FULLRESYNC` 回复表示不能进行部分重同步，slave 告诉给 master 的 offset 不在 master 的复制积压缓冲区范围内，只能进行完全重同步，返回给上层函数 **PSYNC_FULLRESYNC**，代码如下，
```c
/* 完全重同步得到 response 为 +FULLRESYNC <master_runid> <offset> */
if (!strncmp(reply,"+FULLRESYNC",11)) {
    char *runid = NULL, *offset = NULL;
    runid = strchr(reply,' ');
    if (runid) {
        runid++;
        offset = strchr(runid,' ');
        if (offset) offset++;
    }
    /* 有可能是 master 发送格式有问题，先把 repl_master_runid 置空 */
    if (!runid || !offset || (offset-runid-1) != CONFIG_RUN_ID_SIZE) {
        serverLog(LL_WARNING,
                  "Master replied with wrong +FULLRESYNC syntax.");
        memset(server.repl_master_runid,0,CONFIG_RUN_ID_SIZE+1);
    } else {
        memcpy(server.repl_master_runid, runid, offset-runid-1);
        server.repl_master_runid[CONFIG_RUN_ID_SIZE] = '\0';
        server.repl_master_initial_offset = strtoll(offset,NULL,10);
        serverLog(LL_NOTICE,"Full resync from master: %s:%lld",
                  server.repl_master_runid,
                  server.repl_master_initial_offset);
    }
    /* We are going to full resync, discard the cached master structure. */
    replicationDiscardCachedMaster();
    sdsfree(reply);
    return PSYNC_FULLRESYNC;
}
```
以上代码解析出 master 的 runid，以及 offset，分别赋值给 `repl_master_runid` 和 `repl_master_initial_offset`。因为要进行全同步，`cached_master` 保存的信息就失效了，需要重置，即函数 `replicationDiscardCachedMaster` 的调用。

【2】`+CONTINUE` 表示可以进行部分重同步，返回给上层函数 **PSYNC_CONTINUE**。
```c
if (!strncmp(reply,"+CONTINUE",9)) {
    serverLog(LL_NOTICE,
              "Successful partial resynchronization with master.");
    sdsfree(reply);
    replicationResurrectCachedMaster(fd);
    return PSYNC_CONTINUE;
}
```
```c
void replicationResurrectCachedMaster(int newfd) {
    server.master = server.cached_master;
    server.cached_master = NULL;
    server.master->fd = newfd;
    server.master->flags &= ~(CLIENT_CLOSE_AFTER_REPLY|CLIENT_CLOSE_ASAP);
    server.master->authenticated = 1;
    server.master->lastinteraction = server.unixtime;
    server.repl_state = REPL_STATE_CONNECTED;

    /* Re-add to the list of clients. */
    listAddNodeTail(server.clients,server.master);
    if (aeCreateFileEvent(server.el, newfd, AE_READABLE,
                          readQueryFromClient, server.master)) {
        serverLog(LL_WARNING,"Error resurrecting the cached master, impossible to add the readable handler: %s", strerror(errno));
        freeClientAsync(server.master); /* Close ASAP. */
    }

    if (clientHasPendingReplies(server.master)) {
        if (aeCreateFileEvent(server.el, newfd, AE_WRITABLE,
                          sendReplyToClient, server.master)) {
            serverLog(LL_WARNING,"Error resurrecting the cached master, impossible to add the writable handler: %s", strerror(errno));
            freeClientAsync(server.master); /* Close ASAP. */
        }
    }
}
```
可以看出，从 `cached_master` 恢复 master，将状态机置为 **REPL_STATE_CONNECTED**。
为 fd 的读事件注册新的回调函数 readQueryFromClient。
如果在` server.master` 上仍然有 reply，或者是在写 buffer 里有数据，那么需要为写事件注册回调函数 `sendReplyToClient`。

【3】`-ERR` 的情况。需要清理现有的 `cached_master`，返回给上层函数 **PSYNC_NOT_SUPPORTED** 。

回到 **syncWithMaster** 函数里，处理 PSYNC 命令的返回值。
当返回的是 **PSYNC_CONTINUE** 时，表示进行的是部分重同步，该函数结束。
```c
if (psync_result == PSYNC_CONTINUE) { /* 部分重同步 ，不会走到下面接收 rdb 的流程 */
  serverLog(LL_NOTICE, "MASTER <-> SLAVE sync: Master accepted a Partial Resynchronization.");
  return;
}
```

否则，有两种可能，进行完全重同步，或者 master 不支持 PSYNC 命令(老版本的 master)，但是无论如何都需要断开现有的所有 slave，因为新 master 可能会传过来一份不同的数据。
同时清空复制积压缓冲区，即 repl_backlog，不允许我的 slave 做 psync 了（**毕竟数据不同了嘛**）。

如果新 master 不支持 PSYNC 命令，那么同步发送 SYNC 命令。
```c
if (psync_result == PSYNC_NOT_SUPPORTED) {
    serverLog(LL_NOTICE,"Retrying with SYNC...");
    if (syncWrite(fd,"SYNC\r\n",6,server.repl_syncio_timeout*1000) == -1) {
        serverLog(LL_WARNING,"I/O error writing to MASTER: %s",
                  strerror(errno));
        goto error;
    }
}
```
如果没有出错，接下来准备完全重同步阶段 master 发过来的 rdb 数据。创建一个名字以 tmp 为前缀的临时 rdb 接收文件，打开，并记录 fd，最多 5 次，要是还不能成功创建一个临时文件，那么就走错误处理的流程了。代码如下，

```c
while(maxtries--) {
    snprintf(tmpfile,256,
             "temp-%d.%ld.rdb",(int)server.unixtime,(long int)getpid());
    dfd = open(tmpfile,O_CREAT|O_WRONLY|O_EXCL,0644);
    if (dfd != -1) break;
    sleep(1);
}
if (dfd == -1) {
    serverLog(LL_WARNING,"Opening the temp file needed for MASTER <-> SLAVE synchronization: %s",strerror(errno));
    goto error;
}
```
接着为 fd 的读事件注册回调函数 `readSyncBulkPayload`，用来处理从 master 读到的数据 rdb 文件。
```c
/* 为 fd 的可读事件注册新的函数 readSyncBulkPayload */
if (aeCreateFileEvent(server.el,fd, AE_READABLE,readSyncBulkPayload,NULL) == AE_ERR)
{
    serverLog(LL_WARNING,
              "Can't create readable event for SYNC: %s (fd=%d)",
              strerror(errno),fd);
    goto error;
}
```
最后是一些 server 变量的赋值。
```c
server.repl_state = REPL_STATE_TRANSFER;
/* 初始化 RDB 文件大小 */
server.repl_transfer_size = -1;
/* 已读数据大小 */
server.repl_transfer_read = 0;
/* 最近一次执行的 fsync 偏移量 */
server.repl_transfer_last_fsync_off = 0;
/* 本地临时 rdb 文件的 fd */
server.repl_transfer_fd = dfd;
/* 最近一次读数据的时间 */
server.repl_transfer_lastio = server.unixtime;
/* 本地临时 rdb 文件的名字 */
server.repl_transfer_tmpfile = zstrdup(tmpfile);
```

状态机置为 **REPL_STATE_TRANSFER**，`repl_transfer_fd` 记录 rdb 临时文件的 fd。

#### 几个超时保证
在 **replicationCron** 函数中的开始部分，有一些超时保证。

与 master 建立连接后，一直没能发 PING，说明连接可能有问题。
在鉴权和确认capa 的流程中，花了过多的时间。
```c
if (server.masterhost &&
    (server.repl_state == REPL_STATE_CONNECTING ||  slaveIsInHandshakeState()) &&
        (time(NULL)-server.repl_transfer_lastio) > server.repl_timeout) // 默认 60s 超时
{
    serverLog(LL_WARNING,"Timeout connecting to the MASTER...");
    cancelReplicationHandshake();
}

int slaveIsInHandshakeState(void) {
    return server.repl_state >= REPL_STATE_RECEIVE_PONG &&
        server.repl_state <= REPL_STATE_RECEIVE_PSYNC;
}
```
接收 rdb 文件的时长做限制。
```c
/* Bulk transfer I/O timeout? */
if (server.masterhost && server.repl_state == REPL_STATE_TRANSFER &&
    (time(NULL)-server.repl_transfer_lastio) > server.repl_timeout) // 默认 60s 超时
{
    serverLog(LL_WARNING,"Timeout receiving bulk data from MASTER... If the problem persists try to set the 'repl-timeout' parameter in redis.conf to a larger value.");
    cancelReplicationHandshake();
}
```
成为 slave 以后，没有数据发过来。
```c
 /* Timed out master when we are an already connected slave? */
if (server.masterhost && server.repl_state == REPL_STATE_CONNECTED &&
    (time(NULL)-server.master->lastinteraction) > server.repl_timeout)
{
    serverLog(LL_WARNING,"MASTER timeout: no data nor PING received...");
    freeClient(server.master);
}
```

### 接收 RDB 文件

接收 rdb 数据有两种方式，一种是磁盘化的，一种是无磁盘化的。

>   从 V2.8.18 开始，redis 引入了“无硬盘复制”选项，开启该选项时，redis 在与 slave 进行复制初始化时将不会将快照内容存储到硬盘上，而是直接通过网络发送给slave，避免了硬盘的性能瓶颈，可以在配置文件中使用 **repl-diskless-sync** 选项来配置开启该功能。

两种方式发送的数据格式是不一样的。
磁盘化复制时，master 先生成 rdb 文件，然后将文件内容加上 `$<len>/r/n` 的头部后，发送给 slave。
而无磁盘化复制时，master 直接把 rdb 数据发送给你 slave 时，以 `$EOF:<XXX>\r\n` 开头，并以 `<XXX>` 结尾，开头和结尾的 `<XXX>` 内容相同，都是 40 个字节，是由 **0123456789abcdef** 中的字符组成的随机字符串，为了校验数据的是否发送完成。

该流程主要是回调函数 `readSyncBulkPayload` 中的逻辑。
首先读取 master 传过来的辅助信息。

```c
if (server.repl_transfer_size == -1) {
    /* 第一行内容 $<len>/r/n */
    if (syncReadLine(fd,buf,1024,server.repl_syncio_timeout*1000) == -1) {
        serverLog(LL_WARNING,
                  "I/O error reading bulk count from MASTER: %s",
                  strerror(errno));
        goto error;
    }

    if (buf[0] == '-') {
        serverLog(LL_WARNING,
                  "MASTER aborted replication with an error: %s",
                  buf+1);
        goto error;
    } else if (buf[0] == '\0') {
        server.repl_transfer_lastio = server.unixtime;
        return;
    } else if (buf[0] != '$') {
        serverLog(LL_WARNING,"Bad protocol from MASTER, the first byte is not '$' (we received '%s'), are you sure the host and port are right?", buf);
        goto error;
    }

  /* 有两种可能的 bulk payload 格式，正常的是 $<count>
   * 还有一种可能就是无磁盘化主从同步时，因为这个时候不知道后面要传输数据的长度，因此会发送一个分隔符，
   * 格式为 $EOF:<40 bytes delimiter>
   * 在发送完 rdb 数据后，分隔符会再次被发送，以便让接收端知道数据发送完成了。
   * 分隔符足够的长和随机，因此真实文件内容碰撞的可能性可以被忽略。*/
    if (strncmp(buf+1,"EOF:",4) == 0 && strlen(buf+5) >= CONFIG_RUN_ID_SIZE) {
      usemark = 1;
      memcpy(eofmark,buf+5,CONFIG_RUN_ID_SIZE);
      memset(lastbytes,0,CONFIG_RUN_ID_SIZE);
      server.repl_transfer_size = 0;
      serverLog(LL_NOTICE,
                "MASTER <-> SLAVE sync: receiving streamed RDB from master");
    } else {
      usemark = 0;
      server.repl_transfer_size = strtol(buf+1,NULL,10);
      serverLog(LL_NOTICE,
                "MASTER <-> SLAVE sync: receiving %lld bytes from master",
                (long long) server.repl_transfer_size);
    }
    return;
}
```

同步读取第一行内容，当开启了无磁盘化同步时，有一点需要注意，保存完 eofmark 后，要把 `repl_transfer_size` 变量置为一个非 -1 的值，防止下次事件触发后又进到这个逻辑里来了。而正常同步时，可以读到 `repl_transfer_size` 的大小。
通过 `usemark` 来标记同步类型，值为 1 表示无磁盘化的同步，值为 0 表示磁盘化同步。

```c
/* Read bulk data */
if (usemark) {
    readlen = sizeof(buf);
} else {
    left = server.repl_transfer_size - server.repl_transfer_read;
    readlen = (left < (signed)sizeof(buf)) ? left : (signed)sizeof(buf);
}
```

以上逻辑来调整每次从 socket 中读取数据的长度，因为 usemark 时，不知道要读取的数据总长度。

```c
nread = read(fd,buf,readlen);
if (nread <= 0) {
    serverLog(LL_WARNING,"I/O error trying to sync with MASTER: %s",
              (nread == -1) ? strerror(errno) : "connection lost");
    cancelReplicationHandshake();
    return;
}
```

计算出 readlen 后，读取数据，如果读错了，要断开连接，清理 fd ，重置同步状态等，`cancelReplicationHandshake` 的逻辑在上面已经说过。
如果是 usemark，那么需要校验 eofmark，以便知道数据是否已经读完。

```c
int eof_reached = 0;

if (usemark) {
    /* Update the last bytes array, and check if it matches our delimiter.*/
    if (nread >= CONFIG_RUN_ID_SIZE) {
        memcpy(lastbytes,buf+nread-CONFIG_RUN_ID_SIZE,CONFIG_RUN_ID_SIZE);
    } else {
        int rem = CONFIG_RUN_ID_SIZE-nread;
        memmove(lastbytes,lastbytes+nread,rem);
        memcpy(lastbytes+rem,buf,nread);
    }
    /* 读到 EOF 了 */
    if (memcmp(lastbytes,eofmark,CONFIG_RUN_ID_SIZE) == 0) eof_reached = 1;
}
```

如果读到的数据长度 >= 40，那么截取 buf 最后 40 个字符。否则使用 `memmove` 和 `memcpy` 将最后的 40 个字节填满，这部分操作有点绕，画了个图帮助理解，

![lastbytes](http://ww1.sinaimg.cn/large/71ca8e3cly1g5w95590gbj20h60873z7.jpg)

然后根据前面记录 eofmark 去判断是不是数据接收结束了，如果是，`eof_reached` 置为 1。
读完一次数据需要将其写入本地的临时 rdb 文件里，

```c
if (write(server.repl_transfer_fd,buf,nread) != nread) {
    serverLog(LL_WARNING,"Write error or short write writing to the DB dump file needed for MASTER <-> SLAVE synchronization: %s", strerror(errno));
    goto error;
}
server.repl_transfer_read += nread; // 更新读了多少数据量
```

如果是已经读到末尾了，那么需要从文件中删掉 eofmark，因为它不是 rdb 数据嘛，只是个辅助标识。

```c
if (usemark && eof_reached) {
    if (ftruncate(server.repl_transfer_fd,
                  server.repl_transfer_read - CONFIG_RUN_ID_SIZE) == -1)
    {
        serverLog(LL_WARNING,"Error truncating the RDB file received from the master for SYNC: %s", strerror(errno));
        goto error;
    }
}
```

光是 `write` 了还不够，这只是写到了系统的 cache，还需要做 `fsync` 将数据落盘。

```c
if (server.repl_transfer_read >=
    server.repl_transfer_last_fsync_off + REPL_MAX_WRITTEN_BEFORE_FSYNC)
{
    off_t sync_size = server.repl_transfer_read -
      server.repl_transfer_last_fsync_off;
    rdb_fsync_range(server.repl_transfer_fd,
                    server.repl_transfer_last_fsync_off, sync_size);
    server.repl_transfer_last_fsync_off += sync_size;
}
```

刷盘策略是每 8M 一次。
如果不是无磁盘化的主从同步，就要依赖于接收到的数据 size 与第一次传过来的值作比较。

```c
if (!usemark) {
    if (server.repl_transfer_read == server.repl_transfer_size)
        eof_reached = 1;
}
```

如果完全接收完数据了了，那么需要做一些善后工作，如下代码，

```c
 if (eof_reached) {....}
```

首先，把本地 rdb 文件的名字改成配置文件里配置的名字`server.rdb_filename`。

```c
if (rename(server.repl_transfer_tmpfile,server.rdb_filename) == -1) {
    serverLog(LL_WARNING,"Failed trying to rename the temp DB into dump.rdb in MASTER <-> SLAVE 				synchronization: %s", strerror(errno));
    cancelReplicationHandshake();
    return;
}
```

然后需要为加载新的 rdb 文件做一些准备。

```c
signalFlushedDb(-1); // 使得本实例的所有客户端感知到接下来要清空数据库
emptyDb(replicationEmptyDbCallback); // 清空所有数据，给 master 发一个 \n
```

```c
long long emptyDb(void(callback)(void*)) {
    int j;
    long long removed = 0;

    for (j = 0; j < server.dbnum; j++) {
        removed += dictSize(server.db[j].dict);
        dictEmpty(server.db[j].dict,callback);
        dictEmpty(server.db[j].expires,callback);
    }
    if (server.cluster_enabled) slotToKeyFlush();
    return removed;
}

/* Callback used by emptyDb() while flushing away old data to load
 * the new dataset received by the master. */
void replicationEmptyDbCallback(void *privdata) {
    UNUSED(privdata);
    replicationSendNewlineToMaster();
}

/* 给 master 发 \n 表明自己还活着，在加载数据 */
void replicationSendNewlineToMaster(void) {
    static time_t newline_sent;
    if (time(NULL) != newline_sent) {
        newline_sent = time(NULL);
        if (write(server.repl_transfer_s,"\n",1) == -1) {
            /* Pinging back in this stage is best-effort. */
        }
    }
}
```

清空老数据完老数据，下面开始加载新数据。

```c
aeDeleteFileEvent(server.el,server.repl_transfer_s,AE_READABLE);
serverLog(LL_NOTICE, "MASTER <-> SLAVE sync: Loading DB in memory");
if (rdbLoad(server.rdb_filename) != C_OK) {
    serverLog(LL_WARNING,"Failed trying to load the MASTER synchronization DB from disk");
    cancelReplicationHandshake();
    return;
}
```

在加载新数据之前，需要先删除socket fd 的可读事件，这是因为在调用 `rdbLoad` 加载 rdb 数据时，每次调用`rioRead` 都会因为要计算 checksum 而调用 `processEventsWhileBlocked` 处理当前已触发的事件，如果不删除该可读事件的话，就会递归进入的本函数中（因此，slave 在加载 rdb 数据时，是不能处理主节点发来的其他数据的）。
然后做一些清理工作。

```c
zfree(server.repl_transfer_tmpfile);
close(server.repl_transfer_fd);
```

根据 socket fd 创建一个 master 的 client。

```c
 /* 创建 master 相关的变量 */
replicationCreateMasterClient(server.repl_transfer_s);
```

然后可以看下这个 `replicationCreateMasterClient` 这个函数都干了些什么事情。

```c
void replicationCreateMasterClient(int fd) {
    server.master = createClient(fd);
    server.master->flags |= CLIENT_MASTER;
    server.master->authenticated = 1;
    server.repl_state = REPL_STATE_CONNECTED;
    server.master->reploff = server.repl_master_initial_offset;
    memcpy(server.master->replrunid, server.repl_master_runid,
        sizeof(server.repl_master_runid));
    if (server.master->reploff == -1)
        server.master->flags |= CLIENT_PRE_PSYNC;
}
```

需要注意一点，如果 master 不支持 PSYNC 的话，那么 salve 不会得到 `+FULLRESYNC` 的回复，也就不会更新 `server.repl_master_initial_offset` 变量，它就一直是 -1，在这里创建 master client 时，会给它一个标记 **CLIENT_PRE_PSYNC**。

这里会把状态机更新为 **REPL_STATE_CONNECTED**。
最后，如果 aof 功能没有关闭的话，需要重新生成 aof 文件，因为数据已经改变了。

```c
if (server.aof_state != AOF_OFF) {
    int retry = 10;

    stopAppendOnly();
    while (retry-- && startAppendOnly() == C_ERR) {
        serverLog(LL_WARNING,"Failed enabling the AOF after successful master synchronization! 							Trying it again in one second.");
        sleep(1);
    }
    if (!retry) {
        serverLog(LL_WARNING,"FATAL: this slave instance finished the synchronization with its 							master, but the AOF can't be turned on. Exiting now.");
        exit(1);
    }
}
```

到这里，`readSyncBulkPayload` 函数读取并加载新 rdb 文件的流程就走完了。

当复制状态变为 **REPL_STATE_CONNECTED** 后，表示进入了命令传播阶段。后续 slave 将 master 当成一个客户端，并接收其发来的命令请求，像处理普通客户端一样处理即可。命令传播在前面的博客已经详细讲过。



### 探活机制

在 master-slave 连接建立以后，他们就通过心跳进行相互探活，这些机制都在 `replicationCron` 函数里。

#### master 探活

master 会定期给它所有的 slave 发送 PING。

```c
if ((replication_cron_loops % server.repl_ping_slave_period) == 0) {
    ping_argv[0] = createStringObject("PING",4);
    replicationFeedSlaves(server.slaves, server.slaveseldb,
                          ping_argv, 1);
    decrRefCount(ping_argv[0]);
}
```

给 slave 发送命令是通过 `replicationFeedSlaves` 函数实现的。

```c
void replicationFeedSlaves(list *slaves, int dictid, robj **argv, int argc) {....}
```

下面看一下该函数的详细实现。

```c
if (server.repl_backlog == NULL && listLength(slaves) == 0) return;
```

如果 `repl_backlog` 为空，或者是没有 slave，那么这个过程是不必要的，直接返回。必要的时候生成 SELECT 命令，告知 slave 切换数据库。`slaveseldb` 中保存的是上一次 replication 输出时选择的数据库。

```c
if (server.repl_backlog) {
    char aux[LONG_STR_SIZE+3];

    /* Add the multi bulk reply length. */
    aux[0] = '*';
    len = ll2string(aux+1,sizeof(aux)-1,argc);
    aux[len+1] = '\r';
    aux[len+2] = '\n';
    feedReplicationBacklog(aux,len+3);

    for (j = 0; j < argc; j++) {
        long objlen = stringObjectLen(argv[j]);
        aux[0] = '$';
        len = ll2string(aux+1,sizeof(aux)-1,objlen);
        aux[len+1] = '\r';
        aux[len+2] = '\n';
        feedReplicationBacklog(aux,len+3);
        feedReplicationBacklogWithObject(argv[j]);
        feedReplicationBacklog(aux+len+1,2);
    }
}
```

如果 `repl_backlog` 不为空，那么组装 redis 协议的命令，这里是 `*1\r\n$4\r\nPING`，放到 `repl_backlog` 变量里。

#### slave 探活

```c
void replicationCron(void) {
    ...
    if (server.masterhost && server.master &&
          !(server.master->flags & CLIENT_PRE_PSYNC)) {
      	replicationSendAck();
    }
    ...
}

void replicationSendAck(void) {
    client *c = server.master;

    if (c != NULL) {
        c->flags |= CLIENT_MASTER_FORCE_REPLY;
        addReplyMultiBulkLen(c,3);
        addReplyBulkCString(c,"REPLCONF");
        addReplyBulkCString(c,"ACK");
        addReplyBulkLongLong(c,c->reploff);
        c->flags &= ~CLIENT_MASTER_FORCE_REPLY;
    }
}
```

对于非老版本的 master，slave 向它定期发送 `REPLCONF ACK <offset>` 命令，以便告诉它复制偏移量。

## cluster 模式

cluster 模式下，使用 `CLUSTER REPLICATE <NODE ID>` 命令来进行新的主从关系的构建。

```c
void clusterCommand(client *c) {
    ...
    else if (!strcasecmp(c->argv[1]->ptr,"replicate") && c->argc == 3) {
        /* CLUSTER REPLICATE <NODE ID> */
        clusterNode *n = clusterLookupNode(c->argv[2]->ptr);

        /* Lookup the specified node in our table. */
        if (!n) {
            addReplyErrorFormat(c,"Unknown node %s", (char*)c->argv[2]->ptr);
            return;
        }
        /* I can't replicate myself. */
        if (n == myself) {
            addReplyError(c,"Can't replicate myself");
            return;
        }
        /* Can't replicate a slave. */
        if (nodeIsSlave(n)) {
            addReplyError(c,"I can only replicate a master, not a slave.");
            return;
        }
        // 我要做别人的 slave， 那么不是不能够有 slots 和数据库数据的
        if (nodeIsMaster(myself) &&
            (myself->numslots != 0 || dictSize(server.db[0].dict) != 0)) {
            addReplyError(c,
                "To set a master the node must be empty and "
                "without assigned slots.");
            return;
        }

        /* Set the master. */
        clusterSetMaster(n);
        clusterDoBeforeSleep(CLUSTER_TODO_UPDATE_STATE|CLUSTER_TODO_SAVE_CONFIG);
        addReply(c,shared.ok);
    }
    .....
}
```

**很重要的一个检查**是，有 slot 或者有数据的 master 节点，不能做此操作，防止丢数据。
跳过一些合理性检查，重点函数就是 `clusterSetMaster` 了，那么它做了什么呢？

```c
void clusterSetMaster(clusterNode *n) {
    serverAssert(n != myself);
    serverAssert(myself->numslots == 0);

    if (nodeIsMaster(myself)) {
        myself->flags &= ~(CLUSTER_NODE_MASTER|CLUSTER_NODE_MIGRATE_TO);
        myself->flags |= CLUSTER_NODE_SLAVE;
        clusterCloseAllSlots();
    } else {
        if (myself->slaveof)
            clusterNodeRemoveSlave(myself->slaveof,myself); // 解除原有的主从关系
    }
    myself->slaveof = n;
    clusterNodeAddSlave(n,myself);
    replicationSetMaster(n->ip, n->port);
    resetManualFailover();
}
```

首先，如果本身是个 master，那么取消掉 master 和 migrating 的 flag，因为该 master 没有数据，可以大胆地取消迁移的叫标记，然后加上 slave 的标记 **CLUSTER_NODE_SLAVE**。
如果原本就是个 slave 节点，那么调整自己的主从归属信息，置空以手动主从切换有关的变量值，关于 cluster mf 的逻辑以后会专门去讨论。
然后就是前面说过的 `replicationSetMaster` 函数，触发上也是在 cron 里，就不啰嗦了。

以上，主从复制中，slave 的逻辑就介绍完了。
