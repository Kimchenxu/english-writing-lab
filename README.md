# WriteLab · English Writing Gym

一个专门练习 **词汇主动使用、英语搭配、句子构建、句间逻辑、学术段落和自我修改** 的静态英语写作训练网站。目标用户可能已经认识很多英文单词、学过语法，但写作时难以迅速组织完整且自然的表达。

**强度：每天 60 分钟、15 道题；当前已经编写完整的 Day 01–07，总计 105 道训练题。** 周 2–4 已有学习路线，但题库未开放。每一天的题目完全独立，随时可以添加。

网站不需要 React、Node、数据库、账号或付费 API。所有学习记录保存在你**当前设备的当前浏览器**，不会自动同步；清理浏览器数据会丢失记录。

## 目录结构

```text
english-writing-lab/
├── index.html                      # 首页 / 唯一 HTML 入口
├── .nojekyll                       # GitHub Pages 静态发布标记
├── .gitignore
├── assets/
│   ├── style.css                   # 响应式设计
│   └── app.js                      # 答题、进度、计时、交卷、复制
├── lessons/
│   ├── index.json                  # 上线课程列表，增加 Day 时改这里
│   ├── day01/lesson.json           # Day 01：准确搭配与句子
│   ├── day02/lesson.json           # Day 02：信息精准的简单句
│   ├── day03/lesson.json           # Day 03：因果逻辑
│   ├── day04/lesson.json           # Day 04：转折、让步与对比
│   ├── day05/lesson.json           # Day 05：学术与技术搭配
│   ├── day06/lesson.json           # Day 06：Claim–Evidence–Reasoning
│   ├── day07/lesson.json           # Day 07：综合挑战
│   └── _template/lesson.json       # 新课程模板（默认不上线）
├── docs/
│   ├── learning-roadmap.md         # 28 天课程路线
│   └── review-method.md            # 复盘标准与错题方法
└── README.md
```

## 每天怎么练？

| 时间 | 模块 | 训练内容 |
|---:|---|---|
| 8 分钟 | Word in Action | 词组/搭配选择与主动造句 |
| 12 分钟 | Build the Sentence | 中译英与高精度句子构建 |
| 10 分钟 | Sentence Surgery | 改写模糊、口语化、不自然的句子 |
| 10 分钟 | Connect the Logic | 原因、结果、对比、例子和让步关系 |
| 15 分钟 | Paragraph Challenge | 120–210 词短段落（按天递进） |
| 5 分钟 | Rewrite & Reflect | 检查一个关键错误并再写一遍 |

先**独立尝试**，不会再用页面上的「句型提示」，然后提交。提交后全部范例出现，选择题会自动判分；自由写作题需要你自行对照判断。文章参考范例不是唯一答案，语义相同、语法正确且自然的表达同样算对。

提交后的 **✦ 复制 AI 批改请求** 会复制当天全部题目与草稿、以及详细批改标准；你可以直接粘贴到 ChatGPT。网站本身不对文章进行 AI 自动批改，不会上传你的答题记录。

## 在 VS Code 本地打开

> 因课程数据存放在 `.json` 文件中，**不要直接双击 `index.html` 使用 `file://` 打开**，那样浏览器可能因为安全限制不能读取 JSON。

**最简单的方法：** VS Code 打开整个 `english-writing-lab` 文件夹，安装 `Live Server` 扩展，右键 `index.html` → **Open with Live Server**。

**不想安装扩展：** 在项目根目录的终端执行：

```bash
# 使用 Python 提供本地静态文件服务，不需要依赖 npm。
python3 -m http.server 5500
```

然后访问 `http://localhost:5500/`。

## 如何增加 Day 08？

不用修改 `index.html`、`assets/app.js` 或 `assets/style.css`。

1. 将 `lessons/_template/lesson.json` 复制到 `lessons/day08/lesson.json`。
2. 将模板中的 `id` 设置为 `day08`，`day` 设置为 `8`，编辑当天的语法、搭配、段落题目和参考答案。
3. 编辑 `lessons/index.json` 的 `lessons` 数组，最后添加 `"day08"`。
4. 刷新网页，Day 08 立即显示。

**重要字段解释：**

- `id`：课程 ID，必须与文件夹一致。题目也有自己的 `id`，**同一天不能重复**。建议 `d8-01`、`d8-02`。
- `type: "choice"`：单选，必须提供 `options`，`answer` 必须是其中之一；自动评分。
- `type: "write"`：英文自由输入，提供 `answer` 参考表达、`explanation` 解析、可选 `hint` 提示。
- `minWords`：可选的最低建议英文词数，适用于长段落；页面显示实时词数，但**不强行限制提交**。
- `sections`：板块数组，每个含 `id/title/subtitle/durationLabel/minutes/tasks`，可以任意增加题目或自定义模块。
- `languageKit`：数组，内含 `[搭配, 中文解释, 英文示例, 常见错误]`，手机端可以展开查看。
- `plannedDays`：首页总体规划天数，不代表所有课程均已上线。

`.json` 格式不支持 `//` 和 `/* ... */` 注释。课程解析写在 `explanation`，代码维护备注可以写在 `.js`、`.css` 或 `README.md` 中。

如果你更换课程中已上线某道题的**含义/正确答案**，建议更换该题的 `id`，避免旧答题记录被错误复用。

## GitHub Pages 部署（与韩语网站分开）

建议单独创建一个公开仓库 `english-writing-lab`，**不要覆盖妈妈的 `korean-teach-practice` 仓库**。

1. GitHub 上新建公开仓库 `english-writing-lab`（可以不预设 README）。
2. 用 VS Code 打开本项目根目录，执行以下命令。

```bash
# 初始化此项目的 Git 仓库
 git init
# 提交全部网页文件和课程题库
 git add .
 git commit -m "Initial WriteLab with Week 1 lessons"
# 主分支与远程仓库地址
 git branch -M main
 git remote add origin https://github.com/YOUR-USERNAME/english-writing-lab.git
 git push -u origin main
```

（请把 `YOUR-USERNAME` 改为你实际的 GitHub 用户名。）

3. 打开 GitHub 仓库的 **Settings → Pages**，设置 `Deploy from a branch` → `main` → `/(root)`，点击 **Save**。
4. 部署成功后访问 `https://YOUR-USERNAME.github.io/english-writing-lab/`。

如果遇到 404，先看 **GitHub Actions** 是否出现 Pages 部署运行及失败原因；确认 `main` 根目录有 `index.html`、`assets/` 和 `lessons/`。根目录 `.nojekyll` 已包含在项目内。

以后只要修改课程 JSON 并 `git add . && git commit -m "Add Day 8" && git push`，就可以更新网页。

## 技术说明与限制

- 使用纯 HTML、CSS、JavaScript，静态站点即可运行。
- 数据由浏览器 `fetch` 加载，需用 HTTP(S) 打开，适合 GitHub Pages。
- 计时器支持开始/暂停；离开页面或切换课程时自动暂停。
- 作答、写作自评与计时按 `lesson.id` 保存到 `localStorage`；不同天相互独立。
- 自由写作 **不会“假装自动评分”**：先提交，再阅读参考答案、人工标注“达到要求/需要重写”；系统仅汇总用户自己的判断。
- 提交锁定后若想直接改写，先把草稿复制出去，或选择“重做这一天”（会清空那一天的记录）。
- 页面不联网发送任何作答内容，唯一的网络请求是读取站点本身的 HTML/CSS/JS/JSON；点击复制只是把内容写入你本机剪贴板。
