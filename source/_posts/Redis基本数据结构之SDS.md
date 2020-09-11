---
title: Redis 基本数据结构之 SDS
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: 75a172a4
date: 2017-10-15 17:57:32
---

本文以 redis 3.2.8 版本来介绍 redis 源码。

字符串是 Redis 最基本的数据结构，首先键都是字符串类型的，而且其他几种数据结构也都是在字符串类型的基础之上构建的，因此，我认为从字符串入手来探究 Redis 的数据结构是相对合理的。

<!--more-->
redis 没有直接使用 C 语言中传统的字符串表示，而是自己实现了一套名为简单动态字符串（simple dynamic string, SDS）的抽象类型，将其作为 redis 的默认字符串使用。实际上 redis 并没有完全抛弃 C 字符串，只是在这之上进行了进一步封装，使其获得更好的特性，比如二进制安全、动态扩展内存等，这也使得 SDS 可以兼容 C 字符串的 API。

redis 源码中关于 sds 的部分，主要在 `sds.h` 和 `sds.c` 这两个文件中。

### SDS 的定义

首先在 `sds.h` 中找到了 sds 的定义
```c
typedef char *sds;
```
这跟 C 字符串是一样的，但是真的这么简单吗？往下看，会有新的发现：
```c
// 暂时未用到
struct __attribute__ ((__packed__)) sdshdr5 {
    unsigned char flags;
    char buf[];
};
struct __attribute__ ((__packed__)) sdshdr8 {
    uint8_t len;
    uint8_t alloc;
    unsigned char flags;
    char buf[];
};
struct __attribute__ ((__packed__)) sdshdr16 {
    uint16_t len;
    uint16_t alloc;
    unsigned char flags;
    char buf[];
};
struct __attribute__ ((__packed__)) sdshdr32 {
    uint32_t len;
    uint32_t alloc;
    unsigned char flags;
    char buf[];
};
struct __attribute__ ((__packed__)) sdshdr64 {
    uint64_t len;
    uint64_t alloc;
    unsigned char flags;
    char buf[];
};
```
到此，大概明白了，sds 采用一段连续的内存空间来存储动态字符串，即 **header + str** 的形式。
`__attribute__ ((packed))` 是为了让编译器以紧凑模式来分配内存。不对 struct 中的字段进行内存对齐，以此保证 header 和 sds 的数据部分紧紧的相邻，否则，不能按照固定的偏移来获取 flags 字段。
当定义了 `sds* s` 后，使用 `s[-1]` 就可以获得 flag 的值，这样就知道了这个 sds 属于哪种类型。

为了满足存储不同长度字符串的需求（为了节省内存），在宏定义中定义了五种 header（0~4）。

下面解释一下 header 中各个字段的含义：
   - **len**: 字符串真正的长度（不包含空终止字符）
   - **alloc**: 字符串的最大容量，不包含 header 和最后的 '\0'，初始时与 len 值一致
   - **flags**: 低三位表示 header 类型
   - **buf**: 柔性数组，表示一个长度动态的字符串

柔性数组，只能定义在一个结构体的**最后一个字段**上。它在这里只是起到一个标记的作用，表示在 flags字段后面是一个字符数组，或者说，它指明了紧跟在 flags 字段后面的这个字符数组在结构体中的偏移位置。
程序在为 header 分配内存的时候，**buf[]** 并不占用内存空间。如果计算 `sizeof(struct sdshdr16)`的值，**那么结果是5个字节，其中没有 buf 字段**.

