---
title: Redis 源码之 cluster meet
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: c62267d
date: 2018-12-10 00:02:03
---

本文主要用来厘清`cluster meet` 命令执行后，一个节点如何加入集群，重点关注各节点路由打平。

<!--more---->
一个新启动的节点 B 想要加入一个已有的 cluster，选 cluster 中一个节点 A，在 A 上 meet B。整个流程如下图所示，

![](https://gitee.com/happencc/pics/raw/master/images/cluster-meet.jpg)

图上大致可以分为 3 个阶段：
- A 通过 meet msg 的 pong 回包，更改 A 对 B 的认识
- B 更过 ping msg 的 pong 回包，更改 B 对 A 的认识
- 在来自 A 的 ping or pong msg， B 更新自己看到的 A 的 slot 信息

### 1. 老节点 A add 新节点 B

A 节点在 clusterCommand 函数中，接到 `CLUSTER MEET` 命令，即

```c
if (!strcasecmp(c->argv[1]->ptr,"meet") && c->argc == 4) {
    long long port;

    // CLUSTER MEET <ip> <port>
    ......
    if (clusterStartHandshake(c->argv[2]->ptr,port) == 0 && errno == EINVAL)
    {
        ......
    } else {
        addReply(c,shared.ok);
    }
}
```

可以看到，主要在 `clusterStartHandshake` 函数里。

```c
int clusterStartHandshake(char *ip, int port) {
    clusterNode *n;
    /* IP and Port sanity check */
    ......

    // 检查节点 norm_ip:port 是否正在握手
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
        // 40 字节随机字符串
        getRandomHexChars(node->name, CLUSTER_NAMELEN);
    node->ctime = mstime(); // mstime
    node->configEpoch = 0;
    node->link = NULL; // link 为空, 在 clusterCron 中能检查的到
    ......
    return node;
}
```

首先进行一些 ip 和 port 的合理性检查，然后去遍历所看到的所有 node，这个 ip:port 对应的 node 是不是正处于 `CLUSTER_NODE_HANDSHAKE` 状态，如果是，说明重复 meet 了 B 节点，没必要做重复操作。

之后，通过 `createClusterNode` 函数创建一个带有 `CLUSTER_NODE_HANDSHAKE|CLUSTER_NODE_MEET` 标记的节点，名字为一个**随机**的 40 字节字符串，通过 `clusterAddNode` 函数加到本地路由表中。

<p class="note note-info">这个时候对 A 来说，只知道 B 的 ip 和 port，其他信息一概不知道，因此在初始化 B 时，name 使用的是随机字符串</p>

这个过程成功后，就返回给客户端 OK 了，其他事情需要通过 gossip 通信去完成。

### 2. 老节点 A meet 新节点 B
在上面的过程中，A 节点上新建的 B  link 为空，这在周期函数  `clusterCron`  中被检查到，进而触发 meet msg。

A 节点在定时任务 `clusterCron` 中，会做一些事情。

```c
di = dictGetSafeIterator(server.cluster->nodes); // 遍历所有节点
while((de = dictNext(di)) != NULL) {
    clusterNode *node = dictGetVal(de);

    //忽略掉 myself 和 noaddr 状态的节点
    // 无法建连接
    if (node->flags & (CLUSTER_NODE_MYSELF|CLUSTER_NODE_NOADDR)) continue;
    ......

    // 刚刚收到 cluster meet 命令创建的新 node ，或是 server 刚启动，或是由于某种原因断开了
    if (node->link == NULL) {
        int fd;
        mstime_t old_ping_sent;
        clusterLink *link;
        
        // 建连
        fd = anetTcpNonBlockBindConnect(server.neterr, node->ip, 
                                        node->port+CLUSTER_PORT_INCR, NET_FIRST_BIND_ADDR);
        ......
        link = createClusterLink(node);
        link->fd = fd;
        node->link = link;

        // 注册 link->fd 上的可读事件，事件回调函数为 clusterReadHandler
        aeCreateFileEvent(server.el,link->fd,AE_READABLE, clusterReadHandler,link);
        ......
        
        // 发 meet msg
        clusterSendPing(link, node->flags & CLUSTER_NODE_MEET ? CLUSTERMSG_TYPE_MEET : CLUSTERMSG_TYPE_PING);
        node->flags &= ~CLUSTER_NODE_MEET;
    }
}
dictReleaseIterator(di);
```
以 B 的启动端口号+10000 为 gossip 通信端口建立连接，注册可读事件，处理函数为 `clusterReadHandler`。
发送 `CLUSTERMSG_TYPE_MEET` 消息给 B 节点，消除掉 B 节点 flag 中`CLUSTER_NODE_MEET` 状态。

### 3. 新节点 B 处理老节点 A 发来的 MEET

当 B 接收外部发来的 gossip 消息时，回调函数 `clusterAcceptHandler` 进行处理，然后会 accept 对端的 connect（B 作为 server，对端作为 client），注册可读事件，回调函数为 `clusterReadHandler`，基本逻辑如下，

```c
void clusterAcceptHandler(aeEventLoop *el, int fd, void *privdata, int mask) {
    int cport, cfd;
    int max = MAX_CLUSTER_ACCEPTS_PER_CALL;
    ......

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
        link = createClusterLink(NULL);
        link->fd = cfd;
        aeCreateFileEvent(server.el,cfd,AE_READABLE,clusterReadHandler,link);
    }
}
```

<p class="note note-warning">需要注意，</br>上面收到 connnet 请求后创建的 link 中，link-> node 是 null 。
根据 socket 里的信息无法确定 connect 过来的节点是哪个，暂时置空。

明显有别于 clusterCron 里的主动建连，这也是在 gossip 消息处理中，**区分主动发包还是被动收包的依据**。
即 A B 节点之间的 gossip 通信用了两条连接。
</p>

`clusterReadHandler` 回调函数中使用 `clusterProcessPacket` 函数来处理（接收数据过程很简单，不做分析）。


```c
sender = clusterLookupNode(hdr->sender);
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

这时 B 还不认识 A ，因此 B 从本地路由表中找不到 A，所以 sender 是空，执行以上这段逻辑。同样以**随机的名字**，`CLUSTER_NODE_HANDSHAKE` 为 flag 创建一个 node，加入本地路由表。

**最后，给 A 节点回复一个 PONG 消息**。

### 4. 老节点 A 处理新节点 B 回复的 PONG

同样是在 `clusterProcessPacket` 中处理 gossip 消息。

```c
if (type == CLUSTERMSG_TYPE_PING || type == CLUSTERMSG_TYPE_PONG || type == CLUSTERMSG_TYPE_MEET) {
    ... ...
    // 主动发消息一侧收到对方的回包
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

A 会根据 B 发来的消息，更正 A 本地路由表中 B 的名字，以及抹掉`CLUSTER_NODE_HANDSHAKE` 状态。

那么，现在 A 的本地路由中看到的 B 的各种状态已经完全正常。

### 5. 新节点 B 给老节点 A 发 PING

当 B 节点在做周期检查 `clusterCron` 时，发现自己看到的 A 节点的 link 为空，即 `node->link == NULL`，这与步骤 2 类似。

### 6. 老节点 A 处理新节点 B 节点发来的 PING
与上面的步骤 3 类似。
**对于 PING 和 MEET 消息，无论如何都是会回复一个 PONG 消息的**。

### 7. 新节点 B 处理老节点 A 回复的 PONG
与上面的步骤 4 类似。抹掉 B 本地路由表中 A 的  `CLUSTER_NODE_HANDSHAKE` flag。

<p class="note note-warning">这里有一个问题！<br /><br />
处理 pong 后，没有 更新 sender，即更新完 flag 后 sender 依然是 null，所以，后面关于 slots 处理的事情就没办法做了！只能等到下一次交互，即图上的第 3 部分。</p>

### 8. 更新路由
步骤 7 结束后，新节点 B 在本地路由表中看到的 A 是没有 slots 的，这需要额外一次 gossip 交互，必须是 B 认识 A 后，才能进行路由的变更。

----

### 补充
步骤 1~3 是确定的，因为网络的不确定性， A 节点时先收到 B 回复的 pong（步骤 4），还是 B 主动发的 ping（步骤 5），顺序是不确定的。但未更新名字之前，老节点 A 还不是认识新节点 B，因此，这不会导致异常状态。

另外，节点在处理 gossip 消息时，更新完新节点的名字后，并不会接着进行 slots 的更新操作。如果同时更新 sender，那是否可以缩短交互次数呢？

在进行集群扩容时，在新节点上 meet 原集群节点效率会更高。




