---
title: Redis源码分析之数据迁移(2)
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: badab03c
date: 2020-04-02 18:40:22
---
上一篇文章中，详细讲解了 redis  cluster 中说数据迁移的流程，那在迁移过程中，节点对正常用户访问是如何处理的呢？
本篇文章将探讨一下。

<!--more---->

### processCommand 函数处理
众所周知，`processCommand` 函数负责处理具体的命令处理过程，

在 cluster 模式下，此函数中会进行 cluster 重定向，但 2 种情况除外：

- 发送命令的是我的 master
- 发送的命令没有 key 参数

具体代码，如下，

```c
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
    if (n == NULL || n != server.cluster->myself) {
        if (c->cmd->proc == execCommand) {
            discardTransaction(c);
        } else {
            flagTransaction(c);
        }
        clusterRedirectClient(c,n,hashslot,error_code);
        return C_OK;
    }
}
```
由上可以看出，代码中使用 `getNodeByQuery` 函数负责处理 hashslot 的节点 n。
如果 n 是空的，或者不是我自己，那么就需要做一个 cluster 的 redirection，使用 `clusterRedirectClient` 函数，该函数主要是针对 `getNodeByQuery` 函数返回的不同错误码，给 client 不同的返回信息，具体代码如下，
```c
void clusterRedirectClient(client *c, clusterNode *n, int hashslot, int error_code) {
    if (error_code == CLUSTER_REDIR_CROSS_SLOT) {
        addReplySds(c,sdsnew("-CROSSSLOT Keys in request don't hash to the same slot\r\n"));
    } else if (error_code == CLUSTER_REDIR_UNSTABLE) {
        addReplySds(c,sdsnew("-TRYAGAIN Multiple keys request during rehashing of slot\r\n"));
    } else if (error_code == CLUSTER_REDIR_DOWN_STATE) {
        addReplySds(c,sdsnew("-CLUSTERDOWN The cluster is down\r\n"));
    } else if (error_code == CLUSTER_REDIR_DOWN_UNBOUND) {
        addReplySds(c,sdsnew("-CLUSTERDOWN Hash slot not served\r\n"));
    } else if (error_code == CLUSTER_REDIR_MOVED || error_code == CLUSTER_REDIR_ASK)
    {
        addReplySds(c,sdscatprintf(sdsempty(),
            "-%s %d %s:%d\r\n",
            (error_code == CLUSTER_REDIR_ASK) ? "ASK" : "MOVED",
            hashslot,n->ip,n->port));
    } else {
        serverPanic("getNodeByQuery() unknown error.");
    }
}
```

最后返回 `C_OK`，结束命令处理流程，因为涉及到的 slot 不是本节点负责！

### getNodeByQuery 函数处理

下面来看下比较重要的 `getNodeByQuery` 函数的处理逻辑，它用来返回负责访问 slot 的真实节点。

```c
multiState *ms, _ms;
multiCmd mc;
int i, slot = 0, migrating_slot = 0, importing_slot = 0, missing_keys = 0;
/* Set error code optimistically for the base case. */
if (error_code) *error_code = CLUSTER_REDIR_NONE;
if (cmd->proc == execCommand) {
    /* If CLIENT_MULTI flag is not set EXEC is just going to return an
     * error. */
    if (!(c->flags & CLIENT_MULTI)) return myself;
        ms = &c->mstate;
    } else {
        /* In order to have a single codepath create a fake Multi State
         * structure if the client is not in MULTI/EXEC state, this way
         * we have a single codepath below. */
        ms = &_ms;
        _ms.commands = &mc;
        _ms.count = 1;
        mc.argv = argv;
        mc.argc = argc;
        mc.cmd = cmd;
}
```

当没有错误时，该函数返回的错误码是 **CLUSTER_REDIR_NONE**。

**注意**：
如果当前处于事务模式下，则事务中的所有命令中的所有 key，需要一起进行判断。
对于非事务模式下的命令，也按照事务的方式进行处理，只不过本事务只包含当前一条命令。

如果当前执行的命令是 `EXEC`，并且 client 没有 **CLIENT_MULTI** 标记，那么直接返回 myself，表示自己能处理这个命令，但是实际上这种情况下，在命令处理函数 `execCommand` 中，会直接反馈给客户端 **EXEC without MULTI** 错误。
否则，构造伪事务数据结构变量 `ms`，其中只包含当前命令这一条。

接下来，针对每一条命令，即所有逻辑包裹在如下循环里，

```c
for (i = 0; i < ms->count; i++) {}
```

```c
// 每一个命令的相关参数
mcmd = ms->commands[i].cmd;
margc = ms->commands[i].argc;
margv = ms->commands[i].argv;
keyindex = getKeysFromCommand(mcmd,margv,margc,&numkeys);
```

`getKeysFromCommand` 函数的返回值 `keyindex` 为本条命令中所有 key 的 index 数组，`numkeys` 则为 key 的个数。
接下来就循环处理本条命令中的所有 key。

```c
// 循环处理每个 key
for (j = 0; j < numkeys; j++) {}
```

```c
// 拿到 key
robj *thiskey = margv[keyindex[j]];
// 拿到对应的 slot
int thisslot = keyHashSlot((char*)thiskey->ptr, sdslen(thiskey->ptr));
```

```c
if (firstkey == NULL) {
    // 如果是该命令中的一个 key，记录到 firstkey 里
    firstkey = thiskey;
    slot = thisslot;
    n = server.cluster->slots[slot];
    // 找不到负责该 slot 的节点，报错 "-CLUSTERDOWN, unbound slot."
    if (n == NULL) {
        getKeysFreeResult(keyindex);
        if (error_code)
            *error_code = CLUSTER_REDIR_DOWN_UNBOUND;
        return NULL;
     }
     // 是我负责的 slot，并且该 slot 正在迁出 key
     if (n == myself
         && server.cluster->migrating_slots_to[slot] != NULL) {
         migrating_slot = 1;
     } else if (server.cluster->importing_slots_from[slot] != NULL) {
         importing_slot = 1;
     }
}
```

