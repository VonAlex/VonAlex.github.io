---
title: python标准库之 pickle 模块
tags:
  - python
categories: quick-start
index_img: https://gitee.com/happencc/pics/raw/master/images/python.jpg
abbrlink: 9cd13682
date: 2016-07-17 17:25:37
---

对象存在于程序运行时的内存中，当程序不再运行时或断电关机时，这些对象便不再存在。我现在想把对象保存下来，方便以后使用，这就是持久化技术。
<!-- more -->
利用 python标准库中的的pickle模块可以将对象转换为一种可以传输或存储的格式。
> 如果希望透明地存储 python 对象，而不丢失其身份和类型等信息，则需要某种形式的对象序列化：它是一个将任意复杂的对象转成对象的文本或二进制表示的过程。


## 主要方法
pickle模块中有两个主要函数，它们是`dump()`和`load()`。

### dump()方法
该方法的作用是实现python 对象的序列化，将 obj 保存到 file 中。
具体语法如下：

```python
pickle.dump(obj, file[, protocol])
```
**obj**：要持久化保存的对象；
**file**： 将对象序列化后保存到的类文件对象。
它必须有一个可以接受单字符串作为入参的write() 方法。这个对象可以是一个以写模式打开的文件对象或者一个 StringIO 对象，或者其他任意满足条件的接口；
**protocol**: 可选的参数，默认为 0。0表示所序列化的对象使用可打印的ASCII码表示；1或True 表示使用老式的二进制协议；2表示使用python2.3版本引入的新二进制协议，比以前的高效；负值表示将使用可用的最高协议版本。
如果 **protocol>=1**，那么文件对象需要以二进制形式打开。
### dumps()
具体语法为：

```python
pickle.dumps(obj[, protocol])
```
返回一个字符串，而不是存入文件中。

### load()
该方法用于反序列化，即将序列化的对象重新恢复成python对象。
具体语法如下：

```python
pickle.load(file)
```
这个 file 必须是一个拥有一个能接收单整数为参数的 `read()` 方法以及一个不接收任何参数的 `readline() `方法，并且这两个方法的返回值都应该是字符串。这可以是一个打开为读的文件对象、StringIO 对象或其他任何满足条件的对象。

### loads()
```python
pickle.loads(string)
```
从字符串中恢复对象。

### Pickler()
```python
class pickle.Pickler(file[, protocol])
```
可以使用该对象调用dunmp 和 load 等方法。

### clear_memo()
对于相同的对象，如果不使用clear_memo()方法，那么python只会pickle一次
## cPickle 模块
> cPickle 是 pickle的优化版， cPickle是 C 编写的因此它可以比pickle快 1000倍。但是它不支持使用子类化的Pickler()和Unpickler()类，因为在cPickle中，这些都是不是类的功能。大多数应用程序不需要此功能，并可以受益于cPickle的改进性能。除此之外，这两个模块的接口是几乎完全相同。

## 用例

```python
In [2]: try:
   ...:     import cPickle as pickle
   ...: except:
   ...:     import pickle
   ...:

In [3]: info = [1, 2, 3, 'hello']
In [4]: data1 = pickle.dumps(info)
In [5]: print data1
(lp1
I1
aI2
aI3
aS'hello'
p2
a.

In [6]: data2 = pickle.loads(data1)
In [7]: print data2
[1, 2, 3, 'hello']

In [8]: type(data1)
Out[8]: str
```