**注**：关于柔性数组的介绍，可以参考这篇博客 [结构体中使用柔性数组](http://blog.csdn.net/u013165704/article/details/53733412)。
下面画了一个内存简易图可以帮助理解：
<center><img src="https://s1.ax1x.com/2018/10/28/icwIM9.jpg" width="600"/></center>


## SDS 宏定义

```c
// sds 类型
#define SDS_TYPE_5 0
#define SDS_TYPE_8 1
#define SDS_TYPE_16 2
#define SDS_TYPE_32 3
#define SDS_TYPE_64 4

// 类型掩码，与 flag 相与，可以得到低三位
#define SDS_TYPE_MASK 7

// 类型占用的比特位数
#define SDS_TYPE_BITS 3

// 获得 sds header 头指针
#define SDS_HDR_VAR(T, s) struct sdshdr##T *sh = (void *)((s) - (sizeof(struct sdshdr##T)));
#define SDS_HDR(T, s) ((struct sdshdr##T *)((s) - (sizeof(struct sdshdr##T))))

// SDS_TYPE_5 类型的 sds，低三位表示 sds type， 高五位表示 sds len
#define SDS_TYPE_5_LEN(f) ((f) >> SDS_TYPE_BITS)
```

## SDS 函数

### 创建 sds
```c
sds sdsnewlen(const void *init, size_t initlen) {
    void *sh;
    sds s;
    char type = sdsReqType(initlen); // 根据 initlen 判断需要以哪种类型的 sds 来存储 init
    /* Empty strings are usually created in order to append. Use type 8
     * since type 5 is not good at this. */
    if (type == SDS_TYPE_5 && initlen == 0) type = SDS_TYPE_8;
    int hdrlen = sdsHdrSize(type); // 所选择的 sds 类型的 header 长度
    unsigned char *fp; /* flags pointer. */

    sh = s_malloc(hdrlen+initlen+1); // 分配 sds 需要的内存：header + str + 1，以\0 结尾
    if (!init)
        memset(sh, 0, hdrlen+initlen+1); // 初始化 sds
    if (sh == NULL) return NULL;
    s = (char*)sh+hdrlen; // s 指向 buf 首元素
    fp = ((unsigned char*)s)-1; // fp 指向 flag
    switch(type) {// 设置 sds 的 header 各参数
        case SDS_TYPE_5: {
            *fp = type | (initlen << SDS_TYPE_BITS); // sds5, 第三位为 type，高五位是 len
            break;
        }
        case SDS_TYPE_8: {
            SDS_HDR_VAR(8,s);
            sh->len = initlen; // len 与 alloc 起始值相同
            sh->alloc = initlen;
            *fp = type;
            break;
        }
        case SDS_TYPE_16: {
            SDS_HDR_VAR(16,s);
            sh->len = initlen;
            sh->alloc = initlen;
            *fp = type;
            break;
        }
        case SDS_TYPE_32: {
            SDS_HDR_VAR(32,s);
            sh->len = initlen;
            sh->alloc = initlen;
            *fp = type;
            break;
        }
        case SDS_TYPE_64: {
            SDS_HDR_VAR(64,s);
            sh->len = initlen;
            sh->alloc = initlen;
            *fp = type;
            break;
        }
    }
    if (initlen && init)
        memcpy(s, init, initlen); // copy
    s[initlen] = '\0';// 结束
    return s;
}
```

### 释放 sds

```c
#define s_free zfree

void sdsfree(sds s) {
    if (s == NULL)
        return;
    s_free((char *)s - sdsHdrSize(s[-1]));
}
```

### 扩展 sds 容量

```c
sds sdsMakeRoomFor(sds s, size_t addlen) {
    void *sh, *newsh;
    size_t avail = sdsavail(s); // 当前 sds 剩余空间
    size_t len, newlen;
    char type, oldtype = s[-1] & SDS_TYPE_MASK;
    int hdrlen;

    /* Return ASAP if there is enough space left. */
    if (avail >= addlen) // 需要增加的空间当前的 sds 足以满足，不需要调整 sds
        return s;

    len = sdslen(s);
    sh = (char *)s - sdsHdrSize(oldtype); // header 头指针
    newlen = (len + addlen);              // 新的 sds 需要的长度

    /* sds规定：如果扩展后的字符串总长度小于 1M 则新字符串长度加倍
     * 否则，新长度为扩展后的总长度加上1M
     * 这样做的目的是减少Redis内存分配的次数，同时尽量节省空间 */
    if (newlen < SDS_MAX_PREALLOC)
        newlen *= 2;
    else
        newlen += SDS_MAX_PREALLOC;
    type = sdsReqType(newlen);
    /* Don't use type 5: the user is appending to the string and type 5 is
     * not able to remember empty space, so sdsMakeRoomFor() must be called
     * at every appending operation. */
    if (type == SDS_TYPE_5)
        type = SDS_TYPE_8;

    hdrlen = sdsHdrSize(type);
    if (oldtype == type) {// 新旧 sds 的类型一致，调用realloc函数扩充内存
        newsh = s_realloc(sh, hdrlen + newlen + 1); // realloc对malloc申请的内存进行大小的调整
        if (newsh == NULL)
            return NULL;
        s = (char *)newsh + hdrlen; // s 指向 buf
    }
    else {
        /* 如果类型调整了，header的大小就需要调整
           这时就需要移动buf[]部分，所以不能使用realloc */
        newsh = s_malloc(hdrlen + newlen + 1);
        if (newsh == NULL)
            return NULL;
        memcpy((char *)newsh + hdrlen, s, len + 1); // 拷贝
        s_free(sh); // 释放之前的 sh 占用的内存
        s = (char *)newsh + hdrlen;
        s[-1] = type; // 设置 flag
        sdssetlen(s, len); // 设置 sds 的 len 字段
    }
    sdssetalloc(s, newlen); // 设置 sds 的 alloc 字段
    return s;
}
```
另外，redis 提供 `sds sdsRemoveFreeSpace(sds s);` 函数来回收 sds 空余空间。
redis 还提供了很多其他的函数，来方便 sds 的操作，这个可以自行查看 源码

## 参考
【1】[Redis源码剖析--动态字符串SDS](https://zhuanlan.zhihu.com/p/24202316)
【2】[redis之sds](http://blog.csdn.net/fusan2004/article/details/51817878)
