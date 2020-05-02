---
title: Redis源码分析之数据迁移(1)
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: 91f7e3ff
date: 2020-04-02 18:11:43
---

redis 中的数据迁移是以 key 为单位的，整个迁移过程由一系列命令组成，在官方提供的 ruby 实现的 trib 工具中对整个过程进行了包装串联，在更新的版本的 redis 中，已经将这些逻辑移植到了 redis-cli 中，使用 C 进行了重写。下面进行分步详细讲解。

<!--more---->

## 标记 importing

在**目的节点** B 执行命令 `SETSLOT 10 IMPORTING <A 的 nodeID>`，标记有一个 slot (10) 将要从源节点 A 迁入到本节点 B。
此时，在 B 上使用  `cluster nodes` 命令查看集群路由现状，可以发现，在 B 负责的 slot 信息里有这样的标记`[10-<-A nodeid]`。（其他节点不知道这件事）

具体代码执行逻辑如下，

```c
void clusterCommand(client *c) {
    .....
    else if (!strcasecmp(c->argv[1]->ptr,"setslot") && c->argc >= 4) {
        .....
        else if (!strcasecmp(c->argv[3]->ptr,"importing") && c->argc == 5) {
            if (server.cluster->slots[slot] == myself) {
                addReplyErrorFormat(c, "I'm already the owner of hash slot %u",slot);
                return;
            }
            if ((n = clusterLookupNode(c->argv[4]->ptr)) == NULL) {
                addReplyErrorFormat(c,"I don't know about node %s", (char*)c->argv[3]->ptr);
                return;
            }
            server.cluster->importing_slots_from[slot] = n;
        }
        .....
    }
    .....
}
```

当接收到 `setslot` 命令时，匹配到关于设置 slot  importing 状态的逻辑。

首先是一些参数的校验。

- 检查 slot x 是不是已经属于我了，如果是，那么报错 **I'm already the owner of hash slot x**。（slot x 已经是我的了，不需要再迁给我）
- 检查源节点我是否认识，如果不认识的话，报错  **I don't know about node**。（不认识源节点，我从哪儿迁入呢？）

然后，修改 `server.cluster` 结构体的相应变量，表示已经记下了。

在每个 cluster 节点中，都有一个 `clusterState` 结构体，用来保存集群信息，其中 `importing_slots_from` 变量表示要迁入本节点的 slot 信息，而 `migrating_slots_to` 变量表示要迁出本节点的 slot 信息，它们都是 16384 长度的数组。

## 标记 migrating

在源节点 A  执行命令 `SETSLOT 10 MIGRATING <B 的 nodeID>`，标记有一个 slot (10) 将要从本节点 A 迁出到目标节点 B。
此时，在 A 上使用 `cluster nodes` 命令查看集群路由现状，可以发现，在 A 负责的 slot 信息里有这样的标记`[10->-B nodeid]`。（其他节点不知道这件事）

具体代码执行逻辑如下，

```c
void clusterCommand(client *c) {
    ....
    else if (!strcasecmp(c->argv[1]->ptr,"setslot") && c->argc >= 4) {
        ....
          if (!strcasecmp(c->argv[3]->ptr,"migrating") && c->argc == 5) {
                addReplyErrorFormat(c,"I'm not the owner of hash slot %u",slot);
                return;
            }
            if ((n = clusterLookupNode(c->argv[4]->ptr)) == NULL) {
                addReplyErrorFormat(c,"I don't know about node %s", (char*)c->argv[4]->ptr);
                return;
            }
            server.cluster->migrating_slots_to[slot] = n; // 标记 slot 的目的地
        }
        ....
    }
    .....
}
```

当接收到 `setslot` 命令时，匹配到关于设置 slot  migrating 状态的逻辑。
首先是一些参数的校验。

