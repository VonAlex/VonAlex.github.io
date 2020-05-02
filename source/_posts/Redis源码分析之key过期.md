---
title: Redis 源码分析之 key 过期
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: 5a077de9
date: 2020-04-06 19:47:58
---
redis 支持 key 级别的过期设置，可以使用 `EXPIRE` 相关的命令对此进行设置，同时支持相对时间和绝对时间两种方式。

<!--more---->

## 设置过期时间命令
 redis 中设置 key 相对过期时间的命令 `EXPIRE`/ `PEXPIRE`，设置 key 绝对过期时间的命令 `EXPIREAT`/`PEXPIREAT`，最终都是调用 `expireGenericCommand` 函数实现的。

代码分析大致如下，

 ```c
void expireGenericCommand(client *c, long long basetime, int unit) {
    robj *key = c->argv[1], *param = c->argv[2];
    long long when; /* unix time in milliseconds when the key will expire. */
    if (getLongLongFromObjectOrReply(c, param, &when, NULL) != C_OK)
        return;

    if (unit == UNIT_SECONDS) when *= 1000;
    when += basetime;

    /* No key, return zero. */
    if (lookupKeyWrite(c->db,key) == NULL) {
        addReply(c,shared.czero);
        return;
    }

    if (when <= mstime() && !server.loading && !server.masterhost) {
        robj *aux;

        serverAssertWithInfo(c,key,dbDelete(c->db,key));
        server.dirty++;

        /* Replicate/AOF this as an explicit DEL. */
        aux = createStringObject("DEL",3);
        rewriteClientCommandVector(c,2,aux,key);
        decrRefCount(aux);
        signalModifiedKey(c->db,key);
        notifyKeyspaceEvent(NOTIFY_GENERIC,"del",key,c->db->id);
        addReply(c, shared.cone);
        return;
    } else {
        setExpire(c->db,key,when);
        addReply(c,shared.cone);
        signalModifiedKey(c->db,key);
        notifyKeyspaceEvent(NOTIFY_GENERIC,"expire",key,c->db->id);
        server.dirty++;
        return;
    }
}
 ```
 首先是解析参数，相对时间会被转换成绝对时间 `when`。

 找一个下这个 key 是否存在，如果不存在，那么直接返回。

 如果 `when` 比当前时间还要小，没有做数据的 loading，且当前节点是 master（slave 节点等着 master 传过去的 DEL 就好），这时把 expire 命令转换成 **DEL**。
 否则，调用 `setExpire` 函数为 key 设置过期时间，

 代码分析如下，
 ```c
 void setExpire(redisDb *db, robj *key, long long when) {
    dictEntry *kde, *de;

    /* Reuse the sds from the main dict in the expire dict */
    kde = dictFind(db->dict,key->ptr);
    serverAssertWithInfo(NULL,key,kde != NULL);
    // 在 expires 中寻找 key，找不到就新建一个
    de = dictReplaceRaw(db->expires,dictGetKey(kde));
    dictSetSignedIntegerVal(de,when);
}
 ```
通过以上代码可以发现，含有过期时间的 key 都会放到 `db->expires` 变量中（在数据库结构体 `redisDb` 中，使用 `expires` 字典存放这些 key）。
```c
typedef struct redisDb {
    dict *dict; // 存放所有 key
    dict *expires; // 存放过期 key
    int id; // 数据库 id
    ....
} redisDb;
```
过期时间通过 `dictSetSignedIntegerVal` 函数，存放到 key 所在的 `dictEntry` 结构，如下，
```c
typedef struct dictEntry {
    void *key;
    union {
        void *val;
        uint64_t u64;
        int64_t s64; // 存放过期时间
        double d;
    } v;
    struct dictEntry *next;
} dictEntry;
```
## 查询过期时间命令
查询某个 key 的过期时间，redis 提供了 `TTL` 这个命令，有三种返回值，
- 返回 **-2**，表示查询的 key 不存在。
- 返回 **-1**，表示查询的 key 没有设置过期。
- 返回正常的过期时间。

