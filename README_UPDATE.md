# WriteLab — 1.1 更新包

这是 **增量更新包**，适用于 GitHub 仓库 `Kimchenxu/english-writing-lab` 当前的静态网页结构。

## 替换哪些文件

只需将压缩包内的 `assets/app.js` 与 `assets/style.css` 覆盖到仓库相同路径，然后 `git add assets/app.js assets/style.css && git commit -m "Add annotated rewrites and delayed collocation reveal" && git push`。

**没有改动** `index.html`、`lessons/index.json`、`lessons/day01/lesson.json`、其他课程 JSON，避免影响已有课程结构。

## 新功能

- **原文保留 + 批注副本**：交卷后，初稿固定保留。在下方批注区选中文字并点击「划掉选中文字」，即可加删除线；在旁边输入框填入修改表达，点击「插入红色（改法）」，就会插入红色括号，例如 `(accurately)`。批注自动保存。
- **两轮写作**：每道主观题交卷后可切换 `1/2 · 初稿与改错` 和 `2/2 · 重新写作`。第二遍独立保存、不会覆盖第一遍原文；切换回来后还能继续批注。
- **交卷后解锁搭配**：Language Kit 和今日目标中的具体搭配在交卷前不会出现在侧边栏，交卷后可查看。
- **备份与恢复**：计时栏旁新增「↓ 备份」「↑ 恢复」。导出的 JSON 包含当前浏览器保存的全部 WriteLab v1 学习记录；导入时提示可能覆盖同一天的数据。
- **复制教练批改请求**：继续保留原来的 `MY ANSWER (1/2)`，已存在的批注、二次作答作为补充加入复制文本。

## Day 01 进度是否安全？

这次更新 **继续使用原 localStorage 键 `writelab.progress.v1.day01`**，以及原有 `answers`、`assessments`、`submitted`、`rubric`、`time` 字段。只额外保存 `annotations`、`revisions`、`attemptViews`，读取旧记录时缺失字段自动补空对象。即使 Day 01 已交卷，也可以继续使用批注和 2/2 重写。

**重要：** localStorage 属于浏览器和网站域名，不是 Git 仓库文件。如果此前你是在同一浏览器、同一 GitHub Pages 网址答题，覆盖 JS/CSS 后旧记录会照常显示；若换浏览器、设备、不同域名（例如 Live Server → GitHub Pages），需要通过备份/恢复转移数据。请勿清除浏览器站点数据，也不要点击「清空这一天」。

建议部署更新后先进入 Day 01 检查原文和评分，再点击「↓ 备份」下载一次备份。数据保留在本地，不会被网站自动上传。

## 关于评分

本网站选择题自动检查、主观题自行核对。**批注和第二遍均不表示 AI 自动评分**。
