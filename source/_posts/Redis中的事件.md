---
title: Redis 中的事件
tags:
  - redis
categories: 源码系列
index_img: /images/redis.png
abbrlink: 85f7b0b4
date: 2018-08-17 01:50:50
---

每个 CS 模式程序，尤其是高并发的网络服务端程序都有自己的网络异步事件处理库，Redis不例外。Redis 基于 [Reactor 模型](https://my.oschina.net/mjRao/blog/666033) 封装了自己的事件驱动模型库。你可能会跟我有一样的疑问，为什么作者不使用已有的成熟的相关库，比如 Libevent 或 Libev？作者是[这样](https://groups.google.com/forum/#!topic/redis-db/tSgU6e8VuNA)跟别人讨论的，感兴趣的可以了解下。
下面从源码入手介绍下 Redis 中封装的 ae 库。
<!--more---->

### Redis 中的 I/O 多路复用
Redis 的 I/O 多路复用函数库对常见的 select/epoll/evport/kqueue 等进行了封装，提高了易用性。每一个 I/O 多路复用函数库在 Redis 源码中都单独成一个个文件，因此你可以找到 ae_epoll.c 等文件，它们对外提供统一的 API，这样做有一个好处是，底层库可以互换。
Redis 在底层用哪个 I/O 多路复用函数库是在编译时决定的，源码中定义了如下的规则，

```c
#ifdef HAVE_EVPORT
#include "ae_evport.c"
#else
    #ifdef HAVE_EPOLL
    #include "ae_epoll.c"
    #else
        #ifdef HAVE_KQUEUE
        #include "ae_kqueue.c"
        #else
        #include "ae_select.c"s
        #endif
    #endif
#endif
```
该规则保证在编译时会自动选择系统中性能最高的 I/O 多路复用函数库作为其 I/O 多路复用程序的底层实现。绝大多数的 Redis 服务都跑在 linux 服务器上，因此用的是 epoll。
大家都知道，epoll 常用函数主要有以下 3 个：

```c
#include <sys/epoll.h>
int epoll_create(int size);
int epoll_ctl(int epfd, int op, int fd, struct epoll_event *event);
int epoll_wait(int epfd, struct epoll_event *events, int maxevents, int timeout);
```
与之相对，在 ae_epoll.c 文件中对这三个函数进行了相应的封装（主要是配合 `aeEventLoop`）

```c
// 获得 epfd 以及为 aeEventLoop 结构体创建 aeApiState
static int aeApiCreate(aeEventLoop *eventLoop) {
    aeApiState *state = zmalloc(sizeof(aeApiState));

    if (!state) return -1;
    state->events = zmalloc(sizeof(struct epoll_event)*eventLoop->setsize);
    if (!state->events) {
        zfree(state);
        return -1;
    }
    state->epfd = epoll_create(1024); /* 1024 is just a hint for the kernel */
    if (state->epfd == -1) { // 出错释放
        zfree(state->events);
        zfree(state);
        return -1;
    }
    eventLoop->apidata = state;
    return 0;
}
```
```c
// 为 fpfd 添加监控 fd 感兴趣的事件
static int aeApiAddEvent(aeEventLoop *eventLoop, int fd, int mask) {
    aeApiState *state = eventLoop->apidata;
    struct epoll_event ee = {0}; /* avoid valgrind warning */
    /* If the fd was already monitored for some event, we need a MOD
     * operation. Otherwise we need an ADD operation. */
    int op = eventLoop->events[fd].mask == AE_NONE ?
            EPOLL_CTL_ADD : EPOLL_CTL_MOD;

    ee.events = 0;
    mask |= eventLoop->events[fd].mask; /* Merge old events */
    if (mask & AE_READABLE) ee.events |= EPOLLIN;
    if (mask & AE_WRITABLE) ee.events |= EPOLLOUT;
    ee.data.fd = fd;
    if (epoll_ctl(state->epfd,op,fd,&ee) == -1) return -1;
    return 0;
}
```
```c
// epoll_wait
static int aeApiPoll(aeEventLoop *eventLoop, struct timeval *tvp) {
    aeApiState *state = eventLoop->apidata; // 这里的 aeApiState 为 aeApiCreate 时创建的
    int retval, numevents = 0;

    retval = epoll_wait(state->epfd,state->events,eventLoop->setsize,
            tvp ? (tvp->tv_sec*1000 + tvp->tv_usec/1000) : -1);
    if (retval > 0) {
        int j;

        numevents = retval;
        // 遍历产生的事件，加入 eventLoop->fired 数组
        for (j = 0; j < numevents; j++) {
            int mask = 0;
            struct epoll_event *e = state->events+j;

            // 根据事件不同设置不同的 mask
            if (e->events & EPOLLIN) mask |= AE_READABLE;
            if (e->events & EPOLLOUT) mask |= AE_WRITABLE;
            if (e->events & EPOLLERR) mask |= AE_WRITABLE;
            if (e->events & EPOLLHUP) mask |= AE_WRITABLE;
            eventLoop->fired[j].fd = e->data.fd;
            eventLoop->fired[j].mask = mask;
        }
    }
    return numevents;
}

```
看起来很简单，感兴趣的小伙伴可以看看 select 等其他底层库的封装。

### Redis 中的事件

Redis 是事件驱动的程序，服务器需要处理文件事件(file event)和时间事件(time event)，其中各结构体关系如下：
<img src="https://s1.ax1x.com/2018/10/28/icw25T.jpg" width="800" />
可以看到事件处理的核心是 `aeEventLoop`，它的作用是负责保存待处理文件事件和时间事件的结构体。

那么，下面先介绍 Redis 中的两种事件。

#### 文件事件
**文件事件是 Redis 服务器对套接字操作的抽象**。
服务器通过套接字与客户端进行连接，服务器与客户端的通信会产生相应的文件事件。
Redis 中使用 I/O 多路复用程序同时监听多个 socket，然后 socket 中做的不同操作关联不同的事件处理器，即采用不用的处理逻辑。
当客户端 connect server 时，即有新的连接到来，此时在服务器 listen socket fd 上产生 `ae.h/AE_READABLE` 事件，该事件由 `acceptTcpHandler` 函数进行处理。
当客户端有数据写到 socket 时，client fd 上产生`ae.h/AE_READABLE` 事件，该事件由 `readQueryFromClient` 函数进行处理。
当 sever 给 client 回复时，client fd 产生 `ae.h/AE_WRITABLE` 事件，该事件由 `sendReplyToClient` 函数进行处理。
而对于所有的文件事件，在事件处理器 `aeProcessEvents` 中都有如下处理逻辑：

```c
 // 阻塞等待，返回就绪文件事件的个数
numevents = aeApiPoll(eventLoop, tvp);
for (j = 0; j < numevents; j++) {
    aeFileEvent *fe = &eventLoop->events[eventLoop->fired[j].fd];
    int mask = eventLoop->fired[j].mask;
    int fd = eventLoop->fired[j].fd;
    int rfired = 0;
    if (fe->mask & mask & AE_READABLE) { // read 处理
        rfired = 1;
        fe->rfileProc(eventLoop,fd,fe->clientData,mask);
    }
    if (fe->mask & mask & AE_WRITABLE) { // write 处理
        if (!rfired || fe->wfileProc != fe->rfileProc)
            fe->wfileProc(eventLoop,fd,fe->clientData,mask);
    }
    processed++; // 处理的事件数 + 1
}
```

#### 事件处理与调度
包含对文件事件和时间事件的处理，其实都收敛到 `aeProcessEvents` 这个函数。

在[网上](https://draveness.me/redis-eventloop)找了一个图可以很好的说明这个过程
<img src="https://s1.ax1x.com/2018/10/28/icwfGF.jpg" width="650" />

在时间处理器中有这样一个逻辑:

```c
// 找出最近要发生的那个时间事件
shortest = aeSearchNearestTimer(eventLoop);
... ...
 // 阻塞等待，返回就绪文件事件的个数
numevents = aeApiPoll(eventLoop, tvp);
```
将最近要发生的时间事件的时间作为 `aeApiPoll` 函数的最大阻塞时间，这既可以避免服务器对时间事件进行频繁的轮询（忙等待），也可以确保该函数不会阻塞过长时间。

**注意**：
事件可能是并发产生的，但是到了时间处理器这里都变成串行处理了；
时间事件并不一定是按照预设的时间点发生，会有偏差。


#### 时间事件
**时间事件时服务器对一些定时或者周期任务的抽象**。
分为两类，定时事件和周期事件。两类事件可以根据时间事件处理器 `processTimeEvents` 中时间事件处理函数 `timeProc` 绑定的具体函数返回结果来区分。如果返回值为 `AE_NOMORE`，则表示这是个一次性的时间事件，否则表明是个周期任务。
对此，在事件处理器 `aeProcessEvents` 如下处理逻辑：

```c
if (flags & AE_TIME_EVENTS) // 处理时间事件
    processed += processTimeEvents(eventLoop);
```
进到 `processTimeEvents`里去看，会遍历每一个时间事件，然后执行以下逻辑：

```c
aeGetTime(&now_sec, &now_ms);
if (now_sec > te->when_sec ||
    (now_sec == te->when_sec && now_ms >= te->when_ms))  // 时间事件过时，需要执行
{
    int retval;

    id = te->id;
    retval = te->timeProc(eventLoop, id, te->clientData);
    processed++;
    if (retval != AE_NOMORE) { // 周期任务
        aeAddMillisecondsToNow(retval,&te->when_sec,&te->when_ms);
    } else { // 一次性时间事件，标记成 AE_DELETED_EVENT_ID，从 epfd 的监控中删掉
        te->id = AE_DELETED_EVENT_ID;
    }
}
```
从时间事件的结构体也可以看出，Redis 中将时间事件串成一个无序链表，说无序是因为该链表对各个时间事件的发生顺序是乱的。
> 在目前版本中，正常模式下的 Redis 服务器只使用了 `serverCron` 一个时间事件，而在 benchmark 模式下，服务器也值使用了两个时间事件。在这种情况下，服务器几乎是将无序链表退化成一个指针来使用，因此不影响时间事件执行的性能。


### Redis 服务流程
将 Redis 源码主流程简化，其实就是下面这样，

```c
int main(int argc, char **argv) {
    ...
    initServer();
    ...
    aeSetBeforeSleepProc(server.el,beforeSleep);
    aeMain(server.el); // 陷入循环，等待外部事件发生
    aeDeleteEventLoop(server.el);
    return 0;
}
```
而在 `aeMain ` 函数中则是一个大循环，该循环一直到 `eventLoop->stop` 被标记成非 0 才会停止，如下，

```c
void aeMain(aeEventLoop *eventLoop) {
    eventLoop->stop = 0;
    while (!eventLoop->stop) {
        if (eventLoop->beforesleep != NULL)
            eventLoop->beforesleep(eventLoop);
        aeProcessEvents(eventLoop, AE_ALL_EVENTS); // 事件（文件|时间）处理函数
    }
}
```

在初始化 `initServer` 函数中会创建一个 `aeEventLoop` 结构体，如下，

```c
server.el = aeCreateEventLoop(server.maxclients+CONFIG_FDSET_INCR);
```
`maxclients` 为配置文件中配置的可接受最大连接数。



### 参考
【1】《Redis 设计与实现》
【2】https://draveness.me/redis-eventloop
