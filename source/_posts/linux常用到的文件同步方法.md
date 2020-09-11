---
title: linux 常用到的文件同步方法
tags:
  - tools
categories: linux
index_img: https://gitee.com/happencc/pics/raw/master/images/linux.jpg
abbrlink: e8a575f7
date: 2017-10-05 16:36:03
---

下面总结了一些日常可以用到的**文件同步**的方法，以方便参考使用。
<!--more -->
## sftp
> SFTP ，即 SSH 文件传输协议（ SSH File Transfer Protocol ），或者说是安全文件传输协议（ Secure File Transfer Protocol ）。SFTP 是一个独立的 SSH 封装协议包，通过安全连接以相似的方式工作。它的优势在于可以利用安全的连接传输文件，还能遍历本地和远程系统上的文件系统。在大多数情况下，优先选择 SFTP 而不是 FTP ，原因在于 SFTP 最基本的安全特性和能利用 SSH 连接的能力。FTP 是一种不安全的协议，应当只有在特定的情况下或者你信任的网络中使用。

sftp 这个命令在linux上及 mac 上被默认安装了。

### 用法

``` shell
# 建立一个 SSH 连接打开一个 SFTP 会话，默认 port 为22
sftp username@remote_hostname_or_IP -p prot
# 建立连接后执行help, 可以看看 sftp 支持哪些命令
help
# 操作远端服务器
pwd/ls/cd
# 操作本地
lpwd/lls/lcd
# 离开
quit

# 下载文件 a.txt,以b.txt 重命名，若没有的话，下载到本地后，依然以 a.txt 的名字存在
get a.txt b.txt
# 下载 rmtDir 文件夹，以 reDir 名字存在，若没有重新命名，那以源文件夹名字存在
get -r rmtDir reDir

# 将当前目录下的 a.txt 文件上传到远端服务器的目录下,以 b.txt 的名字存在，若没有重命名依然是 a.txt
put a.txt b.txt
# 将本地的 localDir 文件夹下的内容，长传到远端 rmtDir 目录下（这个目录必须存在）
put -r localDir/. rmtDir
```

## nc

> NetCat，在网络工具中有“瑞士军刀”美誉，其有Windows和Linux的版本。因为它短小精悍（1.84版本也不过25k，旧版本或缩减版甚至更小）、功能实用，被设计为一个简单、可靠的网络工具，可通过TCP或UDP协议传输读写数据。同时，它还是一个网络应用Debug分析器，因为它可以根据需要创建各种不同类型的网络连接。通常的Linux发行版中都带有NetCat（简称nc），但不同的版本，其参数的使用略有差异。

这里只说明 nc 在**传输文件**方面的应用。

### 用法
下面两条命令实现的功能是，将本地的 localfile 上传到 remote_ip，并且以 targetfile 命名。

```sh
# 在远端
nc -l port > targetfile

# 在本地
nc remote_ip remote_port < localfile
```
另外，nc 可以做**端口扫描**工具，命令为

```shell
# -w<超时秒数>，扫描 21 到 22 端口， -z 端口扫描模式即零 I/O 模式
nc -v -z -w 2 `hostname -i` 21-22
```

## scp

> scp是secure copy的简写，用于在Linux下进行远程拷贝文件的命令，和它类似的命令有cp，不过cp只是在本机进行拷贝不能跨服务器，而且scp传输是加密的。可能会稍微影响一下速度。当你服务器硬盘变为只读 read only system时，用scp可以帮你把文件移出来。另外，scp还非常不占资源，不会提高多少系统负荷，在这一点上，rsync就远远不及它了。虽然 rsync比scp会快一点，但当小文件众多的情况下，rsync会导致硬盘I/O非常高，而scp基本不影响系统正常使用。

### 用法

```shell
# 将本地文件 copy 到 remote
scp local_file remote_username@remote_ip:remote_folder

# 拷贝文件夹
scp -r local_folder remote_username@remote_ip:remote_folder

# 反过来可以从 remote 到 local
```


## rsync
> rsync命令是一个远程数据同步工具，可通过LAN/WAN快速同步多台主机间的文件。rsync使用所谓的“rsync算法”来使本地和远程两个主机之间的文件达到同步，这个算法只传送两个文件的不同部分，而不是每次都整份传送，因此速度相当快。

具体配置可以参考文章：[linux rsync同步设置详细指南](http://www.blogjava.net/Alpha/archive/2011/06/30/353439.html)