上面已经知道，key 过期时间存放位置了，那么直接取出来就好了。
```c
long long getExpire(redisDb *db, robj *key) {
    dictEntry *de;

    /* No expire? return ASAP */
    if (dictSize(db->expires) == 0 ||
       (de = dictFind(db->expires,key->ptr)) == NULL) return -1;
    serverAssertWithInfo(NULL,key,dictFind(db->dict,key->ptr) != NULL);
    return dictGetSignedIntegerVal(de);
}
```
通过 `dictGetSignedIntegerVal` 函数取到过期时间。

## 删除过期时间
如果一个 key 设置了过期时间后想删除怎么办？redis 提供了 `PERSIST` 命令，或者直接用 `SET` 命令去覆盖，它们都涉及到函数 `removeExpire`。

具体代码如下，
```c
int removeExpire(redisDb *db, robj *key) {
    /* An expire may only be removed if there is a corresponding entry in the
     * main dict. Otherwise, the key will never be freed. */
    serverAssertWithInfo(NULL,key,dictFind(db->dict,key->ptr) != NULL);
    return dictDelete(db->expires,key->ptr) == DICT_OK;
}
```
从 `db->expires` 中删掉这个 key，但是 `dictEntry` 结构体中的**过期时间并不会重置**。

## 删除过期 key
redis 3.x 中，过期 key 的删除方式有两种，**惰性删除**和**周期删除**。

### 惰性删除
当 key 过期后，并不会立刻删除，即，它们占用的内存不能够得到及时释放。

redis 在对每个 key 进行读写时，都会去检查这个 key 是否过期需要删除了，这样就**把清理过期 key 的工作分摊到每一次访问中**。类似的思路还有，redis 中的 dict 的扩容，称为渐进式 rehash。

<p class="note note-warning">
这样会导致一个问题，当检查到一个大 key 要删除时，会占用比较长的时间，导致此次访问的响应时间变长。
</p>

检查 key 的 expire 的逻辑在 `expireIfNeeded` 函数中实现，代码如下，

```c
int expireIfNeeded(redisDb *db, robj *key) {
    // 获得 key 的过期时间
    mstime_t when = getExpire(db,key);
    mstime_t now;

    // key 没有设置过期时间
    if (when < 0) return 0;

    // 在 load 数据时，暂时先不要处理过期的 key
    if (server.loading) return 0;

    // 有 lua 脚本调用时，now 取 lua 脚本开始的时间，否则取当前时间
    now = server.lua_caller ? server.lua_time_start : mstime();

    // 如果本节点是 slave，等着 master 同步 DEL 命令
    if (server.masterhost != NULL) return now > when;

    // 如果没过期，返回 0
    if (now <= when) return 0;

    // 过期 key 的统计
    server.stat_expiredkeys++;

    // 同步 DEL 命令给 slave 和 aof 文件
    propagateExpire(db,key);
    notifyKeyspaceEvent(NOTIFY_EXPIRED,
        "expired",key,db->id);

    // 删 key
    return dbDelete(db,key);
}
```
经过一些前置校验，在 `propagateExpire` 函数中，将 `DEL` 命令分发给所有的 slave，以及写入 aof。
```c
void propagateExpire(redisDb *db, robj *key) {
    robj *argv[2];

    argv[0] = shared.del;
    argv[1] = key;
    incrRefCount(argv[0]);
    incrRefCount(argv[1]);

    if (server.aof_state != AOF_OFF)
        feedAppendOnlyFile(server.delCommand,db->id,argv,2);
    replicationFeedSlaves(server.slaves,db->id,argv,2);

    decrRefCount(argv[0]);
    decrRefCount(argv[1]);
}
```
当一个 key 在 master 上过期后，将会给所有的 slave 发送相应的 DEL 命令，如果 aof 打开了，也会写入 aof。

<p class="note note-primary">
这种在一个地方集中化管理 key 的方式，并且在 aof 和主从链接里保证操作顺序，即使有对于过期 key 的写操作也是允许的。
</p>

而删 key 的操作，在函数 `dbDelete` 中完成，代码如下，
```c
int dbDelete(redisDb *db, robj *key) {
    if (dictSize(db->expires) > 0) dictDelete(db->expires,key->ptr);
    if (dictDelete(db->dict,key->ptr) == DICT_OK) {
        if (server.cluster_enabled) slotToKeyDel(key);
        return 1;
    } else {
        return 0;
    }
}
```
如上代码可以看到，分别从 `db->expires` 和 `db->dict` 这两个 dict 里删除相应的 key。如果开启了 **cluster 模式**，还有在相应的 slot 里删掉。

