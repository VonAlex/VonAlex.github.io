---
title: Redis 源码分析之内存淘汰策略
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: f0a45582
date: 2020-04-19 12:33:33
---

redis 是内存数据库，当内存数据集达到一定大小时，命令处理会触发数据淘汰机制，直至把当前内存使用量降到设定值(maxmemory)以下。
<!--more---->

**那为啥要做内存使用量的限制呢？**
当 redis 使用内存量接近或超过物理机内存时，操作系统会根据内核参数 `vm.swappiness` 做内存页的 swap 操作或者 oom kill，这在生产环境是不能接受的。

maxmemory 可以通过配置文件 `redis.conf` 中的 `maxmemory` 配置项来设置，0 表示不做限制。也可以使用 `config set maxmemory 内存值` 命令来设置，内存值可使用的单位如下，

```c
while(*u && isdigit(*u)) u++;
if (*u == '\0' || !strcasecmp(u,"b")) {
    mul = 1;
}
else if (!strcasecmp(u,"k")) {
    mul = 1000;
}
else if (!strcasecmp(u,"kb")) {
    mul = 1024;
}
else if (!strcasecmp(u,"m")) {
    mul = 1000*1000;
}
else if (!strcasecmp(u,"mb")) {
    mul = 1024*1024;
}
else if (!strcasecmp(u,"g")) {
    mul = 1000L*1000*1000;
}
else if (!strcasecmp(u,"gb")) {
    mul = 1024L*1024*1024;
} else {
    if (err) *err = 1;
    return 0;
}
```

可以看到，当加上 `b` 时，以 1024 做换算，否则以 1000 做换算。

当服务器启动进行初始化时，对于 32 位系统，内存的最大使用量是 4G，如果用户没有做限制，那么设置 maxmemory 默认为 3G，并设置不做内存淘汰的策略，64 位系统则不做限制。

```c
void initServer(void) {
    ....
    if (server.arch_bits == 32 && server.maxmemory == 0)
    {
        server.maxmemory = 3072LL*(1024*1024); /* 3 GB */
        server.maxmemory_policy = MAXMEMORY_NO_EVICTION;
    }
    ...
}
```
redis 基本上是通过 **zmalloc** 统一接口进行内存管理的，在 `zmalloc.c` 文件中提供了丰富的接口来支持申请、释放和查询内存等操作。


## 1. 内存淘汰概述
在 redis 3.x 版本中一共提供了以下 4 种内存淘汰策略，
- 不做淘汰
- 随机淘汰
- 先淘汰到期或快到期数据
- 近似 LRU 算法（最近最少使用）

<p class="note note-info">
后续版本提供了更合理的近似 LFU 算法（最近使用频率最小）。
</p>

这些策略通过 `redis.conf` 中的 `maxmemory-policy` 配置项来设置，可用值如下，
- volatile-lru -> 使用 LRU 算法淘汰设置了过期时间的 key
- allkeys-lru -> 使用 LRU 算法淘汰任意 key
- volatile-random -> 随机淘汰一个设置了过期时间的 key
- allkeys-random -> 随机淘汰任意一个 key
- volatile-ttl -> 淘汰最近要过期的 key，ttl 时间最小
- noeviction -> 不淘汰数据

在源码中，有以下的宏定义，

```c
/* Redis maxmemory strategies */
#define MAXMEMORY_VOLATILE_LRU 0
#define MAXMEMORY_VOLATILE_TTL 1
#define MAXMEMORY_VOLATILE_RANDOM 2
#define MAXMEMORY_ALLKEYS_LRU 3
#define MAXMEMORY_ALLKEYS_RANDOM 4
#define MAXMEMORY_NO_EVICTION 5
#define CONFIG_DEFAULT_MAXMEMORY_POLICY MAXMEMORY_NO_EVICTION
```
## 2. 内存淘汰时机
内存淘汰的核心逻辑在函数 `freeMemoryIfNeeded` 里。

有三个时机会触发这个函数的执行。

1）**首先**，使用 `config` 命令设置 maxmemory 时，代码如下，

```c
config_set_memory_field("maxmemory",server.maxmemory) {
    if (server.maxmemory) {
        if (server.maxmemory < zmalloc_used_memory())
        {
            serverLog(LL_WARNING,"WARNING: xxxxxx.");
        }
        freeMemoryIfNeeded();
    }
}
```
2）**其次**，在 lua 脚本的处理时，对于携带禁写 flag 的命令（这种命令会增大数据集），但是只能判断第一个写命令，脚本中间的无法判断。