- 检查 slot x 是不是我负责的，如果不是，报错 **I'm not the owner of hash slot x**。（不是我负责的 slot，我无权迁出）
- 检查目的节点我是否认识，如果不认识的话，报错 **I don't know about node**。（不认识目的节点，我怎么迁出？）

然后，修改 `server.cluster` 结构体相应变量，表示已经记下了。

<p class="note note-warning">
应该先在迁入节点标记 slot 的 importing 状态，后在迁出节点标记 slot 的 migrating 状态。若颠倒顺序的话，会有一些问题。<br><br>
假设这样的场景，在迁出节点设置了 slot 的 migrating 状态。之后访问迁出节点 slot 的写命令，会被重定向到迁入节点（没有 key 就会重定向），但是此时迁入节点 slot 还没有做标记，所以又会产出一个 MOVED 错误，如此循环往复。说到底还是因为这些命令的执行是分开的，而非原子的。
</p>

## 源节点从 slot 中取 key

经过前面两步，将要迁移的 slot 在源节点和目的节点都进行的标记。 现有的 redis cluster 中数据迁移的基本单位是 key，因此要先取出要迁移的一部分 key，有 `GETKEYSINSLOT` 命令可以使用，全格式为 `CLUSTER GETKEYSINSLOT <slot> <count>`。

具体代码逻辑如下，

```c
void clusterCommand(client *c) {
    ......
    else if (!strcasecmp(c->argv[1]->ptr,"getkeysinslot") && c->argc == 4) {
        /* CLUSTER GETKEYSINSLOT <slot> <count> */
        long long maxkeys, slot;
        unsigned int numkeys, j;
        robj **keys;
        if (getLongLongFromObjectOrReply(c,c->argv[2],&slot,NULL) != C_OK)
            return;
        if (getLongLongFromObjectOrReply(c,c->argv[3],&maxkeys,NULL)
            != C_OK)
            return;
        if (slot < 0 || slot >= CLUSTER_SLOTS || maxkeys < 0) {
            addReplyError(c,"Invalid slot or number of keys");
            return;
        }

        keys = zmalloc(sizeof(robj*)*maxkeys);
        numkeys = getKeysInSlot(slot, keys, maxkeys);
        addReplyMultiBulkLen(c,numkeys);
        for (j = 0; j < numkeys; j++) addReplyBulk(c,keys[j]);
        zfree(keys);
    }
    .....
}
```

首先，解析参数，

- 从哪个 slot 取数据？存到变量 slot 中。

- 这一次取多少个 key？存到变量 maxkeys 中。

然后，分配内存，使用 `getKeysInSlot` 函数从跳表 `server.cluster->slots_to_keys` 中取出 slot x 里最多 maxkeys 个 key，存入数组 keys 中，`getKeysInSlot` 函数返回实际取得的key的数量。
最后，响应客户端 OK，并释放内存。

## migrate keys 过程

### 源节点处理

使用上一步取出来的 key，使用 `MIGRATE` 命令进行 key 的搬迁。

```c
MIGRATE host port "" dbid timeout [COPY | REPLACE] KEYS key1 key2 ... keyN
```

正常流程中，将 key 搬迁到目标节点以后，会其从源节点删除掉，但是命令中的 **COPY** 和 **REPLACE** 选项会使得此过程有不同的表现。

- COPY ：目的节点如果已经存在要搬迁的 key，会报错。且 key 搬迁完成后，源节点也不会删掉这个 key。

- REPLACE：不管目的节点是否存在要迁移的 key，都覆盖它。

- 两个选项都不要。目的节点如果已经存在要搬迁的 key，会报错。

#### 一些初始化

`MIGRATE` 命令使用函数 `migrateCommand` 进行处理。

首先，进行一些参数校验以及变量的初始化。
如果 timeout 选项解析出来 <=0，那么设置为默认值 1s。timeout 值用来做建链接接超时，以及后面的读写超时。
将要迁移的 key 保存到数组 kv 中，相应的 value 保存到数组 ov 中 ，代码如下，

