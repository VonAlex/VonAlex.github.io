---
title: gdb 日常使用
tags:
  - gdb
categories: linux
index_img: /images/gdb.jpg
abbrlink: 14ffc71
date: 2017-09-24 03:16:46
---

gdb 是一个由 GNU 开源组织发布的、UNIX/LINUX 操作系统下的、基于命令行的、功能强大的程序调试工具。当然了，一般都是使用 gdb 调试 c/cpp 程序。

<!--more -->

一般来说，GDB主要帮忙你完成下面四个方面的功能：
1. 启动你的程序，可以按照你的自定义的要求随心所欲的运行程序。
2. 可让被调试的程序在你所指定的调置的断点处停住。（断点可以是条件表达式）
3. 当程序被停住时，可以检查此时你的程序中所发生的事。
4. 动态的改变你程序的执行环境。

gdb 功能很强大，因此命令也很多，但是并不见得都能用得到，对于日常使用来说，知道一些常用的就够用了。

## 准备工作
代码在编译时要加上 `-g` 选项，生成的可执行文件才能用 gdb 进行源码级调试。
比如，`gcc -g main.c -o main`。
`-g` 选项的作用是在可执行文件中加入源代码的信息，比如可执行文件中第几条机器指令对应源代码的第几行，但并不是把整个源文件嵌入到可执行文件中，所以在调试时必须保证gdb能找到源文件。

## 参数说明
### list/l
**list linenum**，打印出以 linenum 行为中心的上下几行源码。
**list func**，打印以函数 func 定义所在行为中心的上下几行代码。
**list**, 打印当前行后面的源程序，每次10行。

### run/r
运行程序至第一个断点处停止。

### break/b
**break linenum**，在第 linenum 处设置一个断点。
**break func**，在 func 函数入口处设置一个断点。

### d
**d 断点num**，删除第 num 个断点。

### step/s
执行一行源程序代码，如果此行代码中有函数调用，则进入该函数。

### next/n
与 step 相反，n 表示不进入函数内容，继续执行。

### print/p
**print 变量名**，打印出变量值。

### backtrace/bt
查看各级函数调用及参数。

### frame/f
**frame 帧编号**，选择栈帧。

### set
**set var 变量=值**，修改某变量的值。
或者用 `print` 指令也能达到目的。

### finish
让程序一直运行到从当前函数返回为止。

### info/i
**info break**，查看所有已经设置的断点信息。
**info locals**，查看当前栈帧局部变量的值。

### shell
不离开 gdb 就执行 UNIX shell 命令

### help/h
获取帮助信息。

### quit/q
离开 gdb。


**注意: 上述命令几乎都可以使用首字母来简写长命令。**

## 调试 coredump 文件
**gdb 可执行文件 产生的coredump文件**，比如，`gdb test core.3533`。

## 参考
1. [Linux gdb调试器用法全面解析](http://blog.csdn.net/21cnbao/article/details/7385161)
2. [使用gdb调试程序完全教程](http://blog.csdn.net/gatieme/article/details/51671430)