### 周期删除
上面的惰性删除，只有在访问到 key 时才会触发，这使得过期 key 的清理时间拉的很长，所以只有惰性删除一种方式是不行的，因此增加周期删除这个方式作为补充。

周期删除使用的函数是 `activeExpireCycle`。这个函数在调用时，入参分情况有 2 种过期循环类型，两者的主要区别是执行时间的差异。
 - 常量 `ACTIVE_EXPIRE_CYCLE_FAST` ，执行时间限制是 1000 us。在 `beforeSleep` 函数中调用的，即，每次 redis 要进入事件循环之前调用，因此需要比较快的返回
 - 常量 `ACTIVE_EXPIRE_CYCLE_SLOW`，执行时间限制有一个复杂公式计算，后面会说到。在周期性任务 `databasesCron` 中调用的，执行时间可以稍微长一点。

 在 `activeExpireCycle` 函数里，会尝试删除一些过期的 key。使用到的算法是**自适应的**，如果几乎没有过期 key，仅使用少量的 CPU 周期，否则，为了避免过期 key 过多占用内存，将会更积极地从数据库删除它们。每轮检查的数据库个数不超过常量 **CRON_DBS_PER_CALL** (16) 个。

代码大概如下，

```c
if (type == ACTIVE_EXPIRE_CYCLE_FAST) {
      if (!timelimit_exit) return;
      if (start < last_fast_cycle + ACTIVE_EXPIRE_CYCLE_FAST_DURATION*2) return;
      last_fast_cycle = start;
  }
```
如果上一次循环不是因为 timeout 而结束的，那么这一次没必要跑 fast 循环，也就是说，时间够用了，可以跑 slow 多清理一些过期 key。
另外，不要在上一次跑过 fast 之后的 2 倍 **ACTIVE_EXPIRE_CYCLE_FAST_DURATION** (1000) us 时间内再跑一次 fast 循环。

`dbs_per_call` 变量保存的是，本轮循环需要遍历的 db 数量，默认值是 16，在以下 2 种情况下需要修改，
- 检查的 db 数超过现有的。
- 上一次以为 timelimit 离开了。此时需要尽快的把已有的 db 里的过期 key 给清理掉，减少内存占用，留出更多空间供正常使用。

判断代码如下，

```c
  if (dbs_per_call > server.dbnum || timelimit_exit)
      dbs_per_call = server.dbnum;
```

下面是循环时间 limit 的计算，
```c
  timelimit = 1000000*ACTIVE_EXPIRE_CYCLE_SLOW_TIME_PERC/server.hz/100;
  timelimit_exit = 0;
  if (timelimit <= 0) timelimit = 1;

  if (type == ACTIVE_EXPIRE_CYCLE_FAST)
      timelimit = ACTIVE_EXPIRE_CYCLE_FAST_DURATION; /* in microseconds. 1000 us */
```
然后开启遍历每个 db 了，如下逻辑均在此循环中实现，
```c
for (j = 0; j < dbs_per_call; j++) {}
```
代码里有一个记录上一次遍历到那个 db 的静态变量 `current_db`，每次都加 1。
```c
static unsigned int current_db = 0; /* Last DB tested. */
current_db++;
```
选择一个 db 进行数据清理，
```c
redisDb *db = server.db+(current_db % server.dbnum);
```
下面就是在选择的 db 里对 key 进行抽样检查的过程，
```c
// 如果没有过期的 key，那么这个 db 的检查结束
if ((num = dictSize(db->expires)) == 0) {
            db->avg_ttl = 0;
            break;
}

slots = dictSlots(db->expires);
if (num && slots > DICT_HT_INITIAL_SIZE && (num*100/slots < 1))
        break;
```
如果 expires 字典不为空，存储的数据可能已经很少了，但是字典还是大字典(**数据不足 1%**)，这样遍历数据有效命中率会很低，处理起来会浪费时间，后面的访问会很快触发字典的缩容，缩容后再进行处理效率更高, 暂时结束这个 db 的检查。

