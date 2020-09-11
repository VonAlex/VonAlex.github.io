---
title: Redis 源码之 Bio
tags:
  - redis
categories: 源码系列
index_img: https://gitee.com/happencc/pics/raw/master/images/redis.png
abbrlink: 9ceee0f6
date: 2018-10-29 12:35:51
---
很多人提到 Redis 时都会讲这是一个**单线程**的内存数据库，其实不然。虽然 Redis 把处理网络收发和执行命令这些操作都放在了主工作线程，但是除此之外还有许多 bio 后台线程也在兢兢业业的工作着，比如用来处理关闭文件和刷盘这些比较重的IO操作。bio，即 Background I/O。

Redis 源码中关于 bio 的部分，主要在 `bio.h` 和 `bio.c` 这两个文件中。

<!--more---->

### 任务类型

```c
/* Background job opcodes */
#define BIO_CLOSE_FILE    0 /* Deferred close(2) syscall. */
#define BIO_AOF_FSYNC     1 /* Deferred AOF fsync. */
#define BIO_NUM_OPS       2
```

从上面代码可以看出，在 3.2 的版本的 redis 中 Bio 负责两种类型任务。一是关闭文件，二是 aof 持久化。4.x 的版本增加了惰性删除的任务。每种类型的任务都有单独的线程去处理，并配置相关的锁和条件变量用于同步。同一类型的任务组成 list，按 **FIFO** 的顺序执行。

源码中有如下定义：

```c
// 任务线程数组
static pthread_t bio_threads[BIO_NUM_OPS];
// 锁
static pthread_mutex_t bio_mutex[BIO_NUM_OPS];
// 条件变量
static pthread_cond_t bio_condvar[BIO_NUM_OPS];
// 任务 list 数组
static list *bio_jobs[BIO_NUM_OPS];
// pending 的任务数量
static unsigned long long bio_pending[BIO_NUM_OPS];
```

Job 的数据结构很简单，在源码中定义如下：

```c
struct bio_job {
    time_t time; /* Time at which the job was created. */
    void *arg1, *arg2, *arg3;
};
```

其他有用的宏定义

```c
#define REDIS_THREAD_STACK_SIZE (1024*1024*4)
```



### API 详解

```c
void bioInit(void);
void bioCreateBackgroundJob(int type, void *arg1, void *arg2, void *arg3);
unsigned long long bioPendingJobsOfType(int type);
void bioKillThreads(void);
void bioWaitPendingJobsLE(int type, unsigned long long num); // 本版本未实现
time_t bioOlderJobOfType(int type); // 本版本未实现
```

#### bioInit 初始化

```c
void bioInit(void) {
    pthread_attr_t attr;
    pthread_t thread;
    size_t stacksize;
    int j;

    // 初始化各任务类型的锁和条件变量, BIO_NUM_OPS 个
    for (j = 0; j < BIO_NUM_OPS; j++) {
        pthread_mutex_init(&bio_mutex[j],NULL);
        pthread_cond_init(&bio_condvar[j],NULL);
        bio_jobs[j] = listCreate();
        bio_pending[j] = 0;
    }

    //设置 stack 大小，因为某些系统默认值可能很小
    pthread_attr_init(&attr);
    pthread_attr_getstacksize(&attr,&stacksize);
    if (!stacksize) stacksize = 1; /* The world is full of Solaris Fixes */
    while (stacksize < REDIS_THREAD_STACK_SIZE) stacksize *= 2;
    pthread_attr_setstacksize(&attr, stacksize);

    // 创建线程。
    for (j = 0; j < BIO_NUM_OPS; j++) {
        void *arg = (void*)(unsigned long) j;
        if (pthread_create(&thread,&attr,bioProcessBackgroundJobs,arg) != 0) {
            serverLog(LL_WARNING,"Fatal: Can't initialize Background Jobs.");
            exit(1);
        }
        bio_threads[j] = thread;
    }
}
```

上面创建线程时，回调函数 `bioProcessBackgroundJobs`传入一个参数来代表 job 类型，这样方便找到相应的线程处理不同的任务，像上面说的那样 ， 0  表示文件关闭任务， 1 表示 aof 任务。

#### bioProcessBackgroundJobs 任务处理