```c
ov = zrealloc(ov,sizeof(robj*)*num_keys);
kv = zrealloc(kv,sizeof(robj*)*num_keys);
int oi = 0;
for (j = 0; j < num_keys; j++) {
    if ((ov[oi] = lookupKeyRead(c->db,c->argv[first_key+j])) != NULL) {
        kv[oi] = c->argv[first_key+j];
        oi++;
    }
}
num_keys = oi;
if (num_keys == 0) {
    zfree(ov); zfree(kv);
    addReplySds(c,sdsnew("+NOKEY\r\n"));
    return;
}
```

<p class="note note-warning">
由于 key 的过期或者主从删除等原因，这里的 oi 的值很可能跟 num_keys 是不一致的，如果 key 都没有了，也就是不用再迁移了，那么返回信息 +NOKEY。
</p>

#### 建立连接

然后，跟要迁入 key 的目的节点建立连接。代码如下，

```c
/* Connect */
cs = migrateGetSocket(c,c->argv[1],c->argv[2],timeout);
if (cs == NULL) {
    zfree(ov); zfree(kv);
    return; /* error sent to the client by migrateGetSocket() */
}
```

可以看到，代码中根据命令参数 host 和 port 使用 `migrateGetSocket` 函数可拿到一个可用的连接，该函数逻辑可以参考附录。

#### 填充 cmd 信息

拿到可用的连接后，接着就需要将要搬迁的 key 以 **redis 协议的格式**发送到目的节点，具体格式如下，

```c
*4\r\n (或 *5\r\n)
$14\r\nRESTORE-ASKING\r\n (或 $7\r\nRESTORE\r\n)
$<count>\r\n<payload>\r\n (key 信息)
$<count>\r\n<payload>\r\n (ttl 信息)
$<count>\r\n<payload>\r\n (value dump 信息)
$7\r\nREPLACE\r\n (根据情况决定是否有这个参数)
```

可以看到使用的是 `RESTORE-ASKING` 或者 `RESTORE` 的命令。

下面看填充 cmd 的具体代码分析。

```c
rio cmd, payload;
rioInitWithBuffer(&cmd,sdsempty());
```

首先，使用 `rio` 类型的变量 cmd 存放要发给目的节点的 redis 协议格式的命令，下面就开始使用要迁移的 key/value 组装数据。
看下是否需要切换数据库，有必要的话，强制发 `SELECT <dbid>` 。

```c
int select = cs->last_dbid != dbid; /* Should we emit SELECT? */
if (select) {
    serverAssertWithInfo(c,NULL,rioWriteBulkCount(&cmd,'*',2));
    serverAssertWithInfo(c,NULL,rioWriteBulkString(&cmd,"SELECT",6));
    serverAssertWithInfo(c,NULL,rioWriteBulkLongLong(&cmd,dbid));
}
```

下面是针对每一个 key 进行的处理，具体代码如下，

```c
long long ttl = 0;
long long expireat = getExpire(c->db,kv[j]);
if (expireat != -1) {
    ttl = expireat-mstime();
    if (ttl < 1) ttl = 1;
}
```

首先将 key 的过期时间从绝对时间转成相对时间，记录在 ttl 中。
根据前面命令传入的选项是 replace 还是 copy，决定发送命令的参数个数。

```c
serverAssertWithInfo(c,NULL,rioWriteBulkCount(&cmd,'*',replace ? 5 : 4));
```

```c
if (server.cluster_enabled)
    serverAssertWithInfo(c,NULL,
                rioWriteBulkString(&cmd,"RESTORE-ASKING",14));
else
    serverAssertWithInfo(c,NULL,rioWriteBulkString(&cmd,"RESTORE",7));
```

如果当前处于集群模式下，则向 cmd 中填充 `RESTORE-ASKING` 命令，否则填充 `RESTORE` 命令。
然后，对每个 key 的信息进行填充，

