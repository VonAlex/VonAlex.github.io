---
title: go 依赖管理 govendor
tags:
  - go
categories: quick-start
index_img: /images/gopher.png
abbrlink: b5574948
date: 2017-05-02 23:34:26
---

Golang 官方并没有推荐最佳的包管理方案。到了1.5版本时代，官方引入包管理的设计，加了 vendor 目录来支持本地包管理依赖。官方 wiki 推荐了多种支持这种特性的包管理工具，如：Godep、gv、gvt、glide、govendor等。

<!-- more -->

下面简要介绍一个我在项目中用到的 -- **govendor**。
该工具将项目依赖的外部包拷贝到项目下的 vendor 目录下，并通过 vendor.json 文件来记录依赖包的版本，方便用户使用相对稳定的依赖。
对于 govendor 来说，依赖包主要有以下多种类型:

| 状态        | 缩写状态 | 含义                               |
| --------- | ---- | -------------------------------- |
| +local    | l    | 本地包，即项目自身的包组织                    |
| +external | e    | 外部包，即被 $GOPATH 管理，但不在 vendor 目录下 |
| +vendor   | v    | 已被 govendor 管理，即在 vendor 目录下     |
| +std      | s    | 标准库中的包                           |
| +unused   | u    | 未使用的包，即包在 vendor 目录下，但项目并没有用到    |
| +missing  | m    | 代码引用了依赖包，但该包并没有找到                |
| +program  | p    | 主程序包，意味着可以编译为执行文件                |
| +outside  |      | 外部包和缺失的包                         |
| +all      |      | 所有的包                             |

## Installation

```go
go get -u github.com/kardianos/govendor
```

命令行执行 `govendor`，若出现以下信息，则说明安装成功。

```go
➜  ~ govendor
govendor (v1.0.8): record dependencies and copy into vendor folder
    -govendor-licenses    Show govendor's licenses.
    -version              Show govendor version
...
...
```

**Warning：** 需要把 `$GOPATH/bin/` 加到 `PATH` 中。

## Quickstart

```go
# Setup your project.
cd "my project in GOPATH"
# 初始化 vendor 目录, project 下出现 vendor 目录
govendor init

# Add existing GOPATH files to vendor.
govendor add +external

# 删掉那些在 vendor 目录中，但是代码中没有使用的包
govendor remove +unused

# 去掉 github.com/k0kubun/pp 这个包
govendor remove github.com/k0kubun/pp

# View your work.
govendor list

# Look at what is using a package
govendor list -v fmt

# Specify a specific version or revision to fetch
govendor fetch golang.org/x/net/context@a4bbce9fcae005b22ae5443f6af064d80a6f5a55

# Get latest v1.*.* tag or branch.
govendor fetch golang.org/x/net/context@v1

# Get the tag or branch named "v1".
govendor fetch golang.org/x/net/context@=v1

# Update a package to latest, given any prior version constraint
govendor fetch golang.org/x/net/context

# Format your repository only
govendor fmt +local

# Build everything in your repository only
govendor install +local

# Test your repository only
govendor test +local
```

## Sub-commands

```go
init     创建 vendor 文件夹和 vendor.json 文件
list     列出已经存在的依赖包
add      从 $GOPATH 中添加依赖包，会加到 vendor.json
update   从 $GOPATH 升级依赖包
remove   从 vendor 文件夹删除依赖
status   列出本地丢失的、过期的和修改的package
fetch   从远端库增加新的，或者更新 vendor 文件中的依赖包

sync    本地存在 vendor.json 时候拉取依赖包，匹配所记录的版本

migrate  Move packages from a legacy tool to the vendor folder with metadata.
get     类似 go get，但是会把依赖包拷贝到 vendor 目录
license  List discovered licenses for the given status or import paths.
shell    Run a "shell" to make multiple sub-commands more efficient for large projects.

go tool commands that are wrapped:
      `+<status>` package selection may be used with them
    fmt, build, install, clean, test, vet, generate, tool
```

**warning**

- The project must be within a `$GOPATH/src`.
- If using go1.5, ensure you set `GO15VENDOREXPERIMENT=1`.

## 参考

[govendor github](https://github.com/kardianos/govendor)
[go 依赖管理利器 -- govendor](http://blog.csdn.net/yeasy/article/details/65935864)
