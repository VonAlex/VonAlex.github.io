---
title: dstat工具使用
tags:
  - shell
categories: linux
index_img: /images/linux.jpg
abbrlink: fe52c850
date: 2018-07-04 00:35:12
---
**Dstat** 是一个多样化的资源统计工具。[官网](http://dag.wiee.rs/home-made/dstat/)上是这么说的，感受一下：
> Dstat is a versatile replacement for vmstat, iostat, netstat and ifstat. Dstat overcomes some of their limitations and adds some extra features, more counters and flexibility. Dstat is handy for monitoring systems during performance tuning tests, benchmarks or troubleshooting.
> Dstat allows you to view all of your system resources in real-time, you can eg. compare disk utilization in combination with interrupts from your IDE controller, or compare the network bandwidth numbers directly with the disk throughput (in the same interval).

<!--more---->
dstat将以列表的形式为你提供选项信息并清晰地告诉你是在何种幅度和单位显示输出。这样更好地避免了信息混乱和误报。更重要的是，它可以让你更容易编写插件来收集你想要的数据信息，以从未有过的方式进行扩展。

Dstat的默认输出是专门为人们实时查看而设计的，不过你也可以将详细信息通过CSV输出到一个文件，并导入到Gnumeric或者Excel生成表格中。

### 特点
- Combines **vmstat**, **iostat**, **ifstat**, **netstat** information and more
- Shows stats in exactly the same timeframe
- Enable/order counters as they make most sense during analysis/troubleshooting
- Modular design
- Written in **python** so easily extendable for the task at hand
- Easy to extend, add your own counters (please contribute those)
- Includes many external plugins to show how easy it is to add counters
- Can summarize grouped block/network devices and give total numbers
- Can show interrupts per device
- Very accurate timeframes, no timeshifts when system is stressed
- Shows exact units and limits conversion mistakes
- Indicate different units with different colors
- Show intermediate results when delay > 1
- Allows to export CSV output, which can be imported in Gnumeric and Excel to make graphs

以上的特点是从官网扒下来的，可以参考一下。

### 安装
centos 可以直接使用如下命令安装：

```
yum install dstat
```

### 外部插件

```shell
[root@pandora ~]# dstat --list
internal:
	aio, cpu, cpu24, disk, disk24, disk24old, epoch, fs, int, int24, io, ipc, load, lock, mem, net, page, page24, proc, raw, socket, swap, swapold, sys, tcp, time, udp, unix, vm
/usr/share/dstat:
	battery, battery-remain, cpufreq, dbus, disk-util, fan, freespace, gpfs, gpfs-ops, helloworld, innodb-buffer, innodb-io, innodb-ops, lustre, memcache-hits, mysql-io, mysql-keys, mysql5-cmds,
	mysql5-conn, mysql5-io, mysql5-keys, net-packets, nfs3, nfs3-ops, nfsd3, nfsd3-ops, ntp, postfix, power, proc-count, rpc, rpcd, sendmail, snooze, thermal, top-bio, top-cpu, top-cputime, top-cputime-avg,
	top-io, top-latency, top-latency-avg, top-mem, top-oom, utmp, vm-memctl, vmk-hba, vmk-int, vmk-nic, vz-cpu, vz-io, vz-ubc, wifi
```

通过`dstat --list`可以查看 dstat 能使用的所有参数，其中上面 internal 是 dstat 本身自带的一些监控参数，下面 `/usr/share/dstat`中是 dstat 的插件，这些插件可以扩展 dstat 的功能，如可以监控电源（battery）、mysql等。
下面这些插件并不是都可以直接使用的，有的还依赖其他包，如想监控 mysql，必须要装 python 连接 mysql 的一些包。

### 用例
用法可以用 `-h` 选项看下，或者 `man dstat` 查一下。我执行了一下，大概是这样的：

```shell
[root@pandora ~]# dstat -h
Usage: dstat [-afv] [options..] [delay [count]]
Versatile tool for generating system resource statistics

Dstat options:
  -c, --cpu              enable cpu stats
     -C 0,3,total           include cpu0, cpu3 and total
  -d, --disk             enable disk stats
     -D total,hda           include hda and total
  -g, --page             enable page stats
  -i, --int              enable interrupt stats
     -I 5,eth2              include int5 and interrupt used by eth2
  -l, --load             enable load stats
  -m, --mem              enable memory stats
  -n, --net              enable network stats
     -N eth1,total          include eth1 and total
  -p, --proc             enable process stats
  -r, --io               enable io stats (I/O requests completed)
  -s, --swap             enable swap stats
     -S swap1,total         include swap1 and total
  -t, --time             enable time/date output
  -T, --epoch            enable time counter (seconds since epoch)
  -y, --sys              enable system stats

  --aio                  enable aio stats
  --fs, --filesystem     enable fs stats
  --ipc                  enable ipc stats
  --lock                 enable lock stats
  --raw                  enable raw stats
  --socket               enable socket stats
  --tcp                  enable tcp stats
  --udp                  enable udp stats
  --unix                 enable unix stats
  --vm                   enable vm stats

  --plugin-name          enable plugins by plugin name (see manual)
  --list                 list all available plugins

  -a, --all              equals -cdngy (default)
  -f, --full             automatically expand -C, -D, -I, -N and -S lists
  -v, --vmstat           equals -pmgdsc -D total

  --bw, --blackonwhite   change colors for white background terminal
  --float                force float values on screen
  --integer              force integer values on screen
  --nocolor              disable colors (implies --noupdate)
  --noheaders            disable repetitive headers
  --noupdate             disable intermediate updates
  --output file          write CSV output to file

delay is the delay in seconds between each update (default: 1)
count is the number of updates to display before exiting (default: unlimited)
```
直接执行 `dstat` 这个命令，默认选项是 `-cdngy`，1s 显示一条信息。可以在最后指定显示一条信息的时间间隔，如`dstat 5`是每 5s 显示一条，`dstat 5 10`表示每 5s 显示一条，一共显示 10 条。

一个可能的输出如下：

```shell
[root@pandora ~]# dstat
----total-cpu-usage---- -dsk/total- -net/total- ---paging-- ---system--
usr sys idl wai hiq siq| read  writ| recv  send|  in   out | int   csw
  3   4  92   0   0   0| 135k 4182k|   0     0 |  52k   86k|  20k   50k
  4   3  93   0   0   0|   0  3668k|5873B 5436B|   0   120k|  30k   51k
  4   3  93   0   0   0|   0  3632k|6040B 4520B|   0   100k|  32k   55k
  4   3  93   0   0   0|4096B 3832k|3274B 1574B|   0    72k|  30k   50k
  4   3  93   0   0   0|   0  3644k|3404B 1654B|   0   120k|  33k   57k
```
可以看到的统计项有以下几个：
`-c` 选项。CPU 状态：从左到右依次是用户/系统/空闲部分的 cpu 占比，wait，硬/软中断次数。
`-d` 选项。磁盘状态：磁盘的读写操作，这一栏显示磁盘的读、写总数。
`-n` 选项。网络状态：网络设备发送和接受的数据。
`-g` 选项。页面状态：系统的分页活动，分页指的是一种内存管理技术用于查找系统场景，一个较大的分页表明系统正在使用大量的交换空间，或者说内存非常分散，大多数情况下你都希望看到 page in（换入）和 page out（换出）的值是 0。
`-y` 选项。系统统计：中断（int）和上下文切换（csw）数量。较高的值通常表示大量的进程造成拥塞，需要对 CPU 进行关注。

### 常用选项
`--socket` 显示常用的 socket 统计
`--tcp` 显示常用的TCP统计
`--mem` 显示内存使用率
`--io` 显示I/O统计
`--int` 显示终端统计

`--disk-util` 显示某一时间磁盘的忙碌状况
`--freespace` 显示当前磁盘空间使用率
`--proc-count` 显示正在运行的程序数量
`--top-bio` 指出块I/O最大的进程
`--top-cpu` 图形化显示CPU占用最大的进程
`--top-io` 显示正常I/O最大的进程
`--top-mem` 显示占用最多内存的进程

一个可能的输出如下：

```shell
[root@pandora ~]# dstat --tcp --io --top-cpu --top-io --mem --top-mem
----tcp-sockets---- --io/total- -most-expensive- ----most-expensive---- ------memory-usage----- --most-expensive-
lis act syn tim clo| read  writ|  cpu process   |     i/o process      | used  buff  cach  free|  memory process
 12  29   0   0   0|4.93  46.2 |codis-config 0.0|sshd        102k   46k|38.7G  333M 60.4G  152G|java         183M
 12  29   0   0   0|   0  27.0 |irqbalance   0.0|irqbalance   48k    0 |38.7G  333M 60.4G  152G|java         183M
 12  29   0   0   0|   0  4.00 |codis-config 0.0|redis-serve  34k   47B|38.7G  333M 60.4G  152G|java         183M
 12  29   0   0   0|   0  1.00 |bin/codis-con0.0|redis-serve  34k   54B|38.7G  333M 60.3G  152G|java         183M
```
