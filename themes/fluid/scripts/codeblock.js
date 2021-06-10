var attributes = [
    'autocomplete="off"',
    'autocorrect="off"',
    'autocapitalize="off"',
    'spellcheck="false"',
    'contenteditable="true"'
]
var attributesStr = attributes.join(' ')
hexo.extend.filter.register('after_post_render', function (data) {   //在渲染 HTML 之后执行操作
  //查找页面里所有的符合条件的 pre 标签
  let x =/<pre><code(?: class="([a-zA-Z]*?)")?>.*?<\/code><\/pre>/s  
    while (x.test(data.content)) {
        data.content = data.content.replace(x, function () {
          var language = RegExp.$1 || 'plain'      //如果没有 class 属性则默认为 plain
          var lastMatch = RegExp.lastMatch
          //将替换过的标签加入 n 属性做标记，防止重复替换
          lastMatch = lastMatch.replace(/<pre><code/, '<pre n><code')
          //用 div 标签把 pre 包裹起来，并在 div 上应用上面写的 CSS 样式 
          return '<div class="highlight-wrap"' + attributesStr + 'data-rel="' + language.toUpperCase() + '">' + lastMatch + '</div>'
        })
      }
    return data
})