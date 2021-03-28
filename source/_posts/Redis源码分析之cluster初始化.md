---
title: Redis 源码之 cluster 初始化
tags:
  - redis
categories: 源码系列
index_img: 'https://gitee.com/happencc/pics/raw/master/images/redis.png'
abbrlink: 3800d1bd
date: 2018-12-09 00:02:03
---
Redis Cluster 是官方提出的 redis 分布式集群解决方案，在此之前，也有一些第三方的可选方案，如 codis、Twemproxy 等。
cluster 内部使用了 gossip 协议进行通信，以达到数据的最终一致性。详细介绍可参考官网 [Redis cluster tutorial](https://redis.io/topics/cluster-tutorial)。

<!--more---->

当  redis server  以 cluster mode 启动时，即配置文件中的 `cluster-enabled` 选项设置为 `true`，会有一个 cluster 相关数据结构初始化的流程，在之前的文章 [**Redis 启动流程**](https://happencc.gitee.io/35a9decf.html)中提到过，即执行函数 `clusterInit`。

### 初始化 cluster 信息

有 3 个数据结构很重要， `clusterState` 、 `clusterNode` 和 `clusterLink`。
每个节点都有一个 `clusterState`，记录了在"我"的视角下，集群目前所处的状态。
每个节点都会使用一个 `clusterNode` 来记录自己的状态， 并为集群中的所有其他节点都创建一个相应的 `clusterNode` 结构， 以此来记录其他节点的状态。
`clusterNode` 结构的 `link` 是一个 `clusterLink` 结构体， 保存了连接节点的相关信息， 比如套接字描述符，输入缓冲区和输出缓冲区。

更多细节也可以通过 [redis 设计与实现 - 节点](http://redisbook.com/preview/cluster/node.html) 进行了解。

首先创建一个  `clusterState` 结构，并初始化一些成员变量，大概如下：

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

cluster 相关结构体关系图大致如下，
![](https://gitee.com/happencc/pics/raw/master/images/clusternodes.jpg)

### 加载 cluster 配置文件
给 <span class="label label-info">node.conf</span> 文件加锁，确保每个节点读取自己的配置文件。

```c
if (clusterLockConfig(server.cluster_configfile) == C_ERR)
    exit(1);
```

借这个机会学习下 redis 如何使用文件锁。

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

然后加载 cluster 配置文件，按照文件信息构建集群路由。

如果加载失败（或配置文件不存在），则以 `REDIS_NODE_MYSELF|REDIS_NODE_MASTER` 为标记，创建一个clusterNode 结构表示自己，置为主节点，并设置自己的名字为一个40字节的随机串；然后将该节点添加到server.cluster->nodes中，这说明这是个新启动的节点，生成的配置文件进行刷盘。

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
### 设置 gossip 消息监听
调用 `listenToPort` 函数，在集群 gossip 通信端口上创建 socket fd 进行监听。其通信端口是在 **Redis 监听端口基础上加 10000**，比如，如果 Redis 监听客户端的端口（即启动端口）为 6379，则集群监听端口就是16379，该端口用于接收其他集群节点发送过来的 gossip 消息。

注册监听端口上的可读事件，事件回调函数为 `clusterAcceptHandler`。

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

当前节点收到其他集群节点发来的 TCP 建链请求之后，就会调用 `clusterAcceptHandler` 函数 accept 连接，对于每个已经 accept 的连接，都会创建一个`clusterLink` 结构，并注册 socket fd 上的可读事件，事件回调函数为 `clusterReadHandler`。

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

最后是 mf 相关的参数的初始化，在 `resetManualFailover` 函数。