每一次抽样最多 20 个 key。
```c
if (num > ACTIVE_EXPIRE_CYCLE_LOOKUPS_PER_LOOP)
      num = ACTIVE_EXPIRE_CYCLE_LOOKUPS_PER_LOOP;

while (num--) {
    dictEntry *de;
    long long ttl;

    if ((de = dictGetRandomKey(db->expires)) == NULL) break;
    ttl = dictGetSignedIntegerVal(de)-now;
    if (activeExpireCycleTryExpire(db,de,now)) expired++; // 过期的 key 删掉
    if (ttl > 0) {
        /* We want the average TTL of keys yet not expired. */
        ttl_sum += ttl;
        ttl_samples++;
    }
}
```
随机选取 key，调用 `activeExpireCycleTryExpire` 函数进行过期 key 的删除，该函数逻辑见附录。

这里还有个统计平均 ttl 的逻辑，
```c
if (ttl_samples) {
    // 抽样 key 的平均 ttl 时间
    long long avg_ttl = ttl_sum/ttl_samples;

    // 本轮 avg_ttl 占比 2%，历史值占比 98%

    if (db->avg_ttl == 0) db->avg_ttl = avg_ttl;
    db->avg_ttl = (db->avg_ttl/50)*49 + (avg_ttl/50);
}
```
每个 db 的检查什么时候退出呢？有 2 个时刻。

1. 通过超时时间 `timelimit`。
每 16 轮循环检查一次是否超时，到时间后 ，`timelimit_exit` 变量置 1，接着就退出了。
```c
iteration++;
if ((iteration & 0xf) == 0) { /* check once every 16 iterations. */
    long long elapsed = ustime()-start;

    latencyAddSampleIfNeeded("expire-cycle",elapsed/1000);
    if (elapsed > timelimit) timelimit_exit = 1;
}
if (timelimit_exit) return;
```
2. 在每个 db 的检查循环外，是有条件的。
每检查到一个过期的 key，就把 `expired` 变量加 1，所以，这个循环的条件时，如果一轮抽样到的 key 中过期的比例小于 25%，那么这个 db 就不必再抽样了。
```c
#define ACTIVE_EXPIRE_CYCLE_LOOKUPS_PER_LOOP 20
do {
  ...
} while (expired > ACTIVE_EXPIRE_CYCLE_LOOKUPS_PER_LOOP/4);
```

<p class="note note-warning">
在一个时间范围内，过期 key 最好不要太密集，因为系统发现到期数据很多，会迫切希望尽快处理掉这些过期数据，所以每次检查都要耗尽分配的时间片，直到到期数据到达一个可接受的密度比例。
</p>

<p class="note note-primary">
由上总结，redis 主逻辑在单进程主线程中实现，要保证不能影响主业务前提下，检查过期数据，不能太影响系统性能。主要三方面进行限制：
(1) 检查时间限制。
(2) 过期数据检查数量限制。
(3) 过期数据是否达到可接受比例。
</p>

至此，redis 中 key 的过期逻辑就讲完了。顺便说一下，为了解决删大 key 带来的阻塞风险，在更高版本的 redis 中，将删 key 放到了 bio 后台线程中。

## 附录

`activeExpireCycleTryExpire` 函数将试着将存储的过期 key 从全局 key 的 dict 和 expire 的 dict 中删掉。如果发现 key 过期了，操作后返回 1，否则什么也不做，返回 0。代码逻辑如下，

```c
int activeExpireCycleTryExpire(redisDb *db, dictEntry *de, long long now) {
    long long t = dictGetSignedIntegerVal(de);
    if (now > t) {
        sds key = dictGetKey(de);
        robj *keyobj = createStringObject(key,sdslen(key));

        // 广播到 slave 和 aof
        propagateExpire(db,keyobj);

        // 删 key
        dbDelete(db,keyobj);
        notifyKeyspaceEvent(NOTIFY_EXPIRED,
            "expired",keyobj,db->id);
        decrRefCount(keyobj);

        // 更新统计
        server.stat_expiredkeys++;
        return 1;
    } else {
        return 0;
    }
}
```