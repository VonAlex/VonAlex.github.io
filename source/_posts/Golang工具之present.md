---
title: golang 工具之 present
tags:
  - go
categories: quick-start
index_img: /images/gopher.png
abbrlink: 1cbd4f22
date: 2017-05-13 22:09:56
---
Golang Present 是 Golang 社群开发出來的一个简单工具，通过简单的语法可以制作 ppt（语法近似于 Markdown)。
<!--more-->
## 简介
Golang 相关的技术幻灯片有多种格式，以 .ppt, .pdf 和 .slide 为主。
.slide 格式是随着 golang 诞生而出现的一种 present 格式，Go 核心开发成员似乎十分喜欢以这种格式分享 Go 语言。在Golang 官方，几乎所有技术会议的 [talk 幻灯片](https://talks.golang.org/) 均是以 **.slide** 形式提供的。**.slide**文件通过 web 服务来进行查看，有一个名为 `present` 的工具可以在本地查看 **.slide** 文件。

## 安装
```go
// 下载
go get -u golang.org/x/tools/cmd/present
// 安装
go install golang.org/x/tools/cmd/present
```

## 使用
在工作目录下, 执行 `present` 命令，启动一个服务器。
比如，我的工作目录是 `$GOPATH/src/github.com/golang/talks`,启动服务后，出现下面的提示：

```other
2017/05/13 22:21:21 Open your web browser and visit http://127.0.0.1:3999
```
这表明服务启动成功，然后就可以写 slide 文件了。
present 文件的语法可以在 [**go doc**](https://godoc.org/golang.org/x/tools/present) 中查看


**题外话：**由于某种原因的存在，有些代码使用 `go get` 无法获取到，这里比较推荐两个网站可能会比较好的解决这个痛点。

- [golang 中国](http://golangtc.com/download/package)提供的服务
- [go 语言包管理](https://gopm.io/) 提供的服务

## 参考
[Golang技术幻灯片的查看方法](http://studygolang.com/articles/4703)
[[Golang] 來用 Golang Present 製造 Golang 專屬投影片](http://www.th7.cn/Program/go/201612/1027068.shtml)