```c
// 填充 key 的信息
serverAssertWithInfo(c,NULL,sdsEncodedObject(kv[j]));
serverAssertWithInfo(c,NULL,rioWriteBulkString(&cmd,kv[j]->ptr,
                sdslen(kv[j]->ptr)));

// 填充 ttl 信息
serverAssertWithInfo(c,NULL,rioWriteBulkLongLong(&cmd,ttl));

// 填充 value 的信息
createDumpPayload(&payload,ov[j]);
serverAssertWithInfo(c,NULL,
rioWriteBulkString(&cmd,payload.io.buffer.ptr,
    sdslen(payload.io.buffer.ptr)));
sdsfree(payload.io.buffer.ptr);
```

value 的值，要使用 `createDumpPayload` 函数进行 rdb 序列化，具体格式如下，

```c
/* Write the footer, this is how it looks like:
 * ----------------+---------------------+---------------+
 * ... RDB payload | 2 bytes RDB version | 8 bytes CRC64 |
 * ----------------+---------------------+---------------+
 * RDB version and CRC are both in little endian.
 */
```

序列化过程在函数 `createDumpPayload` 中，在此就不做分析了。
最后根据 replace 变量，决定是否要填充 **REPLACE**，即，

```c
if (replace)
    serverAssertWithInfo(c,NULL,rioWriteBulkString(&cmd,"REPLACE",7));
```

这样，所有要迁移的 key 也就序列化到 cmd 这个 `rio` 变量里了。下面就要发给目的节点了。

#### 发送到目的节点

组装完cmd，就要把它们发送到对端，代码逻辑如下，

```c
sds buf = cmd.io.buffer.ptr;
size_t pos = 0, towrite;
int nwritten = 0;
while ((towrite = sdslen(buf)-pos) > 0) {
    towrite = (towrite > (64*1024) ? (64*1024) : towrite);
    nwritten = syncWrite(cs->fd,buf+pos,towrite,timeout);
    if (nwritten != (signed)towrite) {
        write_error = 1;
        goto socket_err;
     }
     pos += nwritten;
}
```

循环调用 `syncWrite` 函数，向远端 Redis **同步**发送 cmd 中的内容，每次最多发送 **64k** 个字节。

#### 对目的节点回复的处理

定义两个变量，接收对端的回复。

```c
char buf1[1024]; /* Select reply. */
char buf2[1024]; /* Restore reply. */
```

```c
// 如果前面发送了 select 命令，那么需要先读取此命令的回复
if (select && syncReadLine(cs->fd, buf1, sizeof(buf1), timeout) <= 0)
    goto socket_err;
```

下面同步读取每一个 restore key 的返回值，具体逻辑如下，

```c
if (syncReadLine(cs->fd, buf2, sizeof(buf2), timeout) <= 0) {
     socket_error = 1;
     break;
}

if ((select && buf1[0] == '-') || buf2[0] == '-') {
    /* On error assume that last_dbid is no longer valid. */
   if (!error_from_target) {
       cs->last_dbid = -1;
       addReplyErrorFormat(c,"Target instance replied with error: %s",
           (select && buf1[0] == '-') ? buf1+1 : buf2+1);
       error_from_target = 1;
   }
} else {
    if (!copy) {
        /* No COPY option: remove the local key, signal the change. */
        dbDelete(c->db,kv[j]);
        signalModifiedKey(c->db,kv[j]);
        server.dirty++;
        /* Populate the argument vector to replace the old one. */
         newargv[del_idx++] = kv[j];
         incrRefCount(kv[j]);
    }
}
```

首先将对端回复读取变量 **buf2** 里。
如果 **buf1** 或者 **buf2** 首字母是字符 `-`，说明遇到了错误，那么将连接中的  `last_dbid` 置为 -1，这样下次再使用时，会强制发送 `SELECT` 命令。
如果 `MIGRATE` 命令中没有使用 **COPY**  选项，那么需要将搬迁到目标节点的 key 从本地删除掉。同时记录在数组 `newargv` 中，**以方便后面修改命令，传播到副本中**。

