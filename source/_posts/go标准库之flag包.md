---
title: golang 标准库之 flag 包
tags:
  - go
categories: quick-start
index_img: https://gitee.com/happencc/pics/raw/master/images/gopher.png
abbrlink: 1e9de668
date: 2017-06-04 15:51:29
---
命令行参数常用来为命令行程序指定选项。比如在 `wc -l ` 命令中 `-l` 就是命令行参数。

golang 提供了 flag 包来支持基本的命令行参数解析。
<!--more-->
### 命令行语法
命令行语法如下：

```go
-flag
-flag=x
-flag x  // non-boolean flags only
```

### 基本用法
#### 定义 flag 参数
**方法一**：
通过 `flag.Xxx()` 方法返回一个相应的指针，举几个栗子：

```go
wordPtr := flag.String("word", "foo", "a string")
numbPtr := flag.Int("numb", 42, "an int")
boolPtr := flag.Bool("fork", false, "a bool")
```
使用形式为 `flag.Type(name, defValue, usage)`

**方法二**：
通过 `flag.XxxVar()` 方法将 flag 绑定到一个变量，该种方式返回值类型，举个栗子：

```go
var svar string
flag.StringVar(&svar, "svar", "bar", "a string var")
```
使用形式为 `flag.TypeVar(&flagvar, name, defValue, usage)`
**方法三**：
通过 `flag.Var()` 绑定自定义类型，自定义类型需要实现 `Value` 接口(`Receives`必须为指针)，

```go
type Value interface {
        String() string
        Set(string) error
}
```
使用方式是 `flag.Var(&flagvar, name, usage)`
#### 解析
调用 `flag.Parse()` 解析命令行参数到定义的flag

#### 其他
还可通过 `flag.Args()`, `flag.Arg(i)` 来获取非 flag 命令行参数

#### 栗子

```go
package main
import "flag"
import "fmt"
import "strconv"
type percentage float32
func (p *percentage) Set(s string) error {
    v, err := strconv.ParseFloat(s, 32)
    *p = percentage(v)
    return err
}
func (p *percentage) String() string { return fmt.Sprintf("%f", *p) }
func main() {
    namePtr := flag.String("name", "lyh", "user's name")
    agePtr := flag.Int("age", 22, "user's age")
    vipPtr := flag.Bool("vip", true, "is a vip user")
    var email string
    flag.StringVar(&email, "email", "lyhopq@gmail.com", "user's email")
    var pop percentage
    flag.Var(&pop, "pop", "popularity")
    flag.Parse()
    others := flag.Args()
    fmt.Println("name:", *namePtr)
    fmt.Println("age:", *agePtr)
    fmt.Println("vip:", *vipPtr)
    fmt.Println("pop:", pop)
    fmt.Println("email:", email)
    fmt.Println("other:", others)
}
$ ./command-line-flags
name: lyh
age: 22
vip: true
email: lyhopq@gmail.com
other: []
$ ./command-line-flags -name golang -age 4 -vip=true -pop 99 简洁 高并发 等等
name: golang
age: 4
vip: true
pop: 99
email: lyhopq@gmail.com
other: [简洁 高并发 等等]
$ ./command-line-flags -h
Usage of ./command-line-flags:
 -age=22: user's age
 -email="lyhopq@gmail.com": user's email
 -name="lyh": user's name
 -pop=0.0: popularity
 -vip=true: is a vip user
```


### 参考
1. [Golang flag包使用详解(一)](http://faberliu.github.io/2014/11/12/Golang-flag%E5%8C%85%E4%BD%BF%E7%94%A8%E8%AF%A6%E8%A7%A3-%E4%B8%80/)
2. [Go by Example: Command-Line Flags](https://gobyexample.com/command-line-flags)
3. [Go语言中使用flag包对命令行进行参数解析的方法](https://www.teakki.com/p/57df64d9da84a0c4533815ee)
