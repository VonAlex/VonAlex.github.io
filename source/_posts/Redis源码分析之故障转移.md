---
title: Redis 源码之故障转移
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: 54df012b
date: 2019-01-31 16:13:30
---
在 Redis cluster 中故障转移是个很重要的功能，下面就从故障发现到故障转移整个流程做一下详细分析。

<!--more---->

## 1. 故障检测

### 1.1 PFAIL 标记

集群中每个节点都会定期向其他节点发送 **PING** 消息，以此来检测对方是否在线，如果接收 **PING** 消息的节点 B 没有在规定时间（**cluster_node_timeout**）内回应节点 A **PONG** 消息，那么节点 A 就会将节点 B 标记为疑似下线（probable fail,  **PFAIL**）。

```c
void clusterCron(void) {
    // ...
    di = dictGetSafeIterator(server.cluster->nodes);
    while((de = dictNext(di)) != NULL) {
        clusterNode *node = dictGetVal(de);
        now = mstime(); /* Use an updated time at every iteration. */
        // ...
        delay = now - node->ping_sent;
        if (delay > server.cluster_node_timeout) {
            /* Timeout reached. Set the node as possibly failing if it is
             * not already in this state. */
            if (!(node->flags & (CLUSTER_NODE_PFAIL|CLUSTER_NODE_FAIL))) {
                node->flags |= CLUSTER_NODE_PFAIL;
                update_state = 1;
            }
        }
    }
    dictReleaseIterator(di);
    // ...
}
```

可以看到，在 `clusterCron` 函数中如果对节点 B 发出 PING 消息，在 **server.cluster_node_timeout** 时间内没有收到其返回的 PONG 消息，如果节点 B 现在没有被标记成 **CLUSTER_NODE_PFAIL** 状态，那么现在就做下这个标记。
可以根据 **ping_sent** 参数进行判断的依据如下，

```c
int clusterProcessPacket(clusterLink *link) {
    // ...
    if (link->node && type == CLUSTERMSG_TYPE_PONG) {
        link->node->pong_received = mstime();
        link->node->ping_sent = 0;
        // ...
    }
    // ...
}
```

