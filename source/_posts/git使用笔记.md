---
title: git 使用笔记
tags:
  - git
categories: tools
index_img: 'https://gitee.com/happencc/pics/raw/master/images/git.jpg'
abbrlink: a722b34f
date: 2020-09-12 02:43:04
---

本文档主要记录 git 日常高频使用命令。
<!-- more -->

本地仓库由 git 维护的三棵“树”组成。
第一个是**工作目录**，它持有实际文件；
第二个是**暂存区（Index）**，它像个缓存区域，临时保存改动；
最后是 **HEAD**，它指向你最后一次提交的结果。
如下图所示，

![](https://gitee.com/happencc/pics/raw/master/images/git-flow.png)

## 新建
1. `git init`，创建一个新的本地仓库。
2. `git clone -b <远端分支名> <url> <local-name>`，从远端 url 拉取仓库拉取制定分支到本地 local-name 文件夹下，如果不加远端分支名，则为默认分支 master。

## 提交
1. `git add <file1> <file2> ...` 将 working dir 相应文件的更改提交到 index 中。
2. `git add .` 提交所有文件的更改。
3. `git commit -m 'cmmit xx'` 将 index 中的内容提交到本地仓库，HEAD 指向最新提交。
4. `git commit -a -m 'commit xx'` 将 working dir 所有更改一次性提交到本地仓库。
5. `git commmit` 作用同 3，但是会弹出窗口，支持更长的 commit 信息。
6. `git push <上游> <上游分支>` 代码提交到远端库。

## commit 信息变更
1. `git commit --amend` 进入编辑器，修改上一次的 commit 信息。
2. `git rebase -i <commitid>` 合并 commit。

举例说明，使用 `git log` 查看，有以下 4 个 commit，

```shell
commit C4
Date:   Sun Jun 21 17:25:56 2020 +0800
    add line11

commit C3
Date:   Sun Jun 21 17:24:33 2020 +0800
    add line10

commit C2
Date:   Sun Jun 21 11:49:06 2020 +0800
    add line1
    commbine 1

commit C1
Date:   Sun Jun 21 11:45:06 2020 +0800
    add newfile
```
现在，我想要将 C2 和 C3 合并，那么找到最早的 commit C2 的上一个 C1(或者使用 `C2^`)，执行 `git rebase -i C1`，会出现合并 commit 选择的页面，大概如下，

``` shell
pick C2 add line1
pick C3 add line10
pick C4 add line11

# Commands:
# p, pick = use commit
# r, reword = use commit, but edit the commit message
# e, edit = use commit, but stop for amending
# s, squash = use commit, but meld into previous commit
# f, fixup = like "squash", but discard this commit's log message
# x, exec = run command (the rest of the line) using shell
# d, drop = remove commit
```
根据命令说明，将要合并的 commit 前面的命令改成 `f` 或者 `s`, 两者的区别的是 `f` 在编辑合并后 commit的信息时只会出现最后一条，而 `s` 都会保存，**建议使用** `s` 。要合并 C2 和 C3 的话，那么选择时间早的 C2，所以把 C3 前的 `pick` 改为 `s`，保存。

接着会出现编辑页，编辑合并后 commit 的提交信息，改好以后再次保存就可。

<p class="note note-warning">要合并的 C2 和 C3 是连续的 commit。</p>

## 撤销
1. `git checkout -- <file>` 撤销一个工作区文件（必须是已经被 track 的文件）的修改。`<file>` 参数为 `.` 时表示撤销所有修改。
2. `git rm --cached <file>` 从 index 中删除一个文件，使之变为 **Untracked files** 状态。
3. `git reset HEAD <file>` 从 index 中撤销一个更改。
4.  `git reset --soft <commitid>` 从本地仓库 HEAD 回滚到 index 区（未 commit 的状态）。
5.  `git reset --mixed <commitid>` 从本地仓库 HEAD 回滚到工作区（未 add 的状态）。
6.  `git reset --hard <commitid>` 从本地仓库 HEAD 做版本回退（工作区未更改，已提交）。
7. `git revert --no-commit <commit1>..<commit2> `  撤销指定 cimmit 的代码提交。
    撤销从 commit1 到 commit2 的提交，区间前开后闭区间。`--no-commit`  表示可以最后一起手动 git commit 提交。
    **revert** 其实是将要取消的提交记录按照相反的操作将他们抵消掉，然后重新生成一个提交记录，这样在提交记录的完整性上更好，不同于 **reset** 的直接抹掉。
    **有冲突时需要手动修复**，add 后再次 continue。

8. `git merge --abort` 抛弃合并过程并且尝试重建合并前的状态。**该命令仅仅在合并后导致冲突时才使用**。

## 分支管理
1.  `git checkout -b <banch name> <base branch>` 基于 base 分支创建一个新分支，并切到新分支。**base 分支为空时**，表示为当前分支，**base 分支如果为远端分支**，则要加上游分支名字，如 `origin/dev`。
2. `git checkout <branch name>` 切到某分支。
3. `git branch -a` 查看所有分支。

## 代码 diff
1. `git diff <commit1> <commit2> <filename>`  比较 file 在两个版本之前的差异。
   如果不加 filename，那么比较所有文件的差异，
   如果只有一个 commitid，表示指定 commitid 与当前版本的差异。
   如果没有 commitid，只有 filename，比较某个文件与 HEAD 中的差异。
   如果后面什么参数也没有，表示与 HEAD 的所有差异。

2. `git diff --staged/--cached` 比较暂存区/工作区与上一次提交的差异。

## 删除文件/分支
1. `git branch -d <branch name>` 删除本地分支。
2. `git push origin --delete <branch name>` 删除远端分支。
3. `git rm --cached <file>` 并进行提交，完成本地文件在远端的删除。

## 代码合并
1. `git merge <feature> <master>` 在 feature 上合并 master(这可能出现冲突，需要自行解决)，
   如果参数只有一个 branch，则表示与当前分支合并。
  ![](https://gitee.com/happencc/pics/raw/master/images/git-merge.jpg)

   feature 分支每次需要合并上游更改时，它都将产生一个额外的合并提交。如果master 提交非常活跃，这可能会**严重污染你的 feature 分支历史记录**。
2. `git rebase -i <branch name>` 交互式合并指定分支。
![](https://gitee.com/happencc/pics/raw/master/images/git-rebase.jpg)

rebase 通过为原始分支中的每个提交创建全新的 commits 来 重写 项目历史记录。

rebase 的主要好处是可以获得更清晰的项目历史。
**在提交拉取请求之前，通常使用交互式 rebase 清理代码通常是个好的办法，但是在别人使用的分支（公共分支）上进行 rebase，重写其历史记录将使 Git 和你的队友无法跟踪添加到该功能的任何后续提交，也会在别人拉取代码时产生冲突**。

在你运行 `git rebase` 命令之前，总是问自己，还有其他人在用这个分支吗？ 如果答案是肯定的，那就把你的手从键盘上移开，开始考虑采用非破坏性的方式进行改变（例如，`git merge` 命令）。否则，你可以随心所欲地重写历史记录。

3. `git cherry-pick <commitid1>..<commitid2>`   从 commitid1（不包括）到 commitid2 的更改，应用到本分支，如果要包含 commitid1，则使用 `commitid1^`

### 好的实践
**永远不要在公共分支上使用** `git rebase`。
在私人分支，rebase 修改个人本次功能的 commit，通过定期执行交互式 rebase，你可以确保功能中的每个提交都具有针对性和意义。然后 merge 到主分支上。

更多参考 《[git rebase VS git merge？ 更优雅的 git 合并方式值得拥有](https://juejin.im/post/5d2d24245188250501477cc4)》

## 代码拉取
`git pull <上游> <上游分支>` 从上游拉取指定分支。

如果上游分支与本地分支存在交叉，就会出现 **Merge branch 'xx' of xx into xxx** 的自动 commit，所以**最好在使用 `git pull` 命令时，后面加上 `--rebase` 选项**。
如果拉取不产生冲突，会直接 rebase，不会产生分支合并操作，如果有冲突则需要手动 fix 后，自行合并。

<p class="note note-warning">以上所有使用 commitid 的地方，也都可以使用 HEAD/ HEAD^/HEAD~3 这种方式。</p>

```