```c
int luaRedisGenericCommand(lua_State *lua, int raise_error) {
  ...
  if (server.maxmemory && server.lua_write_dirty == 0 &&
        (cmd->flags & CMD_DENYOOM)) {
        if (freeMemoryIfNeeded() == C_ERR) {
            luaPushError(lua, shared.oomerr->ptr);
            goto cleanup;
        }
    }
  ...
}
```
3）**最后**，触发最频繁的是在命令处理的主流程里，如下，
```c
int processCommand(client *c) {
    ...
    if (server.maxmemory) {
        int retval = freeMemoryIfNeeded();
        if (server.current_client == NULL) return C_ERR;
        if ((c->cmd->flags & CMD_DENYOOM) && retval == C_ERR) {
            flagTransaction(c);
            addReply(c, shared.oomerr);
            return C_OK;
        }
    }
    ...
}
```

## 3. 内存淘汰处理
下面进入内存淘汰处理的分析，也就是 `freeMemoryIfNeeded` 函数的逻辑。

使用 zmalloc 接口获得现在已经使用的内存量，从中**减掉 slave 的 output buffers 和 AOF buffer**，因为这两部分内存迟早会释放掉。

```c
mem_used = zmalloc_used_memory();
if (slaves) {
    listIter li;
    listNode *ln;

    listRewind(server.slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = listNodeValue(ln);
        unsigned long obuf_bytes = getClientOutputBufferMemoryUsage(slave);
        if (obuf_bytes > mem_used)
            mem_used = 0;
        else
            mem_used -= obuf_bytes;
    }
}
if (server.aof_state != AOF_OFF) {
    mem_used -= sdslen(server.aof_buf);
    mem_used -= aofRewriteBufferSize();
}
```
代码中使用了 `getClientOutputBufferMemoryUsage` 函数来获得没有被 client 读取的**虚拟**字节数。之所以说**虚拟**，是由于 reply output 列表中可能包含一些共享对象，而这部分对象是不占用额外内存的。这个函数的调用非常快。
所以，从上面可以看到，aof 缓存和主从复制缓存区内的数据是不会被淘汰的，也没有算在 `mem_used` 内。

当使用内存小于 maxmemory 时，直接返回 **C_OK**，这时没必要做内存淘汰。
```c
if (mem_used <= server.maxmemory) return C_OK;
```
而超限后，就需要做内存淘汰了。

基本代码框架如下，从每个 db 中按照配置的淘汰策略抽出 key 进行内存淘汰，直至内存降到 maxmemory 以下，可见当需要淘汰的内存非常多时，代码会**堵塞**到这里，不响应用户请求。因此，在设计这部分逻辑的原则也是要尽量地快！

```c
// 计算出有多大内存需要淘汰
mem_tofree = mem_used - server.maxmemory;
// 已经淘汰掉多少内存
mem_freed = 0;
latencyStartMonitor(latency);
while (mem_freed < mem_tofree) {
    int j, k, keys_freed = 0;
    for (j = 0; j < server.dbnum; j++) { // 操作每个 db
        ...
    }
    if (!keys_freed) {
        latencyEndMonitor(latency);
        latencyAddSampleIfNeeded("eviction-cycle",latency);
        return C_ERR; /* nothing to free... */
    }
}
latencyEndMonitor(latency);
latencyAddSampleIfNeeded("eviction-cycle",latency);
return C_OK;
```

下面讨论各淘汰策略的具体做法。

### 3.1 MAXMEMORY_NO_EVICTION
```c
if (server.maxmemory_policy == MAXMEMORY_NO_EVICTION)
    return C_ERR;
```
服务器配置的策略是不淘汰数据，所以这里报错，返回 **C_ERR**，返回到 `processCommand` 函数中，对于禁写的命令返回错误 **-OOM command not allowed when used memory > maxmemory**。

禁写命令携带 **CMD_DENYOOM** 这个 flag，也就是在 `redisCommandTable` 中 command 携带的 m 标识，如，

```c
{"set",setCommand,-3,"wm",0,NULL,1,1,1,0,0},
```
大部分可以改变数据库状态的命令都带有此标识。

