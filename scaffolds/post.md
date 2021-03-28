---
title: {{ title }}
tags: [Hexo, Fluid] # 文章标签
categories: quick-start
index_img: /img/example.jpg # 缩略图
banner_img: /img/post_banner.jpg # 顶图，默认显示主题配置中的 post.banner_img
date: {{ date }}
hide: false # 文章是否被隐藏
---

这里是摘要
<!-- more -->
这里是正文


-----------------------------
**注脚的使用**：
```
这是一句话[^1]

[^1]: 这是对应的脚注
```

**便签的使用**：
```
{% note success %}
文字 或者 `markdown` 均可
{% endnote %}

使用时 {% note primary %} 和 {% endnote %} 需单独一行，否则会出现问题
```
可用等级有 primary/secondary/success/danger/warning/info/light

**行内标签的使用**：

在 markdown 中加入如下的代码来使用 Label：
```
{% label primary @text %}
若使用 {% label primary @text %}，text 不能以 @ 开头
```
可选 Label：primary/default/info/success/warning/danger