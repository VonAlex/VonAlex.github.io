---
title: 'sublime text3 配置[ python 篇]'
tags:
  - sublime
categories: tools
index_img: /images/sublime.jpg
abbrlink: f49a9b8a
date: 2016-05-12 23:24:10
---
古语有云，工欲善其事必先利其器。选择一个好的工具，往往能达到意想不到的效果。因为个人电脑原因，用 pycharm 太卡，所以想起了 sublime text，配置了一下，觉得挺好用。
<!-- more -->
## 下载
下载 [Sublime Text3 Build 3080 x64](http://pan.baidu.com/s/1qYoZ5Pa)，文件中有 **License**，输入一个即可破解。
当然了，还是希望支持**正版**。

## 配置
我的用户配置文件如下：

```othe
{
    "auto_complete_commit_on_tab": true,
    "bold_folder_labels": true, //侧边栏文件夹加粗
"color_scheme": "Packages/Tomorrow Color Schemes/Tomorrow-Night.tmTheme",
    "draw_minimap_border": false, // 右侧缩略图边框
    "ensure_newline_at_eof_on_save": true, //文件末尾自动保留一个空行
    "fade_fold_buttons": false, //显示代码块的倒三角
    "line_numbers": true, // 是否显示行号，默认显示
    // 哪些文件不要被显示到侧边栏
    "file_exclude_patterns":
    [
        ".DS_Store",
        "*.pid",
        "*.pyc"
    ],
    // 哪些文件夹不要被显示到侧边栏
    "folder_exclude_patterns":
    [
        ".git",
        "__pycache__",
        ".idea",
    ],
    "font_size": 11,
    // 删除想要忽略的插件，需要重启, 去掉Vinage开启vim模式
    "ignored_packages":
    [
        "Vintage"
    ],
    "line_padding_bottom": 3, // 设置行间距
    "line_padding_top": 3,
    "save_on_focus_lost": true, // 当前行标亮
    "spell_check": false, // 不进行拼写检查
    "tab_size": 4,  // 1个tab=4个空格
    "translate_tabs_to_spaces": true, // 缩进和遇到Tab键时是否使用空格替代
    // 保存文件时是否删除每行结束后多余的空格
    "trim_trailing_white_space_on_save": false,
    "update_check": false,  // // 禁止检查更新
   "default_encoding": "UTF-8", // 默认编码格式
   "match_selection": true, // 全文突出显示和当前选中字符相同的字符,默认为true
}

```
## 常用快捷键
所有的快捷键都可以在 `Preferences -> Key Bindings - Default` 这里找到，或者打开命令面板，输入 `Key Bindings`。

```othe
Ctrl + shift + n 新建窗口
ctrl + shift + w 关闭窗口
Ctrl + n 新建文件
Ctrl + w 关闭当前文件

ctrl + tab 在两个标签之间跳转
ctrl +　j 在某行末尾敲该快捷键，会将下一行合并上来
ctrl + shift + d 将当前行复制到下一行
ctrl + shift + up/down 上下交换行
ctrl + ]/[  当前行缩进一个级别/取消缩进
ctrl + l 选择当前行
Ctrl+Shift+l 先选中多行，再按下快捷键，会在每行行尾插入光标，即可同时编辑这些行。
ctrl + d 选中一个后，按此快捷键可以同时选中另一个，同时多了另一个光标
ctrl +　enter 在下面新开一行
ctrl +　shift + enter 在上面新开一行

Ctrl+Shift+K 删除整行。
Ctrl+Shift+[ 选中代码，按下快捷键，折叠代码。
Ctrl+Shift+] 选中代码，按下快捷键，展开代码。
Ctrl+K+0 展开所有折叠代码。
Ctrl+← 向左单位性地移动光标，快速移动光标。
Ctrl+→ 向右单位性地移动光标，快速移动光标。
shift+↑ 向上选中多行。
shift+↓ 向下选中多行。
Shift+← 向左选中文本。
Shift+→ 向右选中文本。

Alt+Shift+1~4 窗口左右分1-4屏，恢复默认1屏（非小键盘的数字）
Alt+Shift+5 等分4屏
Alt+Shift+8 垂直分屏-2屏
Alt+Shift+9 垂直分屏-3屏

Ctrl + g，输入行号，可以快速跳转到该行。
Ctrl+K+B 开启/关闭侧边栏。

Ctrl + \  打开控制行
Ctrl + Shift + P 打开命令面板
```
## 常用插件
### Package Control
进行包管理的必装插件，[安装方式看这里](https://packagecontrol.io/installation#st3)
### SublimeTmpl
提供了常用文件的模板，新建文件时很有用。也可以自动定制，模版文件位置在 `\Packages\SublimeTmpl\templates\*.tmpl`,模版文件中的 `author`，`Date` 等字段的默认值在 `Setting-Default `中，可以在 `Setting-User` 中进行重写覆盖。
### Code Snippets
补全代码片段，可以[自定义代码片段](http://9iphp.com/web/html/sublime-text-code-snippets.html),或者直接安装代码片段。
### SublimeCodeIntel
智能提示插件，这个插件的智能提示功能非常强大，可以自定义提示的内容库，我的Python智能提示设置,
**注意**：我的python安装径为` D:/Python27/python.exe`，请视情况自行调整
在该插件的配置文件中添加如下内容（大括号内）：

```othe
"Python": {
        "python":"D:/Python27/python.exe",
        "pythonExtraPaths":
            [
                "D:/Python27",
                 "D:/Python27/DLLs",
                 "D:/Python27/Lib",
                 "D:/Python27/Lib/lib-tk",
                 "D:/Python27/Lib/site-packages"
            ]
        }
```
### Anaconda
可以提示模块的类和方法，简单设置如下：

```othe
{
    "python_interpreter": "D:/Python27/python.exe",
    "complete_parameters": true,  // 补齐方法参数
    "suppress_word_completions": true,
    "suppress_explicit_completions": true,
    "pep8_ignore":
    [
        "E501"
    ],  // 忽略每行长度的限定，默认是79个字符
}
```
本插件默认支持 pep8 格式化，可以在默认配置文件中查看。
新建一个配置文件 `Python.sublime-settings`，并把它存放在包安装路径,即 User 目录下，文件内容如下：

```othe
{
    "auto_complete_triggers":
    [{"selector": "source.python - string - comment - constant.numeric", "characters": "."}]
}
```
### autoPep8
格式化Python代码
`ctrl+shift+8` 进行 pep8 格式化，`ctrl+8` 进行预览
配置一下：

```othe
{
    "ignore": "E501",
    "format_on_save": true,// 保存时就自动格式化
}
```
### SublimeREPL
提供Sublime可以执行许多脚本语言的直译器环境
以 python 为例进行配置，（在自定义配置文件中进行配置）

```otghe
｛
    "default_extend_env": {"PATH": "{PATH};D:/Python27"}
｝
```
`D:/Python27` 为本地安装的 python 的路径，打开控制面板，选择 `SublimeREPL:Python`，就可以打开 python 的命令行，
选择 `SublimeREPL:Python-RUN current file` 就可以运行本文件，还可以使用 pdb 调试程序，
**小问题：**关于 ipython 没有配置好找了网上的方法也有点问题，先不管了，不影响其他使用。

### BracketHighlighter
BracketHighlighter 插件能为 Sublime Text 提供括号，引号这类高亮功能。
将默认配置文件复制到自定义配置文件中，然后配置，找到 "bracket_styles" 这一项，
style 类型有 outline， underline， highlight 和 solid 四种，对应关系是这样的，

```other
{} － curly
() － round
[] － square
<> － angle
“” ” － quote
```
### SublimeGit
`ctrl+shift+p` 输入 `git` 可以查看到所有的命令，当然也可以设置快捷键。
### ConvertToUTF8
GBK编码兼容。
### ColorSublime
用来安装其[官网](http://colorsublime.com/)上的所有主题。 安装此插件后，Ctrl+Shift+P，输入install theme并回车，等待片刻即缓存其官网所有主题到本地，按上下键可以即时预览效果，回车键安装。
### sidebarenhancement
侧边栏增强工具，[sublime text 3扩展插件SideBarEnhancements用法教程--使用浏览器快捷预览网页](https://segmentfault.com/a/1190000004464318)

### SyncedSidebarBg
同步侧边栏的颜色与主题一致
### [**material-theme**](https://github.com/equinusocio/material-theme)
一款扁平化主题，自认为是用过的最好的一款
## 运行
可以直接使用 **ctrl+b** 在运行，也可以是使用 REPL 中的 **RUN pythpn**

**注：** 若出现 Package Control 不能使用的情况，可以将插件下载下来以后，放在 \Data\Packages 路径下

## 参考
1. [MattDMo/ipy_repl.py](https://gist.github.com/MattDMo/6cb1dfbe8a124e1ca5af)
2. [Sublime Text3 BracketHighlighter色彩配置](http://www.dbpoo.com/sublime-text3-brackethighlighter/)
3. [Sublime Text 3 配置和使用方法](https://www.zybuluo.com/king/note/47271)
4. [ Sublime Text 3 配置分析与我的配置](http://blog.csdn.net/hexrain/article/details/13997565)
5. [Sublime Text 3使用心得](http://www.imooc.com/article/1356)