### 3.2 MAXMEMORY_xxx_RANDOM

ALLKEYS 还是 VOLATILE 决定了从哪个 dict 里取 key 进行淘汰，
```c
if (server.maxmemory_policy == MAXMEMORY_ALLKEYS_LRU ||
    server.maxmemory_policy == MAXMEMORY_ALLKEYS_RANDOM)
{   // 如果选择的淘汰策略是 MAXMEMORY_ALLKEYS_xxx，就是所有的数据都是潜在淘汰对象
    dict = server.db[j].dict;
} else {
    // 否则只从带过期时间的 key 里进行淘汰
    dict = server.db[j].expires;
}
```

```c
// dict 里没有 key，就跳过吧
if (dictSize(dict) == 0) continue;
```

random 策略，从 dict 里随机选一个 key。
```c
if (server.maxmemory_policy == MAXMEMORY_ALLKEYS_RANDOM ||
    server.maxmemory_policy == MAXMEMORY_VOLATILE_RANDOM) {
    de = dictGetRandomKey(dict);
    bestkey = dictGetKey(de);
}
```

### 3.3 MAXMEMORY_xxx_LRU
redis 实现的 LRU 并不是一个严格的 LRU 算法，只是一个近似算法。

一般来说，缓存应该保留那些在未来高概率被访问到的 key，作为淘汰策略，恰恰相反，应该将那些在未来低概率被访问到的 key 从数据集中淘汰掉。但有一个问题，redis 和其他缓存都无法预测未来。虽说不可预测未来，但是用以下方式推断：**那些最近经常被访问的 key，很可能会再一次被访问**。由于访问模型通常不会突然变更，因此，这是一个有效的策略。对于“**最近经常访问**”的概念，就被简化成了 LRU 算法，只记录一个 key 上一次被访问的时间戳。

<p class="note note-info">
严格来说，LRU 算法，要把所有要淘汰的 key 放到一个链表中，当一个 key 可以被访问时，把它移到 list 的头端，当需要淘汰 key 的时候，直接从尾部淘汰。
</p>

但是 redis 之前是不支持 LRU 淘汰数据的，如果要改成严格 LRU 是算法，那么需要对现有的数据结构进行一个大的改动，另外需要很多的内存存储 metadata。而算法实现要做到高效，不能因选出要淘汰 key 的流程致使服务器性能大幅下降。且 maxmemory 导致触发数据淘汰是一个低频操作。总之就是改起来性价比较低。因此采用近似 LRU 算法，通过采样的方式获得目标 key。

那么，下面有两个问题需要解决。

1）**如何计算 LRU 值？**

在 object 中腾出 24 bits 空间存储 unix 时间（秒）的最低有效位。这种表示，在 redis 源码称为 **LRU clock**，**194 天会溢出**，但 key 基本信息会频繁更新，因此这个方案已经足够好了。因此，这里的 LRU 值是个近似值。

```c
#define LRU_BITS 24
typedef struct redisObject {
    unsigned type:4;
    unsigned encoding:4;
    unsigned lru:LRU_BITS;
    int refcount;
    void *ptr;
} robj;
```
在每次访问 key 的时候，根据 flag，对 key 的 lru 时间进行更新，代码如下，
```c
robj *lookupKey(redisDb *db, robj *key, int flags) {
    dictEntry *de = dictFind(db->dict,key->ptr);
    if (de) {
        robj *val = dictGetVal(de);

        // 只在不存在子进程时执行，防止破坏 copy-on-write 机制
        if (server.rdb_child_pid == -1 &&
            server.aof_child_pid == -1 &&
            !(flags & LOOKUP_NOTOUCH))
        {
            val->lru = LRU_CLOCK();
        }
        return val;
    } else {
        return NULL;
    }
}
```

2）**如何选出 idletime 最大的 key？**

**最简单的办法**是，从 key 空间中随机选择 n 个（n = 5 效果就很好了），然后淘汰那个 idle 最大的 key，这种方案虽然简单，但是效果不错，在精确度上是有问题的。这是 2.8 版本中的实现方案。

