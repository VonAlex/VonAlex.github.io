---
title: Redis 基本数据结构之双向链表
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: ba6bb8e7
date: 2018-08-13 20:19:52
---

> 链表提供了高效的节点重排能力，以及顺序性的节点访问方式，并且可以通过增删节点来灵活地调整链表的长度。

链表是一种非常常见的数据结构。由于 redis 使用的 C 语言并没有这种数据结构，因此，作者在 redis 对这一数据结构进行了实现。redis 的链表实现为双向链表，主要用在实现列表键、发布订阅、保存多客户端状态、服务器模块，订阅模块和保存输入命令等方面，使用较广。

<!--more---->

redis 源码中关于 adlist 的部分，主要在 `adlist.h` 和 `adlist.c` 这两个文件中。

### adlist 的定义
首先在 `adlist.h` 中找到定义

```c
// list 节点
typedef struct listNode {
    // 前驱节点
    struct listNode *prev;
    // 后继节点
    struct listNode *next;
    // 节点值
    void *value;
} listNode;

// redis 双链表实现
typedef struct list {
    listNode *head;                      // 表头指针
    listNode *tail;                      // 表尾指针
    void *(*dup)(void *ptr);             // 节点值复制函数
    void (*free)(void *ptr);             // 节点值释放函数（函数指针）
    int (*match)(void *ptr, void *key);  // 节点值对比函数
    unsigned long len;                   // 链表包含的节点数量
} list;

```
可以发现，这就是一个无环双向链表。
`list` 结构中带有一个 `len` 的变量，可以将获取链表长度的时间复杂度从 O(n) 降到 O(1)。
`head` 指针和 `tail` 指针让给我们可以快速的找到链表的头尾，时间复杂度都是 O(1)。
三个函数指针，让我们可以对链表有更灵活的操作，使用起来也更加方便。


当需要进行链表迭代时，可以使用如下函数：

```c
typedef struct listIter {
    listNode *next; // 指向下一个节点
    int direction;  // 迭代器，正向反向
} listIter;
```
`direction` 决定了遍历的方向，可正向可反向。

### adlist 宏定义
这部分定义了一些获取 `list` 结构的宏，简化操作。

```c
#define listLength(l) ((l)->len)                    // 获取 list 中包含的 node 数量
#define listFirst(l) ((l)->head)                    // 获取 list 头节点指针
#define listLast(l) ((l)->tail)                     // 获取 list 尾节点指针
#define listPrevNode(n) ((n)->prev)                 // 获取当前节点的前驱节点
#define listNextNode(n) ((n)->next)                 // 获得当前节点的后继节点
#define listNodeValue(n) ((n)->value)

#define listSetDupMethod(l,m) ((l)->dup = (m))      // 指定节点复制函数
#define listSetFreeMethod(l,m) ((l)->free = (m))    // 指定节点释放函数
#define listSetMatchMethod(l,m) ((l)->match = (m))  // 指定节点的比较函数

#define listGetDupMethod(l) ((l)->dup)   // 获得节点复制函数
#define listGetFree(l) ((l)->free)
#define listGetMatchMethod(l) ((l)->match)
```

### adlist 函数
这部分定义了一些双向链表的常用操作。

```c
list *listCreate(void); // 创建一个不包含任何节点的新链表
void listRelease(list *list); // 释放给定链表，以及链表中的所有节点

// CRUD 操作
list *listAddNodeHead(list *list, void *value);  // 头部插入节点
list *listAddNodeTail(list *list, void *value);  // 尾部插入节点
list *listInsertNode(list *list, listNode *old_node, void *value, int after); // 中间某个位置插入节点
void listDelNode(list *list, listNode *node); // O(N) 删除指定节点

listIter *listGetIterator(list *list, int direction); // 获取指定迭代器
void listReleaseIterator(listIter *iter);   // 释放迭代器
listNode *listNext(listIter *iter); // 迭代下一个节点

list *listDup(list *orig); // 链表复制
listNode *listSearchKey(list *list, void *key); // O(N) 按 key 找节点
listNode *listIndex(list *list, long index);  // O(N)
void listRewind(list *list, listIter *li); // 重置为正向迭代器
void listRewindTail(list *list, listIter *li); // 重置为逆向迭代器
void listRotate(list *list); // 链表旋转
```

#### 创建 adlist

```c
list *listCreate(void)
{
    struct list *list;

    if ((list = zmalloc(sizeof(*list))) == NULL)
        return NULL;
    list->head = list->tail = NULL;
    list->len = 0;
    list->dup = NULL;
    list->free = NULL;
    list->match = NULL;
    return list;
}
```
创建一个空的 adlist 很简单，就是分配内存，初始化数据结构，而 `listRelease` 的释放链表过程与之相反，这个自不必多说。