```c
void *bioProcessBackgroundJobs(void *arg) {
    struct bio_job *job;
    unsigned long type = (unsigned long) arg;// 传入参数为 job type
    sigset_t sigset;

    // 检查传入 type 的合理性
    if (type >= BIO_NUM_OPS) {
        serverLog(LL_WARNING, "Warning: bio thread started with wrong type %lu",type);
        return NULL;
    }

    // 设置线程可以被其他线程调用pthread_cancel函数取消/终止 （其他线程发来 cancel 请求）
    pthread_setcancelstate(PTHREAD_CANCEL_ENABLE, NULL); // 设置本线程对cancel信号的反应
    // 收到信号后继续运行至下一个取消点再退出，默认是立即退出，与 PTHREAD_CANCEL_ENABLE 配合使用
    pthread_setcanceltype(PTHREAD_CANCEL_ASYNCHRONOUS, NULL);

    pthread_mutex_lock(&bio_mutex[type]);
    // 阻塞 SIGALRM， 确保只有主线程将收到 watchdog 信号
    sigemptyset(&sigset);
    sigaddset(&sigset, SIGALRM);
    if (pthread_sigmask(SIG_BLOCK, &sigset, NULL))
        serverLog(LL_WARNING,
            "Warning: can't mask SIGALRM in bio.c thread: %s", strerror(errno));

    while(1) {
        listNode *ln;

        // 当没有 type 类型的任务时，会阻塞在这里，等待条件变量触发，这里会释放锁
        // 当被激活后们首先要加锁
        if (listLength(bio_jobs[type]) == 0) {
            pthread_cond_wait(&bio_condvar[type],&bio_mutex[type]);
            continue;
        }
        // 从这种任务的 list 中取出来一个
        ln = listFirst(bio_jobs[type]);
        job = ln->value;
        pthread_mutex_unlock(&bio_mutex[type]);

        // 不同类型的 job 做不同的处理
        if (type == BIO_CLOSE_FILE) {
            close((long)job->arg1);
        } else if (type == BIO_AOF_FSYNC) {
            aof_fsync((long)job->arg1);
        } else {
            serverPanic("Wrong job type in bioProcessBackgroundJobs().");
        }
        zfree(job);

        /*
         * 下一次循环前需要再一次加锁
         * 如果没有相应的 job，将再一次在 pthread_cond_wait() 阻塞住。
         */
        pthread_mutex_lock(&bio_mutex[type]);
        listDelNode(bio_jobs[type],ln); // 删掉执行过的 job
        bio_pending[type]--; // 这种类型还没有出来 job 数减去 1
    }
}

```

以上是 bio 处理 job 的过程，这个就是一个死循环，不断地取到 job 进行处理。

这个过程需要参考着以下新加某种类型的一个 job 来看。

#### bioCreateBackgroundJob 创建 job

下面的函数将创建一个特定类型的 job， 并放入相应的 job list 中。

```c
void bioCreateBackgroundJob(int type, void *arg1, void *arg2, void *arg3) {
    struct bio_job *job = zmalloc(sizeof(*job));
    job->time = time(NULL);
    job->arg1 = arg1;
    job->arg2 = arg2;
    job->arg3 = arg3;

    pthread_mutex_lock(&bio_mutex[type]); // 加锁
    listAddNodeTail(bio_jobs[type],job); // 将新的 job 放到对应 job queue 中
    bio_pending[type]++;
    pthread_cond_signal(&bio_condvar[type]); // 条件变量通知有新的 job 产生
    pthread_mutex_unlock(&bio_mutex[type]);// 解锁
}
```

在该版本的源码中，有两个地方使用到了 `bioCreateBackgroundJob` 这个函数。

```c
// 执行 fsync() 刷盘的后台任务
void aof_background_fsync(int fd) {
    bioCreateBackgroundJob(BIO_AOF_FSYNC,(void*)(long)fd,NULL,NULL);
}
```

```c
// 异步关闭重写的 aof 文件
if (oldfd != -1) {
    bioCreateBackgroundJob(BIO_CLOSE_FILE,(void*)(long)oldfd,NULL,NULL);
}

```

可以发现这个用例中，创建 job 的第一个参数都是一个 fd，其他参数都置空了。

### 一个完整的 bio 任务处理过程

首先服务器启动时，调用 `bioInit` 函数，进行不同类型 job 线程、锁、条件变量等的初始化，每种类型 job 有自己的处理线程，初始化时会注册回调函数 `bioProcessBackgroundJobs` 处理各种 job。

还没有 job 时，各个 job 处理流程在经过 `pthread_mutex_lock(&bio_mutex[type])` 的加锁后，在 job 处理循环中 `pthread_cond_wait(&bio_condvar[type],&bio_mutex[type])` 处阻塞住，随之**释放锁** `bio_mutex[type]`,  `pthread_cond_wait` 在阻塞时，会释放锁，所以在**使用前需要先加锁**。

这时在主线程中创建某个类型的 job，创建过程中，先加锁 `pthread_mutex_lock(&bio_mutex[type])`,然后往某种类型的 job list 中 新加一个 job。接着主线程通知 bio 去处理这个 job，`pthread_cond_signal(&bio_condvar[type])`。

该类型 job 的后台处理线程从阻塞中被唤醒，它会去加锁，但是由于在主线程中 `bio_mutex[type]` 这把锁还没有得到释放，因此会继续阻塞。

接着，主线程释放了锁 ` pthread_mutex_unlock(&bio_mutex[type])`，bio 线程进行加锁，这个由 `pthread_cond_wait`  完成的。然后 `continue` 进入下次循环，在取到 job 后 `job = ln->value` 进行解锁。执行了 job 之后，在进入下一次循环之前**再次加锁**。

### 补充

```c
int pthread_cond_wait(pthread_cond_t *restrict cond, pthread_mutex_t *restrict mutex);
```

这个函数的理解很重要。

在条件不满足的时候, 调用该函数进入等待。 当条件满足的时候, 该函数会停止等待, 继续执行。

该函数的第二个参数是 `pthread_mutex_t` 类型，这是因为在条件判断的时候, 需要**先进行加锁来防止出现错误**，在执行该函数前需要主动对这个变量执行加锁操作，进入这个函数以后， **其内部会对mutex进行解锁操作**，而函数执行完以后(也就是停止阻塞以后)，又会重新加锁。

该函数也有带有超时时间的版本。

### 总结

从上面可以看到，redis bio 其实是一个 C 语言多线程编程很好的例子，值得学习。