<p class="note note-primary">
作者是这样做测试的，向 redis 中写入一定数量的 key，此时已经达到 maxmemory，然后依次访问它们，这样就可以使它们的 idletime 是一个依序递减的，当再次写入 50% 数量的 key 时，按道理应该将源数据中后 50% 的 key 淘汰掉，但是测试发现一些新写入的 key 也有部分被淘汰掉了。这个结果其实是显而易见的，因为 key 的选取的 random 的，因此作者对 random 算法进行了改进，这就是 3.x 版本中用到的算法，引入 pool 存放待淘汰的 key。
</p>

说完作者的优化思路，现在回到 `freeMemoryIfNeeded` 的代码逻辑，

```c
else if (server.maxmemory_policy == MAXMEMORY_ALLKEYS_LRU ||
    server.maxmemory_policy == MAXMEMORY_VOLATILE_LRU) {
    struct evictionPoolEntry *pool = db->eviction_pool;

    while(bestkey == NULL) {
        // 更新回收池
        evictionPoolPopulate(dict, db->dict, db->eviction_pool);

        // 从eviction_pool里 idletime 最大的 key（在数组最右边）开始处理
        for (k = MAXMEMORY_EVICTION_POOL_SIZE-1; k >= 0; k--) {
            if (pool[k].key == NULL) continue;
            de = dictFind(dict,pool[k].key);

            // 从 pool 里删掉第 k 个数据
            sdsfree(pool[k].key);

            // 将 k 右边的数据通通左移
            memmove(pool+k,pool+k+1,
                sizeof(pool[0])*(MAXMEMORY_EVICTION_POOL_SIZE-k-1));

            // 因为我们往左移动了一个位置，初始化 pool 最右边那个位置（因为左移而填充的未知值）
            pool[MAXMEMORY_EVICTION_POOL_SIZE-1].key = NULL;
            pool[MAXMEMORY_EVICTION_POOL_SIZE-1].idle = 0;

            // 如果找到 key 了，那么保存到 bestkey 里，到此为止
            // 否则重试一下
            if (de) {
                bestkey = dictGetKey(de);
                break;
            } else {
                /* Ghost... */
                continue;
            }
        }
    }
}
```
每个 db 都有一个 `eviction_pool` 的结构，存放潜在的淘汰对象，就是那些 idle 时间很大的 key，长度为 16，该 pool 的结构如下图所示，

![](/images/redis-evictionpool.jpg)

可以看到，在 pool 中，key 按照 idletime 升序排列，所以淘汰数据时，从右侧开始遍历 pool，也就是拿到 pool 中 idletime 最大的那个 key 进行淘汰，这个 key 就是代码中的 `bestkey`。

代码中，更新 pool 是关键的操作，每次需要从 dict 中选出 `maxmemory_samples` 个 key，然后对 pool 进行更新。`maxmemory_samples` 值由配置文件中的 **maxmemory-samples** 配置项决定，默认值是 5，5 的效果已经足够好了，10 基本接近真实 LRU 算法的效果，但是多消耗一点 CPU。

- 当 pool 不满时，采样 key 总是能够插入到 pool 里的。
- 当 pool 满了时，pool 中所有的 key 的 idletime 均大于采样 key 时，无法插入，否则释放掉 pool 中 idletime 最小的那个 key（也就是 pool 最左边的那个 key），然后插入采样 key。
以上的插入过长中，都要使用 `memmove` 函数进行元素的移动。

逻辑主要如下图所示，这里就不贴代码了，
![](/images/ecictionpoo-update.jpg)


需要注意的一点是，在 idletime 的获取时，需要兼容 24 bit lru lock 溢出的情况。
```c
#define LRU_CLOCK_RESOLUTION 1000

// 精度为 s
unsigned int getLRUClock(void) {
    return (mstime()/LRU_CLOCK_RESOLUTION) & LRU_CLOCK_MAX;
}

// 如果 cron 执行的频率高于LRU算法的精度，返回之前计算好的 lruclock，
// 否则需要一次系统调用
#define LRU_CLOCK() ((1000/server.hz <= LRU_CLOCK_RESOLUTION) ? server.lruclock : getLRUClock())

// 使用近似 LRU 算法，计算出给定对象的闲置时长(毫秒)
unsigned long long estimateObjectIdleTime(robj *o) {
    unsigned long long lruclock = LRU_CLOCK();
    if (lruclock >= o->lru) {
        return (lruclock - o->lru) * LRU_CLOCK_RESOLUTION;

    // 这种情况一般不会发生，key 长时间不访问，LRU 时间发生了 wrap
    } else {
        return (lruclock + (LRU_CLOCK_MAX - o->lru)) *
                    LRU_CLOCK_RESOLUTION;
    }
}
```
上面的 `server.lruclock` 变量在每次执行 `serverCron` 函数时更新一次，而该函数 `1000/server.hz` 毫秒内执行一次，默认是 100ms，所以如果 `serverCron` 函数执行不及时的时候，就自动调用一下 `getLRUClock` 函数拿当前时间。

