# LanguageLab v2 · 课程、复习、考试与语音

## 设计与依赖

- 保留原生 JavaScript、GitHub Pages 和原有 v1 学习记录。
- `assets/app.js` 负责旧版训练生命周期、批改和备份；`assets/language-lab.js` 负责扩展；`assets/language-lab.css` 负责新增界面。
- 参考 Anki/FSRS 的复习调度思路、Moodle 的题库和考试模式。FSRS 需要额外调度状态及库，当前固定间隔更容易审计；不是 FSRS 的实现。没有移植 Anki 或 Moodle 代码。
- Web Speech API 用于 TTS、语音转写；生产运行时无 npm 依赖。Playwright 仅用于可选开发测试。

参考：https://github.com/open-spaced-repetition/ts-fsrs ，https://github.com/moodle/moodle ，https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API

## M1: 数据格式

新课建议使用 format="writelab-course", version=2。支持原 v1 的 sections/tasks 和 questions 简写。每份课程最多 20 sections / 200 tasks，每个 section 最多 100 tasks。保留原有最多 100 门自定义课程的限制。

字段：
- language: BCP-47，如 es-MX、en-US、ja-JP；非语言课程可用 und。
- program: 稳定学习计划 ID，如 spanish-a1；保持相同计划所有课程一致。
- level、category: 分类；unit、week、day: 非负整数，0 为未指定。
- lessonType: learning / review / weekly / unit / final；examMinutes: 1–180。
- prerequisites: 建议的前置课程 ID/名称列表，不强制锁课。
- objectives 与每道题 tags: 用相同稳定知识点 ID 追踪，如 ser-present。
- studyNotes、section.notes: 学习讲解字符串数组，练习时可见，考试不复制。
- languageKit: 原有四字符串一组的词汇/表达资料；交卷后解锁，并可进入复习卡片。

内部兼容：新题型被映射为原引擎可保存的 choice/write，并使用 kind 保留真实题型。导出的已规范化 JSON 仍可重新导入当前版本。旧 v1 引擎不支持 v2。v2 schema 描述推荐的原始输入结构；运行时会额外验证题目 ID 唯一、choice 答案在选项里、BCP-47 等。

## M2: 复习与知识点表现

源题提交后，客观题及已自评/AI 批改的开放题进入复习中心；词汇卡来自 languageKit。按所选语言/计划筛选。错题本显示初次错误且尚未被复习标记为已掌握的题目，以及最近复习失败的题。展开后看参考答案，自行标记记得/忘记。失败 10 分钟后到期；成功逐步延长到 1、3、7、14、30、60 天。第一次尚未复习的题立即到期。词卡模式包含所有词卡；到期复习模式只显示到期项。

知识点表现 = 最近一次有评分证据的正确题/卡片数除以有评分证据的题/卡片数；不能视为科学估计的记忆概率。复习评级不会覆盖原课程答案。移除课程后其题卡不再显示，原复习记录仍保存。

## M3: 考试

- 周测按 week，单元考试按 unit，期末覆盖 program。优先用同范围已导入的对应 lessonType 试卷，否则从 learning/review 题库抽样。旧自定义课程未填写 week/unit 时只能自动纳入期末，或升级元数据后纳入周测/单元考试。
- 指定试卷使用课程卡片上的「按考试模式开始」，默认 examMinutes；每次最多 100 题。
- 开始后保存题目快照、答案、开始时间和绝对截止时间。刷新、离开页面不暂停计时；重新打开时过期试卷自动锁定。
- 交卷前不渲染答案、参考解释、讲解和提示。客户端 JSON 与 localStorage 并不是安全考试环境，不能防止作弊。
- 交卷后客观题自动判分；口语/自由写作自己核对。结果同时显示已评分数与总题数；可导出考试 JSON，独立于原课记录。AI 反馈导入仍针对普通课程；考试可导出交给外部 AI，但不自动导入考试批改。
- 每个浏览器同一时刻只允许一场未完成考试；最多 200 场记录。已交卷记录可手动删除。

## M4: 语言题型

- choice: 精确匹配选项。
- fill / conjugation / flashcard: 文本客观题。默认忽略大小写和首尾/重复空白，NFC Unicode 归一化，保留重音与标点差异。可用 acceptedAnswers 指定其他接受答案，caseSensitive=true 严格比较大小写。每道动词变位题对应一个独立变位。
- listening: 必须提供 audioText；可提供 options 做选择题，否则按客观文本题判分。播放由浏览器 TTS 实现。
- speaking: 开放题，可手动输入或在浏览器支持时使用麦克风转写。不是专业发音评分，识别结果不保证正确。浏览器/系统可能使用联网识别服务；网站不保存音频，转写作为普通文本保存。
- write: 开放题；保留初稿、二次写作、自评和 AI 批改。

示例课程使用墨西哥西语 es-MX；其他地区（如 es-ES）仍可导入。TTS 优先选对应语言的设备语音，若只找到同语言其他地区的语音则使用该语音；设备可能缺少 es-MX 语音。使用麦克风前会说明第三方处理风险并请求确认。Firefox/Safari/Chrome 支持程度可能不同，建议使用 HTTPS 或 localhost，且授予麦克风权限。未支持时仍可手动作答。

## 存档与兼容

原有 writelab.progress.v1.* 与 writelab.customCourses.v1 键不变。新增 writelab.languageLab.v1 保存复习、考试独立数据。原有 version=2 备份新增可选 languageLab 字段，同时兼容旧 v1/v2 备份；恢复旧备份不主动清除新增复习/考试存档。恢复备份会覆盖相同 ID 的记录，请先备份。所有数据保存在当前浏览器，清除网站数据或切换设备不会自动同步。建议定期导出。

## 验证

`node tests/smoke.cjs` 检查现有课程、v1/v2 数据、重音、题型判分、复习调度、考试到期、备份恢复及示例。可选 `node tests/browser-smoke.cjs` 在 Playwright Chromium 检查实际导航、导入、筛选、复习、考试与记录隔离。头部语音按钮的存在可自动验证，声音品质、设备语音及麦克风权限需要真机测试。
