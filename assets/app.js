"use strict";

/*
 * WriteLab: 原生 JS 的静态多课程引擎。
 * 所有题目来自 lessons/dayXX/lesson.json；添加课程时只修改 lessons/index.json。
 * 写作没有真正的自动语义评分，所以客观题自动检查、主观题由使用者参考范文自评。
 */
const ui = document.getElementById("app");
const siteStatus = document.getElementById("site-status");
const SAVE_PREFIX = "writelab.progress.v1.";
const PARAGRAPH_RUBRIC = ["观点明确", "理由或机制具体", "例子支持观点", "逻辑连接自然", "搭配与语法准确"];
const store = {
  manifest: null, lessons: new Map(), current: null,
  answers: {}, assessments: {}, submitted: false, rubric: {},
  // 批注、二次写作和视图切换使用独立字段，绝不覆盖第一遍 answers。
  annotations: {}, revisions: {}, attemptViews: {},
  time: { elapsed: 0, started: null }
};
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, s => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[s]));
const pad = x => String(x).padStart(2,"0");
const formatClock = ms => `${pad(Math.floor(ms/60000))}:${pad(Math.floor((ms%60000)/1000))}`;
const getRoute = () => (location.hash.match(/^#\/(day\d{2,3})\/?$/) || [])[1] || null;
const getTasks = (lesson = store.current) => lesson.sections.flatMap(section => section.tasks);
const wordCount = text => (String(text || "").match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;

// 使用题目独立 id 保存作答，调整题目排序不会导致答案错位。
function loadRecord(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_PREFIX + id) || "null");
    if (raw && typeof raw === "object") {
      return {
        answers: raw.answers || {}, assessments: raw.assessments || {},
        rubric: raw.rubric || {}, submitted: raw.submitted === true,
        // 兼容旧版 v1 存档；旧数据没有这些字段时直接使用空对象。
        annotations: raw.annotations || {}, revisions: raw.revisions || {},
        attemptViews: raw.attemptViews || {},
        time: raw.time && typeof raw.time.elapsed === "number" ? raw.time : {elapsed:0,started:null}
      };
    }
  } catch (_) { /* 禁用本地存储时仍然允许使用网站。 */ }
  return {answers:{},assessments:{},rubric:{},submitted:false,annotations:{},revisions:{},attemptViews:{},time:{elapsed:0,started:null}};
}
function saveRecord() {
  if (!store.current) return;
  try {
    localStorage.setItem(SAVE_PREFIX + store.current.id, JSON.stringify({
      answers:store.answers,assessments:store.assessments,
      rubric:store.rubric,submitted:store.submitted,time:store.time,
      annotations:store.annotations,revisions:store.revisions,attemptViews:store.attemptViews
    }));
  } catch (_) { /* 无法永久存储时，当前页面的答题仍然正常。 */ }
}
// 安全恢复 contenteditable 的批注：保留 <del>、红色括号、换行，不保留粘贴的 HTML 属性/脚本。
function sanitizeAnnotationHTML(html) {
  const template=document.createElement("template");
  template.innerHTML=String(html ?? "");
  function clean(node) {
    if (node.nodeType===Node.TEXT_NODE) return escapeHTML(node.nodeValue);
    if (node.nodeType!==Node.ELEMENT_NODE) return "";
    if (node.tagName==="BR") return "<br>";
    const inner=Array.from(node.childNodes,clean).join("");
    if (node.tagName==="DEL") return `<del>${inner}</del>`;
    if (node.tagName==="SPAN" && node.classList.contains("annotation-add")) {
      return `<span class="annotation-add">${escapeHTML(node.textContent)}</span>`;
    }
    // 浏览器在富文本区敲回车时会创建 DIV/P，统一为换行。
    if (node.tagName==="DIV" || node.tagName==="P") return `${inner}<br>`;
    return inner;
  }
  return Array.from(template.content.childNodes,clean).join("");
}

// 导出给 AI 的是可读的文字标记，不携带可执行 HTML。
function annotationAsText(html) {
  const template=document.createElement("template");
  template.innerHTML=sanitizeAnnotationHTML(html);
  const visit=node=>{
    if(node.nodeType===Node.TEXT_NODE) return node.nodeValue;
    if(node.nodeType!==Node.ELEMENT_NODE) return "";
    if(node.tagName==="BR") return "\n";
    const value=Array.from(node.childNodes,visit).join("");
    return node.tagName==="DEL"?`~~${value}~~`:value;
  };
  return Array.from(template.content.childNodes,visit).join("");
}

// 从旧草稿初始化改错层，仅提供视觉副本，不改变用户原先的答案。
function getAnnotationHTML(id,original) {
  return Object.prototype.hasOwnProperty.call(store.annotations,id)
    ? sanitizeAnnotationHTML(store.annotations[id])
    : escapeHTML(original).replace(/\n/g,"<br>");
}