具体逻辑如下，

```c
if (!copy) {
    if (del_idx > 1) {
        newargv[0] = createStringObject("DEL",3);
        replaceClientCommandVector(c,del_idx,newargv);
        argv_rewritten = 1;
    } else {
        zfree(newargv);
    }
   newargv = NULL;
}
```

将 `MIGRATE` 命令改成 `DEL` 命令。

#### 回复 client 与错误处理

```c
if (socket_error) migrateCloseSocket(c->argv[1],c->argv[2]);
if (!copy) {
    ....
}
```

`socket_error` 在同步读取对端回复时，有可能遇到。当发生这个错误时，直接关掉这个 socket。

<p class="note note-warning">
这里并没有返回，这是因为，对于已经迁移成功的 key，后面还是要做命令转换的，因此不能直接返回。
</p>

如果没有发生错误，就可以给 client 正确的回复了。

```c
if (!error_from_target) {
    cs->last_dbid = dbid;
    addReply(c,shared.ok);
} else {
}
```

成功了，更改连接中的 `last_dbid` 为本次使用的 dbid，留着下一次用，避免下次再发送 `SELECT` 命令。
如果写命令或者读回复发生错误，而且若**不是超时错误**的话，那么可以重试一次。

```c
if (errno != ETIMEDOUT && may_retry) {
    may_retry = 0;
    goto try_again;
}
```

**try_again** 会跳到前面重新填 cmd，再来一遍，否则会回复 client 错误。

```c
addReplySds(c, sdscatprintf(sdsempty(),
    "-IOERR error or timeout %s to target instance\r\n",
    write_error ? "writing" : "reading"));
```

<p class="note note-danger">
从上面的分析，<br><br>
为了避免同一个 key 出现在两个节点中，在源节点上，涉及到向目标节点建链、发送命令和等待回复的过程，都是同步的。如果遇到大 key，那么搬迁时间会比较长，此时会堵塞住进来请求的 client，甚至有可能触发 failover。<br><br>
所以，不建议一次性搬移过多的 key，而且要提前解决掉 大 key 的问题。<br><br>
目前业界已经有以主从复制的思路，以 slot 为单位进行数据搬迁了，能很好解决大 key 问题。
</p>

### 目的节点的处理

对端接收到 `RESTORE-ASKING` 或 `RESTORE` 命令后，使用函数 `restoreCommand` 进行逻辑处理。
首先检查第 4 个参数是否为 replace。

```c
for (j = 4; j < c->argc; j++) {
    if (!strcasecmp(c->argv[j]->ptr,"replace")) {
        replace = 1;
    } else {
         addReply(c,shared.syntaxerr);
         return;
    }
}
```

**如果有**第 4 个参数，那么一定是  replace ，否则就报语法错误 **-ERR syntax error**。当然也有可能没有，这时 replace = 0。
如果 replace = 0，且当前数据库中已经有个这个 key，报错 **-BUSYKEY Target key name already exists**
取出 ttl 信息，且它一定是个 > 0 的数值。

```c
if (getLongLongFromObjectOrReply(c,c->argv[2],&ttl,NULL) != C_OK) {
    return;
} else if (ttl < 0) {
    addReplyError(c,"Invalid TTL value, must be >= 0");
    return;
}
```

接着解析第 3 个参数，应该是 value 的 dump 信息了。

```c
/* Verify RDB version and data checksum. */
if (verifyDumpPayload(c->argv[3]->ptr,sdslen(c->argv[3]->ptr)) == C_ERR) {
    addReplyError(c,"DUMP payload version or checksum are wrong");
    return;
}

rioInitWithBuffer(&payload,c->argv[3]->ptr);
if (((type = rdbLoadObjectType(&payload)) == -1) ||
    ((obj = rdbLoadObject(type,&payload)) == NULL)) {
    addReplyError(c,"Bad data format");
    return;
}
```

