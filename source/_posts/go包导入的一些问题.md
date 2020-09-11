---
title: golang 包导入的一些问题
tags:
  - go
categories: quick-start
index_img: https://gitee.com/happencc/pics/raw/master/images/gopher.png
abbrlink: 3dbe6014
date: 2017-12-19 01:26:55
---
对 golang 包导入以及包管理方面的学习中遇到的问题做记录。
<!--more-->
## import
Go 使用包（package）作为基本单元来组织源代码，所有语法可见性均定义在 package 这个级别。同一 package 下面，可以有非常多的不同文件，只要每个文件属于相同的 package name。
每个源码文件的第一行必定要通过如下语法定义属于哪个 package，

```
package xxx
```
然后就是导入本源码文件所使用的标准包或第三方包，即

```
import (
    "a/b/c"
    "fmt"
)
```
标准库会从 **GO 的安装目录**下查找，第三方库会从开发者定义的 `$GOPATH` 下查找。当都找不到时，编译器就会报错。在使用第三方包的时候，当源码和 `.a` 均已安装的情况下，编译器链接的是**源码**。

**注意：** 上面语句中 `a/b/c` 最后的 `c` 为目录名，**不是 package name**。

在对文件中的方法进行调用时，使用如下格式:

```
package.Methodxxx()
```
同一文件夹下的多个文件的 package 一般定义为该文件夹的名字，但是也有例外，比如上面的栗子中，c 文件下的所有文件的 package 定义为 fux，那么在调用这个文件夹下文件的方法时，只能使用 `fux.Methodxxx()`,而不是 `c..Methodxxx()`

> 一个非main包在编译后会生成一个.a文件（在临时目录下生成，除非使用go install安装到 `$GOROOT` 或 `$GOPATH`下，否则你看不到 **.a**），用于后续可执行程序链接使用。

## vendor
Go 在 1.5 的版本加入的 vendor 的支持来做包管理。1.5 版本要设置 `GO15VENDOREXPERIMENT="1"` 来支持这个特性，1.6版本将其作为默认参数配置。下面对于包含 vendor 目录的包导入路径规则大致如下。

```
├── d
    ├── mypkg
    |     └── main.go
    └── vendor
          └── q
              ├── q.go
```
当上述目录结构，在 `main.go` 中 `import q`时，后首先从 **vendor** 目录下查找，若找不到，会从 **$GOPATH** 目录下查找，再找不到的话，编译器就报错了。

## 参考
【1】[理解Go 1.5 vendor](http://tonybai.com/2015/07/31/understand-go15-vendor/)
【2】[理解Golang包导入](http://tonybai.com/2015/03/09/understanding-import-packages/)