当节点 A 接收到节点 B 的 PONG 消息时，会把 **ping_sent** 更新成 0，同时记下收到本次 PONG 消息的时间。
上面提到的 clusterNode 与 clusterLink 有如下关联关系：
![](http://ww1.sinaimg.cn/large/71ca8e3cly1fzpznib0gij20ff07qjrt.jpg)

可以看出， clusterLink 就是为了接收对端 gossip 消息而设置的。
另外，我们发现， 在上面的 `clusterCron` 函数中将节点标记成 PFAIL 时，会将 update_state 变量置为 1，这会引发后面更改集群状态的逻辑。

```c
if (update_state || server.cluster->state == CLUSTER_FAIL)
    clusterUpdateState();
```
集群有两个状态，**CLUSTER_OK** 和  **CLUSTER_FAIL**，如果集群目前状态是 CLUSTER_FAIL，且设置了参数 `cluster-require-full-coverage yes`，那么此时访问集群会返回错误，意思是可能有某些 slot 没有被 server 接管。
`clusterUpdateState` 函数负责更新集群状态，该部分逻辑与本篇博文要讲的主逻辑关系不大，所以放到了后面的**补充章节**中了。

### 1.2 FAIL 标记

#### 1.2.1 主动标记 FAIL

被节点 A 标记成 FAIL/ PFAIL 的节点如何让节点 C 知道呢？这主要是通过平常发送的 PING/PONG 消息实现的，在 3.x 的版本时，会尽最大努力把这样的节点放到 gossip 消息的流言部分，到后面的 4.x 版本的代码中每次的 PING/PONG 消息都会把 PFAIL 节点都带上。
`clusterProcessGossipSection` 函数用来处理 gossip 消息的流言部分。

```c
void clusterProcessGossipSection(clusterMsg *hdr, clusterLink *link) {
    uint16_t count = ntohs(hdr->count);
    clusterMsgDataGossip *g = (clusterMsgDataGossip*) hdr->data.ping.gossip;
    clusterNode *sender = link->node ? link->node : clusterLookupNode(hdr->sender);
    while(count--) {
        // ...
        node = clusterLookupNode(g->nodename);
        if (node) {
            if (sender && nodeIsMaster(sender) && node != myself) {
                if (flags & (CLUSTER_NODE_FAIL|CLUSTER_NODE_PFAIL)) {
                    if (clusterNodeAddFailureReport(node,sender)) {
                        serverLog(LL_VERBOSE,
                           "Node %.40s reported node %.40s as not reachable.",
                            sender->name, node->name);
                    }
                    markNodeAsFailingIfNeeded(node);
                } else {
                // ...
                }
            }
        // ...
        }
    // ...
    }
    // ...
}
```
该函数依次处理 gossip 消息流言部分携带的各节点信息（总节点数的1/10）。当发现带有 CLUSTER_NODE_FAIL 或者 CLUSTER_NODE_PFAIL 时会调用 `clusterNodeAddFailureReport` 函数。
```c
int clusterNodeAddFailureReport(clusterNode *failing, clusterNode *sender) {
    list *l = failing->fail_reports;
    listNode *ln;
    listIter li;
    clusterNodeFailReport *fr;

    /* If a failure report from the same sender already exists, just update
     * the timestamp. */
    listRewind(l,&li);
    while ((ln = listNext(&li)) != NULL) {
        fr = ln->value;
        if (fr->node == sender) {
            fr->time = mstime();
            return 0;
        }
    }

    /* Otherwise create a new report. */
    fr = zmalloc(sizeof(*fr));
    fr->node = sender;
    fr->time = mstime();
    listAddNodeTail(l,fr);
    return 1;
}
```
每一个节点都有一个名为 fail_reports 的 list 结构的变量，用来搜集该异常节点获得了集群中哪些节点的 PFAIL 状态投票。fail_reports 每个成员都是一个 clusterNodeFailReport 结构。
```c
typedef struct clusterNodeFailReport {
    struct clusterNode *node;  /* Node reporting the failure condition. */
    mstime_t time;             /* Time of the last report from this node. */
} clusterNodeFailReport;
```

clusterNodeFailReport 中带有时间戳，标记这个节点上一次被报上来处于异常状态的时间。
每次调用 `clusterNodeAddFailureReport` 函数时，先会检查sender 是否已经为该异常节点投票过了，如果有，更新时间戳，如果没有，把 sender 加入到投票节点中。
简单点说就是，在 A 节点看来 B 节点是  PFAIL 状态，在 gossip 通信中把它告诉了 C 节点，C 节点发现这个异常状态的节点，检查一下为 B 节点投过票的节点中有没有  A 节点，如果没有就加进去。

然后下面就是判断 PFAIL 状态是不是要转变成 FAIL 状态的关键。

```c
void markNodeAsFailingIfNeeded(clusterNode *node) {
    int failures;
    int needed_quorum = (server.cluster->size / 2) + 1;

    if (!nodeTimedOut(node)) return; /* We can reach it. */
    if (nodeFailed(node)) return; /* Already FAILing. */

    failures = clusterNodeFailureReportsCount(node);
    /* Also count myself as a voter if I'm a master. */
    if (nodeIsMaster(myself)) failures++;
    if (failures < needed_quorum) return; /* No weak agreement from masters. */

    serverLog(LL_NOTICE, "Marking node %.40s as failing (quorum reached).", node->name);

    /* Mark the node as failing. */
    node->flags &= ~CLUSTER_NODE_PFAIL;
    node->flags |= CLUSTER_NODE_FAIL;
    node->fail_time = mstime();

    /* Broadcast the failing node name to everybody, forcing all the other
     * reachable nodes to flag the node as FAIL. */
    if (nodeIsMaster(myself)) clusterSendFail(node->name); /* 广播这个节点的 fail 消息 */
    clusterDoBeforeSleep(CLUSTER_TODO_UPDATE_STATE|CLUSTER_TODO_SAVE_CONFIG);
}
```
C 节点收到消息，检查下 A 报过来的异常节点 B，在自己看来是否也是 PFAIL 状态的，如果不是，那么不理会 A 节点本次 report。如果在节点 C 看来，节点 B 已经被标记成 FAIL 了，那么就不需要进行下面的判定了。

在函数 `clusterNodeFailureReportsCount` 中会判断计算出把 B 节点标记成 PFAIL 状态的节点的数量 sum，如果 **sum 值小于集群 size 的一半**，为防止误判，忽略掉这条信息。在函数 `clusterNodeFailureReportsCount` 中会检查关于 B 节点的 **clusterNodeFailReport**，清理掉那些**过期的**投票，过期时间为 2 倍的 **server.cluster_node_timeout**。

如果满足条件，节点 C 将节点 B 的 PFAIL 状态消除，标记成 FAIL，同时记下 fail_time，如果 C 节点是个 master，那么将 B 节点 FAIL 的消息广播出去，以便让集群中其他节点尽快知道。

```c
void clusterSendFail(char *nodename) {
    unsigned char buf[sizeof(clusterMsg)];
    clusterMsg *hdr = (clusterMsg*) buf;
    clusterBuildMessageHdr(hdr,CLUSTERMSG_TYPE_FAIL);
    memcpy(hdr->data.fail.about.nodename,nodename,CLUSTER_NAMELEN);
    clusterBroadcastMessage(buf,ntohl(hdr->totlen));
}
```

发送的 gossip 消息类型为 CLUSTERMSG_TYPE_FAIL，广播的节点排除自身和处于 HANDSHAKE 状态节点。

#### 1.2.2 Gossip 被动感知 FAIL

前面说过，gossip 消息的处理函数为 `clusterProcessPacket`，下面看 CLUSTERMSG_TYPE_FAIL 类型的消息如何处理。

```c
int clusterProcessPacket(clusterLink *link) {
    // ...
    uint16_t type = ntohs(hdr->type);
    // ...
    if (type == CLUSTERMSG_TYPE_FAIL) { // fail
        clusterNode *failing;
        if (sender) {
            failing = clusterLookupNode(hdr->data.fail.about.nodename);
            if (failing && !(failing->flags & (CLUSTER_NODE_FAIL|CLUSTER_NODE_MYSELF)))
            {
                serverLog(LL_NOTICE,
                    "FAIL message received from %.40s about %.40s",
                    hdr->sender, hdr->data.fail.about.nodename);
                failing->flags |= CLUSTER_NODE_FAIL;
                failing->fail_time = mstime();
                failing->flags &= ~CLUSTER_NODE_PFAIL;
                clusterDoBeforeSleep(CLUSTER_TODO_SAVE_CONFIG|
                                     CLUSTER_TODO_UPDATE_STATE);
            }
        } else {
            serverLog(LL_NOTICE,
                "Ignoring FAIL message from unknown node %.40s about %.40s",
                hdr->sender, hdr->data.fail.about.nodename);
        }
    }
    // ...
}
```

集群中另一个节点 D 收到节点 B 广播过来的消息：B 节点 FAIL 了。如果 D 还没有把 B 标记成 FAIL，那么标记成 CLUSTER_NODE_FAIL，并取消 CLUSTER_NODE_PFAIL 标记；否则，忽略，因为D已经知道 B 是 FAIL 节点了。

## 2. 故障转移

failover 分为两类，主动 failover（主动切主从）以及被动 failover（被动切主从），下面挨个进行分析。

### 2.1 被动 failover

#### 2.1.1 先验条件及初始化

```c
void clusterCron(void) {
    // ...
    if (nodeIsSlave(myself)) {
        clusterHandleSlaveFailover();
        // ...
    }
    // ...
}
```
是否要做被动主从切换，在 `clusterHandleSlaveFailover` 函数中有如下的判断逻辑，
```c
if (nodeIsMaster(myself) ||
    myself->slaveof == NULL ||
    (!nodeFailed(myself->slaveof) && !manual_failover) ||
    myself->slaveof->numslots == 0)
{
    /* There are no reasons to failover, so we set the reason why we
     * are returning without failing over to NONE. */
    server.cluster->cant_failover_reason = CLUSTER_CANT_FAILOVER_NONE;
    return;
}
```

只有满足如下条件的节点才有资格做 failover：
- slave 节点
-  master 不为空
-  master 负责的 slot 数量不为空
-  master 被标记成了 FAIL，或者这是一个主动 failover（manual_failover 为真）

假设，现在 B 节点的 slave Bx 节点检测到 B 节点挂掉了，通过了以上的条件测试，接下来就会进行 failover。
那么下面 Bx 节点就开始在集群中进行拉票，该逻辑也在 `clusterHandleSlaveFailover` 函数中。

```c
mstime_t auth_age = mstime() - server.cluster->failover_auth_time;
int needed_quorum = (server.cluster->size / 2) + 1;
mstime_t auth_timeout, auth_retry_time;

auth_timeout = server.cluster_node_timeout*2;
if (auth_timeout < 2000) auth_timeout =2000 ;
auth_retry_time = auth_timeout*2;
```
cluster 的 **failover_auth_time** 属性，表示 slave 节点开始进行故障转移的时刻。集群初始化时该属性置为 0，一旦满足 failover 的条件后，该属性就置为**未来的某个时间点**（不是立马执行），在该时间点，slave 节点才开始进行拉票。**auth_age** 变量表示从发起 failover 流程开始到现在，已经过去了多长时间。
**needed_quorum** 变量表示当前 slave 节点必须至少获得多少选票，才能成为新的 master。
**auth_timeout** 变量表示当前 slave 发起投票后，等待回应的超时时间，至少为 2s。如果超过该时间还没有获得足够的选票，那么表示本次 failover 失败。
**auth_retry_time** 变量用来判断是否可以开始发起下一次 failover 的时间间隔。

```c
if (server.repl_state == REPL_STATE_CONNECTED) {
    data_age = (mstime_t)(server.unixtime - server.master->lastinteraction) * 1000;
} else {
    data_age = (mstime_t)(server.unixtime - server.repl_down_since) * 1000;
}
if (data_age > server.cluster_node_timeout)
    data_age -= server.cluster_node_timeout;
```
**data_age** 变量表示距离上一次与我的 master 节点交互过去了多长时间。经过 cluster_node_timeout 时间还没有收到 PONG 消息才会将节点标记为 PFAIL 状态。实际上 data_age 表示在 master 节点下线之前，当前 slave 节点有多长时间没有与其交互过了。

> data_age 主要用于判断当前 slave 节点的数据新鲜度；如果 data_age 超过了一定时间，表示当前 slave 节点的数据已经太老了，不能替换掉下线 master 节点，因此在不是手动强制故障转移的情况下，直接返回。

#### 2.1.2 制定 failover 时间

```c
void clusterHandleSlaveFailover(void) {
    // ...
    if (auth_age > auth_retry_time) {
        server.cluster->failover_auth_time = mstime() +
            500 + /* Fixed delay of 500 milliseconds, let FAIL msg propagate. */
            random() % 500; /* Random delay between 0 and 500 milliseconds. */
        server.cluster->failover_auth_count = 0;
        server.cluster->failover_auth_sent = 0;
        server.cluster->failover_auth_rank = clusterGetSlaveRank();
        /* We add another delay that is proportional to the slave rank.
         * Specifically 1 second * rank. This way slaves that have a probably
         * less updated replication offset, are penalized.
         * */
        server.cluster->failover_auth_time +=
            server.cluster->failover_auth_rank * 1000;
        if (server.cluster->mf_end) {
            server.cluster->failover_auth_time = mstime();
            server.cluster->failover_auth_rank = 0;
        }
        // ...
        clusterBroadcastPong(CLUSTER_BROADCAST_LOCAL_SLAVES);
        return;
    }
    // ...
}
```

满足条件（**auth_age > auth_retry_time**）后，发起故障转移流程。
首先设置故障转移发起时刻，即设置 failover_auth_time 时间。

```c
mstime() + 500 + random()%500 + rank*1000
```
固定延时 500ms 是为了让 master fail 的消息能够广泛传播到集群，这样集群中的其他节点才可能投票。
随机延时是为了避免多个你 slave 节点同时发起 failover 流程。
rank 表示 slave 节点的排名，计算方式如下，
```c
int clusterGetSlaveRank(void) {
    long long myoffset;
    int j, rank = 0;
    clusterNode *master;

    serverAssert(nodeIsSlave(myself));
    master = myself->slaveof;
    if (master == NULL) return 0; /* Never called by slaves without master. */

    myoffset = replicationGetSlaveOffset();
    for (j = 0; j < master->numslaves; j++)
        if (master->slaves[j] != myself &&
            master->slaves[j]->repl_offset > myoffset) rank++;
    return rank;
}
```

可以看出，排名主要是根据复制数据量来定，复制数据量越多，排名越靠前（rank 值越小）。这样做是为了做 failover 时尽量选择一个复制数据量较多的 slave，以尽最大努力保留数据。在没有开始拉选票之前，**每隔一段时间**（每次调用`clusterHandleSlaveFailover`函数，也就是每次 cron 的时间）就会调用一次 `clusterGetSlaveRank` 函数，以更新当前 slave 节点的排名。

**注意**，如果是 mf，那么 failover_auth_time 和 failover_auth_rank 都置为 0，表示该 slave 节点现在就可以执行故障转移。

最后向该 master 的所有 slave 广播 PONG 消息，主要是为了更新复制偏移量，以便其他 slave 计算出 failover 时间点。
这时，函数返回，就此开始了一轮新的故障转移，当已经处在某一轮故障转移时，执行接下来的逻辑。

#### 2.1.3 slave 拉选票

首先对于一些不合理的 failover 要过滤掉。

```c
/* Return ASAP if we can't still start the election.
 */
if (mstime() < server.cluster->failover_auth_time) {
    clusterLogCantFailover(CLUSTER_CANT_FAILOVER_WAITING_DELAY);
    return;
}

/* Return ASAP if the election is too old to be valid.
 * failover 超时
 */
if (auth_age > auth_timeout) {
    clusterLogCantFailover(CLUSTER_CANT_FAILOVER_EXPIRED);
    return;
}
```
然后开始拉选票。
```c
if (server.cluster->failover_auth_sent == 0) {
    server.cluster->currentEpoch++; // 增加当前节点的currentEpoch的值，表示要开始新一轮选举了
    server.cluster->failover_auth_epoch = server.cluster->currentEpoch;
    serverLog(LL_WARNING,"Starting a failover election for epoch %llu.",
              (unsigned long long) server.cluster->currentEpoch);

    /* 向所有节点发送 CLUSTERMSG_TYPE_FAILOVER_AUTH_REQUEST 消息，开始拉票*/
    clusterRequestFailoverAuth();
    server.cluster->failover_auth_sent = 1; // 表示已经发起了故障转移流程
    clusterDoBeforeSleep(CLUSTER_TODO_SAVE_CONFIG|
                         CLUSTER_TODO_UPDATE_STATE|
                         CLUSTER_TODO_FSYNC_CONFIG);
    return; /* Wait for replies. */
}
```
如果 **failover_auth_sent** 为 0，表示没有发起过投票，那么将 currentEpoch 加 1，记录 failover_auth_epoch 为 currentEpoch，函数 `clusterRequestFailoverAuth` 用来发起投票，failover_auth_sent 置 1，表示该 slave 已经发起过投票了。
```c
void clusterRequestFailoverAuth(void) {
    unsigned char buf[sizeof(clusterMsg)];
    clusterMsg *hdr = (clusterMsg*) buf;
    uint32_t totlen;

    clusterBuildMessageHdr(hdr,CLUSTERMSG_TYPE_FAILOVER_AUTH_REQUEST);
    /* If this is a manual failover, set the CLUSTERMSG_FLAG0_FORCEACK bit
     * in the header to communicate the nodes receiving the message that
     * they should authorized the failover even if the master is working. */
    if (server.cluster->mf_end) hdr->mflags[0] |= CLUSTERMSG_FLAG0_FORCEACK;
    totlen = sizeof(clusterMsg)-sizeof(union clusterMsgData);
    hdr->totlen = htonl(totlen);
    clusterBroadcastMessage(buf,totlen);
}
```
`clusterRequestFailoverAuth` 函数向集群广播 **CLUSTERMSG_TYPE_FAILOVER_AUTH_REQUEST** 类型的 gossip 信息，这类型的信息就是向集群中的 master 节点索要本轮选举中的选票。另外，如果是 mf，那么会在 gossip hdr 中带上 **CLUSTERMSG_FLAG0_FORCEACK** 信息。

#### 2.1.4 其他 master 投票

```c
else if (type == CLUSTERMSG_TYPE_FAILOVER_AUTH_REQUEST) {
    if (!sender) return 1;  /* We don't know that node. */
    clusterSendFailoverAuthIfNeeded(sender,hdr);
}
```
在 `clusterProcessPacket` 函数中处理 gossip 消息，当接收到 **CLUSTERMSG_TYPE_FAILOVER_AUTH_REQUEST** 类型的消息时，调用 `clusterSendFailoverAuthIfNeeded` 函数处理，在满足条件的基础上，给 sender 投票。

注：以下若不进行特殊说明，都是 `clusterSendFailoverAuthIfNeeded` 函数处理逻辑。

##### 2.1.4.1 筛掉没资格投票的节点

```c
 if (nodeIsSlave(myself) || myself->numslots == 0) return;
```
<i class="fa fa-times" aria-hidden="true"></i>  slave 节点或者不负责 slot 的 master 节点

##### 2.1.4.2 筛掉不需要投票的 sender

```c
uint64_t requestCurrentEpoch = ntohu64(request->currentEpoch);
if (requestCurrentEpoch < server.cluster->currentEpoch) {
    serverLog(LL_WARNING,
              "Failover auth denied to %.40s: reqEpoch (%llu) < curEpoch(%llu)",
              node->name,
              (unsigned long long) requestCurrentEpoch,
              (unsigned long long) server.cluster->currentEpoch);
    return;
}
```
<i class="fa fa-times" aria-hidden="true"></i>  sender 节点集群信息过旧。
正常来说，如果 receiver 在接收到 sender 的 CLUSTERMSG_TYPE_FAILOVER_AUTH_REQUEST 消息之前接收了 PING/PONG 消息，会更新自己的 currentEpoch，这时 currentEpoch 会增加，因为 sender 发起选举之前，会先增加自身的currentEpoch；否则的话，receiver 的 currentEpoch 应该小于 sender。因此 sender 的 currentEpoch 应该 **>=**  receiver 的。有可能 sender 是个长时间下线的节点刚刚上线，这样的节点不能给他投票，因为它的集群信息过旧。

```c
if (server.cluster->lastVoteEpoch == server.cluster->currentEpoch) {
    serverLog(LL_WARNING,
              "Failover auth denied to %.40s: already voted for epoch %llu",
              node->name,
              (unsigned long long) server.cluster->currentEpoch);
    return;
}
```
<i class="fa fa-times" aria-hidden="true"></i>  receiver 节点在本轮选举中已经投过票了，避免两个 slave 节点同时赢得本界选举。
lastVoteEpoch 记录了在本轮投票中 receiver 投过票的 sender 的 currentEpoch。各 slave 节点独立发起选举，currentEpoch 是相同的，都在原来的基础上加 1。

```c
clusterNode *master = node->slaveof;
if (nodeIsMaster(node) || master == NULL || (!nodeFailed(master) && !force_ack))
{
    if (nodeIsMaster(node)) {
        serverLog(LL_WARNING,
                  "Failover auth denied to %.40s: it is a master node",
                  node->name);
    } else if (master == NULL) {
        serverLog(LL_WARNING,
                  "Failover auth denied to %.40s: I don't know its master",
                  node->name);
    } else if (!nodeFailed(master)) {
        serverLog(LL_WARNING,
                  "Failover auth denied to %.40s: its master is up",
                  node->name);
    }
    return;
}
```
<i class="fa fa-times" aria-hidden="true"></i>  sender 是个 master。
<i class="fa fa-times" aria-hidden="true"></i>  sender 是个没有 master 的 slave。
<i class="fa fa-times" aria-hidden="true"></i>  sender 的 master 没有 fail，且不是个 mf。

```c
if (mstime() - node->slaveof->voted_time < server.cluster_node_timeout * 2)
{
    serverLog(LL_WARNING,
              "Failover auth denied to %.40s: "
              "can't vote about this master before %lld milliseconds",
              node->name,
              (long long) ((server.cluster_node_timeout*2) - (mstime() - node->slaveof->voted_time)));
    return;
}
```
<i class="fa fa-times" aria-hidden="true"></i>  两次投票时间间隔**不能少于 2 倍 的 cluster_node_timeout**。
这个裕量时间，使得获得赢得选举的 slave 将新的主从关系周知集群其他节点，避免其他 slave 发起新一轮的投票。
```c
uint64_t requestConfigEpoch = ntohu64(request->configEpoch);
unsigned char *claimed_slots = request->myslots;
for (j = 0; j < CLUSTER_SLOTS; j++) {
    if (bitmapTestBit(claimed_slots, j) == 0) continue;
    if (server.cluster->slots[j] == NULL ||
        server.cluster->slots[j]->configEpoch <= requestConfigEpoch)
    {
        continue;
    }
    /* If we reached this point we found a slot that in our current slots
         * is served by a master with a greater configEpoch than the one claimed
         * by the slave requesting our vote. Refuse to vote for this slave. */
    serverLog(LL_WARNING,
              "Failover auth denied to %.40s: "
              "slot %d epoch (%llu) > reqEpoch (%llu)",
              node->name, j,
              (unsigned long long) server.cluster->slots[j]->configEpoch,
              (unsigned long long) requestConfigEpoch);
    return;
}
```
<i class="fa fa-times" aria-hidden="true"></i>  sender 节点声称要接管的 slots，在 receiver 节点看来其中有个别 slot 原来负责节点的 configEpoch 要比 sender 的大，这说明 sender 看到的集群消息太旧了，这可能是一个长时间下线又重新上线的节点。

##### 2.1.4.3 在本轮选举投票

```c
clusterSendFailoverAuth(node);
server.cluster->lastVoteEpoch = server.cluster->currentEpoch;
node->slaveof->voted_time = mstime(); // 更新投票时间
```
`clusterSendFailoverAuth` 函数中发送 **CLUSTERMSG_TYPE_FAILOVER_AUTH_ACK** 类型的 gossip 消息，这就算在本轮选举中投票了，并记录本轮投票的 epoch以及投票时间。

#### 2.1.5 slave 统计选票

slave 接收到 **CLUSTERMSG_TYPE_FAILOVER_AUTH_ACK** 类型的 gossip 消息，就算统计到一票。
```c
else if (type == CLUSTERMSG_TYPE_FAILOVER_AUTH_ACK) { // slave 统计票数
    if (!sender) return 1;  /* We don't know that node. */
    /* We consider this vote only if the sender is a master serving
         * a non zero number of slots, and its currentEpoch is greater or
         * equal to epoch where this node started the election. */
    if (nodeIsMaster(sender) && sender->numslots > 0 &&
        senderCurrentEpoch >= server.cluster->failover_auth_epoch)
    {
        server.cluster->failover_auth_count++;
        /* Maybe we reached a quorum here, set a flag to make sure
             * we check ASAP. */
        clusterDoBeforeSleep(CLUSTER_TODO_HANDLE_FAILOVER);
    }
}
```
sender 是个负责 slot 的 master 并且满足 currentEpoch 的要求，那么这张选票有效。出现 `senderCurrentEpoch < server.cluster->failover_auth_epoch` 的情况时有可能的，如果这张选票是上一轮选举的获得选票，就不能作数。
failover_auth_count 变量中记录了 slave 在本轮选举中获得选票数目。

#### 2.1.6 slave 做主从切换

```c
void clusterHandleSlaveFailover(void) {
    // ...
    int needed_quorum = (server.cluster->size / 2) + 1;
    if (server.cluster->failover_auth_count >= needed_quorum) {
        /* We have the quorum, we can finally failover the master. */
        serverLog(LL_WARNING,
                  "Failover election won: I'm the new master.");

        /* Update my configEpoch to the epoch of the election. */
        if (myself->configEpoch < server.cluster->failover_auth_epoch) {
            myself->configEpoch = server.cluster->failover_auth_epoch;
            serverLog(LL_WARNING,
                      "configEpoch set to %llu after successful failover",
                      (unsigned long long) myself->configEpoch);
        }

        /* Take responsability for the cluster slots. */
        clusterFailoverReplaceYourMaster();
    } else {
        clusterLogCantFailover(CLUSTER_CANT_FAILOVER_WAITING_VOTES);
    }
}
```

slave 节点获得足够多选票后， 成为新的 master 节点。
更新自己的 configEpoch 为**选举协商**的 failover_auth_epoch，这是本节点就获得了最新当前集群最大的 configEpoch，表明它看到的集群信息现在是最新的。
最后调用 `clusterFailoverReplaceYourMaster` 函数取代下线主节点，成为新的主节点，并向其他节点广播这种变化。

```c
void clusterFailoverReplaceYourMaster(void) {
    int j;
    clusterNode *oldmaster = myself->slaveof;

    if (nodeIsMaster(myself) || oldmaster == NULL) return;

    /* 1) Turn this node into a master. */
    /* 把 myself 标记为 master，并从原 master 里删掉，更新原 master 的涉及 slave 的参数，
     * 如果 slave 数量为0,去掉它的 CLUSTER_NODE_MIGRATE_TO 标记
     */
    clusterSetNodeAsMaster(myself);

    /* 取消主从复制过程，将当前节点升级为主节点 *、
    replicationUnsetMaster();

    /* 2) Claim all the slots assigned to our master.
     * 接手老的 master 节点负责的槽位
     */
    for (j = 0; j < CLUSTER_SLOTS; j++) {
        if (clusterNodeGetSlotBit(oldmaster,j)) {
            clusterDelSlot(j);
            clusterAddSlot(myself,j);
        }
    }

    /* 3) Update state and save config. */
    clusterUpdateState();
    clusterSaveConfigOrDie(1);

    /* 4) Pong all the other nodes so that they can update the state
     *    accordingly and detect that we switched to master role. */
    clusterBroadcastPong(CLUSTER_BROADCAST_ALL);

    /* 5) If there was a manual failover in progress, clear the state. */
    resetManualFailover();
}
```

进行必要的 flag 设置和 slots 交接，向集群广播 PONG 消息，并进行善后处理。

#### 2.1.7 集群其他节点感知主从变化

```c
if (type == CLUSTERMSG_TYPE_PING || type == CLUSTERMSG_TYPE_PONG || type == CLUSTERMSG_TYPE_MEET) {
    // ...
    /* Check for role switch: slave -> master or master -> slave. */
    if (sender) {
        if (!memcmp(hdr->slaveof, CLUSTER_NODE_NULL_NAME, sizeof(hdr->slaveof)))
        {
            /* Node is a master. set master flag for sender */
            clusterSetNodeAsMaster(sender);
        }
        // ...
    }
    clusterNode *sender_master = NULL; /* Sender or its master if slave. */
    int dirty_slots = 0; /* Sender claimed slots don't match my view? */

    if (sender) {
        sender_master = nodeIsMaster(sender) ? sender : sender->slaveof;
        if (sender_master) {
            dirty_slots = memcmp(sender_master->slots, hdr->myslots, sizeof(hdr->myslots)) != 0;
        }
    }

    if (sender && nodeIsMaster(sender) && dirty_slots)
        clusterUpdateSlotsConfigWith(sender,senderConfigEpoch,hdr->myslots);
    // ...
}
```
集群中其他节点接收到 PONG 消息后，对 sender 进行正确的 role 标记，以某节点 D 为例。
对于刚刚做完故障转移的 slave，也即现在 master，在节点 D 看来它负责的 slot 是空的，所以 dirty_slots 为 1。
之后调用 `clusterUpdateSlotsConfigWith` 函数处理 slots 的 dirty diff 信息。

至此 failover 的逻辑就已经基本完成。

### 2.2 主动 failover

除了上面的发现故障后集群自动 failover，也可以进行主动的主从切换。

#### 2.2.1 slave 节点接受 cluster failover 命令

主动 failover 是通过 redis 命令实现的，命令格式为 `CLUSTER FAILOVER [FORCE|TAKEOVER]`，该命令使用详情可以参考这篇[文档](http://www.redis.cn/commands/cluster-failover.html)。

```c
#define CLUSTER_MF_TIMEOUT 5000
else if (!strcasecmp(c->argv[1]->ptr,"failover") && (c->argc == 2 || c->argc == 3)){
    /* CLUSTER FAILOVER [FORCE|TAKEOVER] */
    int force = 0, takeover = 0;

    if (c->argc == 3) {
        /* 不与 master 沟通，主节点也不会阻塞其客户端，需要经过选举 */
        if (!strcasecmp(c->argv[2]->ptr,"force")) {
            force = 1;
        /* 不与 master 沟通，不经过选举 */
        } else if (!strcasecmp(c->argv[2]->ptr,"takeover")) {
            takeover = 1;
            force = 1; /* Takeover also implies force. */
        /* 与 master 沟通，需要经过选举 */
        } else {
            addReply(c,shared.syntaxerr);
            return;
        }
    }
    // ...
    server.cluster->mf_end = mstime() + CLUSTER_MF_TIMEOUT; // mf 的超时时间为 5s
}
```
cluster failover 命令有三种不同的选项，各有不同的含义，如上面注释所说。takeover 变量标记是否要经过选举， force 变量标记是否需要与 master 沟通。
另外，mf 过程有一个过期时间，目前定义为 5s，同时， mf_end 也表示现在正在做 mf。
不同的选项有不同的处理方式，如下，

```c
if (takeover) {
    // takeover 不会做任何初始化校验。
    // 不经过其他节点选举协商，直接将该节点的 current epoch 加 1，然后广播这个新的配置
    serverLog(LL_WARNING,"Taking over the master (user request).");
    clusterBumpConfigEpochWithoutConsensus();
    clusterFailoverReplaceYourMaster();
} else if (force) {
    /* If this is a forced failover, we don't need to talk with our
     * master to agree about the offset. We just failover taking over
     * it without coordination. */
    serverLog(LL_WARNING,"Forced failover user request accepted.");
    server.cluster->mf_can_start = 1;// 可以直接开始选举过程
} else {
    serverLog(LL_WARNING,"Manual failover user request accepted.");
    clusterSendMFStart(myself->slaveof); // 发送带有 CLUSTERMSG_TYPE_MFSTART 标记的 gossip 包(只有消息头)给我的 master
}
```

takeover 方式最为粗暴，slave 节点不发起选举，而是直接将自己升级为master，接手原主节点的槽位，增加自己的 configEpoch 后更新配置。`clusterFailoverReplaceYourMaster` 的逻辑在前面讲过，只有在本轮选举中获得足够多的选票才会调用该函数。
force 方式表示可以直接开始选举过程，选举过程也在前面说过了。
现在来看看默认方式，处理逻辑为 `clusterSendMFStart` 函数。该函数主要逻辑就是发送向要做 failover 的 slave 的 master 发送 `CLUSTERMSG_TYPE_MFSTART` 类型的 gossip 消息。

#### 2.2.2 master 节点做 mf 准备

```c
else if (type == CLUSTERMSG_TYPE_MFSTART) {
    /* This message is acceptable only if I'm a master and the sender
     * is one of my slaves. */
    if (!sender || sender->slaveof != myself) return 1;
    /* Manual failover requested from slaves.
     * Initialize the state accordingly.
     * master 收到消息，重置 mf 状态
     */
    resetManualFailover();
    server.cluster->mf_end = mstime() + CLUSTER_MF_TIMEOUT;
    server.cluster->mf_slave = sender;
    pauseClients(mstime()+(CLUSTER_MF_TIMEOUT*2)); // 阻塞客户端 10s
    serverLog(LL_WARNING,"Manual failover requested by slave %.40s.",
              sender->name);
}
```

`resetManualFailover` 函数中重置与 mf 相关的参数，表示这是一次新的 mf。
设置 mf_end，将它的 master 指向 sender（就是那个搞事情的 slave），同时阻塞 client 10s 钟。
随后，标记在做 mf 的 master 发送 PING 信息时 hdr 会带上 **CLUSTERMSG_FLAG0_PAUSED** 标记。

```c
void clusterBuildMessageHdr(clusterMsg *hdr, int type) {
    // ...
      /* Set the message flags. */
    if (nodeIsMaster(myself) && server.cluster->mf_end)
        hdr->mflags[0] |= CLUSTERMSG_FLAG0_PAUSED;
    // ...
}
```
mflags 记录与 mf 相关的 flag。

#### 2.2.3 slave 处理

##### 2.2.3.1 获得 master 的 repl offset

slave 节点处理带有  **CLUSTERMSG_FLAG0_PAUSED** 标记的 gossip 消息。
```c
int clusterProcessPacket(clusterLink *link) {
    // ...
    sender = clusterLookupNode(hdr->sender);
    if (sender && !nodeInHandshake(sender)) {
        // ...
        if (server.cluster->mf_end && // 处于 mf 状态
            nodeIsSlave(myself) &&   // 我是 slave
            myself->slaveof == sender && // 我的 master 是 sender
            hdr->mflags[0] & CLUSTERMSG_FLAG0_PAUSED &&
            server.cluster->mf_master_offset == 0) // 还没有正式开始时，mf_master_offset 设置为 0
        {
            server.cluster->mf_master_offset = sender->repl_offset; // 从 sender 获得 repl_offset
            serverLog(LL_WARNING,
                      "Received replication offset for paused "
                      "master manual failover: %lld",
                      server.cluster->mf_master_offset);
        }
    }
    // ...
}
```
对于那个发起 failover 的 slave，记下其 master 的 repl_offset，如果之前还没有记录下的话。

##### 2.2.3.2 向 maser 追平 repl offset

``` c
void clusterCron(void) {
    // ...
    if (nodeIsSlave(myself)) {
        clusterHandleManualFailover();
        // ...
    }
    // ...
}

void clusterHandleManualFailover(void) {
    /* Return ASAP if no manual failover is in progress. */
    if (server.cluster->mf_end == 0) return;

    /* If mf_can_start is non-zero, the failover was already triggered so the
     * next steps are performed by clusterHandleSlaveFailover(). */
    if (server.cluster->mf_can_start) return;

    if (server.cluster->mf_master_offset == 0) return; /* Wait for offset... */

    if (server.cluster->mf_master_offset == replicationGetSlaveOffset()) {
        /* Our replication offset matches the master replication offset
         * announced after clients were paused. We can start the failover. */
        server.cluster->mf_can_start = 1;
        serverLog(LL_WARNING,
                  "All master replication stream processed, "
                  "manual failover can start.");
    }
}
```

在 `clusterCron` 函数里有 `clusterHandleManualFailover` 的逻辑。
mf_end 为 0，说明此时没有 mf 发生。
mf_can_start 非 0 值，表示现在可以此 slave 可以发起选举了。
mf_master_offset 为 0，说明现在还没有获得 master 的复制偏移量，需要等一会儿。当 mf_master_offset 值等于 `replicationGetSlaveOffset` 函数的返回值时，把 mf_can_start 置为 1。另外，应该记得，使用带有 force 选项的 `CLUSTER FAILOVER` 命令，直接就会把 mf_can_start 置为 1，而 `replicationGetSlaveOffset` 函数的作用就是检查当前的主从复制偏移量，也就是说主从复制偏移量一定要达到 mf_master_offset 时，slave 才会发起选举，即默认选项有一个追平 repl offset 的过程。

其他一些选举什么的流程跟被动 failover 没有区别。

#### 2.2.4 过期清理 mf

主从节点在周期性的`clusterCron` 中都有一个检查本次 mf 是否过期的函数。

```c
void manualFailoverCheckTimeout(void) {
    if (server.cluster->mf_end && server.cluster->mf_end < mstime()) {
        serverLog(LL_WARNING,"Manual failover timed out.");
        resetManualFailover();
    }
}

void resetManualFailover(void) {
    if (server.cluster->mf_end && clientsArePaused()) {
        server.clients_pause_end_time = 0;
        clientsArePaused(); /* Just use the side effect of the function. */
    }
    server.cluster->mf_end = 0; /* No manual failover in progress. */
    server.cluster->mf_can_start = 0;
    server.cluster->mf_slave = NULL;
    server.cluster->mf_master_offset = 0;
}
```

如果过期没有做 mf ，那么就会重置它的相关参数。

## 3. 附录

### 3.1 epoch 概念

在 Redis cluster 里 epoch 是个非常重要的概念，类似于 raft 算法中的 term 概念。Redis cluster 里主要是两种：currentEpoch 和 configEpoch。

#### 3.1.1 currentEpoch

>  这是一个集群状态相关的概念，可以当做记录集群状态变更的递增版本号。每个集群节点，都会通过server.cluster->currentEpoch 记录当前的 currentEpoch。
>
> 集群节点创建时，不管是主节点还是从节点，都置currentEpoch 为 0。当前节点接收到来自其他节点的包时，如果发送者的currentEpoch（消息头部会包含发送者的currentEpoch）大于当前节点的currentEpoch，那么当前节点会更新 currentEpoch 为发送者的 currentEpoch。因此，集群中所有节点的currentEpoch最终会达成一致，相当于对集群状态的认知达成了一致。

currentEpoch 作用在于，集群状态发生改变时，某节点会先增加自身 currentEpoch 的值，然后向集群中其他节点征求同意，以便执行某些动作。目前，仅用于 slave 节点的故障转移流程，在上面分析中也看到了，在发起选举之前，slave 会增加自己的 currentEpoch，并且得到的 currentEpoch 表示这一轮选举的 voteEpoch，当获得了足够多的选票后才会执行故障转移。

#### 3.1.2 configEpoch

> 这是一个集群节点配置相关的概念，每个集群节点都有自己独一无二的 configepoch。所谓的节点配置，实际上是指节点所负责的 slot 信息。

configEpoch 主要用于解决不同的节点就 slot 归属认知发生冲突的情况。公说公有理婆说婆有理，到底听谁的，configEpoch 越大，看到的集群节点配置信息越新，就越有话语权。对于冲突的情况，后面会有博客进行详细分析。

以下几种情况 configEpoch 会更新：
1. 新节点加入；
2. 槽节点映射冲突检测；（slot 归属变更）
3. 从节点投票选举冲突检测。(主从切换)

递增 node epoch 称为 bump epoch。关于 configEpoch 有三个原则：
1. 如果 epoch 不变, 集群就不应该有变更(包括选举和迁移槽位)。
2. 每个节点的 node epoch 都是独一无二的。
3. 拥有越高 epoch 的节点, 集群信息越新。

### 3.2 clusterUpdateState 函数逻辑

```c
#define CLUSTER_MAX_REJOIN_DELAY 5000
#define CLUSTER_MIN_REJOIN_DELAY 500
#define CLUSTER_WRITABLE_DELAY 2000
void clusterUpdateState(void) {
    // ...
    static mstime_t among_minority_time;
    static mstime_t first_call_time = 0;
    server.cluster->todo_before_sleep &= ~CLUSTER_TODO_UPDATE_STATE;

    /* 时间从第一次调用该函数算起，是为了跳过 DB load 时间。
     * cluster 启动时，状态为 CLUSTER_FAIL，
     * 这里要等待一定的时间(2s)让 cluster 变为 CLUSTER_OK 状态。
     */
    if (first_call_time == 0) first_call_time = mstime();
    if (nodeIsMaster(myself) &&
        server.cluster->state == CLUSTER_FAIL &&
        mstime() - first_call_time < CLUSTER_WRITABLE_DELAY) return;

    /* 先假设集群状态为 CLUSTER_OK，
     * 然后遍历 16384 个 slot，如果发现有 slot 被有被接管，
     * 或者接管某 slot 的 node 是 fail 状态，那么把集群设置为 CLUSTER_FAIL，退出循环
     */
    new_state = CLUSTER_OK;
    if (server.cluster_require_full_coverage) {
        for (j = 0; j < CLUSTER_SLOTS; j++) {
            if (server.cluster->slots[j] == NULL ||
                server.cluster->slots[j]->flags & (CLUSTER_NODE_FAIL))
            {
                new_state = CLUSTER_FAIL;
                break;
            }
        }
    }
    {
       /* 计算 cluster size，计数的是那些至少负责一个 slot 的 node
        * 计算 reachable_masters，计数基于 cluster size，
        * 加入筛选条件(不带有 CLUSTER_NODE_FAIL|CLUSTER_NODE_PFAIL) 标记
        */
        dictIterator *di;
        dictEntry *de;
        server.cluster->size = 0;
        di = dictGetSafeIterator(server.cluster->nodes);
        while((de = dictNext(di)) != NULL) {
            clusterNode *node = dictGetVal(de);

            if (nodeIsMaster(node) && node->numslots) {
                server.cluster->size++;
                if ((node->flags & (CLUSTER_NODE_FAIL|CLUSTER_NODE_PFAIL)) == 0)
                    reachable_masters++;
            }
        }
        dictReleaseIterator(di);
    }
    {
        /* 如果 reachable_masters 不到 cluster size 一半(a minority partition)，
         * 就将集群标记为 CLUSTER_FAIL
         */
        int needed_quorum = (server.cluster->size / 2) + 1;
        if (reachable_masters < needed_quorum) {
            new_state = CLUSTER_FAIL;
            among_minority_time = mstime();
        }
    }

    if (new_state != server.cluster->state) {
        mstime_t rejoin_delay = server.cluster_node_timeout;

        if (rejoin_delay > CLUSTER_MAX_REJOIN_DELAY)
            rejoin_delay = CLUSTER_MAX_REJOIN_DELAY;
        if (rejoin_delay < CLUSTER_MIN_REJOIN_DELAY)
            rejoin_delay = CLUSTER_MIN_REJOIN_DELAY;
        /* 处于 minority partition 的时间没有超过 cluster_node_timeout，
         * 那么此次不更新集群状态。
         */
        if (new_state == CLUSTER_OK &&
            nodeIsMaster(myself) &&
            mstime() - among_minority_time < rejoin_delay)
        {
            return;
        }

        /* Change the state and log the event. */
        serverLog(LL_WARNING,"Cluster state changed: %s",
            new_state == CLUSTER_OK ? "ok" : "fail");
        server.cluster->state = new_state;
    }

```

## 4. 参考

<i class="fa fa-link" aria-hidden="true"></i> [Redis源码解析：27集群(三)主从复制、故障转移](https://blog.csdn.net/gqtcgq/article/details/51830428)
