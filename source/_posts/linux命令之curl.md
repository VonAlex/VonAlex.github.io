---
title: linux 命令之 curl
tags:
  - shell
categories: linux
index_img: /images/linux.jpg
abbrlink: d904ea3d
date: 2017-06-11 00:12:08
---

> curl 命令是一个利用 URL 规则在命令行下工作的文件传输工具。它支持文件的上传和下载，所以是综合传输工具，但按传统，习惯称 curl 为下载工具。它支持包括 HTTP、HTTPS、ftp等众多协议，还支持 POST、cookies、认证、从指定偏移处下载部分文件、用户代理字符串、限速、文件大小、进度条等特征。做网页处理流程和数据检索自动化，curl 可以助一臂之力。

<!--more-->

## 常用选项
### **抓取页面信息**

`-o` 将文件保存为命令行中指定的文件名的文件中
`-O` 使用URL中默认的文件名保存文件到本地

```shell
 # 将文件下载到本地并命名为 mygettext.html
curl -o mygettext.html http://www.gnu.org/software/gettext/manual/gettext.html

# 将文件保存到本地并命名为gettext.html，后面的 url 可以写正则
curl -O http://www.gnu.org/software/gettext/manual/gettext.html

# -O -O 可以同时下载多个文件
# 不加这个选项会直接打印到标准输出
```
### 网页重定向
有些网页，比如 `www.sina.com`, 发生了跳转，直接 curl 的话无法获得网页源码，这时需要加 `-L` 选项

```shell
# 遇到重定向时，使用该选项可以将请求重定向到新的地址上
curl -L www.sina.com
```

### 断点续传
当 curl 网页时中途终端，可以使用 `-C` 选项来接着已经完成的下载，已经下载过的文件不会被重新下载。

```shell
# 当文件在下载完成之前结束该进程
$ curl -O http://www.gnu.org/software/gettext/manual/gettext.html
##############             20.1%

$ curl -C -O http://www.gnu.org/software/gettext/manual/gettext.html
###############            21.1%
```
### 获得请求信息或通信过程
`-i` 显示 http response 的头信息，连同网页代码一起。
`-I/--head` 只显示 response 头部信息。
`-v` 显示一次http通信的整个过程，包括端口连接和http request头信息。
或者使用下面的命令获得更详细的通信过程：
`curl --trace output.txt www.sina.com`

### 发送表单信息
对于 **GET** 方法，由于参数数据在 url 上，因此，可以直接 curl，这也是 curl 默认方法。
对于其他方法，则需要使用 `-X` 选项进行指定，如 POST、DELETE 等。

```shell
$ curl -X POST --data "data=xxx" example.com
```
`--data` 等同于 `-d`，有以下几种用法：

```shell
-d @file # 将提交的参数放在文件里
-d "string" # 多参数形式为 xxx&xxx
--data "string"
--data-ascii "string"
--data-binary "string"
--data-urlencode "string # 含有特殊符号的需要进行 url 编码
```
### 伪造头部信息
`-e/--referer <url>` 选项可以伪造来源网址。

```shell
# 假装是从 http://www.google.com 页面跳转到目的页面的
$ curl --referer http://www.google.com http://man.linuxde.net
```

`-A/--user-agent <string>` 选项可以伪造 UA。

```shell
curl URL -A "Mozilla/5.0"
```

`-H/--header` 自定义头部信息

```shell
curl -H "Host:man.linuxde.net" -H "accept-language:zh-cn" <url>
```
`-x/--proxy <host[:port]>` 设置代理

### 设置 cookie
`-b/--cookie <name=val/file>` 选项用来设置 cookie 或者从指定文件中读取 cookie 信息发起 http 请求。

```shell
$ curl --cookie "name=xxx;pass=xxx" www.example.com
```
`-c/--cookie-jar <file>` 选项可以将 cookies 保存到指定文件。


### 用户认证
`-u/--user <user[:password]>` 进行 http/ftp 的认证

> 下载文件
>
$ curl -u name:password www.example.com
>
$ curl -O ftp://name:passwd@ip:port/demo/curtain/bbstudy_files/style.css
> 上传文件
>
$ curl -T test.sql ftp://name:passwd@ip:port/demo/curtain/bbstudy_files/


### 限速与限额

 `--limit-rate <rate> ` 选项设置传输速度

```shell
curl URL --limit-rate 50k
```

 `--max-filesize <bytes>` 选项设置最大下载的文件总量

 ```shell
 curl URL --max-filesize bytes
 ```


## 参考
【1】 [Linux curl 命令详解](http://aiezu.com/article/linux_curl_command.html)
【2】[linux curl 命令详解，以及实例](http://blog.51yip.com/linux/1049.html)
【3】[curl网站开发指南](http://www.ruanyifeng.com/blog/2011/09/curl.html)
