---
title: java第三方包学习之 jsoup
tags:
  - java
categories: quick-start
index_img: https://gitee.com/happencc/pics/raw/master/images/java.jpg
abbrlink: ad4c6b9
date: 2016-08-12 23:44:34
description:
---
使用python写爬虫的人，应该都听过beautifulsoup4这个包，用来解析HTML很方便。现在介绍一个类似于beautifulsoup4的java第三方库，功能类似。jsoup 是一个解析 HTML 的第三方 java 库，它提供了一套非常方便的 API，可使用 DOM，CSS 以及类 jQuery 的操作方法来取出和操作数据。
<!--more-->
## 简介
jsoup 是一个解析 HTML 的第三方 java 库，它提供了一套非常方便的 API，可使用 DOM，CSS 以及类 jQuery 的操作方法来取出和操作数据。
**jsoup 这个包类似与 python 中流行的 HTML 解析包 Beautifulsoup4。**
jsoup 实现了 WHATWG HTML5 规范，能够与现代浏览器解析成相同的DOM。其解析器能够尽最大可能从你提供的HTML文档来创建一个干净的解析结果，无论HTML的格式是否完整。比如它可以处理：没有关闭的标签，比如：

```html
<p>Lorem <p>Ipsum parses to <p>Lorem</p> <p>Ipsum</p>
```
隐式标签，创建可靠的文档结构（html标签包含head 和 body，在head只出现恰当的元素）。
**官网地址**[在这里](https://jsoup.org/)， 对应的中文文档[在这里](http://www.open-open.com/jsoup/parsing-a-document.htm)，以及 jar 包的[下载地址](https://jsoup.org/download)。
## 一个文档的对象模型
- 文档由多个**Elements**和**TextNodes**组成 ;
- 其继承结构如下：**Document**继承**Element**继承**Node**, **TextNode**继承 **Node**.
- 一个Element包含一个子节点集合，并拥有一个父Element。他们还提供了一个唯一的子元素过滤列表。

## 获取 Document 对象
jsoup 可以从包括字符串、URL 地址以及本地文件来加载 HTML 文档，并生成 Document 对象实例。

```java
// (1)从字符串中获取
String html = "<html><head><title>First parse</title></head>"
  + "<body><p>Parsed HTML into a doc.</p></body></html>";
Document doc1 = Jsoup.parse(html);

// (2)从 URL 直接加载 HTML 文档
// get方法
Document doc2 = Jsoup.connect("http://www.163.com").get();
// post方法
Document doc = Jsoup.connect("http://example.com")
  .data("query", "Java")
  .userAgent("Mozilla")
  .cookie("auth", "token")
  .timeout(3000)
  .post();

  // (3)从文件中加载 HTML 文档
File input = new File("D:/test.html");
Document doc = Jsoup.parse(input,"UTF-8","http://www.163.com/");
```
常用到的方法如下：

```java
public static Connection connect(String url)
public static Document parse(String html, String baseUri)
public static Document parse(URL url,  int timeoutMillis) throws IOException
public static Document parse(File in,  String charsetName) throws IOException
public static Document parse(InputStream in, String charsetName,  String baseUrl)  throws IOException
```
**parse** 方法能够将输入的 HTML 解析为一个新的文档 (Document），只要解析的不是空字符串，就能返回一个结构合理的文档，其中包含(至少) 一个head和一个body元素。
上面的参数 **baseUri**的作用是，如果要解析的html中存在**相对路径**，那么就根据这个参数变成**绝对路径**, 如果不需要可以传入一个空字符串。

**注：**通过connect方法来获得 html 源码，有的时候会遇到乱码的问题，这个时候该怎么办么？方法里有一个 parse 方法，传入参数 InputStream、charsetName以及baseUrl，所有可以这样解决：

```java
String url = "http://xxxxxxx";
Document document = Jsoup.parse(new URL(url).openStream(), "GBK", url);// 以 gbk 编码为栗。
```
**Jsoup的强项是解析html，当然了，它能处理一些简单情况，遇到复杂的情形还是使用 httpClient 这个包吧，你值得拥有！**

## 解析并提取 HTML 元素
### 使用传统的操作DOM的方式
举个栗子

```java
Element content = doc.getElementById("content");
Elements links = content.getElementsByTag("a");
Elements mx = content.getElementsByClass("help");
```
**注**：doc 为 Document 对象。
还有写常用的方法，比如

```java
public Elements getElementsByAttributeValue(String key,  String value)
public Element attr(String attributeKey,  String attributeValue)
public Elements getAllElements()
// 获得孩子节点中所有的文本拼接
public String text()
// 获得节点的内部html
public String html()
```
Document 对象还有一个方法

```java
// 获取标题
public String title()
// 获得某节点的html，这个方法继承自Node类，所以Element类也有该方法
public String outerHtml()
```
### 选择器
在元素检索方面，jsoup 的选择器简直无所不能。
jsoup 选择器很多，这里仅仅举出几个栗子，

```java
Elements links = doc.select("a[href]"); // 具有href属性的a标签
Elements pngs = doc.select("img[src$=.png]");// src属性以.png结尾的img标签
Element masthead = doc.select("div.masthead").first();// class属性为masthead的div标签中的第一个
Elements resultLinks = doc.select("h3.r > a"); // class属性为r的h3标签的直接子a标签
Elements resultLinks = doc.select(img[src~=(?i)\.(png|jpe?g)])
```
Selector选择器概述

```oth
tagname: 通过标签查找元素，比如：a
ns|tag: 通过标签在命名空间查找元素，比如：可以用 fb|name 语法来查找 <fb:name> 元素
#id: 通过ID查找元素，比如：#logo
.class: 通过class名称查找元素，比如：.masthead
[attribute]: 利用属性查找元素，比如：[href]
[^attr]: 利用属性名前缀来查找元素，比如：可以用[^data-] 来查找带有HTML5 Dataset属性的元素
[attr=value]: 利用属性值来查找元素，比如：[width=500]
[attr^=value], [attr$=value], [attr*=value]: 利用匹配属性值开头、结尾或包含属性值来查找元素，比如：[href*=/path/]
[attr~=regex]: 利用属性值匹配正则表达式来查找元素，比如： img[src~=(?i)\.(png|jpe?g)]
*: 这个符号将匹配所有元素
```
Selector选择器组合使用

`el#id` 元素+ID，比如： div#logo
`el.class` 元素+class，比如： div.masthead
`el[attr]` 元素+class，比如： a[href]
`任意组合` 比如：a[href].highlight
`ancestor child` 查找某个元素下子元素，比如：可以用.body p 查找在"body"元素下的所有 p元素
`parent > child` 查找某个父元素下的直接子元素，比如：可以用div.content > p 查找 p 元素，也可以用body > * 查找body标签下所有直接子元素
`siblingA + siblingB` 查找在A元素之前第一个同级元素B，比如：div.head + div
`siblingA ~ siblingX` 查找A元素之前的同级X元素，比如：h1 ~ p
`el, el, el` 多个选择器组合，查找匹配任一选择器的唯一元素，例如：div.masthead, div.logo

伪选择器selectors

`:lt(n)` 查找哪些元素的同级索引值（它的位置在DOM树中是相对于它的父节点）小于n，比如：td:lt(3) 表示小于三列的元素
`:gt(n)`查找哪些元素的同级索引值大于n，比如： div p:gt(2)表示哪些div中有包含2个以上的p元素
`:eq(n)` 查找哪些元素的同级索引值与n相等，比如：form input:eq(1)表示包含一个input标签的Form元素
`:has(seletor)` 查找匹配选择器包含元素的元素，比如：div:has(p)表示哪些div包含了p元素
`:not(selector)` 查找与选择器不匹配的元素，比如： div:not(.logo) 表示不包含 class=logo 元素的所有 div 列表
`:contains(text)` 查找包含给定文本的元素，搜索不区分大不写，比如： p:contains(jsoup)
`:containsOwn(text)` 查找直接包含给定文本的元素
`:matches(regex)` 查找哪些元素的文本匹配指定的正则表达式，比如：div:matches((?i)login)
`:matchesOwn(regex)` 查找自身包含文本匹配指定正则表达式的元素

**注：** 上述伪选择器索引是从0开始的，也就是说第一个元素索引值为0，第二个元素index为1等。
对于 Elements 的来历，看这里

```java
public class Elements extends ArrayList<Element>
```
另外，可以查看[Selector API](https://jsoup.org/apidocs/org/jsoup/select/Selector.html)参考来了解更详细的内容
可以看出，jsoup 使用跟 jQuery 一模一样的选择器对元素进行检索，以上的检索方法如果换成是其他的 HTML 解释器，至少都需要很多行代码，而 jsoup 只需要一行代码即可完成。

## 修改获取数据

```java
 // 为所有链接增加 rel=nofollow 属性
doc.select("div.comments a").attr("rel", "nofollow");
 // 为所有链接增加 class=mylinkclass 属性
doc.select("div.comments a").addClass("mylinkclass");
// 删除所有图片的 onclick 属性
doc.select("img").removeAttr("onclick");
// 清空所有文本输入框中的文本
doc.select("input[type=text]").val("");
// 获得rel属性的值
doc.select("div.comments a").attr("rel");
```

## 参考
1. [使用 jsoup 对 HTML 文档进行解析和操作](https://www.ibm.com/developerworks/cn/java/j-lo-jsouphtml/)
2. [jsoup 1.9.2 API](https://jsoup.org/apidocs/)
