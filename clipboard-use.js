!function(){var n=window.onload;window.onload=function(){var o;o="",o+='<button class="copy-btn" data-clipboard-snippet="">',o+='<i class="far fa-copy"></i><span>Copy</span>',o+="</button>",$("pre.prettyprint").wrap($('<div class="code-block"></div>')),$(".code-block").prepend(o),new ClipboardJS(".copy-btn",{target:function(n){return n.nextElementSibling}}).on("success",function(n){n.trigger.innerHTML="Success",setTimeout(function(){n.trigger.outerHTML=o},2e3)}),n&&n()}}((window,document));