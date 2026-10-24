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
        time: raw.time && typeof raw.time.elapsed === "number" ? raw.time : {elapsed:0,started:null}
      };
    }
  } catch (_) { /* 禁用本地存储时仍然允许使用网站。 */ }
  return {answers:{},assessments:{},rubric:{},submitted:false,time:{elapsed:0,started:null}};
}
function saveRecord() {
  if (!store.current) return;
  try {
    localStorage.setItem(SAVE_PREFIX + store.current.id, JSON.stringify({
      answers:store.answers,assessments:store.assessments,
      rubric:store.rubric,submitted:store.submitted,time:store.time
    }));
  } catch (_) { /* 无法永久存储时，当前页面的答题仍然正常。 */ }
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
  siteStatus.textContent="7 DAYS LIVE";
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
    <h1>You know the words.<br><em>Now make them work.</em></h1>
    <p class="hero-intro">${escapeHTML(m.heroDescription)}</p>
    <div class="tag-row"><span class="tag">01 / Collocations</span><span class="tag">02 / Sentence control</span><span class="tag">03 / Coherence</span><span class="tag">04 / Academic paragraphs</span></div></div>
    <aside class="hero-aside"><div><div class="aside-label">DAILY WRITING WORKOUT</div><div class="aside-num">60 <small>MIN / DAY</small></div><div class="aside-bottom">先尝试 → 再对照 → 然后重写。<br>真正的进步来自主动输出，而不是多看一遍范文。</div></div>
    <div class="aside-schedule"><span>08m · 搭配</span><span>12m · 造句</span><span>10m · 改写</span><span>10m · 逻辑</span><span>15m · 段落</span><span>05m · 复盘</span></div></aside></section>
    <div class="section-heading"><div><div class="eyebrow">YOUR WEEK ONE</div><h2>开始真正写英文</h2></div><p>已开放 ${m.lessons.length} 天 · 每天 15 题</p></div>
    <div class="lesson-grid">${cards}</div><div class="week-strip">${weeks}</div>
    <div class="info-note"><strong>关于评分：</strong>搭配选择题由浏览器自动判分；自由写作不存在可靠的离线自动语义评分。提交后会显示参考表达与分析，你需要自行判断是否达到要求，并进行二次改写。本网站不调用收费 AI 接口，也不上传你的写作。</div>`;
}
function renderTask(task,index,sectionId) {
  const v=store.answers[task.id]||"";
  const submitted=store.submitted;
  const isEssay=sectionId==="paragraph";
  const choice=task.type==="choice";
  const options=choice?`<div class="quiz-options" role="radiogroup" aria-label="第 ${index} 题">
    ${task.options.map(opt=>`<label class="quiz-option"><input type="radio" name="${escapeHTML(task.id)}" data-answer="${escapeHTML(task.id)}" value="${escapeHTML(opt)}" ${opt===v?"checked":""} ${submitted?"disabled":""}><span>${escapeHTML(opt)}</span></label>`).join("")}</div>`
    :`<textarea id="answer-${escapeHTML(task.id)}" class="answer-editor ${isEssay?"essay":""}" data-answer="${escapeHTML(task.id)}" spellcheck="true" autocomplete="off" aria-label="第 ${index} 题英文答案" placeholder="不要先看答案。用英文写出你的表达…" ${submitted?"readonly":""}>${escapeHTML(v)}</textarea>
    ${(task.minWords||isEssay)?`<div class="word-count ${task.minWords&&wordCount(v)<task.minWords?"low":""}" id="words-${escapeHTML(task.id)}">${wordCount(v)} words${task.minWords?` · 目标 ${task.minWords}+`:""}</div>`:""}`;
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
  }
  store.current=lesson;
  siteStatus.textContent=`DAY ${pad(lesson.day)} / 28`;
  document.title=`Day ${pad(lesson.day)} · ${lesson.title} · WriteLab`;
  let number=0;
  const phases=lesson.sections.map(sec=>`<section class="phase" id="phase-${escapeHTML(sec.id)}"><header class="phase-head">
    <div class="phase-headtop"><h2>${escapeHTML(sec.title)}</h2><span class="phase-duration">${escapeHTML(sec.durationLabel)}</span></div>
    <p class="phase-desc">${escapeHTML(sec.subtitle)}</p></header>
    ${sec.tasks.map(task=>renderTask(task,++number,sec.id)).join("")}</section>`).join("");
  const kit=lesson.languageKit.map(([pair,meaning,example,error])=>`<div class="kit-item"><div class="kit-head">${escapeHTML(pair)}</div>
    <div class="kit-zh">${escapeHTML(meaning)}</div><div class="kit-example">${escapeHTML(example)}</div><div class="kit-error">${escapeHTML(error)}</div></div>`).join("");
  const idx=store.manifest.lessons.indexOf(id),next=store.manifest.lessons[idx+1];
  ui.innerHTML=`<a class="back" href="#/">← 返回训练首页</a><header class="lesson-hero"><div class="eyebrow">DAY ${pad(lesson.day)} · ${escapeHTML(lesson.track)}</div>
    <h1>${escapeHTML(lesson.title)}</h1><p>${escapeHTML(lesson.subtitle)}</p>
    <div class="tag-row" style="margin-top:18px"><span class="tag">60 MIN</span><span class="tag">15 TASKS</span><span class="tag">${escapeHTML(lesson.focus)}</span></div>
  </header><div class="lesson-layout"><div class="study-main"><section class="panel timeline"><div class="timeline-top"><span>训练进度</span><span id="progress-text">0 / ${number}</span></div>
    <div class="track"><div id="progress-fill" class="track-fill"></div></div><div class="timer-line"><div class="timer-count"><span id="timer-display">00:00</span><small> / 60:00</small></div>
    <button type="button" class="timer-button" id="timer-toggle" data-action="timer">▶ 开始计时</button></div></section>
    <div class="coach-note"><strong>COACH'S NOTE</strong>${escapeHTML(lesson.coach)}</div>${phases}
    <section id="submit-panel" class="panel submit-panel ${store.submitted?"hidden":""}"><button type="button" class="button primary wide" data-action="submit">完成练习 · 对照答案与改写 →</button>
      <p class="submit-hint">所有草稿会自动保存。交卷后出现参考答案，作答将锁定；请通过自评记录需要重写的题目。</p></section>
    <section id="results" class="panel results ${store.submitted?"":"hidden"}" aria-live="polite"><div class="results-head"><div><div class="eyebrow">TODAY'S REVIEW</div><h2>写完不等于练完。</h2></div>
      <div class="score" id="score">—<small>自评 / 15</small></div></div><div class="results-desc" id="results-desc"></div><div class="results-note" id="results-note"></div>
      <div class="result-actions"><button type="button" class="button outline" data-action="copy">⧉ 复制写作和成绩</button>
      <button type="button" class="button outline" data-action="coach">✦ 复制 AI 批改请求</button>
      <button type="button" class="button text" data-action="reset">↻ 重做这一天</button></div>
      <p id="copy-status" class="confirm-text hidden"></p><textarea id="copy-fallback" class="backup hidden" readonly aria-label="复制结果"></textarea>
      ${next?`<div class="next-link"><a class="button primary" href="#/${escapeHTML(next)}">去 Day ${pad(lesson.day+1)} →</a></div>`:""}
    </section></div>
    <aside class="sidebar"><section class="panel panel-pad"><h2 class="card-heading">🎯 今天你要做到</h2><ul class="goal-list">${lesson.canDo.map(x=>`<li>${escapeHTML(x)}</li>`).join("")}</ul>
      <div class="tag-row" style="margin-top:15px"><span class="tag">${escapeHTML(lesson.topic)}</span></div></section>
      <details class="panel panel-pad kit-details" ${matchMedia("(max-width:720px)").matches?"":"open"}>
      <summary class="card-heading">🧩 Language Kit <small>展开 5 组今日搭配</small></summary>
      <p style="font-size:12px;color:var(--muted);margin:0 0 12px">先尝试从记忆里提取搭配。卡住时再来看。</p>${kit}</details>
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
    ...qs.map((q,i)=>`${i+1}. ${q.prompt}\nMY ANSWER: ${store.answers[q.id]||"(blank)"}\n${q.type==="choice"?(store.answers[q.id]===q.answer?"✓ correct":"✕ needs review"):(store.assessments[q.id]==="good"?"✓ meets target":store.assessments[q.id]==="revise"?"↻ rewrite":"○ not reviewed")}\n`)
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
  if (!confirm("确定清空这一天的草稿、自评分数和计时，并重新训练吗？")) return;
  pauseTimer();store.answers={};store.assessments={};store.rubric={};store.submitted=false;
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
// 委托事件绑定，新增课程/题目时不需要增加新的监听器。
ui.addEventListener("input",event=>{
  const el=event.target;
  if (!store.current || store.submitted || !el.matches("textarea[data-answer]")) return;
  store.answers[el.dataset.answer]=el.value;
  const t=getTasks().find(q=>q.id===el.dataset.answer);
  const counter=document.getElementById("words-"+el.dataset.answer);
  if (counter){counter.textContent=`${wordCount(el.value)} words${t.minWords?` · 目标 ${t.minWords}+`:""}`;counter.classList.toggle("low",!!t.minWords && wordCount(el.value)<t.minWords);}
  saveRecord();updateProgress();
});
ui.addEventListener("change",event=>{
  const el=event.target;
  if (el.matches("input[data-rubric]")) {store.rubric[el.dataset.rubric]=el.checked;saveRecord();return;}
  if (!store.current || store.submitted || !el.matches('input[type="radio"][data-answer]'))return;
  store.answers[el.dataset.answer]=el.value;saveRecord();updateProgress();
});
ui.addEventListener("click",event=>{
  const button=event.target.closest("button"); if(!button || !store.current) return;
  if(button.dataset.hint){const el=document.getElementById("hint-"+button.dataset.hint);el?.classList.toggle("hidden");return;}
  if(button.dataset.grade){markAnswer(button.dataset.grade,button.dataset.state);return;}
  switch(button.dataset.action){
    case "timer": toggleTimer();break;
    case "submit": submitDay();break;
    case "copy": copySummary(false);break;
    case "coach": copySummary(true);break;
    case "reset": resetDay();break;
  }
});
addEventListener("hashchange",navigate);
loadCourses().then(navigate).catch(e=>showError(e.message));