// 在同一浏览器保存的旧记录也可直接导出，用于切换电脑、浏览器或网站域名。
function exportBackup() {
  const records={};
  try {
    for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);
      if(key && key.startsWith(SAVE_PREFIX)) records[key]=localStorage.getItem(key);
    }
  } catch (_) { alert("浏览器无法读取本地存储，请检查隐私设置。");return; }
  const snapshot={format:"writelab-local-backup",version:1,exportedAt:new Date().toISOString(),records};
  const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:"application/json;charset=utf-8"});
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=`writelab-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function importBackup(file) {
  if(!file) return;
  try {
    const obj=JSON.parse(await file.text());
    if(obj.format!=="writelab-local-backup" || !obj.records || typeof obj.records!=="object" || Array.isArray(obj.records)) {
      throw Error("不是 WriteLab 导出的备份文件");
    }
    const entries=Object.entries(obj.records);
    if(!entries.length || entries.some(([key,value])=>!/^writelab\.progress\.v1\.day\d{2,3}$/.test(key) || typeof value!=="string")) {
      throw Error("备份数据格式不符合要求");
    }
    // 写入前校验全部记录，避免导入一半才发现文件错误。
    for(const [,value] of entries) {
      const record=JSON.parse(value);
      if(!record || typeof record!=="object" || !record.answers || typeof record.answers!=="object") throw Error("发现损坏的存档");
    }
    if(!confirm(`将从备份恢复 ${entries.length} 天的记录。相同日期的现有本地数据会被覆盖。建议先点击“导出备份”。确定继续吗？`))return;
    for(const [key,value] of entries)localStorage.setItem(key,value);
    alert("备份已恢复，页面将重新载入。");
    location.reload();
  } catch(error) {alert(`导入失败：${error.message}。原有作答不会被主动清空。`);}
}

function timerElapsed() {
  return Math.max(0, store.time.elapsed + (store.time.started ? Date.now()-store.time.started : 0));
}
function pauseTimer() {
  if (store.time.started) {
    store.time.elapsed = timerElapsed();
    store.time.started = null;
    saveRecord();
  }
}
function toggleTimer() {
  if (!store.current) return;
  if (store.time.started) pauseTimer();
  else store.time.started = Date.now();
  saveRecord(); updateTimer();
}
function updateTimer() {
  const num = document.getElementById("timer-display");
  const button = document.getElementById("timer-toggle");
  if (num) num.textContent = formatClock(timerElapsed());
  if (button) button.textContent = store.time.started ? "Ⅱ 暂停" : "▶ 开始计时";
}
setInterval(updateTimer,1000);
// 切换课程或关闭标签页时暂停计时，避免把离开浏览器的时间计入训练。
addEventListener("pagehide",pauseTimer);
document.addEventListener("visibilitychange", () => { if (document.hidden) pauseTimer(); });

// 不需要服务器/数据库；HTTP 下浏览器可读取 JSON，Pages 的仓库子路径也可使用。
async function loadCourses() {
  const response = await fetch("./lessons/index.json",{cache:"no-cache"});
  if (!response.ok) throw Error(`无法加载课程目录 (HTTP ${response.status})`);
  const manifest = await response.json();
  if (!Array.isArray(manifest.lessons)) throw Error("lessons/index.json 里缺少 lessons 数组");
  const unique = new Set(manifest.lessons);
  if (unique.size !== manifest.lessons.length) throw Error("课程目录中有重复的 day 文件夹名");
  const entries = await Promise.all(manifest.lessons.map(async id => {
    if (!/^day\d{2,3}$/.test(id)) throw Error(`不合法的课程文件夹名称：${id}`);
    const res=await fetch(`./lessons/${id}/lesson.json`,{cache:"no-cache"});
    if (!res.ok) throw Error(`无法读取 ${id}/lesson.json (HTTP ${res.status})`);
    const lesson = await res.json();
    if (lesson.id !== id || !Array.isArray(lesson.sections) || !Array.isArray(lesson.languageKit)) {
      throw Error(`${id} 的课程内容缺少必要字段`);
    }
    const tasks = getTasks(lesson);
    if (!tasks.length || tasks.some(t => !t.id || !t.prompt || !t.answer || !["choice","write"].includes(t.type) ||
      (t.type === "choice" && (!Array.isArray(t.options) || !t.options.includes(t.answer))))) {
      throw Error(`${id} 的题目缺少字段或选择题答案不在选项里`);
    }
    if (tasks.length !== new Set(tasks.map(t=>t.id)).size) throw Error(`${id} 的题目 ID 重复了`);
    return lesson;
  }));
  entries.forEach(l => store.lessons.set(l.id,l));
  store.manifest=manifest;
}
function completedCount() { return getTasks().filter(t=>String(store.answers[t.id]??"").trim()).length; }
function allStats() {
  const tasks=getTasks(); const choice=tasks.filter(t=>t.type==="choice");
  const written=tasks.filter(t=>t.type==="write");
  const choiceGood=choice.filter(t=>store.answers[t.id]===t.answer).length;
  const marked=written.filter(t=>["good","revise"].includes(store.assessments[t.id]));
  const writtenGood=written.filter(t=>store.assessments[t.id]==="good").length;
  const mistakes=tasks.filter(t=>t.type==="choice" ? store.answers[t.id]!==t.answer : store.assessments[t.id]==="revise");
  return {tasks:tasks.length,choice:choice.length,written:written.length,choiceGood,marked:marked.length,
    writtenGood,score:choiceGood+writtenGood,allMarked:marked.length===written.length,mistakes};
}
function renderHome() {
  siteStatus.textContent=`${store.manifest.lessons.length} DAYS LIVE`;
  document.title="WriteLab · English Writing Gym";
  const m=store.manifest;
  const cards=m.lessons.map(id=>{
    const l=store.lessons.get(id);
    const record=loadRecord(id);
    const qs=getTasks(l);
    const answered=qs.filter(q=>String(record.answers[q.id]??"").trim()).length;
    const written=qs.filter(q=>q.type==="write");
    const done=record.submitted && written.every(q=>["good","revise"].includes(record.assessments[q.id]));
    const status=done?"✓ 已完成":record.submitted?"待复盘":answered?`${answered}/${qs.length} 已作答`:"开始训练";
    return `<a class="lesson-card" href="#/${escapeHTML(id)}"><div class="card-top"><span class="card-day">DAY ${pad(l.day)} / WEEK 01</span>
    <span class="card-state ${done?"done":""}">${escapeHTML(status)}</span></div>
    <h3>${escapeHTML(l.title)}</h3><p>${escapeHTML(l.subtitle)}</p>
    <div class="card-foot"><span>${escapeHTML(l.focus)} · 60 MIN</span><span>↗</span></div></a>`;
  }).join("");
  const weeks=m.weeks.map(w=>`<article class="week-card ${w.status==="available"?"current":""}"><span class="week-name">${escapeHTML(w.name)} ${w.status==="available"?"· OPEN":"· SOON"}</span><h3>${escapeHTML(w.headline)}</h3><p>${escapeHTML(w.goal)}</p><div class="week-days">DAY ${escapeHTML(w.days)}</div></article>`).join("");
  ui.innerHTML=`<section class="hero"><div><div class="eyebrow">ACTIVE WRITING · 28-DAY ROADMAP</div>
    <h1>${escapeHTML(m.heroTitle||"You know the words. Now make them work.")}</h1>
    <p class="hero-intro">${escapeHTML(m.heroDescription)}</p>
    <div class="tag-row"><span class="tag">01 / Collocations</span><span class="tag">02 / Sentence control</span><span class="tag">03 / Coherence</span><span class="tag">04 / Academic paragraphs</span></div></div>
    <aside class="hero-aside"><div><div class="aside-label">DAILY WRITING WORKOUT</div><div class="aside-num">60 <small>MIN / DAY</small></div><div class="aside-bottom">先尝试 → 再对照 → 然后重写。<br>真正的进步来自主动输出，而不是多看一遍范文。</div></div>
    <div class="aside-schedule"><span>08m · 搭配</span><span>12m · 造句</span><span>10m · 改写</span><span>10m · 逻辑</span><span>15m · 段落</span><span>05m · 复盘</span></div></aside></section>
    <div class="section-heading"><div><div class="eyebrow">YOUR WEEK ONE</div><h2>开始真正写英文</h2></div><p>已开放 ${m.lessons.length} 天 · 每天 15 题</p></div>
    <div class="lesson-grid">${cards}</div><div class="week-strip">${weeks}</div>
    <div class="info-note"><strong>关于评分：</strong>搭配选择题由浏览器自动判分；自由写作不存在可靠的离线自动语义评分。提交后会显示参考表达与分析，你需要自行判断是否达到要求，并进行二次改写。本网站不调用收费 AI 接口，也不上传你的写作。</div>`;
}
// 第一遍提交后保留只读原文；下方可以划掉选中词组并追加红色（改法）。
function renderAnnotation(task,v) {
  const html=getAnnotationHTML(task.id,v);
  return `<div class="annotation-panel">
    <div class="annotation-label">第一遍 · 原文改错层 <span>原始答案永久保留在上方，不会被修改</span></div>
    <div class="annotation-editor" data-annotation-editor="${escapeHTML(task.id)}" contenteditable="true"
         role="textbox" aria-multiline="true" aria-label="第 ${escapeHTML(task.id)} 题的改错批注">${html}</div>
    <div class="annotation-toolbar">
      <button type="button" class="mini-button" data-annotation-strike="${escapeHTML(task.id)}">划掉选中文字</button>
      <input class="annotation-input" data-annotation-input="${escapeHTML(task.id)}" placeholder="输入正确写法，例如 accurately" aria-label="插入的正确写法">
      <button type="button" class="mini-button" data-annotation-insert="${escapeHTML(task.id)}">插入红色（改法）</button>
      <button type="button" class="mini-button subtle" data-annotation-restore="${escapeHTML(task.id)}" title="仅还原批注区，不删除原答案">还原批注</button>
    </div>
    <p class="annotation-tip">先选中错误表达 → 点击「划掉」；再输入新写法 → 点击「插入红色（改法）」。也可直接在批注区打字。批注会自动保存。</p>
  </div>`;
}

function renderWritingAttempt(task,index,isEssay,v) {
  const submitted=store.submitted;
  const active=store.attemptViews[task.id]===2?2:1;
  const firstCount=(task.minWords||isEssay)?`<div class="word-count ${task.minWords&&wordCount(v)<task.minWords?"low":""}" id="words-${escapeHTML(task.id)}">${wordCount(v)} words${task.minWords?` · 目标 ${task.minWords}+`:""}</div>`:"";
  if(!submitted) return `<textarea id="answer-${escapeHTML(task.id)}" class="answer-editor ${isEssay?"essay":""}" data-answer="${escapeHTML(task.id)}" spellcheck="true" autocomplete="off" aria-label="第 ${index} 题英文答案" placeholder="不要先看答案。用英文写出你的表达…">${escapeHTML(v)}</textarea>${firstCount}`;
  const switcher=`<div class="attempt-switch" role="group" aria-label="第 ${index} 题的写作轮次">
    <button type="button" class="attempt-button ${active===1?"active":""}" data-attempt="${escapeHTML(task.id)}" data-round="1" aria-pressed="${active===1}">1/2 · 初稿与改错</button>
    <button type="button" class="attempt-button ${active===2?"active":""}" data-attempt="${escapeHTML(task.id)}" data-round="2" aria-pressed="${active===2}">2/2 · 重新写作</button>
  </div>`;
  if(active===1) return `${switcher}<div class="attempt-headline">第一遍作答（只读原文）</div>
    <textarea id="answer-${escapeHTML(task.id)}" class="answer-editor ${isEssay?"essay":""}" readonly aria-label="第 ${index} 题的原始作答">${escapeHTML(v)}</textarea>
    ${firstCount}${renderAnnotation(task,v)}`;
  const revised=store.revisions[task.id]||"";
  return `${switcher}<div class="rewrite-pane"><div class="attempt-headline">第二遍作答（独立保存）</div>
    <p class="rewrite-help">尝试不看第一遍重新表达。此处不会覆盖初稿，也不会改变原有自评结果。</p>
    <textarea id="rewrite-${escapeHTML(task.id)}" class="answer-editor ${isEssay?"essay":""}" data-revision="${escapeHTML(task.id)}" spellcheck="true" placeholder="Write your second attempt here…">${escapeHTML(revised)}</textarea>
    <div class="word-count ${task.minWords&&wordCount(revised)<task.minWords?"low":""}" id="revision-words-${escapeHTML(task.id)}">${wordCount(revised)} words${task.minWords?` · 目标 ${task.minWords}+`:""}</div>
  </div>`;
}

function renderTask(task,index,sectionId) {
  const v=store.answers[task.id]||"";
  const submitted=store.submitted;
  const isEssay=sectionId==="paragraph";
  const choice=task.type==="choice";
  const options=choice?`<div class="quiz-options" role="radiogroup" aria-label="第 ${index} 题">
    ${task.options.map(opt=>`<label class="quiz-option"><input type="radio" name="${escapeHTML(task.id)}" data-answer="${escapeHTML(task.id)}" value="${escapeHTML(opt)}" ${opt===v?"checked":""} ${submitted?"disabled":""}><span>${escapeHTML(opt)}</span></label>`).join("")}</div>`
    : renderWritingAttempt(task,index,isEssay,v);
  const hint=task.hint&&!submitted?`<div class="task-tools"><button type="button" data-hint="${escapeHTML(task.id)}" aria-controls="hint-${escapeHTML(task.id)}">↳ 卡住了？看句型提示</button></div>
    <div class="hint hidden" id="hint-${escapeHTML(task.id)}">${escapeHTML(task.hint)}</div>`:"";
  const grade=store.assessments[task.id];
  const result=submitted?`<div class="review-box">
    ${choice?`<div class="choice-result ${v===task.answer?"":"no"}">${v===task.answer?"✓ 选择正确":"✕ 选项需要复习"}</div>`:""}
    <div class="review-title">${choice?"Correct answer":"Model answer · one possible response"}</div>
    <div class="review-answer">${escapeHTML(task.answer)}</div><div class="review-explain">${escapeHTML(task.explanation)}</div>
    ${choice?"":`<div class="review-actions"><span>自行核对：</span>
      <button class="mini-button correct ${grade==="good"?"active":""}" data-grade="${escapeHTML(task.id)}" data-state="good">✓ 达到要求</button>
      <button class="mini-button review ${grade==="revise"?"active":""}" data-grade="${escapeHTML(task.id)}" data-state="revise">↻ 需要重写</button></div>`}
    ${isEssay?renderRubric():""}</div>`:"";
  return `<article class="task" id="task-${escapeHTML(task.id)}"><div class="task-top"><span class="task-num">${pad(index)}</span>
    <div class="task-body"><div class="task-prompt">${escapeHTML(task.prompt)}</div>${task.note?`<div class="task-extra">${escapeHTML(task.note)}</div>`:""}</div></div>
    ${options}${hint}${result}</article>`;
}
function renderRubric() {
  return `<div class="review-title" style="margin-top:14px">PARAGRAPH CHECKLIST</div>
    <div class="checklist">${PARAGRAPH_RUBRIC.map((name,i)=>`<label class="check-item"><input type="checkbox" data-rubric="${i}" ${store.rubric[i]?"checked":""}><span>${escapeHTML(name)}</span></label>`).join("")}</div>`;
}
function renderDay(id) {
  const lesson=store.lessons.get(id);
  if (!lesson) { showError(`没有找到 ${id} 的课程，请检查 lessons/index.json`);return; }
  // 交卷后重新渲染同一天，应使用内存状态，不能覆盖为可能不可用的 localStorage 旧数据。
  if (store.current?.id!==id) {
    pauseTimer();
    const record=loadRecord(id);
    store.answers=record.answers;store.assessments=record.assessments;store.submitted=record.submitted;
    store.rubric=record.rubric;store.time=record.time;
    store.annotations=record.annotations;store.revisions=record.revisions;store.attemptViews=record.attemptViews;
  }
  store.current=lesson;
  siteStatus.textContent=`DAY ${pad(lesson.day)} / 28`;
  document.title=`Day ${pad(lesson.day)} · ${lesson.title} · WriteLab`;
  let number=0;
  const phases=lesson.sections.map(sec=>`<section class="phase" id="phase-${escapeHTML(sec.id)}"><header class="phase-head">
    <div class="phase-headtop"><h2>${escapeHTML(sec.title)}</h2><span class="phase-duration">${escapeHTML(sec.durationLabel)}</span></div>
    <p class="phase-desc">${escapeHTML(sec.subtitle)}</p></header>
    ${sec.tasks.map(task=>renderTask(task,++number,sec.id)).join("")}</section>`).join("");
  // 完成整天练习前，Language Kit 不进入 DOM，防止提前看到固定搭配。
  const kit=store.submitted ? lesson.languageKit.map(([pair,meaning,example,error])=>`<div class="kit-item"><div class="kit-head">${escapeHTML(pair)}</div>
    <div class="kit-zh">${escapeHTML(meaning)}</div><div class="kit-example">${escapeHTML(example)}</div><div class="kit-error">${escapeHTML(error)}</div></div>`).join("") : "";
  const kitPanel=store.submitted
    ? `<details class="panel panel-pad kit-details" open><summary class="card-heading">🧩 Language Kit <small>交卷后解锁 · ${lesson.languageKit.length} 组</small></summary>
        <p class="kit-unlocked">现在可以对照搭配，再完成第二遍写作。</p>${kit}</details>`
    : `<section class="panel panel-pad kit-locked"><h2 class="card-heading">🔒 Language Kit</h2>
        <p>为了训练主动回忆，今日固定搭配和例句会在提交练习后显示。</p>
        <span class="kit-locked-label">完成练习后解锁</span></section>`;
  const idx=store.manifest.lessons.indexOf(id),next=store.manifest.lessons[idx+1];
  ui.innerHTML=`<a class="back" href="#/">← 返回训练首页</a><header class="lesson-hero"><div class="eyebrow">DAY ${pad(lesson.day)} · ${escapeHTML(lesson.track)}</div>
    <h1>${escapeHTML(lesson.title)}</h1><p>${escapeHTML(lesson.subtitle)}</p>
    <div class="tag-row" style="margin-top:18px"><span class="tag">60 MIN</span><span class="tag">${number} TASKS</span><span class="tag">${escapeHTML(lesson.focus)}</span></div>
  </header><div class="lesson-layout"><div class="study-main"><section class="panel timeline"><div class="timeline-top"><span>训练进度</span><span id="progress-text">0 / ${number}</span></div>
    <div class="track"><div id="progress-fill" class="track-fill"></div></div><div class="timer-line"><div class="timer-count"><span id="timer-display">00:00</span><small> / 60:00</small></div>
    <div class="timer-actions"><button type="button" class="timer-button" id="timer-toggle" data-action="timer">▶ 开始计时</button><button type="button" class="timer-button backup-button" data-action="backup">↓ 备份</button><button type="button" class="timer-button backup-button" data-action="import">↑ 恢复</button></div></div>
    <input type="file" id="backup-import" accept="application/json,.json" class="hidden" aria-label="导入 WriteLab 本地记录"></section>
    <div class="coach-note"><strong>COACH'S NOTE</strong>${escapeHTML(lesson.coach)}</div>${phases}
    <section id="submit-panel" class="panel submit-panel ${store.submitted?"hidden":""}"><button type="button" class="button primary wide" data-action="submit">完成练习 · 对照答案与改写 →</button>
      <p class="submit-hint">初稿自动保存。交卷后保留第一遍原文，可划线批注并打开 2/2 独立重写；参考答案届时解锁。</p></section>
    <section id="results" class="panel results ${store.submitted?"":"hidden"}" aria-live="polite"><div class="results-head"><div><div class="eyebrow">TODAY'S REVIEW</div><h2>写完不等于练完。</h2></div>
      <div class="score" id="score">—<small>自评 / 15</small></div></div><div class="results-desc" id="results-desc"></div><div class="results-note" id="results-note"></div>
      <div class="result-actions"><button type="button" class="button outline" data-action="copy">⧉ 复制写作和成绩</button>
      <button type="button" class="button outline" data-action="coach">✦ 复制 AI 批改请求</button>
      <button type="button" class="button outline" data-action="backup">↓ 导出全部学习记录</button></div>
    <details class="danger-zone"><summary>数据管理（谨慎操作）</summary><button type="button" class="button text" data-action="reset">清空这一天的全部记录</button></details>
      <p id="copy-status" class="confirm-text hidden"></p><textarea id="copy-fallback" class="backup hidden" readonly aria-label="复制结果"></textarea>
      ${next?`<div class="next-link"><a class="button primary" href="#/${escapeHTML(next)}">去 Day ${pad(lesson.day+1)} →</a></div>`:""}
    </section></div>
    <aside class="sidebar"><section class="panel panel-pad"><h2 class="card-heading">🎯 今天你要做到</h2><ul class="goal-list">${store.submitted?lesson.canDo.map(x=>`<li>${escapeHTML(x)}</li>`).join(""):`<li>先独立完成练习。包含具体搭配的今日目标将在交卷后显示。</li>`}</ul>
      <div class="tag-row" style="margin-top:15px"><span class="tag">${escapeHTML(lesson.topic)}</span></div></section>
    ${kitPanel}
      <section class="panel panel-pad"><h2 class="card-heading">✦ Writing Framework</h2><p style="color:var(--muted);font-size:13px;margin:0">${escapeHTML(lesson.framework)}</p></section></aside></div>`;
  updateProgress();updateTimer();if (store.submitted) updateResults();
}
function updateProgress() {
  if (!store.current) return;
  const done=completedCount(),total=getTasks().length;
  const txt=document.getElementById("progress-text");if(txt) txt.textContent=`${done} / ${total}`;
  const bar=document.getElementById("progress-fill");if(bar) bar.style.width=`${done/total*100}%`;
}
function submitDay() {
  if (!store.current || store.submitted) return;
  const missed=getTasks().length-completedCount();
  if (missed && !confirm(`还有 ${missed} 题没有作答。确定提前交卷并查看参考答案吗？`)) return;
  pauseTimer();store.submitted=true;saveRecord();renderDay(store.current.id);
  document.getElementById("task-"+getTasks()[0].id)?.scrollIntoView({behavior:"smooth",block:"start"});
}
function markAnswer(id, verdict) {
  store.assessments[id]=verdict;saveRecord();
  document.querySelectorAll(`[data-grade="${id}"]`).forEach(el=>el.classList.toggle("active",el.dataset.state===verdict));
  updateResults();
}
function updateResults() {
  if (!store.current) return;
  const s=allStats();
  document.getElementById("score").innerHTML=`${s.allMarked?s.score:"—"}<small>自评 / ${s.tasks}</small>`;
  document.getElementById("results-desc").textContent=`选择题正确 ${s.choiceGood}/${s.choice} · 写作已核对 ${s.marked}/${s.written} · 计时 ${formatClock(timerElapsed())}`;
  document.getElementById("results-note").textContent=s.allMarked
    ? `需要重写 ${s.mistakes.length} 道题。参考答案不是唯一写法：判断标准是句子是否自然、逻辑是否成立，以及是否正确实现题目目标。`
    : `还有 ${s.written-s.marked} 道写作题没有自评。请对照参考答案，并标记“达到要求”或“需要重写”。`;
}
function copyText() {
  const l=store.current,qs=getTasks(),s=allStats();
  return [`WriteLab · Day ${pad(l.day)} — ${l.title}`,s.allMarked?`Self-reviewed result: ${s.score}/${s.tasks}`:`Objective: ${s.choiceGood}/${s.choice}; Writing reviewed: ${s.marked}/${s.written}`,
    `Time tracked: ${formatClock(timerElapsed())}`,`Needs rewriting: ${s.mistakes.map(x=>x.id).join(", ")||"none"}`,"",
    // 不改变旧版教练请求中 MY ANSWER 的语义，追加批注和第二遍（有内容时）。
    ...qs.map((q,i)=>{
      let txt=`${i+1}. ${q.prompt}\nMY ANSWER (1/2): ${store.answers[q.id]||"(blank)"}\n`;
      if(q.type==="write") {
        if(Object.prototype.hasOwnProperty.call(store.annotations,q.id)) txt+=`CORRECTIONS (~~deleted~~ and red parentheses): ${annotationAsText(store.annotations[q.id])}\n`;
        if(String(store.revisions[q.id]||"").trim()) txt+=`SECOND ATTEMPT (2/2): ${store.revisions[q.id]}\n`;
      }
      return txt+(q.type==="choice"?(store.answers[q.id]===q.answer?"✓ correct":"✕ needs review"):(store.assessments[q.id]==="good"?"✓ meets target":store.assessments[q.id]==="revise"?"↻ rewrite":"○ not reviewed"))+"\n";
    })
  ].join("\n");
}
async function copySummary(forCoach = false) {
  // 复制按钮可以生成教练批改提示词；仍需用户主动粘贴到 AI 聊天窗口。
  const coachingPrompt = `请作为严格、具体的英语写作教练批改下面的训练答案。先只分析问题，不要直接重写所有句子。