先校验一下这个 dump 信息是否符合规范，然后分别使用 `rdbLoadObjectType` 函数和 `rdbLoadObject` 函数，将 type 和 obj 还原。
接着对本地数据库进行处理，代码如下，

```c
if (replace) dbDelete(c->db,c->argv[1]);

/* Create the key and set the TTL if any */
dbAdd(c->db,c->argv[1],obj);

if (ttl) setExpire(c->db,c->argv[1],mstime()+ttl);
signalModifiedKey(c->db,c->argv[1]);
addReply(c,shared.ok);
server.dirty++;
```

如果有 replace，就要从本地删除原来的 key，使用从源节点传过来的值进行覆盖。
有 ttl 的话，再设置一下过期时间。
最后，回复客户端"OK"信息；

**以上，就完成了一个 key 的迁移过程。**

## 设置 slot 最终归属

当 slot 中的 key 全部搬迁完之后，
使用 `CLUSTER SETSLOT <SLOT> NODE <NODE ID>` 命令设置 slot。

先在目标节点设置，消除 importing 标记。
再在源节点设置， 消除 migrating 标记。

为了让整个集群都感知到新的 slot 归属，可以给集群其他节点都发一遍，当然了，也可以等着 gossip 消息，但是在大集群中扩散过程就比较慢了。

<p class="note note-warning">
注意上面的顺序!!<br><br>
如果先取消到 migrating 标记，且还没有取消 importing 标记，那么迁出节点会认为这个 slot 属于迁入节点了，所以读写访问时，会 MOVED 到迁入节点，但是在迁入节点来看这个节点不属于自己，且没有 ASK 重定向，所以会重新 MOVED 到迁出节点。所以产生一个 pingpong 的过程。<br><br>
而按照上面的顺序的话，如果有访问到正在迁出的 slot，那么会 ASK 重定向到迁入节点，在迁入节点看来，这个 slot 是属于自己的，正常处理，不会发生错误。
</p>

<p class="note note-primary">
这个顺序跟开始迁移时是一致的，先处理迁入节点，再处理迁出节点。
</p>

下面看这个命令的实际处理过程，部分代码如下，

```c
else if (!strcasecmp(c->argv[3]->ptr,"node") && c->argc == 5) {
    clusterNode *n = clusterLookupNode(c->argv[4]->ptr);
    if (!n) {
        addReplyErrorFormat(c,"Unknown node %s", (char*)c->argv[4]->ptr);
        return;
    }
    ...
}
```

```c
if (server.cluster->slots[slot] == myself && n != myself) {
    if (countKeysInSlot(slot) != 0) {
        addReplyErrorFormat(c,
            "Can't assign hashslot %d to a different node "
             "while I still hold keys for this hash slot.", slot);
        return;
     }
}
```

首先还是一些参数校验。

- 参数传入的 node 我是否认识，不认识的话，报错退出。

- 参数传入的 slot 是我负责的，且 node 是别人。这时就要看下，这个 slot 里的 key 是否已经全部搬迁完了，如果不是，那么报错。（key 都没有迁完，怎么能把 slot 给别人呢？会丢数据的）。如果 slot 不是我的，那么我就抱着看热闹的心态，跳过这个检查就好了。

下面就是 slot 状态的消除了，主要代码如下，

```c
 if (countKeysInSlot(slot) == 0 &&
     server.cluster->migrating_slots_to[slot])
     server.cluster->migrating_slots_to[slot] = NULL;
```

如果 slot 中没有 key，并且处于 **migrating** 状态（也就说这是针对源节点的操作），那么把迁出状态取消。
接下来，对于 **importing** 状态的目标节点，发布最新的路由，代码如下，

```c
if (n == myself && server.cluster->importing_slots_from[slot]){
    if (clusterBumpConfigEpochWithoutConsensus() == C_OK) {
        serverLog(LL_WARNING, "configEpoch updated after importing slot %d", slot);
    }
    server.cluster->importing_slots_from[slot] = NULL;
}
```

