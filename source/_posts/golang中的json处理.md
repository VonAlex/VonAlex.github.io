---
title: golang 中的 json 处理
tags:
  - go
categories: quick-start
index_img: https://gitee.com/happencc/pics/raw/master/images/gopher.png
abbrlink: fef1a660
date: 2017-06-17 19:11:53
---

**JSON**（Javascript Object Notation）已经成为了一种非常流行的数据交换格式，golang 自然不会忽视对 json 的支持，golang 自带的标准库就可以方便的处理 json。另外，推荐一种号称**全世界最快的 JSON 解析器** -- `jsoniter`。

<!--more-->

## 简介
json 中提供的处理 json 的标准包是 `encoding/json`,主要使用的是以下两个方法：

``` go
// 序列化
func Marshal(v interface{}) ([]byte, error)

// 反序列化
func Unmarshal(data []byte, v interface{}) error
```
序列化前后的数据结构有以下的对应关系：

```go
bool, for JSON booleans
float64, for JSON numbers
string, for JSON strings
[]interface{}, for JSON arrays
map[string]interface{}, for JSON objects
nil for JSON null
```
## Unmarshal
这是一个反序列化的过程，将 JSON 串重新组装成结构体。
### 已知解析类型
<i class="fa fa-code" aria-hidden="true"></i>示例代码如下：

``` go
package main

import (
    "encoding/json"
    "fmt"
)
type Animal struct {
    Name  string
    Order string
}
func main() {
    var jsonBlob = []byte(`[
        {"Name": "Platypus", "Order": "Monotremata"},
        {"Name": "Quoll",    "Order": "Dasyuromorphia"}
    ]`)

    var animals []Animal
    err := json.Unmarshal(jsonBlob, &animals)
    if err != nil {
        fmt.Println("error:", err)
    }
    fmt.Printf("%+v", animals)
}
```
运行后，输出结果：`[{Name:Platypus Order:Monotremata} {Name:Quoll Order:Dasyuromorphia}]`
可以看出，结构体字段名与 JSON 里的 KEY 一一对应.
例如 JSON 中的 KEY 是 **Name**，那么怎么找对应的字段呢？

- 首先查找 tag 含有 Name 的可导出的 struct 字段(首字母大写)
- 其次查找字段名是 Name 的导出字段
- 最后查找类似 NAME 或者 NAmE 等这样的除了首字母之外其他大小写不敏感的导出字段

<i class="fa fa-exclamation-triangle" aria-hidden="true"></i> **能够被赋值的字段必须是可导出字段！！**
> 同时 JSON 解析的时候只会解析能找得到的字段，找不到的字段会被忽略，这样的一个**好处**是：当你接收到一个很大的 JSON 数据结构而你却只想获取其中的部分数据的时候，你只需将你想要的数据对应的字段名大写，即可轻松解决这个问题。

### 未知解析类型

前面说的是，已知要解析的类型，比如说，当看到 JSON arrays 时定义一个 golang 数组进行接收数据， 看到 JSON objects 时定义一个 map 来接收数据，那么这个时候怎么办？答案是使用 interface{} 进行接收，然后配合 **type assert** 进行解析，比如：

``` go
var f interface{}
b := []byte(`{"Name":"Wednesday","Age":6,"Parents":["Gomez","Morticia"]}`)
json.Unmarshal(b, &f)
for k, v := range f.(map[string]interface{}) {
    switch vv := v.(type) {
    case string:
        fmt.Println(k, "is string", vv)
    case int:
        fmt.Println(k, "is int ", vv)
    case float64:
        fmt.Println(k, "is float64 ", vv)
    case []interface{}:
        fmt.Println(k, "is array:")
        for i, j := range vv {
            fmt.Println(i, j)
        }
    }
}
```

## Marshal
这是序列化的过程，将结构体序列化成一个 JSON 串。
<i class="fa fa-code" aria-hidden="true"></i>示例代码如下：

```go
package main

import (
    "encoding/json"
    "fmt"
)
type Animal struct {
    Name  string `json:"name"`
    Order string `json:"order"`
}
func main() {
    var animals []Animal
    animals = append(animals, Animal{Name: "Platypus", Order: "Monotremata"})
    animals = append(animals, Animal{Name: "Quoll", Order: "Dasyuromorphia"})

    jsonStr, err := json.Marshal(animals)
    if err != nil {
        fmt.Println("error:", err)
    }

    fmt.Println(string(jsonStr))
}
```
运行后，输出结果：

`[{"name":"Platypus","order":"Monotremata"},{"name":"Quoll","order":"Dasyuromorphia"}]`

可以发现，序列化得到的 json 串的 key 名字跟结构体 json tag 后指定的名字一样.
当结构体字段后无 json tag 时，得到的 json 串的 key 名与字段名一致。
**json tag** 有很多值可以取，同时有着不同的含义，比如：

- tag 是 "-"，表示该字段不会输出到 JSON.
- tag 中带有自定义名称，那么这个自定义名称会出现在 JSON 的字段名中，比如上面小写字母开头的 `name`.
- tag 中带有 **"omitempty"** 选项，那么如果该字段值为空，就不会输出到JSON 串中.
- 如果字段类型是 bool, string, int, int64 等，而 tag 中带有**",string"** 选项，那么该字段在输出到 JSON 时，会把该字段对应的值转换成 JSON 字符串.

## 推荐的 json 解析库
> jsoniter（json-iterator）是一款快且灵活的 JSON 解析器，同时提供 Java 和 Go 两个版本。从 dsljson 和 jsonparser 借鉴了大量代码。
>
jsoniter 的 Golang 版本可以比标准库（encoding/json）快 6 倍之多,而且这个性能是在不使用代码生成的前提下获得的。

可以使用 `go get github.com/json-iterator/go` 进行获取，完全兼容标准库的 `Marshal` 和 `Unmarshal`方法。
使用时导入 `github.com/json-iterator/go` 代替标准库，基本用法如下：

```go
jsoniter.Marshal(&data)
jsoniter.Unmarshal(input, &data)
```

## 参考
1. [JSON处理](https://github.com/astaxie/build-web-application-with-golang/blob/master/zh/07.2.md)
2. [json iterator](http://jsoniter.com/index.cn.html)
