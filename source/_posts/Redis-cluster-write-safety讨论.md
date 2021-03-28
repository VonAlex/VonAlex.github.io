---
title: Redis Cluster write safety 分析
tags:
  - redis
categories: 源码系列
index_img: 'https://gitee.com/happencc/pics/raw/master/images/redis.png'
abbrlink: a9d44741
date: 2021-02-18 23:25:00
---

redis cluster 是 redis 的分布式实现。
如同官方文档 **[cluster-spec](https://redis.io/topics/cluster-spec)** 强调的那样，其设计**优先考虑高性能和线性扩展能力，并尽最大努力保证 write safety**。

<!-- more -->

这里所说的 write 丢失是指，回复 client ack 后，后续请求中出现数据未做变更或丢失的情况，主要有主从切换、实例重启、脑裂等三种情况可能导致该问题，下面依次分析。

## 主从切换

failover 会带来路由的变更，主动/被动情况需要分开讨论。

### 被动 failover
为表达方便，有以下假设，cluster 状态正常，  node C 为 master，负责 slot 1-100，对应 slave 为 C'。

master C 挂掉后，slave C' 在**最多 2 倍 cluster_node_timeout 的时间**内把 C 标记成 FAIL，进而触发 failover 逻辑。

在 slave C' 成功切换为 master 前，1-100 slot 仍然由 C 负责，访问会报错。
C' 切为 master 后，gossip 广播路由变更，在这个过程中，client 访问 C'，仍可以得到正常的回应，而访问其他持有老路由的 node，请求会被 MOVED 到挂掉的 C，访问报错。

**唯一可能出现 write 丢失的 case 由主从异步复制机制导致**。
如果写到 master 上的数据还没有来得及同步到 slave 就挂掉了，那么这部分数据就会丢失（**重启后不存在 merge 操作**）。master 回复 client ack 与同步 slave 几乎是同时进行的，这种情况很少发生，但这是一个风险，时间窗口很小。

### 主动 failover
主动 failover 通过 sysadmin 在 slave node 上执行 `CLUSTER FAILOVER [FORCE|TAKEOVER]` 命令触发。

完整 manual failover 过程在之前的[博客](https://happencc.gitee.io/54df012b.html)详细讨论过，概括为以下 6 个步骤：
1. slave 发起请求，gossip 消息携带 **CLUSTERMSG_TYPE_MFSTART** 标识。
2. master 阻塞 client，停服时间为 2 倍 **CLUSTER_MF_TIMEOUT**，目前版本为 10s。
3. slave 追赶主从复制 offset 数据。 
4. slave 开始发起选举，并最终当选。
5. slave 切换自身 role，接管 slots，并广播新的路由信息。
6. 其他节点更改路由，cluster 路由打平。

三个选项分别有不同的行为，分析如下，

（1）默认选项。
执行完整的mf 流程，master 有停服行为，因此不存在 write 丢失的问题。

（2）FORCE 选项。
从第 4 步开始执行。在 **slave C' 统计选票阶段，master C 仍然可以正常接收用户请求**，且主从异步复制，这些都可能导致 write 丢失。mf 将在未来的某个时间点开始执行，timeout 时间为 **CLUSTER_MF_TIMEOUT**（现版本为 5s），每次 `clusterCron` 都会检查。

（3）TAKEOVER 选项。
从第 5 步开始执行。slave 直接增加自己的 configEpoch（无需其他 node 同意），接管 slots。**从 slave C' 切换为 master ，到原 master 节点 C 更新路由，发到 C 的请求，都可能存在 write 丢失的可能**，一般在一个 ping 的时间内完成，时间窗口很小。C 和 C' 以外节点更新路由滞后只会带来多一次的 **MOVED** 错误，不会导致 write 丢失。

## master 重启

### cluster 状态初始化
clusterState 结构体中有一个 **state** 成员变量，表示 cluster 的全局状态，控制着当前 cluster 是否可以提供服务，有以下两种取值，

```c
#define CLUSTER_OK 0    /* Everything looks ok */
#define CLUSTER_FAIL 1  /* The cluster can't work */
```
server 重启后，state 被初始化为 **CLUSTER_FAIL**，代码逻辑可以在 `clusterInit` 函数中找到。

对于 **CLUSTER_FAIL** 状态的 cluster 是拒绝接受访问的，代码参考如下，
```c
int processCommand(client *c) {
    ...
    if (server.cluster_enabled &&
    !(c->flags & CLIENT_MASTER) &&
    !(c->flags & CLIENT_LUA &&
        server.lua_caller->flags & CLIENT_MASTER) &&
    !(c->cmd->getkeys_proc == NULL && c->cmd->firstkey == 0 &&
        c->cmd->proc != execCommand))
{
    int hashslot;
    int error_code;
    
    clusterNode *n = getNodeByQuery(c,c->cmd,c->argv,c->argc,
                                    &hashslot,&error_code);
    ...
}
```
重点在 `getNodeByQuery` 函数，在 cluster 模式开启后，用来查找到真正要执行 command 的 node。

{% note warning %}
**注意**：

redis cluster 采用去中心化的路由管理策略，每一个 node 都可以直接访问，如果要执行 command 的 node 不是当前连接的，它会返回一个 -MOVED 的重定向错误，指向真正要执行 command 的 node。
{% endnote %}

下面看 `getNodeByQuery` 函数的部分逻辑，

```c

clusterNode *getNodeByQuery(client *c, 
    struct redisCommand *cmd, robj **argv, 
    int argc, int *hashslot, 
    int *error_code) {
        ...
        if (server.cluster->state != CLUSTER_OK) {
            if (error_code) *error_code = CLUSTER_REDIR_DOWN_STATE;
            return NULL;
        }
        ...
}
```
可以看到，必须是 **CLUSTER_OK** 状态的 cluster 才能正常访问。

我们说，这种限制对于**保证 Write safety** 是非常有必要的！
可以想象，如果 master A 挂掉后，对应的 slave A' 通过选举成功当选为新 master。此时，**A 重启，且恰好有一些 client 看到的路由没有更新，它们仍然会往 A 上写数据，如果接受这些 write，就会丢数据！**A' 才是这个 sharding 大家公认的 master。所以，A' 重启后需要先禁用服务，直到路由变更完成。

### cluster 状态变更
那么，什么时候 cluster 才会出现 **CLUSTER_FAIL** -> **CLUSTER_OK** 的状态变更呢？答案要在 `clusterCron` 定时任务里找。

```c
void clusterCron(void) {
    ...
    if (update_state || server.cluster->state == CLUSTER_FAIL)
        clusterUpdateState();
}
```
关键逻辑在 `clusterUpdateState` 函数里。
```c
#define CLUSTER_WRITABLE_DELAY 2000
void clusterUpdateState(void) {
    static mstime_t first_call_time = 0;
    ...
    if (first_call_time == 0) first_call_time = mstime();
    if (nodeIsMaster(myself) &&
        server.cluster->state == CLUSTER_FAIL &&
        mstime() - first_call_time < CLUSTER_WRITABLE_DELAY) return;
    
    new_state = CLUSTER_OK;
    ...
    if (new_state != server.cluster->state) {
        ...
        server.cluster->state = new_state;
    }
}
```
在以上逻辑里可以看到，cluster 状态变更要延迟 **CLUSTER_WRITABLE_DELAY** 毫秒，目前版本为 2s。

访问延迟就是为了等待路由变更，那么，什么时候触发路由变更呢？
我们知道，一个新 server 刚启动，它与其他 node 进行 gossip 通信的 link 都是 null，在 `clusterCron` 里检查出来后会依次连接，并发送 ping。作为一个路由过期的老节点，收到其他节点发来的 update 消息，更改自身路由。

**CLUSTER_WRITABLE_DELAY** 毫秒后，A 节点恢复访问，我们认为 CLUSTER_WRITABLE_DELAY 的时间窗口足够更新路由。

## partition 

### partition 发生
由于网络的不可靠，网络分区是一个必须要考虑的问题，也即 CAP 理论中的 P。

partition 发生后，cluster 被割裂成 majority 和 minority 两部分，这里以分区中 master 节点的数量来区分。

（1）**对于 minority 部分**，slave 会发起选举，但是不能收到大多数 master 的选票，也就无法完成正常的 failover 流程。同时在 `clusterCron` 里大部分节点会被标记为 **CLUSTER_NODE_PFAIL** 状态，进而触发 `clusterUpdateState` 的逻辑，大概如下，

```c
void clusterCron(void) {
    ...
    di = dictGetSafeIterator(server.cluster->nodes);
    while((de = dictNext(di)) != NULL) {
        ...
        delay = now - node->ping_sent;
        if (delay > server.cluster_node_timeout) {
            if (!(node->flags & (CLUSTER_NODE_PFAIL|CLUSTER_NODE_FAIL))) {
                serverLog(LL_DEBUG,"*** NODE %.40s possibly failing",
                    node->name);
                node->flags |= CLUSTER_NODE_PFAIL;
                update_state = 1;
            }
        }  
    }
    ...
    if (update_state || server.cluster->state == CLUSTER_FAIL)
        clusterUpdateState();
}
```
而在 `clusterUpdateState` 函数里，会改变 cluster 的状态。
```c
void clusterUpdateState(void) {
    static mstime_t among_minority_time;
    ...
    {
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
        int needed_quorum = (server.cluster->size / 2) + 1;

        if (reachable_masters < needed_quorum) {
            new_state = CLUSTER_FAIL;
            among_minority_time = mstime();
        }
    }
    ...
}
```
由上面代码可以看出，在 minority 中，cluster 状态在一段时间后会被更改为 **CLUSTER_FAIL**。但，对于一个划分到 minority 的 master B，在状态更改前是一直可以访问的，这就有一个时间窗口，会导致 write 丢失！！

在 `clusterCron` 函数中可以计算出这个时间窗口的大小。从 partition 时间开始算起，**cluster_node_timeout** 时间后才会有 node 标记为 PFAIL，加上 gossip 消息传播会偏向于携带 PFAIL 的节点，node B 不必等到 **cluster_node_timeout/2** 把 cluster nodes ping 遍，就可以将 cluster 标记为 **CLUSTER_FAIL**。可以推算出，时间窗口大约为 **cluster_node_timeout**。

另外，会记录下禁用服务的时间，即 among_minority_time。

（2）**对于 majority 部分**，slave 会发起选举，以 B 的 slave B' 为例，failover 切为新的 master，并提供服务。
如果 partition 时间小于 **cluster_node_timeout**，以至于没有 PFAIL 标识出现，就不会有 write 丢失。

### partition 恢复
当 partition 恢复后，minority 中的 老 master B 重新加进 cluster，B 要想提供服务，就必须先将 cluster 状态从 **CLUSTER_FAIL** 修改为 **CLUSTER_OK**，那么，应该什么时候改呢？

我们知道 B 中是旧路由，此时它应该变更为 slave，所以，还是需要等待一段时间做路由变更，否则有可能出现 write 丢失的问题（前面分析过），同样在 `clusterUpdateState` 函数的逻辑里。

```c
#define CLUSTER_MAX_REJOIN_DELAY 5000
#define CLUSTER_MIN_REJOIN_DELAY 500
void clusterUpdateState(void) {
    ...
    if (new_state != server.cluster->state) {
        mstime_t rejoin_delay = server.cluster_node_timeout;

        if (rejoin_delay > CLUSTER_MAX_REJOIN_DELAY)
            rejoin_delay = CLUSTER_MAX_REJOIN_DELAY;
        if (rejoin_delay < CLUSTER_MIN_REJOIN_DELAY)
            rejoin_delay = CLUSTER_MIN_REJOIN_DELAY;

        if (new_state == CLUSTER_OK &&
            nodeIsMaster(myself) &&
            mstime() - among_minority_time < rejoin_delay)
        {
            return;
        }
    }
}
```
可以看出，时间窗口为 **cluster_node_timeout**，最多 5s，最少 500ms。

## 小结
failover 可能因为选举和主从异步复制数据偏差带来 write 丢失。

master 重启通过 **CLUSTER_WRITABLE_DELAY** 延迟，等 cluster 状态变更为 **CLUSTER_OK**，可以重新访问，不存在 write 丢失。

partition 中的 minority 部分，在 cluster 状态变更为 **CLUSTER_FAIL** 之前，可能存在 write 丢失。

partition 恢复后，通过 rejoin_delay 延迟，等 cluster 状态变更为 **CLUSTER_OK**，可以重新访问，不存在 write 丢失。