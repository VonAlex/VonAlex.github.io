---
title: Redis 基本数据结构之 SDS
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: 75a172a4
date: 2017-10-15 17:57:32
---

本系列博客以 redis 3.2.8 版本来介绍 redis 源码。

字符串是 Redis 最基本的数据结构，因为键都是字符串类型的，而其他几种数据结构也都建立在字符串类型的基础之上。因此，我认为从字符串入手来探究 Redis 的数据结构是相对合理的。

<!--more-->
redis 没有直接使用 C 语言中传统的字符串表示，而是自己实现了一套名为简单动态字符串（simple dynamic string, SDS）的抽象类型，将其作为 redis 的默认字符串使用。

SDS 相较于原生 C 字符串的好处如下，
1）二进制安全，即字符串中可以包含 `\0` 字符；
2）性能更好，如 O(1) 获得字符串长度；
3）可动态扩展内存；
4）完全兼容 C 字符串的 API

redis 源码中 SDS 数据结构主要定义在 `sds.h` 和 `sds.c` 这两个文件中。

在阅读源码前，试想一下，**如何实现一个扩容方便且二进制安全的字符串呢？**

### SDS 的定义

SDS 既然是字符串，那么首先需要一个字符串指针；为了方便上层的接口调用，该结构体还存放一些统计信息，如当前字符串长度、剩余容量等。

最初版本的 SDS 是这样定义的，
```c
typedef char *sds;
struct sdshdr {
    unsigned int len;
    unsigned int free;
    char buf[];
};
```
优点如下，
1）len/free 统计变量，提升性能，且字符串长度依赖于 len，保证了二进制安全。
2）柔性数组 buf 存放字符串。SDS 对外暴露的是 buf 的首地址，而不是结构体的首地址，这样可以更方便地兼容 C 处理字符串的各种函数。

