---
title: hexo + gitpages 搭建博客
tags:
  - hexo
categories: tools
index_img: https://gitee.com/happencc/pics/raw/master/images/hexo.jpg
abbrlink: '5e988508'
date: 2016-04-03 00:04:49
---

本篇文章主要记录用 hexo 搭建博客，并部署在github上的大概过程。

<!--more-->

## 搭建博客并部署
### 安装 node.js
[安装node.js](https://nodejs.org/en/)
默认 npm 源可能比较慢，建议换一下，参考这个 [淘宝 NPM 镜像](https://npm.taobao.org/)。
### 安装 git
[安装git](https://git-scm.com/download/)
进行简要的配置，详细信息参照[廖雪峰git教程](http://www.liaoxuefeng.com/wiki/0013739516305929606dd18361248578c67b8067c8c017b000)

### 创建 github repo，并关联本地库
repo 名为 `github账号名.github.io`，如 `AlexVon.github.io`


### 安装 hexo
使用 npm 安装 hexo

```shell
# 如果没有按照上面换淘宝的 npm 的话，使用 npm 命令，而不是 cnpm
cnpm install hexo --save
```

### 初始化 hexo 文件夹
在 git 本地库中
```othe
	hexo init
	npm install
	#新建完成后，指定文件夹的目录如下
	.
	├── _config.yml  #全局配置文件
	├── package.json
	├── scaffolds   # 模版文件,新建文章时会根据 scaffold里对应md生成文件
	├── scripts
    ├── public      # hexo g 后产生的文件夹，后面部署时上传的也是这个文件夹
	├── source
	|      └── _posts # 发布的文章
	└── themes  #主题文件
```
### 安装 hexo插件

```shell
# 在部署的时候使用
npm install hexo-deployer-git --save
```

### 查看效果
```shell
hexo g # 生成public静态文件
hexo s # 开启服务器
```
如果没有错误，可以在本地打开浏览器，打开网址 *http://localhost:4000/*

### 部署到github
在根目录下使用 `hexo d` 命令进行部署，不过在第一次部署之前，需要在
<span id="inline-blue">站点配置文件</span> 配置 `deploy` 项：

```yml
deploy:
  type: git
  repo: <repository url>
  branch: [branch]
  message: [message]
```
若没有发生错误，就可以正常访问 [http://vonalex.github.io/](http://vonalex.github.io/) 了。
部署后，会在根目录多出一个名为 `.deploy_git` 的文件夹。

每次都用`hexo cl`/`hexo g`/`hexo d`等命令会比较繁琐，可以在博客根目录下找到 `package.json` 文件，添加以下代码后，只需要运行 `npm run deploy`即可！

```json
  "scripts": {
    "deploy": "hexo clean && hexo g && hexo d",
    "test": "hexo clean && hexo g  && hexo s",
    "dev": "hexo clean && hexo g"
  }
```



## 主题配置
本教程采用的是 **next** 主题，这个主题的优化配置比较好找。
### 下载主题

```shell
git clone https://github.com/iissnan/hexo-theme-next themes/next
```
这时在 `themes` 文件夹下就多出了一个 `next` 的主题文件夹。
### 配置

#### 添加分类页面

```shell
hexo new page categories
```
这时候，根目录下 `source` 文件夹下多出来一个 `categories` 文件夹，修改该文件下的`index.md` 文件如下：
```oth
---
title: categories
date: 2016-04-02 21:38:55
type: "categories"
---
```
#### 添加标签页面

```shell
hexo new page tags
```
修改 `source\tags\index.md` 文件如下：
```oth
---
title: tags
date: 2016-04-02 21:40:22
type: "tags"
---
```
同理可以使用 `hexo new page 页面名` 来添加其他的页面，然后在主题配置文件中加上图标对应关系，若使用的是中文主题，那还要在主题文件夹下的 `language` 文件下的中文文件中进行设置，不然会出现英文。
menu 的`根目录/`是 `source` 文件夹。


### 导航栏新加页面
大体方法跟上面添加 tags 类似，这里举一个具体的栗子，因为有一些在线文档需要经常查看，所以我要增加一个在线文档的页面：
【1】 `hexo new page docs`，docs 为新页面名，这时会出现 `source/docs/index.md` 这个文件。因为这个页面不需要评论，所以添加一行代码 `comments: false`。
【2】 <span id="inline-purple"> 主题配置文件 </span>，在 menu 这个项目中添加 `docs: /docs`，就是让导航栏能够找到这个页面。然后为新加的页面增加一个想要的图标，大概这样 `docs: /docs || envira`。
【3】 **themes/next/languages/zh-Hans.yml** 中找到 menu 这个项，配置要让新的页面显示什么中文名字，如 ` docs: 在线文档`

#### 添加 fork me on github
 [github官方教程](https://github.com/blog/273-github-ribbons)，把代码插入到任意一个全局的模板文件中就行，比如`_layout.swig`的末尾。

#### 添加音乐链接
在网易云音乐网页版上找到自己喜欢的音乐或者歌单，点开到播放界面，生成外链播放器，可以将生成的插件代码放入html文件中或md文件中。
<img src="https://s1.ax1x.com/2018/10/28/icworR.md.jpg" alt="icworR.jpg" border="0" />

### 其他
#### 图标问题
next主题的图标采用的是[fontawesome](http://www.fontawesome.com.cn/faicons/)免费图标，比如在页面中加入这条语句就可以引用 github-alt 这个图标。
`<i class="fa fa-github-alt"></i>`，效果如下 <i class="fa fa-github-alt"></i>
还可以用 `<i class="fa fa-github-alt fa-2x"></i>` 来增大图标，效果如下 <i class="fa fa-github-alt fa-2x"></i>，以此类推！

#### 修改内容区域的宽度
NexT 对于内容的宽度的设定如下：
- 700px，当屏幕宽度 < 1600px
- 900px，当屏幕宽度 >= 1600px
- 移动设备下，宽度自适应

果你需要修改内容的宽度，同样需要编辑样式文件，在 Mist 和 Muse 风格可以用下面的方法：
编辑主题的 `source/css/_variables/custom.styl` 文件，新增变量：
```css
// 修改成你期望的宽度
$content-desktop = 700px

// 当视窗超过 1600px 后的宽度
$content-desktop-large = 900px
```
当你使用Pisces风格时可以用下面的方法：
```css
header{ width: 90%; }
.container .main-inner { width: 90%; }
.content-wrap { width: calc(100% - 260px); }
```
#### 代码主题
我比较喜欢的是 MacPanel代码样式，像本博客中的这样。
关于如何设置，可以参考这篇博客[Hexo博客NexT主题代码高亮MacPanel特效配置](https://blog.shadowy.me/2018/03/16/hexo-next-macpanel-improved/)

#### md文件中插图问题

##### 插图方法
1. 可以用 md 中的语法`![]()`，图片大小不可控。
2. 使用 `<img>` 标签，因为 html 的标签可以无缝使用。

##### 图片位置
1. 可以单独建立一个文件夹，专门存放图片。比如 hexo 下，可以在 `source` 文件夹下新建 `images` 文件夹，用于存放图片。一旦你决定长期写下去，这样并不好！
2. 使用图床，有一些免费图床, 可以搜索到，还可以使用七牛、又拍等的云存储服务。我使用的是这款[路过图床](https://imgchr.com/)

#### 设置网站图标
默认的网站图标是一个 N 的字样，下载喜欢的 png 图片，放在 `themes/next/source/images/` 文件夹下，在 <span id="inline-purple">主题配置文件</span>的`favicon`项进行配置，如：

```
favicon:
  medium: /images/dolphin.png
```

#### URL持久化
hexo 默认生成的文章地址路径是`网站名称/年/月/日/文章名称`.这种链接对搜索爬虫是很不友好的,所以这里修改一下。

```
# 安装插件
$ npm install hexo-abbrlink --save
```
在<span id="inline-blue">站点配置文件</span>中添加如下配置：

```
# permalink: :title/
permalink: :abbrlink.html
abbrlink:
  alg: crc32  # 算法：crc16(default) and crc32
  rep: hex    # 进制：dec(default) and hex
```

html前缀为：对标题+时间进行md5然后再转base64

上面很多配置在新本中已经内置，因此有的可能已经过期！详情想参考http://theme-next.iissnan.com/


### 参考链接
1. [个性化你的Hexo-笔记](http://codingbubble.github.io/2015/05/08/custom-your-Hexo/)
2. [通过Hexo在GitHub搭站全记录](http://blog.csdn.net/anonymalias/article/details/50528946)
3. [next官方使用文档](http://theme-next.iissnan.com/)
4. [動動手指，NexT主題與Hexo更搭哦（基礎篇）](http://www.arao.me/2015/hexo-next-theme-optimize-base/)
5. [hexo常用命令笔记](https://segmentfault.com/a/1190000002632530)
6. [玩转Hexo博客之Next](http://jijiaxin89.com/2015/08/21/%E7%8E%A9%E8%BD%AChexo%E5%8D%9A%E5%AE%A2%E4%B9%8Bnext/)
7. [多说评论框css样式表自定义](http://www.mmuuii360.com/duoshuo-css.html)
8. [Hexo搭建GitHub博客（三）- NexT主题配置使用](http://zhiho.github.io/2015/09/29/hexo-next/)
9. [hexo优化--向Google提交sitemap](http://ppting.me/2015/01/25/sitemap/)
10. [hexo你的博客](http://ibruce.info/2013/11/22/hexo-your-blog/)
11. [hexo的next主题个性化教程:打造炫酷网站](http://shenzekun.cn/hexo%E7%9A%84next%E4%B8%BB%E9%A2%98%E4%B8%AA%E6%80%A7%E5%8C%96%E9%85%8D%E7%BD%AE%E6%95%99%E7%A8%8B.html)
12. [打造个性超赞博客Hexo+NexT+GithubPages的超深度优化](https://reuixiy.github.io/technology/computer/computer-aided-art/2017/06/09/hexo-next-optimization.html#%E9%99%84%E4%B8%8A%E6%88%91%E7%9A%84-custom-styl)
13. [HEXO建站备忘录](https://www.vincentqin.tech/2016/08/09/build-a-website-using-hexo/#%E5%A2%9E%E5%8A%A0Gitter)
14. [hexo定制&优化](https://www.jianshu.com/p/3884e5cb63e5)
15. [解决 Local gulp not found in](https://blog.csdn.net/human8848/article/details/51479920)

--------------

### <i class="fa fa-exclamation-triangle"></i>附录
#### 常用的 hexo 命令
**注意：**这些命令要在根目录下使用

```
npm install hexo -g #安装
npm update hexo -g #升级
hexo init # 初始化
hexo cl == hexo clean 清理之前生成的public文件夹
hexo new page 页面名 #新建页面
# 新建文章（文章名不用加引号），在站点下source\_posts下生成"文章名.md"
hexo n  文章名 == hexo new 文章名
hexo g == hexo g # 生成要发布博客的所有静态资源
hexo s == hexo server #  开启本地服务器可以进行预览
hexo d  == hexo deploy # 部署
hexo deploy -g # 生成并部署
hexo server -g # 生成并预览
hexo server -p 5000 #更改端口
hexo server -i 192.168.1.1 #自定义 IP
```
#### 安装的插件

```
hexo-wordcount  //统计字数
hexo-deployer-git //部署使用
hexo-abbrlink //持久化连接
hexo-generator-baidu-sitemap //百度sitemap
hexo-generator-sitemap //google sitemap
gulp // 静态资源压缩有关
gulp-minify-css
gulp-htmlmin
gulp-htmlclean
gulp-uglify
```