这里有个重要的逻辑。
当要操作的 key 对应的 slot 是我负责的，并且该 slot 正在迁出 key，那么标记 `migrating_slot = 1`。
如果这个 slot 不是我负责的，那么标记 `importing_slot = 1`。

如果不是第一个 key，就要看下**是不是所有的 key 都在一个 slot 上**，否则，会报错 **CROSSSLOT Keys in request don't hash to the same slot**。代码如下，

```c
if (!equalStringObjects(firstkey,thiskey)) {
    if (slot != thisslot) {
       /* Error: multiple keys from different slots. */
        getKeysFreeResult(keyindex);
        if (error_code)
            *error_code = CLUSTER_REDIR_CROSS_SLOT;
        return NULL;
     } else {
        /* Flag this request as one with multiple different keys. */
         multiple_keys = 1;
     }
}
```
所以，对于多 key 操作，涉及到的 key 需要在一个 slot 上，否则会报错。

同时，遇到正在迁入迁出 key 的 slot 还要统计 missing_keys（本地找不到的 key，可能已经迁移到目的地了）。如下，

```c
if ((migrating_slot || importing_slot) &&
    lookupKeyRead(&server.db[0],thiskey) == NULL) {
     missing_keys++;
}
```

结束了每个命令的处理，接着往下走，对于有迁入迁出 slot 的情况是如何处理的呢？

```c
// 命令里没有 key，本节点就可以处理，返回 myself
if (n == NULL) return myself;

// 集群状态不正常，返回错误 -CLUSTERDOWN
if (server.cluster->state != CLUSTER_OK) {
    if (error_code) *error_code = CLUSTER_REDIR_DOWN_STATE;
        return NULL;
 }

// 如果有正在迁入或者迁出的 slot，且正执行的命令是 MIGRATE，返回 myself
// MIGRATE 命令总是在本地上下文环境中运行的
if ((migrating_slot || importing_slot) && cmd->proc == migrateCommand)
    return myself;
```

对于访问到迁入迁出 slot 中的 key 的处理，如下

```c
if (migrating_slot && missing_keys) {
    if (error_code) *error_code = CLUSTER_REDIR_ASK;
    return server.cluster->migrating_slots_to[slot];
}

if (importing_slot &&
 (c->flags & CLIENT_ASKING || cmd->flags & CMD_ASKING)) {
     if (multiple_keys && missing_keys) {
         if (error_code) *error_code = CLUSTER_REDIR_UNSTABLE;
             return NULL;
     } else {
         // 否则返回 myself
         return myself;
     }
}
```

若访问的 slot 正在做迁出，且存在正常访问的 key 在本地查不到，那么报错 **-ASK**，并返回该 key 迁移到的目的节点（可能是迁到目的节点了）。
若访问的 slot 正在做迁入，且 client 带有 **CLIENT_ASKING** 标记，或者 cmd 带有 **CMD_ASKING** 的标记。此时，如果涉及到多 key 操作，且有的key不在当前节点中，报错  **-TRYAGAIN**（后面重试），返回 NULL。否则，返回 myself（因为所有的 key 我都有嘛）。

--------------

经过上面两条分析，**下面总结一下**：
当要访问的 slot 恰好在做迁移，那么 redis 有如下逻辑。
`multiple_keys` 变量表示这是否是个多 key 操作。
`missing_keys` 变量表示，要访问的 key，是否都在本节点。

对于单 key 操作，

- 写 key 时，因为本地没有这个 key，所以通过 ASK 错误重定向到目标节点进行写入操作。

- 读 key 时，如果本地节点有，那么在本地节点访问，否则通过 ASK 错误，重定向到目标节点进行读取。

对于多 key 操作，

- 写 key 时，因为本地没有这些 key，所以通过 ASK 错误重定向到目标节点，而在目标节点中也没有这些 key，而且又是个多 key 操作，那么报错 **-TRYAGAIN**，只能等到后面这个 slot 迁移完成后才能做多 key 写入。

- 多 key 时，如果本地有所有的 key，那么正常返回。如果本地只有部分 key，那么通过 ASK 错误重定向到目标节点。到了目标节点，如果有全部的 key，那么正常返回，否则报错 **-TRYAGAIN**。（待会再来访问吧，等到所有的 key 都迁过来）

------------------

### MOVED 与 ASK 重定向

如果访问到的 slot 不是我负责的，那么报错 **-MOVED**，且返回正确的负责节点。

```c
if (n != myself && error_code) *error_code = CLUSTER_REDIR_MOVED;
    return n;
```

当然，这样也可以很清楚的看到 **MOVED** 和 **ASK** 错误的区别。

- **ASK** 表示，要访问的 key 所在的 slot 当前正在做迁移，去 ASK 迁入节点处理请求。

- **MOVED** 表示，要访问的 key 所在的 slot 不由本节点负责，MOVED 到正确的节点去访问吧。

接收到 ASK 错误后，client 应该先发送 `ASKING` 命令到迁入节点，使得 client 带上 `CLIENT_ASKING` 标记，然后再发送正常命令。

```c
void askingCommand(client *c) {
    if (server.cluster_enabled == 0) {
        addReplyError(c,"This instance has cluster support disabled");
        return;
    }
    c->flags |= CLIENT_ASKING;
    addReply(c,shared.ok);
}
```