---
title: golang 中下划线的使用
tags:
  - go
categories: quick-start
index_img: https://gitee.com/happencc/pics/raw/master/images/gopher.png
abbrlink: 3581d0f0
date: 2019-01-06 16:07:53
---
 在 Golang 里， `_` （下划线）是个特殊的标识符。前几天看 gin 源码，看到一个有意思的用法。虽然网上的总结博客已有很多，但是总是有点欠缺，于是就有了这一篇，方便以后查阅。

<!--more---->

### 用在 import

在导包的时候，常见这个用法，尤其是项目中使用到 mysql 或者使用 pprof 做性能分析时，比如

```go
import _  "net/http/pprof"
import _ "github.com/go-sql-driver/mysql"
```

这种用法，会调用包中的`init()`函数，让导入的包做初始化，但是却不使用包中其他功能。

### 用在返回值

该用法也是一个常见用法。Golang 中的函数返回值一般是多个，err 通常在返回值最后一个值。但是，有时候函数返回值中的某个值我们不关心，如何接收了这个值但不使用，代码编译会报错，因此需要将其忽略掉。比如

```go
for _, val := range Slice {}
_, err := func()
```

### 用在变量

我们都知道 Go 语言的接口是非侵入式的，不像 java 和 c++ 那么重，一个结构体只要实现了接口定义的所有函数，我们就说这个接口实现了该接口。有个专门的名字表示这种行为，duck typing，即**当看到一只鸟走起来像鸭子、游泳起来像鸭子、叫起来也像鸭子，那么这只鸟就可以被称为鸭子。**

```go
type I interface {
    Sing()
}

type T struct {
}

func (t T) Sing() {
}

type T2 struct {
}

func (t *T2) Sing() {
}

// 编译通过
var _ I = T{}
// 编译通过
var _ I = &T{}

// 编译失败
var _ I = T2{}
// 编译通过
var _ I = &T2{}
```

在这里下划线用来判断结构体是否实现了接口，如果没有实现，在编译的时候就能暴露出问题，如果没有这个判断，后代码中使用结构体没有实现的接口方法，在编译器是不会报错的。

可以看到上面四个判断只有第三个编译时失败的，报错如下：

```go
./test.go:27:5: cannot use T2 literal (type T2) as type I in assignment:
	T2 does not implement I (Sing method has pointer receiver)
```

这是为什么呢？仔细看上面代码发现，`T` 实现了 `Sing` 方法，`*T2` 实现了 `Sing` 方法。

我们都知道，Go 语言中是按值传递的。

那对于 `T2` 来说，调用 `Sing`  方法时，copy 一个副本，然后取地址，通过这个地址是找不到原始调用的那个结构体的，但是 receiver 是个指针，表示此次调用是需要改变调用者内部变量的，很明显，以 `T2` 类型调用无法完达到这个目的，所以这里是需要报错的。而以 `&T2` 调用  `Sing`  方法，则可以，因此不报错。

而对于 `T` 来说，不管是否有指针调用，都不会报错，实际上，Go 语言会自动实现 `*T` 的 `Sing` 方法。

**当然，这些都是我的个人理解，如果不对的话，欢迎斧正。**