{% note info %}
柔性数组，只能定义在一个结构体的**最后一个字段**上，语法参考 [结构体中使用柔性数组](http://blog.csdn.net/u013165704/article/details/53733412)。
程序在为 hdr 分配内存的时候，**buf[]** 并不占用内存空间，通过 malloc 为 buf 柔型数组成员分配内存。
柔性数组成员地址与结构体连续，方便通过它的首地址偏移找到结构体首地址，进而获得其他成员变量。
{% endnote %}

len 是 unsigned int 类型变量，占用 4 个字节，最多能表示 2^32-1 长度。
实际应用中，考虑到性能问题，长字符串在 Redis 中是比较少见的，绝大多数都是短字符串，那么问题来了，短字符串并不需要 4 字节表示长度，所有的字符串使用同一个 header，**存在着严重的内存浪费**。所以，本着最大程度节省内存的目的，在 3.2 版本代码中对 SDS 进行的重构，**根据字符串长度使用不同的 header**。

```c
struct __attribute__ ((__packed__)) sdshdr5 {
    unsigned char flags; // 低 3 位表示类型，高 5 位表示字符串长度，即最长 31 字节
    char buf[]; // 柔性数组，存放实际字符串
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
    uint64_t len; // 字符串真正长度，不包含空终止字符
    uint64_t alloc; // 字符串最大长度，不包含 header 和空终止字符
    unsigned char flags; // 低 3 位表示 header 类型，高 5 位未使用
    char buf[];
};
```

需要注意 `__attribute__ ((packed))` 修饰。
一般情况下，结构体会按其所有成员变量大小的公倍数做字节对齐，而使用 packed 修饰以后，编译器以紧凑模式来分配内存，结构体变为按照 1 字节对齐。这样做有以下两个好处，
1）极大节省了内存，例如 sdshdr32 只需要 4+4+1=9 个字节，而原本是需要 4*3=12 个字节。
2）SDS 返回给上层的，不是结构体首地址，而是指向内容的 buf 指针。packed 修饰保证了 header 和 SDS 数据部分紧紧相邻，方便按照固定的偏移，`buf[-1]`，获取 flags，进而区分 SDS 类型。

下面画了一个内存简易图可以帮助理解：
<center><img src="https://s1.ax1x.com/2018/10/28/icwIM9.jpg" width="500"/></center>

## SDS 宏定义

```c
// SDS 类型
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
数据类型的基本操作不外乎增、删、改、查，SDS 也不例外。
### 创建 sds
```c
// 新建一个指定长度的 sds
sds sdsnewlen(const void *init, size_t initlen) {
    void *sh;
    sds s;

    // 根据 initlen 选择合适类型的 sds header
    char type = sdsReqType(initlen); 

    // 空字符串一般用来做 append，使用 type 8 代替 type 5，减少不必要的 sds 扩容
    if (type == SDS_TYPE_5 && initlen == 0) type = SDS_TYPE_8;
    int hdrlen = sdsHdrSize(type); // 所选择的 sds 类型的 header 长度
    unsigned char *fp;

    sh = s_malloc(hdrlen+initlen+1); // header + str + 1
    if (!init)
        memset(sh, 0, hdrlen+initlen+1); // 初始化 sds
    if (sh == NULL) return NULL;
    s = (char*)sh+hdrlen; // s 指向 buf 首元素
    fp = ((unsigned char*)s)-1; // fp 指向 flag
    switch(type) {// 设置 sds 的 header 各参数
        case SDS_TYPE_5: {
            // 低 3 位存 type，高 5 位存 len
            *fp = type | (initlen << SDS_TYPE_BITS);
            break;
        }
        case SDS_TYPE_8: {
            SDS_HDR_VAR(8,s);
            sh->len = initlen; // len 与 alloc 起始值相同
            sh->alloc = initlen;
            *fp = type;
            break;
        }
        ......
    }
    if (initlen && init)
        memcpy(s, init, initlen); // copy 原字符串
    s[initlen] = '\0';// 结束
    return s;
}
```

### 释放 sds 内存

```c
#define s_free zfree

void sdsfree(sds s) {
    if (s == NULL) return;
    s_free((char *)s - sdsHdrSize(s[-1]));
}
```

### 动态扩容
当遇到有些拼接 sds 操作时，可能遇到 sds 长度不够的情况，这时就需要对 sds 进行动态扩容。

```c
sds sdsMakeRoomFor(sds s, size_t addlen) {
    void *sh, *newsh;
    size_t avail = sdsavail(s); // 当前 sds 剩余长度
    size_t len, newlen;
    char type, oldtype = s[-1] & SDS_TYPE_MASK;
    int hdrlen;

    // 当前 sds 足以容纳额外 addlen，不调整，直接返回
    if (avail >= addlen) 
        return s;

    len = sdslen(s);
    sh = (char *)s - sdsHdrSize(oldtype); // header 头指针
    newlen = (len + addlen);              // 新的 sds 的长度

    /* sds规定：
     * 如果扩展后的字符串总长度小于 1M，则新字符串长度加倍
     * 否则，新长度为扩展后的总长度加上 1M。
     *
     * 这样做的目的是减少 Redis 内存分配的次数，同时尽量节省空间 */
    if (newlen < SDS_MAX_PREALLOC)
        newlen *= 2;
    else
        newlen += SDS_MAX_PREALLOC;
    type = sdsReqType(newlen);

    if (type == SDS_TYPE_5) type = SDS_TYPE_8;

    hdrlen = sdsHdrSize(type);
    if (oldtype == type) { // 如果 sds 类型未变，realloc 调整内存
        newsh = s_realloc(sh, hdrlen + newlen + 1); 
        if (newsh == NULL)
            return NULL;
        s = (char *)newsh + hdrlen; // s 指向 buf
    }
    else { // 如果 sds 类型变化了，需要调整 header
        newsh = s_malloc(hdrlen + newlen + 1);
        if (newsh == NULL)
            return NULL;
        memcpy((char *)newsh + hdrlen, s, len + 1); // 拷贝到新的字符串
        s_free(sh); // 释放 old 字符串
        s = (char *)newsh + hdrlen;
        s[-1] = type; // 设置 flag
        sdssetlen(s, len);
    }
    sdssetalloc(s, newlen);
    return s;
}
```

-----

SDS 还未上层提供了许多其他 API，篇幅有限，不再赘述。