<p class="note note-info">
上面的实现中，每个 db 都有一个 pool，这可能有个问题。

当 db0 中所有的 key 的 idle 都小于 db1 中的 key，按道理这时应该淘汰 db1 的数据，但是上面的逻辑中仍然会淘汰一部分 db0 中的数据。
实际上，当 redis 被用做缓存时，很少会使用到不同的 db，然而作者还是在后面的 redis 版本中做了相关优化，pool 中带上了 dbid，使用一个大的 pool 负责所有的 db。
</p>

**LRU 算法受限于采样，每轮采样 10 个 key，使得该近似算法的精确度已经接近理论 LRU 了，所以作者在后面的版本中又探索了 LFU 算法，根据访问频率去淘汰数据是更加准确的。**

关于作者对淘汰策略的设计思路，可以参考文章 《[Random notes on improving the Redis LRU algorithm](http://antirez.com/news/109)》


### 3.3 MAXMEMORY_VOLATILE_TTL

该策略会随机选择 maxmemory_samples 个 key，选 ttl 最小的 key，也就是最先过期的 key。
```c
else if (server.maxmemory_policy == MAXMEMORY_VOLATILE_TTL) {
    for (k = 0; k < server.maxmemory_samples; k++) {
        sds thiskey;
        long thisval;

        de = dictGetRandomKey(dict);
        thiskey = dictGetKey(de);
        thisval = (long) dictGetVal(de);

        if (bestkey == NULL || thisval < bestval) {
            bestkey = thiskey;
            bestval = thisval;
        }
    }
}
```

------

经过上面的策略，获得 bestkey，也就是最终要淘汰的 key。

首先是把这个 key 的信息传播到 slave 和 aof，`propagateExpire` 函数的逻辑，在 key 过期那篇文章讲过，在此不做赘述。
```c
robj *keyobj = createStringObject(bestkey,sdslen(bestkey));
propagateExpire(db,keyobj);
```
然后从 key space 中删掉这个 key，更新相关变量。

```c
delta = (long long) zmalloc_used_memory();
dbDelete(db,keyobj);
delta -= (long long) zmalloc_used_memory();
mem_freed += delta;  // 更新内存释放量
server.stat_evictedkeys++;
decrRefCount(keyobj);
keys_freed++;
```
最后，强制刷一次 slave 输出缓冲区数据，因为当待释放的内存比较大时，在loop 里要花很长时间，因此不可能尽快的把数据传给 slave。

```c
if (slaves) flushSlavesOutputBuffers();
```
然后还有一些就是统计 latency 的更新，会记录每次释放 key 的耗时、每个 db 释放 key 的耗时等等。

## 4. 总结
1. maxmemory 淘汰数据机制，主要淘汰的数据分为两部分，一是整个 key space 里的 key，二是设置了过期时间的 key。
2. maxmemory 淘汰数据算法，3.x 版本的 redis 里主要有，ttl、LRU 和 random，后续版本加入了 LFU。
3. redis 版本从 2.x 到 6.x，一直不停地改进迭代，redis 作者精益求精的精神值得我们学习。
4. LRU 算法的加入，从性价比方面考虑，没有采用精确 LRU 算法，而是使用的一个近似算法，代码改动很小，但是收益却很大，这种代码设计上的取舍很值得学习。
5. 在做数据淘汰时，在 loop 里会一直做淘汰，直到使用内存量降至 maxmemory 以下，当要淘汰的数据过多时，会一直阻塞在这里，无法正常处理用户请求，这一点是需要特别注意的。
6. 虽然有数据淘汰机制，但是在生产环境下应该严格监控，确保内存使用量在 maxmemory 以下。
7. maxmemory 不建议设置过大，否则数据过多，实例启动和主从同步的时间都会很长，单点风险增大。