要求：1) 按题号标出语法错误和不自然搭配；2) 说明为什么错，给出更自然的表达；3) 检查逻辑连接是否成立；4) 对学术段落评估观点明确性、证据和推理、组织、词汇和语法；5) 归纳最需要练习的 5 组可复用搭配，给出 5 道针对性新题；6) 对表达不同但正确的答案不要机械判错。

`;
  const summary=(forCoach ? coachingPrompt : "") + copyText(),status=document.getElementById("copy-status"),fallback=document.getElementById("copy-fallback");
  try {
    if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
    await navigator.clipboard.writeText(summary);
    status.textContent=forCoach?"✓ 已复制批改请求！直接粘贴到 ChatGPT 即可。":"✓ 已复制完整练习结果；可以粘贴给 ChatGPT 或保存进笔记。";
    fallback.classList.add("hidden");
  } catch (_) {
    // 部分手机浏览器限制剪贴板权限，降级到可长按复制的文本框。
    fallback.value=summary;fallback.classList.remove("hidden");fallback.focus();fallback.select();
    let copied=false;try{copied=document.execCommand("copy");}catch(_){}
    status.textContent=copied?"✓ 已复制，可粘贴。":"请长按下方文本，选择全选并复制。";
  }
  status.classList.remove("hidden");
}
function resetDay() {
  if (!confirm("这会清除当天第一遍、批注、第二遍、自评和计时；操作不可撤销。建议先导出备份。确定清空吗？")) return;
  pauseTimer();store.answers={};store.assessments={};store.rubric={};store.submitted=false;
  store.annotations={};store.revisions={};store.attemptViews={};
  store.time={elapsed:0,started:null};saveRecord();renderDay(store.current.id);
  scrollTo({top:0,behavior:"smooth"});
}
function showError(detail) {
  siteStatus.textContent="LOAD ERROR";
  ui.innerHTML=`<section class="panel error-panel"><h1>课程加载失败</h1><p>${escapeHTML(detail)}</p>
    <p>项目使用 JSON 文件题库，如果你直接双击 <code>index.html</code> 打开，会遇到浏览器的本地文件权限限制。请在 VS Code 用 <b>Live Server</b> 打开，或发布到 GitHub Pages。</p>
    <a href="#/" class="back">← 返回首页</a></section>`;
}
function navigate() {
  const id=getRoute();
  if (!id) {
    pauseTimer();store.current=null;renderHome();
  } else renderDay(id);
  scrollTo(0,0);
}
let selectedAnnotationRange=null;
function rememberAnnotationSelection() {
  const selection=window.getSelection();
  if(!selection || !selection.rangeCount) return;
  const range=selection.getRangeAt(0);
  const root=range.commonAncestorContainer.nodeType===Node.ELEMENT_NODE?range.commonAncestorContainer:range.commonAncestorContainer.parentNode;
  const editor=root?.closest?.("[data-annotation-editor]");
  if(editor) selectedAnnotationRange={id:editor.dataset.annotationEditor,range:range.cloneRange()};
}
function handleAnnotationAction(button,type) {
  const id=type==="strike"?button.dataset.annotationStrike:button.dataset.annotationInsert;
  const editor=document.querySelector(`[data-annotation-editor="${id}"]`);
  if(!editor)return;
  const saved=selectedAnnotationRange;
  const selection=window.getSelection();
  let range=(selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer))
    ? selection.getRangeAt(0).cloneRange() : (saved?.id===id && editor.contains(saved.range.commonAncestorContainer)?saved.range.cloneRange():null);
  if(type==="strike") {
    if(!range || range.collapsed) {alert("请先用鼠标或触摸选中需要划掉的文字。");return;}
    const del=document.createElement("del");
    del.appendChild(range.extractContents());range.insertNode(del);
    range.setStartAfter(del);range.collapse(true);
  } else {
    const input=document.querySelector(`[data-annotation-input="${id}"]`);
    const replacement=input?.value.trim();
    if(!replacement) {input?.focus();return;}
    if(!range) {range=document.createRange();range.selectNodeContents(editor);range.collapse(false);}
    else range.collapse(false);
    const span=document.createElement("span");span.className="annotation-add";
    span.textContent=`(${replacement})`;
    range.insertNode(span);range.setStartAfter(span);range.collapse(true);
    input.value="";
  }
  editor.focus();selection?.removeAllRanges();selection?.addRange(range);
  selectedAnnotationRange={id,range:range.cloneRange()};
  store.annotations[id]=sanitizeAnnotationHTML(editor.innerHTML);
  saveRecord();



  /**
   * 自动标红手动输入的括号内容。
   * 只有输入右括号 ")" 后才进行格式化，
   * 避免每输入一个字母就重新渲染，导致光标跳动。
   */
  function autoHighlightParentheses(editor, event) {
    if (event.isComposing || event.data !== ")") return;

    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;

    const currentRange = selection.getRangeAt(0);
    const node = currentRange.startContainer;

    // 只处理普通文本，防止重复包裹已经标红的内容。
    if (
      node.nodeType !== Node.TEXT_NODE ||
      !editor.contains(node) ||
      node.parentElement?.closest(".annotation-add")
    ) return;

    const text = node.textContent;
    const cursor = currentRange.startOffset;

    // 确认光标刚好位于右括号之后。
    if (text[cursor - 1] !== ")") return;

    // 向前查找对应的左括号。
    const start = text.lastIndexOf("(", cursor - 2);
    if (start === -1) return;

    // 暂时不处理嵌套括号，避免误标记。
    const content = text.slice(start + 1, cursor - 1);
    if (/[()]/.test(content)) return;

    // 将整组括号包裹为现有的红色样式。
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, cursor);

    const span = document.createElement("span");
    span.className = "annotation-add";
    range.surroundContents(span);

    // 恢复光标到括号后面，方便继续输入。
    const nextRange = document.createRange();
    nextRange.setStartAfter(span);
    nextRange.collapse(true);

    selection.removeAllRanges();
    selection.addRange(nextRange);
  }

}

// 委托事件绑定，新增课程/题目时不需要增加新的监听器。
ui.addEventListener("mouseup",rememberAnnotationSelection);
ui.addEventListener("keyup",rememberAnnotationSelection);
ui.addEventListener("touchend",rememberAnnotationSelection);
ui.addEventListener("input",event=>{
  const el=event.target;
  // 富文本批注和第二遍独立保存；第一遍在提交后继续保持只读。
  
  if (
    el.matches("[data-annotation-editor]") &&
    store.current &&
    store.submitted
  ) {
    // 输入完成一组括号后，自动将其标红。
    autoHighlightParentheses(el, event);

    // 继续使用原有存储字段，兼容之前的 Day 01 答案。
    store.annotations[el.dataset.annotationEditor] =
      sanitizeAnnotationHTML(el.innerHTML);

    saveRecord();
    return;
  }

  if(el.matches("textarea[data-revision]") && store.current && store.submitted) {
    const id=el.dataset.revision;
    store.revisions[id]=el.value;
    const t=getTasks().find(q=>q.id===id);
    const counter=document.getElementById("revision-words-"+id);
    if(counter){counter.textContent=`${wordCount(el.value)} words${t.minWords?` · 目标 ${t.minWords}+`:""}`;counter.classList.toggle("low",!!t.minWords && wordCount(el.value)<t.minWords);}
    saveRecord();return;
  }
  if (!store.current || store.submitted || !el.matches("textarea[data-answer]")) return;
  store.answers[el.dataset.answer]=el.value;
  const t=getTasks().find(q=>q.id===el.dataset.answer);
  const counter=document.getElementById("words-"+el.dataset.answer);
  if (counter){counter.textContent=`${wordCount(el.value)} words${t.minWords?` · 目标 ${t.minWords}+`:""}`;counter.classList.toggle("low",!!t.minWords && wordCount(el.value)<t.minWords);}
  saveRecord();updateProgress();
});
ui.addEventListener("change",event=>{
  const el=event.target;
  if(el.id==="backup-import") {importBackup(el.files?.[0]);el.value="";return;}
  if (el.matches("input[data-rubric]")) {store.rubric[el.dataset.rubric]=el.checked;saveRecord();return;}
  if (!store.current || store.submitted || !el.matches('input[type="radio"][data-answer]'))return;
  store.answers[el.dataset.answer]=el.value;saveRecord();updateProgress();
});
ui.addEventListener("click",event=>{
  const button=event.target.closest("button"); if(!button || !store.current) return;
  if(button.dataset.attempt) {
    store.attemptViews[button.dataset.attempt]=Number(button.dataset.round);
    saveRecord();
    const position=window.scrollY;
    renderDay(store.current.id);window.scrollTo(0,position);
    return;
  }
  if(button.dataset.annotationStrike) {handleAnnotationAction(button,"strike");return;}
  if(button.dataset.annotationInsert) {handleAnnotationAction(button,"insert");return;}
  if(button.dataset.annotationRestore) {
    const id=button.dataset.annotationRestore;
    if(confirm("只还原这道题的批注副本？原始回答与第二遍不会受影响。")) {
      delete store.annotations[id];saveRecord();const position=window.scrollY;
      renderDay(store.current.id);window.scrollTo(0,position);
    }
    return;
  }
  if(button.dataset.hint){const el=document.getElementById("hint-"+button.dataset.hint);el?.classList.toggle("hidden");return;}
  if(button.dataset.grade){markAnswer(button.dataset.grade,button.dataset.state);return;}
  switch(button.dataset.action){
    case "timer": toggleTimer();break;
    case "submit": submitDay();break;
    case "copy": copySummary(false);break;
    case "coach": copySummary(true);break;
    case "reset": resetDay();break;
    case "backup": exportBackup();break;
    case "import": document.getElementById("backup-import")?.click();break;
  }
});
addEventListener("hashchange",navigate);
loadCourses().then(navigate).catch(e=>showError(e.message));

