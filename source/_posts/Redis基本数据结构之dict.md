---
title: Redis 基本数据结构之 dict
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: d68bbf73
date: 2018-09-08 14:04:32
---
> 字典，又称为符号表(symbol table)、关联数组(associative array)或者映射(map)，是一种用于保存键值对(key-value pair) 的抽象数据结构。

dict 是一种非常常用的数据结构，因为 c 语言里没有内置这种数据结构，所以 redis 内部实现了自己的 dict  数据结构。

<!--more---->

dict 在 redis 中被广泛使用，如 redis 的数据库就是使用 dict 来作为底层实现的，对数据库的增删改查操作也是构建在对 dict 的操作之上的。此外，dict 还是哈希键的底层实现之一。

redis 源码中关于 dict 的部分，主要在 `dict.h` 和 `dict.c` 这两个文件中。

### dict 的定义

首先在 `dict.h` 中找到定义，主要分为以下三个部分：

```c
typedef struct dict {
    dictType *type;   // 类型特定函数
    void *privdata;  // 私有数据，保存着 dictType 结构中函数的参数
    dictht ht[2];  // 哈希表，2个
    long rehashidx; /* 标记 rehash 进度，没有的话为 -1 */
    int iterators; /* number of iterators currently running */
} dict;
```

```c
typedef struct dictht {
    dictEntry **table;  // 哈希节点数组，一个个 hash 桶
    unsigned long size;  // 哈希表大小
    unsigned long sizemask; // 哈希表大小掩码，计算索引值，= size-1
    unsigned long used;  // 该哈希表已有节点（ k-v 对 ）的数量
} dictht;
```

```c
typedef struct dictEntry {
    void *key;
    union {
        void *val;
        uint64_t u64;
        int64_t s64;
        double d;
    } v;
    struct dictEntry *next; // 链表法解决 hash 冲突
} dictEntry;
```

将以上三个结构体使用如下图片进行表示，可能会更清楚一些。