#### adlist 的 CRUD 操作
首先是插入数据，分三种情况：头部插入、中间插入和尾部插入。
(1) 头部插入

```c
// 头部插入值 value
list *listAddNodeHead(list *list, void *value)
{
    listNode *node;

    if ((node = zmalloc(sizeof(*node))) == NULL) // 为新节点分配内存
        return NULL;
    node->value = value;
    if (list->len == 0) { // 若之前的 list 为空，那么插入后就只有一个节点
        list->head = list->tail = node;
        node->prev = node->next = NULL;
    } else {
        node->prev = NULL;
        node->next = list->head;
        list->head->prev = node;
        list->head = node; // 更新 list head 信息
    }
    list->len++; // 更新链表长度信息
    return list;
}
```
（2）尾部插入节点类似，就不啰嗦了。
（3）中间插入

```c
// 在 list 指定节点 old_node 后（after=1）或前插入一个节点
list *listInsertNode(list *list, listNode *old_node, void *value, int after) {
    listNode *node;

    if ((node = zmalloc(sizeof(*node))) == NULL) // 为新节点分配内存
        return NULL;
    node->value = value;
    if (after) { // 后

        // 处理 node 节点的前后指向
        node->prev = old_node;
        node->next = old_node->next;
        if (list->tail == old_node) { // node 成了尾节点，更新 list 信息
            list->tail = node;
        }
    } else { // 前
        node->next = old_node;
        node->prev = old_node->prev;
        if (list->head == old_node) { // node 成了头节点，更新 list 信息
            list->head = node;
        }
    }

    // 处理 node 相邻两个节点的指向
    if (node->prev != NULL) {
        node->prev->next = node;
    }
    if (node->next != NULL) {
        node->next->prev = node;
    }
    list->len++;
    return list;
}
```
然后是删除操作。

```c
// 从 list 中删除 node 节点
void listDelNode(list *list, listNode *node)
{
    if (node->prev) // 是否有前驱节点，即判断要删除的节点是否为头节点
        node->prev->next = node->next;
    else
        list->head = node->next; // 更新 list 的头结点指向
    if (node->next) // 是否有后继节点，即判断要删除的节点是否为尾节点
        node->next->prev = node->prev;
    else
        list->tail = node->prev;
    if (list->free) list->free(node->value);
    zfree(node);
    list->len--; // 更新节点数量信息
}
```

最后是查找。

```c
// 从 list 中查找 key
listNode *listSearchKey(list *list, void *key)
{
    listIter iter;
    listNode *node;

    listRewind(list, &iter); // 获得正向遍历器，并从头开始遍历
    while((node = listNext(&iter)) != NULL) {
        if (list->match) { // list 中有指定的比较器
            if (list->match(node->value, key)) {
                return node;
            }
        } else {
            if (key == node->value) {
                return node;
            }
        }
    }
    return NULL;
}
```
```c
// 获得 list 中第 index 个节点，index 为负数表示从尾部倒序往前找
listNode *listIndex(list *list, long index) {
    listNode *n;
    if (index < 0) { // 从尾部查找
        index = (-index)-1;
        n = list->tail;
        while(index-- && n) n = n->prev; // 往前遍历
    } else {
        n = list->head;
        while(index-- && n) n = n->next; // 往后遍历
    }
    return n;
}
```

#### 其他
迭代器实现如下：

```c
listIter *listGetIterator(list *list, int direction)
{
    listIter *iter;

    if ((iter = zmalloc(sizeof(*iter))) == NULL) return NULL;
    if (direction == AL_START_HEAD)
        iter->next = list->head;
    else
        iter->next = list->tail;
    iter->direction = direction; // 迭代器方向
    return iter;
}
```
另外，一个旋转 list 的操作，实现效果将 1 → 2 → 3 → 4 变成 4 → 1 → 2 → 3

```c
void listRotate(list *list) {
    listNode *tail = list->tail;// 取尾节点

    if (listLength(list) <= 1) return; // 1 个节点不需要 rotate

    /* Detach current tail 分离尾部节点*/
    list->tail = tail->prev;
    list->tail->next = NULL;

    /* Move it as head 转移到 head */
    list->head->prev = tail;
    tail->prev = NULL;
    tail->next = list->head;

    list->head = tail; // 更新 list 的新 head
}

```

### 总结
adlist 其实就是把双向链表的基本操作实现了一遍，看了一遍相当于复习了一遍（之前面试总问这些，哈哈），不过作者设计的很巧，值得学习。