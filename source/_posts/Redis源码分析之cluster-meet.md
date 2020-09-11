---
title: Redis 源码之 cluster meet
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: c62267d
date: 2018-12-10 00:02:03
---
Redis cluster 是 redis 官方提出的分布式集群解决方案，在此之前，有一些第三方的可选方案，如 codis、Twemproxy等。cluster 内部使用了 gossip 协议进行通信，以达到数据的最终一致性。详细介绍可参考官网 [Redis cluster tutorial](https://redis.io/topics/cluster-tutorial)。

本文试图借着`cluster meet` 命令的实现来对其中的一些通信细节一探究竟。

<!--more---->

我们都知道，当 redis server 以 cluster mode 启动时，节点 B 想加入节点 A 所在的集群，只需要执行 `CLUSTER MEET ip port` 这个命令即可，通过  gossip  通信，最终 A 所在集群的其他节点也都会认识到 B。大概流程图如下：

## cluster 初始化

当  redis server  以 cluster mode 启动时，即配置文件中的 `cluster-enabled` 选项设置为 `true`，此时在服务启动时，会有一个 cluster 初始化的流程，这个在之前的文章 《[Redis 启动流程](http://tech-happen.site/e74c6d55.html)》中有提到过，即执行函数 `clusterInit`。在 cluster 中有三个数据结构很重要， `clusterState` 、 `clusterNode` 和 `clusterLink`。

每个节点都保存着一个 `clusterState` 结构，这个结构记录了在当前节点的视角下，集群目前所处的状态，即“我看到的世界是什么样子”。

每个节点都会使用一个 `clusterNode` 结构来记录自己的状态， 并为集群中的所有其他节点（包括主节点和从节点）都创建一个相应的 `clusterNode` 结构， 以此来记录其他节点的状态。

`clusterNode` 结构的 `link` 属性是一个 `clusterLink` 结构， 该结构保存了连接节点所需的有关信息， 比如套接字描述符， 输入缓冲区和输出缓冲区。

更多的细节可以通过网页 《[redis 设计与实现 - 节点](http://redisbook.com/preview/cluster/node.html)》进行了解。

该初始化很简单，首先是创建一个  `clusterState` 结构，并初始化一些成员，如下：

```c
server.cluster = zmalloc(sizeof(clusterState));
server.cluster->myself = NULL;
server.cluster->currentEpoch = 0;     // 新节点的 currentEpoch = 0
server.cluster->state = CLUSTER_FAIL; // 初始状态置为 FAIL
server.cluster->size = 1;
server.cluster->todo_before_sleep = 0;
server.cluster->nodes = dictCreate(&clusterNodesDictType,NULL);
server.cluster->nodes_black_list = dictCreate(&clusterNodesBlackListDictType,NULL);
server.cluster->failover_auth_time = 0;
server.cluster->failover_auth_count = 0;
server.cluster->failover_auth_rank = 0;
server.cluster->failover_auth_epoch = 0;
server.cluster->cant_failover_reason = CLUSTER_CANT_FAILOVER_NONE;
server.cluster->lastVoteEpoch = 0;
server.cluster->stats_bus_messages_sent = 0;
server.cluster->stats_bus_messages_received = 0;
memset(server.cluster->slots,0, sizeof(server.cluster->slots));
clusterCloseAllSlots(); // Clear the migrating/importing state for all the slots
```

然后给 node.conf 文件加锁，确保每个节点使用自己的 cluster 配置文件。

```c
if (clusterLockConfig(server.cluster_configfile) == C_ERR)
    exit(1);
```

借着这个机会学习下 redis 如何使用的文件锁。

```c
int fd = open(filename,O_WRONLY|O_CREAT,0644);
if (fd == -1) {
    serverLog(LL_WARNING,
              "Can't open %s in order to acquire a lock: %s",
              filename, strerror(errno));
    return C_ERR;
}

if (flock(fd,LOCK_EX|LOCK_NB) == -1) {
    if (errno == EWOULDBLOCK) {
        serverLog(LL_WARNING,
                  "Sorry, the cluster configuration file %s is already used "
                  "by a different Redis Cluster node. Please make sure that "
                  "different nodes use different cluster configuration "
                  "files.", filename);
    } else {
        serverLog(LL_WARNING,
                  "Impossible to lock %s: %s", filename, strerror(errno));
    }
    close(fd);
    return C_ERR;
}
```

然后加载 node.conf 文件，这个过程还会检查这个文件是否合理。

如果加载失败（或者配置文件不存在），则以 `REDIS_NODE_MYSELF|REDIS_NODE_MASTER` 为标记，创建一个clusterNode 结构表示自己本身，置为主节点，并设置自己的名字为一个40字节的随机串；然后将该节点添加到server.cluster->nodes中，这说明这是个新启动的节点，生成的配置文件进行刷盘。

```c
if (clusterLoadConfig(server.cluster_configfile) == C_ERR) {
    myself = server.cluster->myself =
        createClusterNode(NULL,CLUSTER_NODE_MYSELF|CLUSTER_NODE_MASTER);
    serverLog(LL_NOTICE,"No cluster configuration found, I'm %.40s",
              myself->name);
    clusterAddNode(myself);
    saveconf = 1;
}
if (saveconf) clusterSaveConfigOrDie(1); // 新节点，将配置刷到配置文件中，fsync
```

接下来，调用 `listenToPort` 函数，在集群 gossip 通信端口上创建 socket fd 进行监听。集群内 gossip 通信端口是在 **Redis 监听端口基础上加 10000**，比如如果Redis监听客户端的端口为 6379，则集群监听端口就是16379，该监听端口用于接收其他集群节点发送过来的 gossip 消息。

然后注册监听端口上的可读事件，事件回调函数为 `clusterAcceptHandler`。

```c
#define CLUSTER_PORT_INCR 10000

if (listenToPort(server.port+CLUSTER_PORT_INCR,
                 server.cfd,&server.cfd_count) == C_ERR)
{
    exit(1);
} else {
    int j;
    for (j = 0; j < server.cfd_count; j++) {
        if (aeCreateFileEvent(server.el, server.cfd[j], AE_READABLE,
                              clusterAcceptHandler, NULL) == AE_ERR)
            serverPanic("Unrecoverable error creating Redis Cluster "
                        "file event.");
    }
}
```

当前节点收到其他集群节点发来的TCP建链请求之后，就会调用 `clusterAcceptHandler` 函数 accept 连接。在 `clusterAcceptHandler`函数中，对于每个已经 accept 的链接，都会创建一个`clusterLink` 结构表示该链接，并注册 socket fd上的可读事件，事件回调函数为 `clusterReadHandler`。

```c
#define MAX_CLUSTER_ACCEPTS_PER_CALL 1000
void clusterAcceptHandler(aeEventLoop *el, int fd, void *privdata, int mask) {
    int cport, cfd;
    int max = MAX_CLUSTER_ACCEPTS_PER_CALL;
    char cip[NET_IP_STR_LEN];
    clusterLink *link;
    ... ...
    // 如果服务器正在启动，不要接受其他节点的连接, 因为 UPDATE 消息可能会干扰数据库内容
    if (server.masterhost == NULL && server.loading) return;
    while(max--) {
        cfd = anetTcpAccept(server.neterr, fd, cip, sizeof(cip), &cport);
        if (cfd == ANET_ERR) {
            if (errno != EWOULDBLOCK)
                serverLog(LL_VERBOSE,
                    "Error accepting cluster node: %s", server.neterr);
            return;
        }
        anetNonBlock(NULL,cfd);
        anetEnableTcpNoDelay(NULL,cfd);
        ... ...
        // 创建一个 link 结构来处理连接
        // 刚开始的时候， link->node 被设置成 null，因为现在我们不知道是哪个节点
        link = createClusterLink(NULL);
        link->fd = cfd;
        aeCreateFileEvent(server.el,cfd,AE_READABLE,clusterReadHandler,link);
    }
}
```

最后是 reset mf 相关的参数。

## CLUSTER MEET

### 一、A 节点接收 CLUSTER MEET 命令

A 节点在`cluster.c` -> `clusterCommand` 函数中，接收到 `CLUSTER MEET` 命令，即

```c
if (!strcasecmp(c->argv[1]->ptr,"meet") && c->argc == 4) {
    long long port;

    // CLUSTER MEET <ip> <port>
    if (getLongLongFromObject(c->argv[3], &port) != C_OK) {
        addReplyErrorFormat(c,"Invalid TCP port specified: %s", (char*)c->argv[3]->ptr);
        return;
    }
    if (clusterStartHandshake(c->argv[2]->ptr,port) == 0 && errno == EINVAL)
    {
        addReplyErrorFormat(c,"Invalid node address specified: %s:%s",
                            (char*)c->argv[2]->ptr, (char*)c->argv[3]->ptr);
    } else {
        addReply(c,shared.ok);
    }
}
```

可以看到重点在 `clusterStartHandshake` 这个函数。

```c
int clusterStartHandshake(char *ip, int port) {
    clusterNode *n;
    char norm_ip[NET_IP_STR_LEN];
    struct sockaddr_storage sa;
    /* IP and Port sanity check */
    ... ...

    // 检查节点(flag) norm_ip:port 是否正在握手
    if (clusterHandshakeInProgress(norm_ip,port)) {
        errno = EAGAIN;
        return 0;
    }
    // 创建一个含随机名字的 node，type 为 CLUSTER_NODE_HANDSHAKE|CLUSTER_NODE_MEET
    // 相关信息会在 handshake 过程中被修复
    n = createClusterNode(NULL,CLUSTER_NODE_HANDSHAKE|CLUSTER_NODE_MEET);
    memcpy(n->ip,norm_ip,sizeof(n->ip));
    n->port = port;
    clusterAddNode(n);
    return 1;
}
```

```c
clusterNode *createClusterNode(char *nodename, int flags) {
    clusterNode *node = zmalloc(sizeof(*node));
    if (nodename)
        memcpy(node->name, nodename, CLUSTER_NAMELEN);
    else
        // 在本地新建一个 nodename 节点，节点名字随机，跟它通信时它会告诉我真实名字
        getRandomHexChars(node->name, CLUSTER_NAMELEN);
    node->ctime = mstime(); // mstime
    node->configEpoch = 0;
    node->flags = flags;
    memset(node->slots,0,sizeof(node->slots));
    node->slaveof = NULL;
    ... ...
    node->link = NULL; // link 为空, 在 clusterCron 中能检查的到
    memset(node->ip,0,sizeof(node->ip));
    node->port = 0;
    node->fail_reports = listCreate();
    ... ...
    listSetFreeMethod(node->fail_reports,zfree);
    return node;
}
```

这个函数会首先进行一些 ip 和 port 的合理性检查，然后去遍历所看到的 nodes，这个 ip:port 对应的 node 是不是正处于 `CLUSTER_NODE_HANDSHAKE` 状态，是的话，就说明这是重复 meet，没必要往下走。之后，通过 `createClusterNode` 函数创建一个带有 `CLUSTER_NODE_HANDSHAKE|CLUSTER_NODE_MEET` 标记的节点，名字为一个**随机**的 40 字节字符串（因为此时对 A 来说，B 是一个陌生的节点，信息除了 ip 和 port，其他都不知道），通过 `clusterAddNode` 函数加到自己的 nodes 中。

这个过程成功后，就返回给客户端 OK 了，其他事情需要通过 gossip 通信去做。

### 二、A 节点发送 MEET 消息给 B 节点

A 节点在定时任务 `clusterCron` 中，会做一些事情。

```c
handshake_timeout = server.cluster_node_timeout;
if (handshake_timeout < 1000) handshake_timeout = 1000;

// 检查是否有 disconnected nodes 并且重新建立连接
di = dictGetSafeIterator(server.cluster->nodes); // 遍历所有节点
while((de = dictNext(di)) != NULL) {
    clusterNode *node = dictGetVal(de);

     // 忽略掉 myself 和 noaddr 状态的节点
    if (node->flags & (CLUSTER_NODE_MYSELF|CLUSTER_NODE_NOADDR)) continue;

    // 节点处于 handshake 状态，且状态维持时间超过 handshake_timeout，那么从 nodes中删掉它
    if (nodeInHandshake(node) && now - node->ctime > handshake_timeout) {
        clusterDelNode(node);
        continue;
    }

    // 刚刚收到 cluster meet 命令创建的新 node ，或是 server 刚启动，或是由于某种原因断开了
    if (node->link == NULL) {
        int fd;
        mstime_t old_ping_sent;
        clusterLink *link;

        // 对端 gossip 通信端口为 node 端口 + 10000，创建 tcp 连接, 本节点相当于 client
        fd = anetTcpNonBlockBindConnect(server.neterr, node->ip, node->port+CLUSTER_PORT_INCR, NET_FIRST_BIND_ADDR);
        ... ...
        link = createClusterLink(node);
        link->fd = fd;
        node->link = link;

        // 注册 link->fd 上的可读事件，事件回调函数为 clusterReadHandler
        aeCreateFileEvent(server.el,link->fd,AE_READABLE, clusterReadHandler,link);
        ... ...

        // 如果 node 带有 MEET flag，我们发送一个 MEET 包而不是 PING,
        // 这是为了强制让接收者把我们加到它的 nodes 中
        clusterSendPing(link, node->flags & CLUSTER_NODE_MEET ? CLUSTERMSG_TYPE_MEET : CLUSTERMSG_TYPE_PING);
        ... ...
        node->flags &= ~CLUSTER_NODE_MEET;
        ... ...
    }
}
dictReleaseIterator(di);
```

可以看到，遍历自己看到的 nodes，当遍历到 B 节点时，由于 `node->link == NULL`，因此会监听 B 的启动端口号+10000，即 gossip 通信端口，然后注册可读事件，处理函数为 `clusterReadHandler`。接着会发送 **CLUSTER_NODE_MEET** 消息给 B 节点，消除掉 B 节点的 **meet** 状态。

### 三、B 节点处理 A 发来的 MEET  消息

当 B 节点接收到 A 节点发送 gossip 时，回调函数 `clusterAcceptHandler` 进行处理，然后会 accept 对端的 connect（B 作为 server，对端作为 client），注册可读事件，回调函数为 `clusterReadHandler`，基本逻辑如下，

```c
void clusterAcceptHandler(aeEventLoop *el, int fd, void *privdata, int mask) {
    int cport, cfd;
    int max = MAX_CLUSTER_ACCEPTS_PER_CALL;
    char cip[NET_IP_STR_LEN];
    clusterLink *link;
    UNUSED(el);
    UNUSED(mask);
    UNUSED(privdata);

    // 如果服务器正在启动，不要接受其他节点的链接，因为 UPDATE 消息可能会干扰数据库内容
    if (server.masterhost == NULL && server.loading) return;
    while(max--) { // 1000 个请求
        cfd = anetTcpAccept(server.neterr, fd, cip, sizeof(cip), &cport);
        if (cfd == ANET_ERR) {
            if (errno != EWOULDBLOCK)
                serverLog(LL_VERBOSE,
                    "Error accepting cluster node: %s", server.neterr);
            return;
        }
        anetNonBlock(NULL,cfd);
        anetEnableTcpNoDelay(NULL,cfd);
        serverLog(LL_VERBOSE,"Accepted cluster node %s:%d", cip, cport);

        // 创建一个 link 结构来处理连接
        // 刚开始的时候， link->node 被设置成 null，因为现在我们不知道是哪个节点
        link = createClusterLink(NULL);
        link->fd = cfd;
        aeCreateFileEvent(server.el,cfd,AE_READABLE,clusterReadHandler,link);
    }
}
```

可以看到每次 accept 对端connect时，都会创建一个 `clusterLink` 结构用来接收数据，

```c
typedef struct clusterLink {
    mstime_t ctime;             /* Link creation time */
    int fd;                     /* TCP socket file descriptor */
    sds sndbuf;                 /* Packet send buffer */
    sds rcvbuf;                 /* Packet reception buffer */
    struct clusterNode *node;   /* Node related to this link if any, or NULL */
} clusterLink;
```

`clusterLink` 有一个指针是指向 node 自身的。

B 节点接收到 A 节点发送过来的信息，放到 `clusterLink` 的 `rcvbuf` 字段，然后使用 `clusterProcessPacket` 函数来处理（接收数据过程很简单，不做分析）。

所以 `clusterProcessPacket` 函数的作用是处理别人发过来的 gossip 包。

```c
if (!sender && type == CLUSTERMSG_TYPE_MEET) {
    clusterNode *node;

    // 创建一个带有 CLUSTER_NODE_HANDSHAKE 标记的 cluster node，名字随机
    node = createClusterNode(NULL,CLUSTER_NODE_HANDSHAKE);
    nodeIp2String(node->ip,link); // ip 和 port 信息均从 link 中获得
    node->port = ntohs(hdr->port);

    clusterAddNode(node);
    clusterDoBeforeSleep(CLUSTER_TODO_SAVE_CONFIG);
}
.....
clusterSendPing(link,CLUSTERMSG_TYPE_PONG);
```

由于这时 B 节点还不认识 A 节点，因此 B 节点从自己的 nodes 中找 A 节点是找不到的，所以 sender 是空，因此会走进如上的这段逻辑。同样以随机的名字，CLUSTER_NODE_HANDSHAKE 为 flag 创建一个 node，加入自己的 nodes 中。

**在这个逻辑末尾会给 A 节点回复一个 PONG 消息**。

### 四、A 节点处理 B 节点回复的 PONG 消息

同样是在 `clusterProcessPacket` 中处理 gossip 消息。

```c
if (type == CLUSTERMSG_TYPE_PING || type == CLUSTERMSG_TYPE_PONG || type == CLUSTERMSG_TYPE_MEET) {
    ... ...
    if (link->node) {
        if (nodeInHandshake(link->node)) { // node 处于握手状态
            ... ...
            clusterRenameNode(link->node, hdr->sender); // 修正节点名
            link->node->flags &= ~CLUSTER_NODE_HANDSHAKE; // 消除 handshake 状态
            link->node->flags |= flags&(CLUSTER_NODE_MASTER|CLUSTER_NODE_SLAVE);
            clusterDoBeforeSleep(CLUSTER_TODO_SAVE_CONFIG);
        }
}
```

这个时候 A 节点会根据 B 节点发来的消息，更正 A 节点 nodes 中关于 B 节点的名字，以及消除 **handshake** 状态。

### 五、B 节点发送 PING 消息给 A 节点

当 B 节点在做 `clusterCron` 时，发现自己看到的 A 节点中的 link 为空，即 `node->link == NULL`，这与上面讲的 A 节点给 B 节点发 MEET 消息类似，不过在 B 节点看了 A 节点没有 meet flag，因此发送的是 PING 消息。

### 六、A 节点处理 B 节点发来的 PING 消息

做一些逻辑，不过跟这次要讨论的事情无关，后面会详写。

**对于 PING 和 MEET 消息，无论如何都是会回复一个 PONG 消息的**。

### 七、B 节点处理 A 节点回复的 PONG 消息

逻辑同上，将 B 节点的 nodes 中 A 节点的名字进行更正，然后去掉 A 节点的 handshake flag。

### 补充

上面流程的**第四步**之后，在 A 看来 B 节点就已经是个完好的节点了，且建立了 A 到 B 的 link。实际上，上面的**第五至七步**是不确定的，可能存在如下并行逻辑，即，

A 节点恰好选中了 B 节点发送 PING 消息，当 B 节点接收到这个 PING 消息后，填充自己看到的 A 节点，消除掉 handshake 状态，但是此时 B 节点的 `server.cluster->nodes` 中到 A 节点的 link 仍然是空，即，没办法给 A 发 gossip 消息。

这两个逻辑哪个先发生不一定，但是最终的状态都是，A 节点与 B 节点之间有两条 link，一条是 A 节点创建的到 B 节点的 link，一条是 B 节点创建的到 A 节点的 link。两个节点地位一样，可以同时给对方发信息，如果只保留一条 link 其实也是可以的，不过逻辑会复杂很多，不方便。



## 小结

至此，一个 `cluster meet` 命令执行的完整过程就解释清楚了，画了一个流程图可以帮助更好的理解这个流程。

![cluster meet](http://ww1.sinaimg.cn/mw690/71ca8e3cly1fycksh2170j20pu0nbjst.jpg)
