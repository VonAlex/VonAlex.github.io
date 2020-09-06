---
title: 从tcpdump抓包看TCP/IP协议
tags:
  - tcp/ip
  - tupdump
categories: linux
index_img: /images/tcpip.jpg
abbrlink: 1f742d6d
date: 2018-05-26 16:44:18
---
因为最近要解析 TCP 报文中 option 段的一块数据，所以不得不详细了解下 TCP/IP 报文。虽然之前看过，很长时间没这么细致地用过，导致了健忘，借着这个机会，通过 tcpdump 抓包分析，详细捋一遍 TCP/IP 报文。
<!--more---->

## 报文获取
如果那样干巴巴地讲这个东西比较晕，而且网上的文章一大堆，没有什么创新。我选择换一个角度来切入 TCP/IP 协议。首先通过 tcpdump 准备报文。
【1】我在 `192.168.1.22` 这台机器的 `10000` 端口启一个 `redis` 服务。
【2】通过 tcpdump 这个工具来抓取数据包，命令如下：

```shell
tcpdump -w /tmp/logs -i eth0 port 10000 -s0
```
【3】在 `192.168.1.26` 这台机器上访问 `192.168.1.22:10000` 这个 redis 实例，可以用 `redis-cli` 客户端，也可以用 `telnet`，发送一个 `ping`, 得到对端回复 `pong`。
【4】停止抓包，用 tcpdump 读取这个数据包（`-x` 以16进制形式展示，便于后面分析）

```shell
tcpdump -r /tmp/logs -n -nn -x| vim -
```
其中有一个数据包是这样的，这也是这篇文章要分析的:

```other
10:54:54.270967 IP 192.168.1.26.61096 > 192.168.1.22.10000: Flags [P.], seq 1041414875:1041414889, ack 658186233, win 115, options [nop,nop,TS val 2377448931 ecr 2741547141], length 14
        0x0000: [4560 0042   7567 0000  3d06 6F3C C0A8 011A
        0x0010:  C0A8 0116] {eea8 2710  3e12 badb 273b 1ff9
        0x0020:  8018 0073   64b0 0000  0101 080a 8db4 fde3
        0x0030:  a368 b085}  2a31 0d0a  2434 0d0a 7069 6e67
        0x0040:  0d0a
```
**注意：**
【1】之前在文章[常用 shell](https://vonalex.github.io/2017/08/05/%E5%B8%B8%E7%94%A8shell/) 中介绍过抓包神器 **tcpdump**，还不会的小伙伴可以偷瞄一眼。
【2】上面报文数据中的 `[`、`]`、`{` 和 `}` 是为了方便区分数据，我自己加上的。`[]`包围的部分为本报文中的 IP 头，`{}`包围的部分为本报文中的 TCP 头。

## 报文分析
 IP 报文整体结构如下，因为抓到的数据包是请求 `redis` 服务，因此在传输层为 TCP 协议。
<img src="https://s1.ax1x.com/2018/10/28/icwsrn.jpg" width="650"/>
### IP 层解析
解析数据包之前，先把 IP 协议拿出来，如下：
<img src="https://s1.ax1x.com/2018/10/28/icwgaV.jpg" width="650"/>
可以看到，IP 报文头部采用`固定长度(20B) + 可变长度`构成，下面的 TCP 头部也是这样。
然后下面对着抓到的数据包进行分析：
【1】`0x4` 4bit， **ip 协议版本**
`0x4` 表示 IPv4。
【2】`0x5` 4bit，**ip首部长度(IHL)**
 该字段表示单位是 32bits (4字节) ，所以这个 ip 包的头部有 `5*4=20B`，这就可以推出，该 IP 报文头没有可选字段。4bit 可以表示最大的数为 0xF，因此，IP 头部的最大长度为 `15*4=60B`。该报文的 IP 头部我已经在报文中标注出来了。
【3】`0x60` 8bit，**服务类型 TOS**
该段数据组成为 3bit 优先权字段(现已被忽略) + 4bit TOS 字段 + 1bit 保留字段(须为0)。
4bit TOS 字段分别表示最小时延、最大吞吐量、最高可用性和最小费用。只能置其中 1bit，全为 0 表示一般服务。**现在大多数的TCP/IP实现都不支持TOS特性** 。可以看到，本报文 TOS 字段为全 0。
【4】`0x0042` 16bit， **IP 报文总长度**
单位字节，换算下来，该数据报的长度为 66 字节，数一下上面的报文，恰好 66B。
从占位数来算， IP 数据报最长为 `2^16=65535B`，但大部分网络的链路层 MTU（最大传输单元）没有这么大，一些上层协议或主机也不会接受这么大的，故超长 IP 数据报在传输时会被分片。
【5】`0x7567` 16bit，**标识**
唯一的标识主机发送的每一个数据报。通常每发送一个报文，它的值+1。当 IP 报文分片时，该标识字段值被复制到所有数据分片的标识字段中，使得这些分片在达到最终目的地时可以依照标识字段的内容重新组成原先的数据。
【6】`0x0000` 3bit **标志** + 13bit **片偏移**
3bit 标志对应 R、DF、MF。目前只有后两位有效，DF位：为1表示不分片，为0表示分片。MF：为1表示“更多的片”，为0表示这是最后一片。
13bit 片位移：本分片在原先数据报文中相对首位的偏移位。**（需要再乘以8）**
【7】`0x3d` 8bit **生存时间TTL**
IP 报文所允许通过的路由器的最大数量。每经过一个路由器，TTL减1，当为 0 时，路由器将该数据报丢弃。TTL 字段是由发送端初始设置一个 8 bit字段.推荐的初始值由分配数字 RFC 指定。发送 ICMP 回显应答时经常把 TTL 设为最大值 255。TTL可以防止数据报陷入路由循环。本报文该值为 61。
【8】`0x06` 8bit **协议**
指出 IP 报文携带的数据使用的是哪种协议，以便目的主机的IP层能知道要将数据报上交到哪个进程。TCP 的协议号为6，UDP 的协议号为17。ICMP 的协议号为1，IGMP 的协议号为2。该 IP 报文携带的数据使用 TCP 协议，得到了验证。
【9】`0x6F3C` 16bit **IP 首部校验和**
由发送端填充。以本报文为例，先说这个值是怎么计算出来的。

```oth
# 将校验和字段 16bit 值抹去变为 `0x0000`，然后将首部 20字节值相加
0x4560 + 0x0042 + 0x7567 + 0x0000 + 0x3d06 + 0x0000 + 0xC0A8 + 0x011A + 0xC0A8 +0x0116 = 0x27B95

# 将上述结果的进位 2 与低 16bit 相加
0x7B95 + 0x2 = 0x7B97

# 0x7B97 按位取反
~(0x7B97) = 0x8468
```
结果 `0x8468` 即为该字段值！
接收端验证的时候，进行以下计算

```o&#39;t
# 20B 首部值相加
0x27B95 + 0x8468 = 0x2FFFD

# 将上述结果的进位 2 与低 16bit 相加
0xFFFD + 0x2 = 0xFFFF

# 0xFFFF 按位取反
~(0xFFFF) = 0  <-- 正确
```
【10】`0xC0A8011A` 32bit 源地址
可以通过一下 python 程序将 hex 转换成我们熟悉的点分 IP 表示法

```python
>>> import socket
>>> import struct
>>> int_ip=int("0xC0A8011A",16)
>>> socket.inet_ntoa(struct.pack('I',socket.htonl(int_ip)))
'192.168.1.26'
```
本报文中的 src addr 为 `192.168.1.26`，恰好就是发起请求的 IP。
【11】`0xC0A80116` 32bit 目的地址
经过计算为  `192.168.1.22`，恰好就是启 redis 服务那台机器的 IP。

------
由于该报文首部长度为 20B，因此没有**可变长部分**。

### 传输层解析
本报文携带的数据使用的 TCP 协议，因此下面开始分析 TCP 协议。
 与上面的 IP 报文一样， TCP 报文头也才用采用`固定长度(20B) + 可变长度`的形式。
首先还是看 TCP 协议的格式，如下：
<img src="https://s1.ax1x.com/2018/10/28/icwba6.jpg" width="800"/>
**注：** TCP 的头部必须是 4字节的倍数,而大多数选项不是4字节倍数,不足的用 `NOP` 填充。
【1】`0xeea8` 16bit，**源端口**
解析得到 61096，这与 tcpdump 读包显示的是一致的。16bit 决定了端口号的最大值为 65535.
【2】`0x2710` 16bit，**目的端口**
解析得到 10000。
【3】`0x273b1ff9` 32bit，**序号**
解析得到 1041414875，这与上面 tcpdump 显示的 **seq** 段是一致的。
【4】`0x273b1ff9` 32bit，**确认号**
解析得到 658186233，这与上面 tcpdump 显示的 **ack** 段是一致的。
【5】`0x8` 4bit，**TCP 报文首部长度**
也叫 offset，其实也就是数据从哪里开始。`8 * 4 = 32B`,因此该 TCP 报文的可选部分长度为 `32 - 20 = 12B`，这个资源还是很紧张的！ 同 IP 头部类似，最大长度为 `60B`。
【6】`0b000000` 6bit, **保留位**
保留为今后使用，但目前应置为 0。
【7】`0b011000` 6bit，**TCP 标志位**
上图可以看到，从左到右依次是紧急 URG、确认 ACK、推送 PSH、复位 RST、同步 SYN 、终止 FIN。
从抓包可以看出，该报文是带了 ack 的，所以 ACK 标志位置为 1。关于标志位的知识这里就不展开了。
【8】`0x0073` 16bit，**滑动窗口大小**
解析得到十进制 115，跟 tcpdump 解析的 **win** 字段一致。
【9】`0x64b0` 16bit，**校验和**
由发送端填充，接收端对 TCP 报文段执行 CRC 算法，以检验 TCP 报文段在传输过程中是否损坏，如果损坏这丢弃。
检验范围包括首部和数据两部分，这也是 TCP 可靠传输的一个重要保障。
【10】`0x0000` 16bit，**紧急指针**
仅在 URG = 1 时才有意义，它指出本报文段中的紧急数据的字节数。
当 URG = 1 时，发送方 TCP 就把紧急数据插入到本报文段数据的最前面，而在紧急数据后面的数据仍是普通数据。

----
下面是 TCP 可选项，其格式如下：
<img src="https://s1.ax1x.com/2018/10/28/icwqIK.jpg" width="550"/>
常见的可选项如下图：
<img src="https://s1.ax1x.com/2018/10/28/icwHVx.jpg" width="650"/>
【11】`0x01`
NOP 填充，没有 Length 和 Value 字段， 用于将TCP Header的长度补齐至 32bit 的倍数。
【12】`0x01`
同上。
【13】`0x080a`
可选项类型为时间戳，len为 10B，value 为`0x8db4 0xfde3 0xa368 0xb085`，加上 `0x080a`，恰好 10B!
启用 Timestamp  Option后，该字段包含2 个 32bit 的Timestamp（TSval 和 TSecr）。
【14】`0x8db4 0xfde3`
解析后得到 2377448931，恰好与 tcpdump 解析到的 TS 字段的 **val**一致！
【15】`0xa368 0xb085`
解析后得到 2741547141，恰好与 tcpdump 解析到的 TS 字段的 **ecr**一致！

### 数据部分解析
上面分析得知，该 IP 报文长度为 66B，IP 头长度为 20B，TCP 头部长度为 32B，因此得到数据的长度为 `66 - 20 - 32 = 14B`，这与 tcpdump 解析到的 **len** 字段一致！下面来分析这个具体的数据。
这里涉及到 redis 协议，不知道的小伙伴可以查看这篇文档[redis 协议说明](http://www.redis.cn/topics/protocol.html)。
在抓包时，用客户端向 redis 服务端发送了一个 `ping` 命令，转换成 redis 协议如下：

```
*1\r\n
$4\r\n
ping\r\n
```
下面看抓包数据解析，这需要对照 ascii 码表来看，在 linux 下可以用 `man 7 ascii` 这个命令来获得，或者在这里查看[ascii码表](https://blog.csdn.net/innobase/article/details/51671996)。

```
0x2a31         -> *1
0x0d0a         -> \r\n
0x2434         -> $4
0x0d0a         -> \r\n
0x7069 0x6e67  -> ping
0x0d0a         -> \r\n
```

好了，这个 IP 包的解析就到此为止了，照着 TCP/IP 协议分析了一遍, 发现协议也就那么回事儿，没有想象的那么难，不要害怕协议！

-----
### tcpdump 补充
既然详细说到 TCP/IP 协议，那补充一下 tcpdump filter 的几点用法。
filter可以简单地分为三类：`type`, `dir` 和 `proto`。

type 区分报文的类型，主要由 host（主机）, net（网络，支持 CIDR） 和 port(支持范围，如 portrange 21-23) 组成。
dir 区分方向，主要由 src 和 dst 组成。
proto 区分协议支持 tcp、udp 、icmp 等。

下面说几个 filter 表达式。
`proto[x:y]` start at offset x into the proto header and read y **bytes**
`[x]` abbreviation for `[x:1]`
**注意**：单位是字节，不是位！

举几个栗子：
【1】**打印 80 端口，有数据的 tcp 包**

```shell
 tcpdump 'tcp port 80 and (((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2)) != 0)'
```
`ip[2:2]` 从 ip 报文的第3个字节开始读2个字节，这个恰好就是 ip 包的总长度，单位是字节
`ip[0]&0xf` 取的是 ip 报文第 1 个字节的低 4 位，`<< 2`（乘以 4），为 ip 头部长度，单位是字节
`tcp[12]&0xf0` 取的是 tcp 报文第 13 个字节的高 4 位，`>> 2` 其实等价于 `>> 4` 然后 `<< 2`，为 tcp 头部长度，单位是字节。
所以 `((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2))` 表示的数据长度。
【2】**打印 80 端口，长度超过 576 的 ip 包**
```shell
 tcpdump 'port 80 and ip[2:2] > 576'
```
【3】**打印特定 TCP Flag 的数据包**
TCP Flags 在 tcpdump 抓取的报文中的体现：
`[S]`：SYN（开始连接）
`[.]`: 没有 Flag
`[P]`: PSH（推送数据）
`[F]`: FIN （结束连接）
`[R]`: RST（重置连接）
`[S.]` SYN-ACK，就是 SYN 报文的应答报文。

```shell
tcpdump 'tcp[13] & 16!=0'
# 等价于
tcpdump 'tcp[tcpflags] == tcp-ack'
```
打印出所有的 ACK 包。

```shell
tcpdump 'tcp[13] & 4!=0'

# 等价于
tcpdump 'tcp[tcpflags] == tcp-rst'
```
打印出所有的 RST 包，即包含 `[R]` 标志的包。

更多 tcpdump filter 可以查看 [PCAP-FILTER](http://www.tcpdump.org/manpages/pcap-filter.7.html) 或者 `man tcpdump`！

-----
## 参考
1. [常用的TCP Option](https://blog.csdn.net/blakegao/article/details/19419237)
2. [IP报文格式详解](https://blog.csdn.net/mary19920410/article/details/59035804)
3. [TCP 报文结构](https://jerryc8080.gitbooks.io/understand-tcp-and-udp/chapter2.html)
