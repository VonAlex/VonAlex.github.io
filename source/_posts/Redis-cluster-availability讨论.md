---
title: Redis Cluster availability 讨论
tags:
  - redis
categories: 源码系列
index_img: 'https://gitee.com/happencc/pics/raw/master/images/redis.png'
abbrlink: a4c4e01c
date: 2021-02-19 21:58:22
---

本文档主要基于个人理解，分析 Redis Cluster 设计中对于 Availability 的一些考量。
<!-- more -->
当 Redis 以 Cluster 模式启动时，对于一个 master 节点，只有当集群为 CLUSTER_OK 状态时，才能正常接受访问，这在之前的博客 《[Redis Cluster write safety 分析](https://happencc.gitee.io/a9d44741.html)》讨论过。

Redis Cluster 设计的三个目标，最后一个才是可用性。

> Redis Cluster is able to survive partitions where the majority of the master nodes are reachable and there is at least one reachable slave for every master node that is no longer reachable. Moreover using replicas migration, masters no longer replicated by any slave will receive one from a master which is covered by multiple slaves.

下面主要讨论三种情况。

### partition 故障

Redis Cluster 在发生 partition 后，minority 部分是不可用的。

假设 majority 部分有过半数 master 及每个 unreachable master 的一个 slave。那么，经过 NODE_TIMEOUT 时间加额外几秒钟（给 slave 进行 failover），cluster 恢复可用状态。

当集群中有过半数 master 可达，cluster 就不会标记成 **CLUSTER_FAIL**。

### replicas migration 功能

Redis Cluster 的设计，保证了少数节点发生故障时，集群依然可用。

举个例子，包含 N 个 master 的集群，每个 master 有唯一 slave。
单个 node 出现故障，cluster 仍然可用，第二个 node 再出现故障，集群仍然可用的概率是 1-(1/(N\*2-1)。

{% note info %}
计算方式如下，

第一个 node fail 后，集群剩下 N\*2-1 个健康节点，此时 orphan master 恰好 fail 的概率是 1/(N*2-1)。
{% endnote %}

套用公式，假设 N = 5，那么，2 个节点从 majority  partition 出去，集群不可用的概率是 11.11%。

redis 为了提高集群可用性，提供了 **replicas migration** 功能，代码分析如下，

```c
void clusterCron(void) {
    int orphaned_masters;
    int max_slaves;
    int this_slaves;
    ... 
    di = dictGetSafeIterator(server.cluster->nodes);
    while((de = dictNext(di)) != NULL) {
    	clusterNode *node = dictGetVal(de);
        ...
        if (nodeIsSlave(myself) && 
            nodeIsMaster(node) && 
            !nodeFailed(node)) {
            // 统计 node 有几个健康的 slave
            int okslaves = clusterCountNonFailingSlaves(node);
            // 没有 slave 但依然负责 slot 的 master
            if (okslaves == 0 && 
                node->numslots > 0 && 
                node->flags & CLUSTER_NODE_MIGRATE_TO)
            {
                orphaned_masters++;
            }
            if (okslaves > max_slaves) max_slaves = okslaves;
            // node 是我的 master
            if (nodeIsSlave(myself) && myself->slaveof == node)
                this_slaves = okslaves;
        }
    }
    ...
    if (nodeIsSlave(myself)) {
        ...
       	if (orphaned_masters && max_slaves >= 2 && this_slaves == max_slaves)
            clusterHandleSlaveMigration(max_slaves);
    }
    ...
}
```

首先定义了什么样的节点算 orphaned master，即，负责部分 slot 但没有健康 slave 的 master。orphaned master 有可用性风险，一旦挂掉，则整个 sharding 不可用。

以上代码可以看出，当 slave 检测到自己的 master 拥有不少于 2 个健康 slave ，且 cluster 中恰好有 orphan master 时，触发 `clusterHandleSlaveMigration` 函数逻辑，尝试进行 slave 漂移，漂移步骤有 4 步，下面进行分步说明。

（1）CLUSTER_FAIL 集群漂移。

```c
 if (server.cluster->state != CLUSTER_OK) return;
```

非 CLUSTER_OK 集群本来就无法正常接受请求，漂移多此一举，忽略掉这种情况。

（2）检查 cluster-migration-barrier 参数。

**redis conf 提供了cluster-migration-barrier 参数**，用来决定 slave 数量达到多少个才会把冗余 slave 漂移出去。

```c
for (j = 0; j < mymaster->numslaves; j++)
    if (!nodeFailed(mymaster->slaves[j]) &&
        !nodeTimedOut(mymaster->slaves[j])) okslaves++;
if (okslaves <= server.cluster_migration_barrier) return;
```

只有 mymaster 健康 slave 的个数超过 cluster-migration-barrier 配置的数量时，才会漂移。

（3）选出要漂移的 slave以及漂给谁。

```c
candidate = myself;
di = dictGetSafeIterator(server.cluster->nodes);
while((de = dictNext(di)) != NULL) {
    clusterNode *node = dictGetVal(de);
    int okslaves = 0, is_orphaned = 1;

    if (nodeIsSlave(node) || nodeFailed(node)) is_orphaned = 0;
    if (!(node->flags & CLUSTER_NODE_MIGRATE_TO)) is_orphaned = 0;

    if (nodeIsMaster(node)) okslaves = clusterCountNonFailingSlaves(node);
    if (okslaves > 0) is_orphaned = 0;

    if (is_orphaned) {
        if (!target && node->numslots > 0) target = node;
        if (!node->orphaned_time) node->orphaned_time = mstime();
    } else {
        node->orphaned_time = 0;
    }

    if (okslaves == max_slaves) {
        for (j = 0; j < node->numslaves; j++) {
            if (memcmp(node->slaves[j]->name,
                       candidate->name,
                       CLUSTER_NAMELEN) < 0)
            {
                candidate = node->slaves[j];
            }
        }
    }
}
dictReleaseIterator(di);
```

选择 node name 最小的 slave ，漂移给遍历到的第一个 orphaned master，如果有多个。

（4）执行漂移。

```c
#define CLUSTER_SLAVE_MIGRATION_DELAY 5000 
if (target && candidate == myself &&
    (mstime()-target->orphaned_time) > CLUSTER_SLAVE_MIGRATION_DELAY)
{
    serverLog(LL_WARNING,"Migrating to orphaned master %.40s",
              target->name);
    clusterSetMaster(target);
}
```

在 failover 期间，master 有一段时间是没有 slave 的，为防止误漂，漂移必须有一定的延迟，时间为 CLUSTER_SLAVE_MIGRATION_DELAY，现版本为 5s。

### sharding 缺失故障

默认情况下，当检测到有 slot 没有绑定，Redis Cluster 就会停止接收请求。在这种配置下，如果 cluster 部分节点挂掉，也就是说一个范围内的 slot 不再有节点负责，最终整个 cluster 会变得不能提供服务。

**有时候，服务部分可用比整个不可用更有意义**，因此，即使一部分 sharding 可用，也要让 cluster 提供服务。redis 将这种选择权交到了用户手中，conf 里提供 **cluster-require-full-coverage** 参数。

```c
void clusterUpdateState(void) {
    ...
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
    ...
}
```

以上代码可以看到，如果配置 cluster-require-full-coverage 为 yes，那么，有 slot 未绑定或者 sharding 缺失，会将 cluster 状态设置为 CLUSTER_FAIL，server 就会拒绝请求。