使用 `clusterBumpConfigEpochWithoutConsensus` 函数，**自行增加自己的 config epoch 值**。

本函数违反了 config epochs 应经过集群达成共识后产生，且在整个 cluster 内是唯一的。
然而 Redis Cluster 在以下两种情况下使用自动生成的新 config epochs：

- 当 slots 在 importing 后关闭。否则，resharding 的代价太昂贵。

- 当 CLUSTER FAILOVER 强制一个 slave failover 的选项调用时，即使没有大多数 master 同意也要产生一个新的 epoch。

如果本节点的 config epoch 值不是集群中最大的，那么会取到最大的，然后 +1，作为现在的 config epoch 和 current epoch。
最后变更路由，代码如下，

```c
clusterDelSlot(slot);
clusterAddSlot(n,slot);
```

**至此，就把完成了一个完整的迁移流程**。

## 附录

### migrateGetSocket 函数分析

主要代码如下，

```c
migrateCachedSocket* migrateGetSocket(client *c, robj *host, robj *port, long timeout) {
    ...
    cs = dictFetchValue(server.migrate_cached_sockets,name);
    if (cs) {
        sdsfree(name);
        cs->last_use_time = server.unixtime;
        return cs;
    }
    /* No cached socket, create one. */
    if (dictSize(server.migrate_cached_sockets) == MIGRATE_SOCKET_CACHE_ITEMS) {
        /* Too many items, drop one at random. */
        dictEntry *de = dictGetRandomKey(server.migrate_cached_sockets);
        cs = dictGetVal(de);
        close(cs->fd);
        zfree(cs);
        dictDelete(server.migrate_cached_sockets,dictGetKey(de));
    }
    fd = anetTcpNonBlockConnect(server.neterr, c->argv[1]->ptr, atoi(c->argv[2]->ptr));
    ...
    anetEnableTcpNoDelay(server.neterr,fd);
   /* Check if it connects within the specified timeout. */
    if ((aeWait(fd,AE_WRITABLE,timeout) & AE_WRITABLE) == 0) {
        sdsfree(name);
        addReplySds(c,
            sdsnew("-IOERR error or timeout connecting to the client\r\n"));
        close(fd);
        return NULL;
    }

    /* Add to the cache and return it to the caller. */
    cs = zmalloc(sizeof(*cs));
    cs->fd = fd;
    cs->last_dbid = -1;
    cs->last_use_time = server.unixtime;
    dictAdd(server.migrate_cached_sockets,name,cs);
 }
```

通过以上代码可以看到，对于连接过程中的 socket fd 封装到结构体 `migrateCachedSocket`，存入 `server.migrate_cached_sockets` 这个 dict 中。

```c
typedef struct migrateCachedSocket {
   int fd;
   long last_dbid;
   time_t last_use_time;
} migrateCachedSocket;
```

`migrateCachedSocket` 结构体包含 socket fd，上一次迁移数据用到的 db，以及连接上一次使用的时间 `last_use_time`。
将 socket 缓存下来的目的是，当要迁移的 key 很多时，一次 migrate 命令是迁不完的，缓存下来 socket 可以减少创建成本。

`last_use_time` 变量存在的意义是，为了节省资源，缓存的连接需要做定期清理，该逻辑在函数 `migrateCloseTimedoutSockets` 中，如果一个连接 **10 s** 未使用，就把它 close 掉。

`last_dbid` 的作用是，强制发送 `SELECT` 命令，以切换数据库。

当缓存的连接数量足够多时，会随机剔除一个，以容纳新的连接。

然后，设置 fd 为非阻塞式的，在给定时间内，看一下是否连接成功了。成功后返回一个 `migrateCachedSocket` 类型的变量，并放到 `migrate_cached_sockets` 中缓存起来。