![redis-dict](https://s1.ax1x.com/2018/09/08/iPRjfg.jpg)

`dict` 结构包含两个哈希表 `dictht`，每一个哈希表都有很多个哈希桶 `dictEntry`，`table` 是一个指针数组类型变量。每一个哈希桶是一个链表，以**链表法**解决哈希冲突问题。

一般情况下，只使用 `ht[0]`，当发生 rehash 的时候才会用到 `ht[1]`，此时 `rehashidx` 变量会记录 rehash 目前的进度，不进行 rehash 时，值为 -1。

`dictType` 结构体定义了一些操作 `dict` 时要用到的函数指针。

```c
typedef struct dictType {
    unsigned int (*hashFunction)(const void *key);  // 计算哈希值的函数
    void *(*keyDup)(void *privdata, const void *key); // 复制 key 的函数
    void *(*valDup)(void *privdata, const void *obj); // 复制 val 的函数
    int (*keyCompare)(void *privdata, const void *key1, const void *key2); // 比较 key 的函数
    void (*keyDestructor)(void *privdata, void *key); // 销毁 key 的析构函数
    void (*valDestructor)(void *privdata, void *obj); // 销毁 val 的析构函数
} dictType;
```

定义了一些宏，可以更方便地使用这些函数指针，比如，

```c
#define dictFreeVal(d, entry) \
    if ((d)->type->valDestructor) \
        (d)->type->valDestructor((d)->privdata, (entry)->v.val)
```

另外，还定义了一个 dict 迭代器

```c
typedef struct dictIterator {
    dict *d; //被迭代的 dict
    long index; //迭代器当前所指向的哈希表索引位置
    // table表示正迭代的哈希表号码，ht[0]或ht[1]。safe表示这个迭代器是否安全
    int table, safe;
    // entry指向当前迭代的哈希表节点，nextEntry 则指向当前节点的下一个节点
    dictEntry *entry, *nextEntry;
    /* unsafe iterator fingerprint for misuse detection. */
    long long fingerprint;
} dictIterator;
```

### 哈希相关

#### 哈希函数

我们知道，当要往 hash 表中插入元素的时候，必须要先计算相应 key 的 hash 值。

在 redis 中定义了三种哈希函数。

【1】Thomas Wang's 32 bit Mix Function

【2】djb 哈希算法

【3】MurmurHash2，最新版本为 MurmurHash3

当字典被用作数据库的底层实现时，或者哈希 key 的底层实现时， redis 使用 MurmurHash2 算法来计算 key 的哈希值。

hash 值使用 hash 函数进行计算，然后与 `dictht` 的 `sizemask` 取模，就得到了哈希桶的索引。

#### 哈希冲突

redis 使用链地址法解决哈希冲突。

因为  `dictEntry` 节点组成的链表没有指向链表表尾的指针，考虑到添加节点的成本，总是将新节点添加到链表的表头位置，使得复杂度从 `O(n)` 降低为 `O(1)`。

### rehash

随着操作的不断执行，hash 表中保存的元素数量会动态变化，为了让哈希表的负载因子维持在一个合理的范围，需要对哈希表的大小多**动态**调整。

大小调整过程中就涉及到哈希桶的分拆或合并，这个过程叫做 rehash。

当负载因子过高时，产生 hash 冲突的几率就增大了，也就是说某些哈希桶中的链表会越来越长，这样时查找元素的时间复杂度趋于 `O(n)`，这个时候对 hash 表扩容。

否则，其中元素太小，浪费空间，就先释放，要用的话再申请。

#### 是否需要 rehash

对于是否需要进行 rehash，有一个私有函数来尽进行判断。

```c
static int _dictExpandIfNeeded(dict *d)
{
    /* Incremental rehashing already in progress. Return. */
    if (dictIsRehashing(d)) return DICT_OK;


    // 如果 hash table 是看的，那么把它收缩成出初始化 size (= 4)
    if (d->ht[0].size == 0) return dictExpand(d, DICT_HT_INITIAL_SIZE);

    if (d->ht[0].used >= d->ht[0].size &&
        (dict_can_resize ||
         d->ht[0].used/d->ht[0].size > dict_force_resize_ratio))
    {
        return dictExpand(d, d->ht[0].used*2);
    }
    return DICT_OK;
}
```

以上函数自动判断的。

还有一个需要手动发起 rehash 的函数，用来对哈希表进行缩容操作。

```c
int dictResize(dict *d)
{
    int minimal;

    // 当 dict_can_resize = 0 或者 dict 正在做 rehash 时
    if (!dict_can_resize || dictIsRehashing(d)) return DICT_ERR;
    minimal = d->ht[0].used;
    if (minimal < DICT_HT_INITIAL_SIZE) // 小于 4 的话按照 4 来算
        minimal = DICT_HT_INITIAL_SIZE;
    return dictExpand(d, minimal); // 用 minimal 调整字典 d 的大小
}
```

`dict_can_resize` 这个变量做了标记，说明 server 在做 `BGSAVE` 命令或者 `BGREWRITEAOF`。

#### 如何 rehash

##### 扩容操作

在 `ht[0].size == 0`时，即空哈希表，这时候把哈希表缩容到 size 为初始值 **4**。

在`used > size` 的情况下，即这个时候肯定出现了哈希冲突，

如果允许 rehash，进行哈希表扩容操作，size 为 第一个 **>=** `ht[0].used*2`

即使不允许，在 `used:size > 5`的情况下也必须做强制 rehash。

这时，新的哈希表，即 `ht[1]` 大小为第一个 >=  `ht[0].used*2`的 2 的 n 次幂。

##### 缩容操作

即执行上面的 `dictResize`操作，这个需要**手动触发**。

`ht[1]` 大小为第一个 >=  `ht[0].used`的 2 的 n 次幂，最小不能小于 4。

根据计算得到的新哈希表的大小，为 `ht[1]`分配内存，将 `ht[0]` 上的数据都迁移到 `ht[1]`。

然后将原来 `ht[0]`的指针指向 `ht[1]`，释放旧的 `ht[0]` 内存，重置各个成员变量，留着下次备用。

##### 渐进式 rehash

如果是一次性完成如上的 rehash 操作，那元素很多的话，可以预见，性能会很差。所以 redis 里采用了一个叫渐进式 rehash 的方案来做这件事情，把一次性要做的事情分为多步。

 主要由 `_dictRehashStep` 和 `dictRehashMilliseconds` 两个函数负责。

```c
static void _dictRehashStep(dict *d) {
    if (d->iterators == 0) dictRehash(d,1);// 没有迭代器，进行1步rehash
}
```

`_dictRehashStep` 为被动 rehash ，每次只迁移一个哈希桶。dict 在做其他操作时会查询一下是不是在做 rehash，是的话，就会调用该函数。

如下：
![dict-rehash](https://s1.ax1x.com/2018/09/09/iPzIIS.jpg)

```c
int dictRehashMilliseconds(dict *d, int ms) {
    long long start = timeInMilliseconds();
    int rehashes = 0;

    while(dictRehash(d,100)) { // 直到 rehash 完或者时间到了
        rehashes += 100;
        if (timeInMilliseconds()-start > ms) break;
    }
    return rehashes;
}
```

`dictRehashMilliseconds` 在给定的**毫秒**时间内进行 rehash，每次步长为 100 个 hash 桶，返回值为 move 了多少个 哈希桶。它是在 redis 的 `serverCron` 里主动触发的，这是一个 1ms 的定时任务。

#### 函数实现

**注意**：

- 因为在 rehash 时，字典会同时使用两个哈希表，所以在这期间的所有查找、删除等操作，除了在 `ht[0]` 上进行，还需要在 `ht[1]` 上进行。
- 在执行添加操作时，新的节点会直接添加到 `ht[1]` 而不是 `ht[0]` ，这样保证 `ht[0]` 的节点数量在整个 rehash 过程中都只减不增。

##### 创建 dict

```c
// 创建一个新的 dict 结构
dict *dictCreate(dictType *type, void *privDataPtr)
{
    dict *d = zmalloc(sizeof(*d)); // 分配内存
    _dictInit(d,type,privDataPtr);
    return d;
}

/* Initialize the hash table */
int _dictInit(dict *d, dictType *type,
        void *privDataPtr)
{
    _dictReset(&d->ht[0]); // 两个 hashtable 的初始化
    _dictReset(&d->ht[1]);
    d->type = type;
    d->privdata = privDataPtr;
    d->rehashidx = -1;  // 初始化为 -1
    d->iterators = 0;
    return DICT_OK;
}
```

创建一个 `dict`，主要就是分配内存，初始化变量。

##### 扩容/创建hash table

```c
int dictExpand(dict *d, unsigned long size)
{
    dictht n; // 新的 dictht，用于替换
    unsigned long realsize = _dictNextPower(size);

    // 当 dict 正在 rehash 或者 size 小于现在的 ht[0].used，说明这个 size 是不合法的，返回错误 DICT_ERR
    // 要包含现在 dict 所有元素，那么 size 一定要 >= ht[0].used
    if (dictIsRehashing(d) || d->ht[0].used > size)
        return DICT_ERR;

    // 要 rehash 的 dictht 大小跟现在 dictht 大小相等，就没必要做 rehash 了，返回错误 DICT_ERR
    if (realsize == d->ht[0].size) return DICT_ERR;

    n.size = realsize;
    n.sizemask = realsize-1;
    n.table = zcalloc(realsize*sizeof(dictEntry*));
    n.used = 0;

    // 这是第一次初始化吗？如果真是这样，那这就不是一个 rehash
    // 仅设置第一个 hash 表，以便接收 keys
    if (d->ht[0].table == NULL) {
        d->ht[0] = n;
        return DICT_OK;
    }

    // 非首次初始化，那就设置第二个 hash 表，设置 rehashidx 标记，
    // 现在可以进行 rehash 了
    d->ht[1] = n;
    d->rehashidx = 0; // rehash 进度为 0
    return DICT_OK;
}
```

##### 添加元素

```c
int dictAdd(dict *d, void *key, void *val)
{
    dictEntry *entry = dictAddRaw(d,key);

    if (!entry) return DICT_ERR;
    dictSetVal(d, entry, val);
    return DICT_OK;
}
```

`dictAddRaw `函数只是增加了 key，而 value 需要 key 增加成功后再次设置。

```c
dictEntry *dictAddRaw(dict *d, void *key)
{
    int index;
    dictEntry *entry;
    dictht *ht;

    // 检查是否在 rehash
    if (dictIsRehashing(d)) _dictRehashStep(d);

    /* 获得这个新元素需要加到哪个 hash 桶，
     * 若返回 -1 表示已经存在这个 key 了，直接返回 NULL
     */
    if ((index = _dictKeyIndex(d, key)) == -1)
        return NULL;

    /* 为新的 key 分配内存并存到 ht 中
     * 把新的 key 放到 hash 桶里 list 的第一个，假定在数据库系统中新加入的 key 会更频繁访问到，这会减少查询时间
     * */
    // dict 在做 rehash 的话，直接把新 key 加到 ht[1]，否则加到 ht[0]
    ht = dictIsRehashing(d) ? &d->ht[1] : &d->ht[0];
    entry = zmalloc(sizeof(*entry));
    entry->next = ht->table[index];
    ht->table[index] = entry;
    ht->used++;

    dictSetKey(d, entry, key); // 为 key 设置 value
    return entry; // 返回新加入的 entry
}
```

##### Replace 元素

这里有两个函数 `dictReplace` 和 `dictReplaceRaw`。

```c
int dictReplace(dict *d, void *key, void *val)
{
    dictEntry *entry, auxentry;
    // 要添加的 key 在 dict 中不存在，那么直接添加成功
    if (dictAdd(d, key, val) == DICT_OK)
        return 1;

   // 运行到这里，说明键 key 已经存在，找到它
    entry = dictFind(d, key);

    // 设置新的 value，释放旧的。
    auxentry = *entry;
    dictSetVal(d, entry, val);
    dictFreeVal(d, &auxentry);
    return 0;
}
```

```c
dictEntry *dictReplaceRaw(dict *d, void *key) {
    dictEntry *entry = dictFind(d,key);

    // 返回已经存在的 key ，或者新加的
    return entry ? entry : dictAddRaw(d,key);
}
```

##### 删除元素

```c
int dictDelete(dict *ht, const void *key) {
    return dictGenericDelete(ht,key,0);
}

int dictDeleteNoFree(dict *ht, const void *key) {
    return dictGenericDelete(ht,key,1);
}
```

上面两个函数的区别在于删除 key 的时候是否调用 key 和 value 的释放函数。而真正的删除函数是 `dictGenericDelete`。

```c
static int dictGenericDelete(dict *d, const void *key, int nofree)
{
    unsigned int h, idx;
    dictEntry *he, *prevHe;
    int table;

     /* d->ht[0].table is NULL */
    if (d->ht[0].size == 0) return DICT_ERR;
    if (dictIsRehashing(d)) _dictRehashStep(d); // 执行渐进式 rehash
    h = dictHashKey(d, key);

    for (table = 0; table <= 1; table++) {
        idx = h & d->ht[table].sizemask;
        he = d->ht[table].table[idx];
        prevHe = NULL;
        while(he) {
            if (key==he->key || dictCompareKeys(d, key, he->key)) { // 找到这个 key
                if (prevHe) // 是不是该 hash slot 的第一个元素
                    prevHe->next = he->next;
                else
                    d->ht[table].table[idx] = he->next;
                if (!nofree) {
                    dictFreeKey(d, he);
                    dictFreeVal(d, he);
                }
                zfree(he);
                d->ht[table].used--;
                return DICT_OK;
            }
            prevHe = he;
            he = he->next;
        }
        if (!dictIsRehashing(d)) break;
    }
    return DICT_ERR; /* not found */
}
```

##### 遍历元素

`dictScan` 这个函数是 `dict` 结构最有特色的一个函数。用来遍历 `dict`，主要是要考虑扩缩容的情况。

```c
unsigned long dictScan(dict *d,
                       unsigned long v,
                       dictScanFunction *fn,
                       void *privdata)
{
    dictht *t0, *t1;
    const dictEntry *de;
    unsigned long m0, m1;

    if (dictSize(d) == 0) return 0;

    if (!dictIsRehashing(d)) { // 不在 rehash，直接扫描 ht[0] 就好了
        t0 = &(d->ht[0]);
        m0 = t0->sizemask;

        /* Emit entries at cursor */
        de = t0->table[v & m0];
        while (de) { // 扫描完这个 slot，因为可能是链表
            fn(privdata, de);
            de = de->next;
        }

    } else { // 正在rehashing，就存在两个哈希表ht[0]、ht[1]
        t0 = &d->ht[0];
        t1 = &d->ht[1];

        // 确保 t0 比 t1 小
        if (t0->size > t1->size) {
            t0 = &d->ht[1];
            t1 = &d->ht[0];
        }

        m0 = t0->sizemask;
        m1 = t1->sizemask;

        de = t0->table[v & m0];// 扫描 t0 的某个 slot
        while (de) {
            fn(privdata, de);
            de = de->next;
        }

        // 迭代(大表)t1 中所有节点，循环迭代，会把小表没有覆盖的slot全部扫描一遍
        // 同模的 slot
        do {
            /* Emit entries at cursor */
            de = t1->table[v & m1];
            while (de) {
                fn(privdata, de);
                de = de->next;
            }

            /* Increment bits not covered by the smaller mask */
            // 新增加的bits 位每次加一
            v = (((v | m0) + 1) & ~m0) | (v & m0);
        } while (v & (m0 ^ m1)); // 直到新加的 bits 都遍处理完了
    }

    v |= ~m0;

    /* Increment the reverse cursor */
    v = rev(v);
    v++;
    v = rev(v);

    return v;
}
```

redis 采用了一种高位进位的方式来遍历哈希桶，而不是传统的加1。以 size 为8为例，遍历顺序是这样的：000 -> 100 -> 010 -> 110 -> 001 -> 101 -> 011 -> 111。可以看到，每次都是最到位加1，向低位去进位，正好跟我们平常的运算相反，因此，这也叫**反向二进制位迭代**。

具体原理可以参考 [《美团针对Redis Rehash机制的探索和实践》](https://tech.meituan.com/Redis_Rehash_Practice_Optimization.html)，同时该文章也指出了该算法的一个 bug，并提供的修复方案。