"use strict";

/*
 * WriteLab: 原生 JS 的静态多课程引擎。
 * 所有题目来自 lessons/dayXX/lesson.json；添加课程时只修改 lessons/index.json。
 * 写作没有真正的自动语义评分，所以客观题自动检查、主观题由使用者参考范文自评。
 */
const ui = document.getElementById("app");
const siteStatus = document.getElementById("site-status");
const SAVE_PREFIX = "writelab.progress.v1.";
// 用户自定义课程与旧版 Day 01–07 作答分开保存；旧存储键保持不变。
const CUSTOM_COURSES_KEY = "writelab.customCourses.v1";
const CUSTOM_COURSE_ID = /^custom-[a-z0-9-]{1,64}$/;
const PARAGRAPH_RUBRIC = ["观点明确", "理由或机制具体", "例子支持观点", "逻辑连接自然", "搭配与语法准确"];
const store = {
  manifest: null, lessons: new Map(), customLessons: new Map(), current: null,
  answers: {}, assessments: {}, submitted: false, rubric: {},
  // 批注、二次写作和视图切换使用独立字段，绝不覆盖第一遍 answers。
  annotations: {}, revisions: {}, attemptViews: {},
  // AI 批改与复练答案独立保存，不干预原题、第一遍或第二遍答案。
  feedback: null, practiceAnswers: {}, feedbackHidden: false,
  time: { elapsed: 0, started: null }
};
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, s => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[s]));
const pad = x => String(x).padStart(2,"0");
const formatClock = ms => `${pad(Math.floor(ms/60000))}:${pad(Math.floor((ms%60000)/1000))}`;
const getRoute = () => (location.hash.match(/^#\/(day\d{2,3}|custom-[a-z0-9-]{1,64})\/?$/) || [])[1] || null;
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
        feedback: raw.feedback?.format === "writelab-feedback" ? raw.feedback : null,
        practiceAnswers: raw.practiceAnswers || {},
        // 仅控制 AI 批改区可见性，旧存档缺少该字段时默认显示。
        feedbackHidden: raw.feedbackHidden === true,
        time: raw.time && typeof raw.time.elapsed === "number" ? raw.time : {elapsed:0,started:null}
      };
    }
  } catch (_) { /* 禁用本地存储时仍然允许使用网站。 */ }
  return {answers:{},assessments:{},rubric:{},submitted:false,annotations:{},revisions:{},attemptViews:{},feedback:null,practiceAnswers:{},feedbackHidden:false,time:{elapsed:0,started:null}};
}
function saveRecord() {
  if (!store.current) return;
  try {
    localStorage.setItem(SAVE_PREFIX + store.current.id, JSON.stringify({
      answers:store.answers,assessments:store.assessments,
      rubric:store.rubric,submitted:store.submitted,time:store.time,
      annotations:store.annotations,revisions:store.revisions,attemptViews:store.attemptViews,
      feedback:store.feedback,practiceAnswers:store.practiceAnswers,
      feedbackHidden:store.feedbackHidden
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

// WriteLab Feedback JSON v1：只接收结构化 JSON，不运行 HTML、Markdown 或脚本。
// 逐项校验后才写入，保证课程 ID 匹配、存档不被错误批改覆盖。
function validateFeedback(input) {
  const error = message => {throw Error(message);};
  const text = (value,context,max=4500) => {
    if(value == null) return "";
    if(typeof value!=="string" || value.length>max) error(`${context} 必须是长度不超过 ${max} 的文字`);
    return value;
  };
  if(!input || typeof input!=="object" || Array.isArray(input) || input.format!=="writelab-feedback" || input.version!==1) {
    error('格式不符：需要 format="writelab-feedback", version=1');
  }
  if(input.dayId!==store.current?.id) error(`课程不匹配：当前是 ${store.current?.id}，JSON 是 ${input.dayId||"未知"}`);
  const known = new Set(getTasks().map(t=>t.id));
  if(!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length>known.size) error("tasks 必须是当前课程的题目数组");
  const seen=new Set();
  const tasks=input.tasks.map((task,index)=>{
    if(!task || typeof task!=="object" || !known.has(task.taskId) || seen.has(task.taskId)) error(`tasks[${index}]: 题号无效或重复`);
    seen.add(task.taskId);
    if(!["wrong","weak","good","excellent","unreviewed"].includes(task.verdict)) error(`${task.taskId}: verdict 无效`);
    if(task.issues!==undefined && (!Array.isArray(task.issues) || task.issues.length>35)) error(`${task.taskId}: issues 必须是数组（最多 35 条）`);
    return {
      taskId:task.taskId,verdict:task.verdict,
      comment:text(task.comment,`${task.taskId}.comment`,5000),
      logic:text(task.logic,`${task.taskId}.logic`,3000),
      suggested:text(task.suggested,`${task.taskId}.suggested`,4000),
      issues:(task.issues||[]).map((issue,i)=>{
        if(!issue || typeof issue!=="object") error(`${task.taskId}.issues[${i}] 必须是对象`);
        return {category:text(issue.category,'category',40)||"writing",
          original:text(issue.original,'original',900),
          replacement:text(issue.replacement,'replacement',1100),
          reason:text(issue.reason,'reason',2300),
          occurrence:issue.occurrence===undefined?1:(Number.isInteger(issue.occurrence)&&issue.occurrence>=1&&issue.occurrence<=30?issue.occurrence:error('occurrence 必须是 1–30 的整数'))};
      })
    };
  });
  const overall=input.overall||{};
  if(!overall || typeof overall!=="object" || Array.isArray(overall)) error('overall 必须是对象');
  const list=(items,key,maxCount=12)=>{
    if(items===undefined)return [];
    if(!Array.isArray(items) || items.length>maxCount)error(`${key} 必须是数组（最多 ${maxCount} 条）`);
    return items.map((x,i)=>text(x,`${key}[${i}]`,1100));
  };
  const collocations=input.collocations||[];
  if(!Array.isArray(collocations)||collocations.length>30)error('collocations 必须是数组（最多 30 条）');
  const practice=input.practice||[];
  if(!Array.isArray(practice)||practice.length>30)error('practice 必须是数组（最多 30 题）');
  const ids=new Set();
  const paragraph=input.paragraph||{};
  if(!paragraph || typeof paragraph!=="object" || Array.isArray(paragraph))error('paragraph 必须是对象');
  return {format:"writelab-feedback",version:1,dayId:input.dayId,
    overall:{summary:text(overall.summary,'overall.summary',7000),
      strengths:list(overall.strengths,'strengths'),priorities:list(overall.priorities,'priorities')},
    tasks,
    paragraph:Object.fromEntries(["claim","evidence","reasoning","organization","vocabulary","grammar"].map(key=>[key,text(paragraph[key],`paragraph.${key}`,1800)])),
    collocations:collocations.map((c,i)=>{
      if(!c||typeof c!=="object")error(`collocations[${i}] 格式错误`);
      return {expression:text(c.expression,'expression',180),meaning:text(c.meaning,'meaning',600),example:text(c.example,'example',750)};
    }),
    practice:practice.map((item,i)=>{
      if(!item||typeof item!=="object" || typeof item.id!=="string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(item.id) || ids.has(item.id))error(`practice[${i}] 的 id 无效或重复`);
      ids.add(item.id);
      return {id:item.id,prompt:text(item.prompt,'practice.prompt',1800),tip:text(item.tip,'practice.tip',800)};
    })
  };
}

function parseFeedbackJSON(raw) {
  // 允许直接复制 ChatGPT 的 ```json ... ``` 代码块。
  const cleaned=raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
  if(cleaned.length>350000)throw Error('内容超过 350 KB，建议精简批改 JSON');
  let data;
  try {data=JSON.parse(cleaned);}catch(e){throw Error(`不是有效 JSON：${e.message}`);}
  return validateFeedback(data);
}

function importFeedbackJSON() {
  if(!store.current || !store.submitted)return;
  const area=document.getElementById("feedback-json-input");
  const status=document.getElementById("feedback-import-status");
  try {
    const feedback=parseFeedbackJSON(area?.value||"");
    applyImportedFeedback(feedback);
  } catch(e) {
    status.textContent=`导入失败：${e.message}`;
    status.classList.remove("hidden");
  }
}

// 粘贴与文件导入共用同一个保存流程；只有验证通过才改动批改记录。
function applyImportedFeedback(feedback) {
  if(store.feedback && !confirm("当前课程已有 AI 批改。导入新报告会替换旧报告，但保留所有原始作答、批注、第二遍和复练答案。继续吗？")) return false;
  store.feedback=feedback;
  // 新导入的报告默认展开，避免之前隐藏的状态让用户误以为导入失败。
  store.feedbackHidden=false;
  saveRecord();
  renderDay(store.current.id);
  document.getElementById("feedback-overview")?.scrollIntoView({behavior:"smooth",block:"start"});
  return true;
}

// 读取用户主动选择的 JSON 文件；解析失败时不会写入旧的初稿或批改。
async function importFeedbackFile(file) {
  if(!file || !store.current || !store.submitted) return;
  const status=document.getElementById("feedback-import-status");
  try {
    if(file.size>750000)throw Error("JSON 文件太大（最大 750 KB）");
    const feedback=parseFeedbackJSON(await file.text());
    applyImportedFeedback(feedback);
  } catch(error) {
    if(status) {
      status.textContent=`文件导入失败：${error.message}`;
      status.classList.remove("hidden");
      document.getElementById("feedback-overview")?.scrollIntoView({behavior:"smooth",block:"start"});
    }
  }
}

// TODAY'S REVIEW 位于页面底部；提供快捷入口，避免用户找不到上方的导入面板。
function showFeedbackImporter() {
  const details=document.querySelector("#feedback-overview .feedback-import-details");
  if(details) details.open=true;
  document.getElementById("feedback-overview")?.scrollIntoView({behavior:"smooth",block:"start"});
  document.getElementById("feedback-json-input")?.focus({preventScroll:true});
}

// AI 批改显示切换：只更改当前课程的展示状态，刷新后仍保留。
function toggleFeedbackVisibility() {
  if(!store.feedback)return;
  store.feedbackHidden=!store.feedbackHidden;
  saveRecord();
  const y=window.scrollY;
  renderDay(store.current.id);
  window.scrollTo(0,y);
}

// 单独清除当前课程已导入的批改；原答案、二次写作、手动批注和复练记录全部保留。
function clearImportedFeedback() {
  if(!store.feedback)return;
  if(!confirm("确定删除当前 Day 已导入的 AI 批改吗？原始答案、批注、第二遍和复练答案不会删除。"))return;
  store.feedback=null;
  store.feedbackHidden=false;
  saveRecord();
  renderDay(store.current.id);
  document.getElementById("feedback-overview")?.scrollIntoView({behavior:"smooth",block:"start"});
}

// 清空尚未提交的 JSON 粘贴框，不影响已经导入的批改数据。
function clearFeedbackPasteBox() {
  const area=document.getElementById("feedback-json-input");
  if(area)area.value="";
  document.getElementById("feedback-import-status")?.classList.add("hidden");
}

const FEEDBACK_LABELS={wrong:"需要修改",weak:"基本正确，可加强",good:"表达正确",excellent:"优秀表达",unreviewed:"未批改"};
// 用原句定位错误片段并渲染建议改法。无法匹配的修改只在问题清单里显示，绝不猜测位置。
function feedbackAnnotatedHTML(original,issues) {
  const text=String(original||"");
  const matches=[];
  for(const issue of issues) {
    if(!issue.original)continue;
    const needle=issue.original;
    const haystack=text.toLowerCase(),lower=needle.toLowerCase();
    let offset=0,start=-1;
    for(let i=0;i<issue.occurrence;i++){
      start=haystack.indexOf(lower,offset);
      if(start<0)break;
      offset=start+lower.length;
    }
    if(start<0)continue;
    const end=start+needle.length;
    if(matches.some(m=>start<m.end && end>m.start))continue;
    matches.push({start,end,replacement:issue.replacement});
  }
  matches.sort((a,b)=>a.start-b.start);
  let cursor=0, html="";
  for(const m of matches) {
    html+=escapeHTML(text.slice(cursor,m.start));
    html+=`<del>${escapeHTML(text.slice(m.start,m.end))}</del>`;
    if(m.replacement)html+=` <span class="annotation-add">(${escapeHTML(m.replacement)})</span>`;
    cursor=m.end;
  }
  return {html:(html+escapeHTML(text.slice(cursor))).replace(/\n/g,"<br>"),count:matches.length};
}

function renderTaskFeedback(task) {
  // 隐藏批改仅改变 UI，不删除导入的报告。
  if(store.feedbackHidden)return "";
  const review=store.feedback?.tasks.find(item=>item.taskId===task.id);
  if(!review)return "";
  const count=review.issues.length;
  const v=store.answers[task.id]||"";
  const preview=task.type==="write"&&v.trim()&&count?feedbackAnnotatedHTML(v,review.issues):null;
  return `<section class="ai-task-review" aria-label="AI 对第 ${escapeHTML(task.id)} 题的反馈">
    <div class="ai-task-head"><span>✦ 教练批改 · ${escapeHTML(task.id)}</span><span class="ai-verdict verdict-${escapeHTML(review.verdict)}">${escapeHTML(FEEDBACK_LABELS[review.verdict])}</span></div>
    ${review.comment?`<p class="ai-comment">${escapeHTML(review.comment)}</p>`:""}
    ${preview?.count?`<div class="ai-preview-label">原句改错对照（红色括号为建议写法）</div><div class="ai-annotated-preview">${preview.html}</div>
      <button type="button" class="mini-button ai-apply-button" data-apply-feedback="${escapeHTML(task.id)}">↳ 复制这些修改到我的批注层</button>`:""}
    ${count?`<div class="ai-issue-list">${review.issues.map((issue,i)=>`<div class="ai-issue">
      <div class="ai-issue-heading"><span>${i+1}. ${escapeHTML(issue.category)}</span>${issue.original?` <code>${escapeHTML(issue.original)}</code>`:""}
      ${issue.replacement?` <span class="ai-arrow">→</span> <strong>${escapeHTML(issue.replacement)}</strong>`:""}</div>
      ${issue.reason?`<p>${escapeHTML(issue.reason)}</p>`:""}
    </div>`).join("")}</div>`:""}
    ${review.logic?`<p class="ai-extra"><strong>逻辑：</strong>${escapeHTML(review.logic)}</p>`:""}
    ${review.suggested?`<details class="ai-suggested"><summary>查看参考修改（不是唯一答案）</summary><p>${escapeHTML(review.suggested)}</p></details>`:""}
  </section>`;
}

function applyFeedbackToAnnotation(id) {
  const review=store.feedback?.tasks.find(t=>t.taskId===id);
  const task=getTasks().find(t=>t.id===id);
  if(!review||!task||task.type!=="write")return;
  const result=feedbackAnnotatedHTML(store.answers[id]||"",review.issues);
  if(!result.count) {alert('批改里的原句片段无法与初稿精确匹配，请手工修改。');return;}
  if(Object.prototype.hasOwnProperty.call(store.annotations,id) &&
     !confirm('这道题已经有手工批注。覆盖批注层？初稿和第二遍不会受到影响。'))return;
  store.annotations[id]=result.html;
  store.attemptViews[id]=1;
  saveRecord();
  const pos=window.scrollY;
  renderDay(store.current.id);window.scrollTo(0,pos);
  document.querySelector(`[data-annotation-editor="${id}"]`)?.scrollIntoView({behavior:"smooth",block:"center"});
}

function renderFeedbackImporter() {
  if(!store.submitted)return "";
  const f=store.feedback;
  const p=f?.paragraph||{};
  const paragraphEntries=[['观点',p?.claim],['证据/例子',p?.evidence],['推理',p?.reasoning],['组织',p?.organization],['词汇',p?.vocabulary],['语法',p?.grammar]].filter(([,v])=>v);
  return `<section class="panel feedback-import-panel" id="feedback-overview">
    <div class="feedback-import-heading"><div><div class="eyebrow">YOUR AI WRITING REVIEW</div><h2>粘贴教练批改 JSON</h2></div><span class="feedback-data-tag">${f?`已导入 ${f.tasks.length} 题`:'尚未导入'}</span></div>
    <p class="feedback-disclaimer">将 ChatGPT 返回的 <code>writelab-feedback</code> JSON 粘贴到下方，按题号自动显示批改。所有数据仅在本地保存，导入不会改动你的初稿与第二遍写作。</p>
    <details class="feedback-import-details" ${f?'':'open'}><summary>${f?'重新导入 / 替换 JSON':'打开 JSON 粘贴框'}</summary>
    <textarea id="feedback-json-input" class="feedback-json-input" spellcheck="false" placeholder='粘贴 {"format":"writelab-feedback","version":1,"dayId":"${escapeHTML(store.current.id)}",...}'></textarea>
    <div class="feedback-import-actions"><button type="button" class="button primary" data-action="feedback-import">导入粘贴的 JSON</button>
    <button type="button" class="button outline" data-action="feedback-file">📁 选择 JSON 文件</button>
    <button type="button" class="button outline" data-action="feedback-template">复制 JSON 格式要求</button>
    <button type="button" class="button outline" data-action="feedback-input-clear">清空粘贴框</button></div>
    <!-- 批改 JSON 文件输入与本地学习记录备份输入严格区分。 -->
    <input type="file" id="feedback-file-input" accept=".json,application/json" class="hidden" aria-label="选择 AI 批改 JSON 文件">
    <p id="feedback-import-status" class="feedback-import-error hidden" role="status"></p></details>
    <!-- 隐藏只改变显示，清空仅删除本 Day 已导入的 AI 批改。 -->
    ${f?`<div class="feedback-import-actions" style="margin:12px 0">
      <button type="button" class="button outline" data-action="feedback-toggle">${store.feedbackHidden?"👁 显示批改":"🙈 隐藏批改"}</button>
      <button type="button" class="button outline" data-action="feedback-clear">清空已导入批改</button>
    </div>`:""}
    ${f&&!store.feedbackHidden?`<div class="feedback-summary"><h3>总体诊断</h3>${f.overall.summary?`<p>${escapeHTML(f.overall.summary)}</p>`:""}
      ${f.overall.strengths.length?`<div class="feedback-summary-list"><strong>做得好的地方</strong><ul>${f.overall.strengths.map(x=>`<li>${escapeHTML(x)}</li>`).join("")}</ul></div>`:""}
      ${f.overall.priorities.length?`<div class="feedback-summary-list"><strong>优先改进</strong><ol>${f.overall.priorities.map(x=>`<li>${escapeHTML(x)}</li>`).join("")}</ol></div>`:""}
      ${paragraphEntries.length?`<details class="ai-suggested"><summary>学术段落专项评价</summary><dl class="paragraph-diagnosis">${paragraphEntries.map(([label,value])=>`<dt>${label}</dt><dd>${escapeHTML(value)}</dd>`).join('')}</dl></details>`:""}
      <p class="feedback-disclaimer">题目下方显示具体问题与修改预览；原有主观题评分仍为自评，不是网站自动生成的 AI 评分。</p>
      <button type="button" class="mini-button" data-action="feedback-scroll-practice">查看复练与搭配 ↓</button>
    </div>`:""}
  </section>`;
}
function renderFeedbackExtras() {
  if(store.feedbackHidden)return "";
  const f=store.feedback;
  if(!f || (!f.collocations.length && !f.practice.length))return "";
  return `<section class="panel feedback-extras" id="feedback-practice"><div class="eyebrow">PERSONALIZED REVIEW</div><h2>搭配库与针对性复练</h2>
    ${f.collocations.length?`<h3>Active Vocabulary Bank</h3><div class="feedback-collocations">${f.collocations.map(c=>`<article><strong>${escapeHTML(c.expression)}</strong>${c.meaning?`<span>${escapeHTML(c.meaning)}</span>`:""}<p>${escapeHTML(c.example)}</p></article>`).join('')}</div>`:""}
    ${f.practice.length?`<h3>针对性复练</h3><p class="feedback-disclaimer">答案自动保存在本地；这些题由导入的批改报告提供，并非网站自动生成。</p>
      ${f.practice.map((q,i)=>`<div class="feedback-practice-item"><strong>${i+1}. ${escapeHTML(q.prompt)}</strong>
        ${q.tip?`<p>${escapeHTML(q.tip)}</p>`:""}<textarea class="answer-editor" data-practice="${escapeHTML(q.id)}" spellcheck="true" placeholder="独立写下你的答案…">${escapeHTML(store.practiceAnswers[q.id]||"")}</textarea></div>`).join('')}`:""}
  </section>`;
}

function feedbackJSONPrompt() {
  return `请严格批改我下面的 WriteLab 英语训练答案，返回且只返回一个有效 JSON 对象，必要时放在一个 \`\`\`json 代码块里，不要写其他说明。
格式必须为：
{
 "format":"writelab-feedback","version":1,"dayId":"${store.current.id}",
 "overall":{"summary":"整体评价","strengths":["优点"],"priorities":["最值得练习的问题"]},
 "tasks":[{"taskId":"${getTasks()[0].id}","verdict":"wrong","comment":"本题评价","issues":[{"category":"collocation","original":"原文里实际出现的短语","replacement":"建议改法","reason":"为什么需要修改","occurrence":1}],"logic":"逻辑是否成立","suggested":"必要时才给出修改版本"}],
 "paragraph":{"claim":"立场评价","evidence":"证据评价","reasoning":"推理评价","organization":"组织评价","vocabulary":"词汇评价","grammar":"语法评价"},
 "collocations":[{"expression":"lead to","meaning":"导致","example":"Practice can lead to improvement."}],
 "practice":[{"id":"R1","prompt":"针对性练习题","tip":"提示"}]
}
重要：以上示例 taskId 和示例表达不能机械套用，请使用下方真实题目 ID。tasks 数组可以包含全部题目，必须使用各题的真实 taskId，绝不能虚构。verdict 只能是 wrong / weak / good / excellent / unreviewed。每个 issues.original 必须是原始作答中实际存在的连续文本（大小写可不同），replacement 是准确替换内容；不适合局部划线的问题，original 和 replacement 都用空字符串，把分析写到 reason。逻辑正确的不同写法不要机械判错。不要把完整段落强行重写；优先解释关键错误和自然搭配。生成 5 组搭配和 5 道针对性复练题。未作答题标为 unreviewed；主观题不要假装有官方自动评分。\n\n${copyText()}`;
}
// 自定义课程 v1：两种输入均支持：完整 sections 课程，以及简单 questions 题库。
// 只保存经过校验的字符串/数组数据，不将用户 JSON 当作 HTML 或 JavaScript 执行。
function normalizeCustomCourse(input) {
  const fail = msg => { throw Error(msg); };
  const obj = x => !!x && typeof x === "object" && !Array.isArray(x);
  const str = (x, field, limit = 2000) => {
    if (x == null) return "";
    if (typeof x !== "string" || x.length > limit) fail(`${field} 必须是文字，长度不超过 ${limit}`);
    return x.trim();
  };
  if (!obj(input)) fail("课程必须是 JSON 对象");
  if (input.format && input.format !== "writelab-course") fail("format 应为 writelab-course（也可以省略）");
  if (input.version !== undefined && input.version !== 1) fail("暂时只支持 version: 1");
  const rawId = str(input.id, "id", 90);
  // 任何旧模板的 day08、day01 ID 都转入 custom-* 空间，避免覆盖内置 Day 01–07。
  const shortId = rawId.replace(/^custom-/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const id = `custom-${shortId || `lesson-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`}`;
  if (!CUSTOM_COURSE_ID.test(id)) fail("课程 id 无效，请使用字母、数字或连字符");
  const title = str(input.title, "title", 180);
  if (!title) fail("缺少课程 title");
  const subject = str(input.subject || input.track || "综合学习", "subject", 80);
  let suppliedSections = input.sections;
  if (!suppliedSections && Array.isArray(input.questions)) {
    suppliedSections = [{id:"practice", title:"Practice · 练习",subtitle:"独立完成后再核对参考答案", minutes: input.minutes || 30, tasks:input.questions}];
  }
  if (!Array.isArray(suppliedSections) || !suppliedSections.length || suppliedSections.length > 20) fail("需要 sections 或 questions 数组（最多 20 个模块）");
  const ids = new Set(); let count = 0;
  const sections = suppliedSections.map((sec, si) => {
    if (!obj(sec) || !Array.isArray(sec.tasks) || !sec.tasks.length || sec.tasks.length > 100) fail(`sections[${si}].tasks 必须是非空数组`);
    const sectionId = str(sec.id || `section-${si+1}`, "section.id", 50).replace(/[^a-zA-Z0-9_-]/g,"-");
    const minutes = Number.isFinite(Number(sec.minutes)) ? Math.max(1,Math.min(180,Math.round(Number(sec.minutes)))) : 15;
    return {id:sectionId,title:str(sec.title || `Section ${si+1}`,"section.title",150), subtitle:str(sec.subtitle,"section.subtitle",360),minutes,
      durationLabel:str(sec.durationLabel,"durationLabel",40) || `${minutes} min`,
      tasks:sec.tasks.map((t, ti) => {
        if (!obj(t)) fail(`sections[${si}].tasks[${ti}] 不是对象`);
        if (++count > 200) fail("每门课最多 200 题");
        const rawType = str(t.type || "write", "type", 35).toLowerCase();
        const type = ["choice","multiple_choice","multiple-choice","quiz"].includes(rawType) ? "choice"
          : ["write","essay","text","short","short_answer","open"].includes(rawType) ? "write" : fail(`不支持题型 ${rawType}`);
        const taskId = str(t.id || `${id}-q${count}`, "task.id", 90);
        if (!/^[a-zA-Z0-9_-]{1,90}$/.test(taskId) || ids.has(taskId)) fail(`题目 ID 无效或重复：${taskId}`);
        ids.add(taskId);
        const prompt = str(t.prompt ?? t.question, "question/prompt", 12000);
        if (!prompt) fail(`第 ${count} 题缺少 prompt 或 question`);
        const options = type === "choice" ? t.options : [];
        if (type === "choice" && (!Array.isArray(options) || options.length < 2 || options.length > 8)) fail(`第 ${count} 题需要 2–8 个 options`);
        const cleanOptions = type === "choice" ? options.map((o,i)=>str(o,`options[${i}]`,400)) : [];
        if (type === "choice" && (cleanOptions.some(x=>!x) || new Set(cleanOptions).size !== cleanOptions.length)) fail(`第 ${count} 题选项无效或重复`);
        const answer = str(t.answer, "answer", 12000);
        if (type === "choice" && !cleanOptions.includes(answer)) fail(`第 ${count} 题 answer 必须与选项文本完全相同`);
        // 开放题允许不附参考答案：显示明确的“未提供”，不制造自动评分的错觉。
        return {id:taskId,type,prompt,options:cleanOptions,answer:answer || "（课程未提供参考答案，请自行复盘或向 AI 请求批改。）",
          explanation:str(t.explanation,"explanation",7000),hint:str(t.hint,"hint",2000),note:str(t.note,"note",2000),
          minWords:Number.isInteger(t.minWords)&&t.minWords>=0&&t.minWords<=3000?t.minWords:0};
      })};
  });
  const kit = input.languageKit === undefined ? [] : input.languageKit;
  if (!Array.isArray(kit) || kit.length>40) fail("languageKit 最多 40 组");
  const languageKit = kit.map((row,i)=>{
    if (!Array.isArray(row) || row.length>4) fail(`languageKit[${i}] 应为最多四项的数组`);
    return [0,1,2,3].map(n=>str(row[n],`languageKit[${i}]`,1200));
  });
  const canDo = input.canDo === undefined ? [] : input.canDo;
  if (!Array.isArray(canDo) || canDo.length>15) fail("canDo 必须是数组（最多 15 条）");
  const totalMinutes=sections.reduce((acc,sec)=>acc+sec.minutes,0);
  return {format:"writelab-course",version:1,id,subject,custom:true,day:0,
    slug:str(input.slug,"slug",100),track:str(input.track,"track",100)||subject,title,
    subtitle:str(input.subtitle || input.description,"subtitle",1600),
    focus:str(input.focus,"focus",200)||"自主练习",topic:str(input.topic,"topic",200)||subject,
    canDo:canDo.map((x,i)=>str(x,`canDo[${i}]`,200)),languageKit,
    framework:str(input.framework,"framework",500),coach:str(input.coach,"coach",900)||"先作答，再查看解析与参考答案。",
    sections,minutes:totalMinutes};
}

function parseCustomCourseJSON(raw) {
  // 复制 ChatGPT 的 ```json 代码块也可以直接导入。
  if (raw.length > 900000) throw Error("单份课程 JSON 不得超过 900 KB");
  const text = raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
  let parsed;try { parsed=JSON.parse(text); } catch(e) {throw Error(`JSON 解析失败：${e.message}`);}
  return normalizeCustomCourse(parsed);
}

function readCustomCourses() {
  try {
    const raw = localStorage.getItem(CUSTOM_COURSES_KEY);
    if (!raw) return [];
    const items=JSON.parse(raw);
    if (!Array.isArray(items)) throw Error("本地课程库格式损坏");
    return items.map(normalizeCustomCourse);
  } catch (e) {
    // 不删除无法读取的数据，以便用户手动备份后排查。
    console.warn("WriteLab 本地课程库读取失败：", e);
    return [];
  }
}
function registerCustomCourse(course) {
  const existing=store.customLessons.get(course.id);
  if (existing && !confirm(`“${course.title}”与已有课程 ID 相同。覆盖题目可能影响旧答案的对应关系；旧作答不会被自动清空。确定覆盖课程内容？`)) return false;
  const list=[...store.customLessons.values()].filter(c=>c.id!==course.id).concat(course);
  if (list.length > 100) throw Error("本地课程最多 100 门，请先导出备份并整理课程库");
  // 先写入 localStorage，再更新运行时缓存；配额不足时不破坏已有记录。
  localStorage.setItem(CUSTOM_COURSES_KEY,JSON.stringify(list));
  store.customLessons.set(course.id,course);store.lessons.set(course.id,course);
  return true;
}
function importCourseFromHome() {
  const box=document.getElementById("course-json-input");
  const status=document.getElementById("course-import-status");
  try {
    const lesson=parseCustomCourseJSON(box?.value||"");
    if(!registerCustomCourse(lesson)) return;
    renderHome();
    document.getElementById("course-import-status").textContent=`✓ 已添加《${lesson.title}》，可直接打开答题。`;
    document.getElementById("course-import-status").classList.remove("hidden");
    document.getElementById("custom-lessons")?.scrollIntoView({behavior:"smooth",block:"start"});
  } catch(e) {status.textContent=`导入失败：${e.message}`;status.classList.remove("hidden");}
}
async function importCourseFile(file) {
  if(!file)return;
  const status=document.getElementById("course-import-status");
  try {
    if(file.size > 900000)throw Error("文件超过 900 KB");
    const lesson=parseCustomCourseJSON(await file.text());
    if(!registerCustomCourse(lesson))return;
    renderHome();
    document.getElementById("course-import-status").textContent=`✓ 已添加《${lesson.title}》。`;
    document.getElementById("course-import-status").classList.remove("hidden");
  } catch(e) {status.textContent=`导入失败：${e.message}`;status.classList.remove("hidden");}
}
function downloadJSON(data,name) {
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json;charset=utf-8"});
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportCustomCourse(id) {
  const lesson=store.customLessons.get(id);
  if(lesson)downloadJSON(lesson,`${id}.json`);
}
function deleteCustomCourse(id) {
  const lesson=store.customLessons.get(id);
  if(!lesson)return;
  if(!confirm(`从首页移除《${lesson.title}》？题目数据将移除，但原答案依然保留；再次导入同 ID 课程可以恢复作答。建议先导出课程备份。`))return;
  const list=[...store.customLessons.values()].filter(x=>x.id!==id);
  try {localStorage.setItem(CUSTOM_COURSES_KEY,JSON.stringify(list));}
  catch(e) {alert(`无法删除课程：${e.message}`);return;}
  store.customLessons.delete(id);store.lessons.delete(id);renderHome();
}
// 两个跨学科示例，首页按钮只填入文本，必须由用户自行点击导入。
const CUSTOM_COURSE_EXAMPLE = {
  format:"writelab-course",version:1,id:"cs-parallel-01",subject:"计算机科学 · 并行计算",
  title:"Parallel Computing · 基础训练",description:"理解线程、并行加速比与内存瓶颈。",minutes:25,
  questions:[
    {id:"pc-q1",type:"choice",question:"Which term describes time spent coordinating parallel tasks?",
      options:["Synchronization overhead","Cache capacity","Clock frequency"],answer:"Synchronization overhead",
      explanation:"Synchronization overhead 指协调并行任务带来的额外时间。"},
    {id:"pc-q2",type:"write",question:"用英文解释：为什么增加线程数不一定带来线性的性能提升？",
      hint:"Consider synchronization and memory bandwidth.",explanation:"可以讨论串行部分、同步开销与内存带宽限制。"}
  ]
};

// 在同一浏览器保存的旧记录也可直接导出，用于切换电脑、浏览器或网站域名。
function exportBackup() {
  const records={};
  try {
    for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);
      if(key && key.startsWith(SAVE_PREFIX)) records[key]=localStorage.getItem(key);
    }
  } catch (_) { alert("浏览器无法读取本地存储，请检查隐私设置。");return; }
  // v2 备份同时包含自定义题库和各课程的作答；仍兼容读取旧版 v1 备份。
  const snapshot={format:"writelab-local-backup",version:2,exportedAt:new Date().toISOString(),
    courses:[...store.customLessons.values()],records};
  downloadJSON(snapshot,`writelab-backup-${new Date().toISOString().slice(0,10)}.json`);
}

async function importBackup(file) {
  if(!file) return;
  try {
    const obj=JSON.parse(await file.text());
    if(obj.format!=="writelab-local-backup" || !obj.records || typeof obj.records!=="object" || Array.isArray(obj.records)) {
      throw Error("不是 WriteLab 导出的备份文件");
    }
    const entries=Object.entries(obj.records);
    if(entries.some(([key,value])=>!/^writelab\.progress\.v1\.(?:day\d{2,3}|custom-[a-z0-9-]{1,64})$/.test(key) || typeof value!=="string")) {
      throw Error("备份数据格式不符合要求");
    }
    if(obj.version!==1 && obj.version!==2)throw Error("不支持的备份版本");
    if(obj.version===1 && !entries.length)throw Error("旧版备份中没有学习记录");
    // 所有课程先校验，再整体恢复；内置课程文件不受影响。
    const courses = obj.version===2 ? obj.courses : [];
    if(!Array.isArray(courses)||courses.length>100)throw Error("备份课程库格式错误");
    const normalized=courses.map(normalizeCustomCourse);
    if(new Set(normalized.map(x=>x.id)).size!==normalized.length)throw Error("备份课程 ID 重复");
    // 写入前校验全部记录，避免导入一半才发现文件错误。
    for(const [,value] of entries) {
      const record=JSON.parse(value);
      if(!record || typeof record!=="object" || !record.answers || typeof record.answers!=="object") throw Error("发现损坏的存档");
    }
    if(!confirm(`将从备份恢复 ${entries.length} 组学习记录、${normalized.length} 门自定义课程。相同 ID 的数据会被覆盖，建议先导出现有备份。继续吗？`))return;
    // 容量问题可能导致写入失败：保存旧值并在失败时尽力回滚。
    const before=entries.map(([key])=>[key,localStorage.getItem(key)]);
    const previousCourses=localStorage.getItem(CUSTOM_COURSES_KEY);
    try {
      if(obj.version===2)localStorage.setItem(CUSTOM_COURSES_KEY,JSON.stringify(normalized));
      for(const [key,value] of entries)localStorage.setItem(key,value);
    }catch(error) {
      if(obj.version===2) {if(previousCourses===null)localStorage.removeItem(CUSTOM_COURSES_KEY);else localStorage.setItem(CUSTOM_COURSES_KEY,previousCourses);}
      for(const [key,old] of before){if(old===null)localStorage.removeItem(key);else localStorage.setItem(key,old);}
      throw error;
    }
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
  // 自定义课程只读取浏览器缓存，不影响 GitHub Pages 的静态课程目录。
  for(const lesson of readCustomCourses()) {
    if(!store.customLessons.has(lesson.id)) {
      store.customLessons.set(lesson.id,lesson);store.lessons.set(lesson.id,lesson);
    }
  }
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


/**
 * WriteLab 通用课程 JSON 模板。
 * 与 normalizeCustomCourse() 兼容。
 * 可用于英语、计算机、数学及其他学科。
 */
const COURSE_SECTION_TEMPLATE = {
  format: "writelab-course",
  version: 1,
  id: "parallel-computing-01",
  subject: "计算机科学",
  title: "Parallel Computing · 基础训练",
  subtitle: "理解并行计算的基本概念与性能瓶颈",
  track: "Computer Science",
  focus: "概念理解 + 主动输出",
  topic: "Parallel Computing",

  canDo: [
    "理解核心概念",
    "准确解释工作原理",
    "分析实际问题"
  ],

  languageKit: [
    [
      "memory bandwidth",
      "内存带宽",
      "Memory bandwidth can limit performance.",
      "注意与 memory latency 区分"
    ]
  ],

  framework: "Definition → Mechanism → Example",
  coach: "先独立完成，再查看答案与解析。",

  sections: [
    {
      id: "concepts",
      title: "01 · Concept Check",
      subtitle: "基础概念判断",
      minutes: 10,
      durationLabel: "10 min",
      tasks: [
        {
          id: "pc-q01",
          type: "choice",
          prompt: "Which concept helps prevent race conditions?",
          options: [
            "Synchronization",
            "Increasing clock speed",
            "Reducing code comments"
          ],
          answer: "Synchronization",
          explanation: "同步机制用于协调并发访问。"
        }
      ]
    },
    {
      id: "explanation",
      title: "02 · Explain the Concept",
      subtitle: "独立解释与应用",
      minutes: 15,
      durationLabel: "15 min",
      tasks: [
        {
          id: "pc-q02",
          type: "write",
          prompt: "Explain why more threads do not always improve performance.",
          answer: "Synchronization overhead and memory bandwidth limitations can reduce parallel speedup.",
          explanation: "应讨论同步开销和内存带宽等因素。",
          hint: "Consider synchronization and bandwidth.",
          minWords: 40
        }
      ]
    }
  ]
};


/**
 * 构造发给其他 ChatGPT 窗口的课程生成要求。
 * 复制 Prompt 时包含完整的 sections JSON 模板。
 */
function buildCourseGenerationPrompt() {
  return `你是一名专业课程设计师。

请为我的 WriteLab 学习网站生成课程 JSON。

要求：
1. 严格遵守下面的 JSON 数据结构。
2. 只返回一个合法 JSON 对象，不要 Markdown 代码块或额外解释。
3. 使用 sections 数组组织课程模块。
4. 每个 section 包含 id、title、subtitle、minutes 和 tasks。
5. 每个 task 使用独立且不重复的 id。
6. type 只能使用 "choice" 或 "write"。
7. choice 必须提供 options、answer、explanation。
8. choice 的 answer 必须与 options 中的某个选项完全相同。
9. write 应提供 prompt、参考答案、解释，必要时添加 hint 和 minWords。
10. 根据具体学科设计高质量题目，避免重复或空泛的问题。
11. id 使用英文字母、数字、连字符或下划线，不包含空格。
12. languageKit 可用于固定搭配、专业术语、定义或公式；每组是最多 4 个字符串的数组。
13. 开放题的参考答案不是唯一正确答案，不要假装网站可以自动完成语义评分。
14. 直接生成可被 WriteLab 首页导入的完整课程 JSON。

以下是格式模板。请按照我的新课程需求替换全部示例内容：

${JSON.stringify(COURSE_SECTION_TEMPLATE, null, 2)}

我的课程需求：
【在这里填写学科、主题、题目数量、难度和练习重点】`;
}


/**
 * 将课程模板或课程生成 Prompt 复制到剪贴板。
 * 复制失败时显示可手动复制的文本，不覆盖课程导入框。
 */
async function copyCourseTemplate(mode) {
  const content = mode === "prompt"
    ? buildCourseGenerationPrompt()
    : JSON.stringify(COURSE_SECTION_TEMPLATE, null, 2);

  const status = document.getElementById("course-template-status");
  const fallback = document.getElementById("course-template-fallback");

  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard unavailable");
    }

    await navigator.clipboard.writeText(content);

    status.textContent = mode === "prompt"
      ? "✓ 已复制完整课程生成 Prompt！"
      : "✓ 已复制 sections JSON 模板！";

    fallback.classList.add("hidden");
  } catch (error) {
    // 浏览器不支持自动复制时，显示文本供手动复制。
    fallback.value = content;
    fallback.classList.remove("hidden");
    fallback.focus();
    fallback.select();

    status.textContent = "自动复制失败，请从下方文本框手动复制。";
  }

  status.classList.remove("hidden");
}

function renderHome() {
  siteStatus.textContent=`${store.manifest.lessons.length} DAYS · ${store.customLessons.size} CUSTOM`;
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
  const customCards=[...store.customLessons.values()].map(lesson=>{
    const record=loadRecord(lesson.id),tasks=getTasks(lesson);
    const answered=tasks.filter(t=>String(record.answers[t.id]??"").trim()).length;
    return `<article class="lesson-card custom-lesson-card"><a href="#/${escapeHTML(lesson.id)}" class="custom-lesson-link">
      <div class="card-top"><span class="card-day">${escapeHTML(lesson.subject)}</span><span class="card-state">${answered}/${tasks.length} 已答</span></div>
      <h3>${escapeHTML(lesson.title)}</h3><p>${escapeHTML(lesson.subtitle)}</p>
      <div class="card-foot"><span>${tasks.length} 题 · ${lesson.minutes} min</span><span>↗</span></div></a>
      <div class="custom-card-actions"><button type="button" data-course-export="${escapeHTML(lesson.id)}">↓ 导出 JSON</button>
      <button type="button" class="custom-delete" data-course-delete="${escapeHTML(lesson.id)}">移除</button></div></article>`;
  }).join("");
  const weeks=m.weeks.map(w=>`<article class="week-card ${w.status==="available"?"current":""}"><span class="week-name">${escapeHTML(w.name)} ${w.status==="available"?"· OPEN":"· SOON"}</span><h3>${escapeHTML(w.headline)}</h3><p>${escapeHTML(w.goal)}</p><div class="week-days">DAY ${escapeHTML(w.days)}</div></article>`).join("");
  ui.innerHTML=`<section class="hero"><div><div class="eyebrow">ACTIVE WRITING · 28-DAY ROADMAP</div>
    <h1>${escapeHTML(m.heroTitle||"You know the words. Now make them work.")}</h1>
    <p class="hero-intro">${escapeHTML(m.heroDescription)}</p>
    <div class="tag-row"><span class="tag">01 / Collocations</span><span class="tag">02 / Sentence control</span><span class="tag">03 / Coherence</span><span class="tag">04 / Academic paragraphs</span></div></div>
    <aside class="hero-aside"><div><div class="aside-label">DAILY WRITING WORKOUT</div><div class="aside-num">60 <small>MIN / DAY</small></div><div class="aside-bottom">先尝试 → 再对照 → 然后重写。<br>真正的进步来自主动输出，而不是多看一遍范文。</div></div>
    <div class="aside-schedule"><span>08m · 搭配</span><span>12m · 造句</span><span>10m · 改写</span><span>10m · 逻辑</span><span>15m · 段落</span><span>05m · 复盘</span></div></aside></section>
    <section class="panel course-importer" id="course-importer"><div class="course-import-head"><div class="eyebrow">CREATE WITHOUT CODING</div><h2>粘贴 JSON，立即生成新课程</h2>
      <p>数据结构、线性代数、机器学习、英语写作……使用同一个练习系统。无需修改仓库文件或重新部署。</p></div>
      <textarea id="course-json-input" aria-label="粘贴课程 JSON" spellcheck="false" placeholder='粘贴课程 JSON，例如 {"title":"线性代数练习","subject":"数学","questions":[...]}'></textarea>
      <div class="course-import-actions"><button type="button" class="button primary" data-action="course-import">＋ 导入并生成课程</button>
        <button type="button" class="button outline" data-action="course-example">填入示例</button>
        <button type="button" class="button outline" data-action="course-file">↑ 上传 .json</button>
        <button type="button" class="button outline" data-action="course-clear">清空文本框</button></div>
      <input type="file" id="course-json-file" class="hidden" accept=".json,application/json">
      <div class="course-backup-actions"><button type="button" class="mini-button" data-action="backup">↓ 备份全部课程与学习记录</button>
        <button type="button" class="mini-button" data-action="import">↑ 恢复备份</button>
        <input type="file" id="backup-import-home" class="hidden" accept=".json,application/json"></div>
      <p class="course-import-note">新课程保存在当前浏览器的 localStorage，不会同步到 GitHub 或其他设备。请定期备份。客观题需要提供正确选项才能自动核对，开放题仍由你自行评价。</p>
      <p id="course-import-status" role="status" class="course-import-status hidden"></p></section>

<!-- 课程 JSON 格式复制工具 -->
<section class="panel course-importer" id="course-template-section">

  <div class="course-import-head">
    <div class="eyebrow">COURSE TEMPLATE</div>

    <h2>生成新的课程 JSON</h2>

    <p>
      复制 WriteLab 的 sections 标准格式，
      让 ChatGPT 在其他窗口生成兼容的练习课程。
    </p>
  </div>

  <div class="course-import-actions">

    <button
      type="button"
      class="button primary"
      data-action="copy-course-prompt">
      ⧉ 复制 AI 课程生成 Prompt
    </button>

    <button
      type="button"
      class="button outline"
      data-action="copy-course-template">
      ⧉ 仅复制 JSON 模板
    </button>

  </div>

  <p
    id="course-template-status"
    class="confirm-text hidden"
    role="status">
  </p>

  <textarea
    id="course-template-fallback"
    class="backup hidden"
    readonly
    aria-label="手动复制课程模板">
  </textarea>

</section>

    <section id="custom-lessons" class="custom-library"><div class="section-heading"><div><div class="eyebrow">YOUR LIBRARY</div><h2>我的自定义课程</h2></div><p>${store.customLessons.size} 门本地课程</p></div>
      ${customCards?`<div class="lesson-grid">${customCards}</div>`:`<div class="custom-empty">还没有导入课程。把 ChatGPT 生成的课程 JSON 粘贴到上方即可开始。</div>`}</section>
    <div class="section-heading"><div><div class="eyebrow">YOUR WEEK ONE</div><h2>原有英语写作课程</h2></div><p>已开放 ${m.lessons.length} 天 · 保留原来的 Day 01–07</p></div>
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
    <p class="annotation-tip">先选中错误表达 → 点击「划掉」；再输入新写法 → 点击「插入红色（改法）」。也可直接输入 (正确写法)，闭合括号后自动标红。批注会自动保存。</p>
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
  const isEssay=sectionId==="paragraph" || (task.minWords||0)>=100;
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
    ${options}${hint}${store.submitted?renderTaskFeedback(task):""}${result}</article>`;
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
    store.feedback=record.feedback;store.practiceAnswers=record.practiceAnswers;
    store.feedbackHidden=record.feedbackHidden;
  }
  store.current=lesson;
  siteStatus.textContent=lesson.custom?lesson.subject:`DAY ${pad(lesson.day)} / 28`;
  document.title=`${lesson.custom?lesson.subject:`Day ${pad(lesson.day)}`} · ${lesson.title} · WriteLab`;
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
  const idx=store.manifest.lessons.indexOf(id),next=idx>=0?store.manifest.lessons[idx+1]:null;
  const duration=lesson.custom?lesson.minutes:60;
  ui.innerHTML=`<a class="back" href="#/">← 返回训练首页</a><header class="lesson-hero"><div class="eyebrow">${lesson.custom?escapeHTML(lesson.subject):`DAY ${pad(lesson.day)}`} · ${escapeHTML(lesson.track)}</div>
    <h1>${escapeHTML(lesson.title)}</h1><p>${escapeHTML(lesson.subtitle)}</p>
    <div class="tag-row" style="margin-top:18px"><span class="tag">${duration} MIN</span><span class="tag">${number} TASKS</span><span class="tag">${escapeHTML(lesson.focus)}</span></div>
  </header><div class="lesson-layout"><div class="study-main"><section class="panel timeline"><div class="timeline-top"><span>训练进度</span><span id="progress-text">0 / ${number}</span></div>
    <div class="track"><div id="progress-fill" class="track-fill"></div></div><div class="timer-line"><div class="timer-count"><span id="timer-display">00:00</span><small> / ${pad(duration)}:00</small></div>
    <div class="timer-actions"><button type="button" class="timer-button" id="timer-toggle" data-action="timer">▶ 开始计时</button><button type="button" class="timer-button backup-button" data-action="backup">↓ 备份</button><button type="button" class="timer-button backup-button" data-action="import">↑ 恢复</button></div></div>
    <input type="file" id="backup-import" accept="application/json,.json" class="hidden" aria-label="导入 WriteLab 本地记录"></section>
    <div class="coach-note"><strong>COACH'S NOTE</strong>${escapeHTML(lesson.coach)}</div>${renderFeedbackImporter()}${phases}
    <section id="submit-panel" class="panel submit-panel ${store.submitted?"hidden":""}"><button type="button" class="button primary wide" data-action="submit">完成练习 · 对照答案与改写 →</button>
      <p class="submit-hint">初稿自动保存。交卷后保留第一遍原文，可划线批注并打开 2/2 独立重写；参考答案届时解锁。</p></section>
    ${renderFeedbackExtras()}
    <section id="results" class="panel results ${store.submitted?"":"hidden"}" aria-live="polite"><div class="results-head"><div><div class="eyebrow">TODAY'S REVIEW</div><h2>写完不等于练完。</h2></div>
      <div class="score" id="score">—<small>自评 / 15</small></div></div><div class="results-desc" id="results-desc"></div><div class="results-note" id="results-note"></div>
      <div class="result-actions"><button type="button" class="button outline" data-action="copy">⧉ 复制写作和成绩</button>
      <button type="button" class="button outline" data-action="coach">✦ 复制 AI 批改请求</button>
      <button type="button" class="button primary review-import-link" data-action="feedback-open">↑ 粘贴 / 导入 AI 批改 JSON</button>
      <button type="button" class="button outline" data-action="feedback-file">📁 上传批改 JSON 文件</button>
      <button type="button" class="button outline" data-action="backup">↓ 导出全部学习记录</button></div>
    <p class="review-import-tip">从 ChatGPT 复制结构化批改 JSON 后点击上方“粘贴 / 导入”；如果已保存为 .json 文件，直接点“上传批改 JSON 文件”。两种方式都不会覆盖原答案。</p>
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
  return [`WriteLab · ${l.custom?l.subject:`Day ${pad(l.day)}`} — ${l.title}`,s.allMarked?`Self-reviewed result: ${s.score}/${s.tasks}`:`Objective: ${s.choiceGood}/${s.choice}; Writing reviewed: ${s.marked}/${s.written}`,
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
  // 复制按钮生成结构化 JSON 批改请求；不会向 AI 服务自动发送写作。
  const summary=forCoach ? feedbackJSONPrompt() : copyText(),status=document.getElementById("copy-status"),fallback=document.getElementById("copy-fallback");
  try {
    if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
    await navigator.clipboard.writeText(summary);
    status.textContent=forCoach?"✓ 已复制 JSON 批改请求！粘贴到 ChatGPT，取得回复后再导入 WriteLab。":"✓ 已复制完整练习结果；可以粘贴给 ChatGPT 或保存进笔记。";
    fallback.classList.add("hidden");
  } catch (_) {
    // 部分手机浏览器限制剪贴板权限，降级到可长按复制的文本框。
    fallback.value=summary;fallback.classList.remove("hidden");fallback.focus();fallback.select();
    let copied=false;try{copied=document.execCommand("copy");}catch(_){}
    status.textContent=copied?"✓ 已复制，可粘贴。":"请长按下方文本，选择全选并复制。";
  }
  status.classList.remove("hidden");
}
async function copyFeedbackTemplate() {
  const prompt=feedbackJSONPrompt();
  const area=document.getElementById("feedback-json-input");
  const status=document.getElementById("feedback-import-status");
  try {
    if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');
    await navigator.clipboard.writeText(prompt);
    status.textContent="已复制结构化 JSON 批改请求。发给 ChatGPT 后，将返回的 JSON 粘贴在这里。";
  } catch(_) {
    // 剪贴板权限不足时提供可手动复制的文本，不丢失当前练习记录。
    area.value=prompt;area.focus();area.select();
    status.textContent="浏览器限制了自动复制，请手动复制上方文字并发送给 ChatGPT。";
  }
  status.classList.remove("hidden");
}
function resetDay() {
  if (!confirm("这会清除当天第一遍、批注、第二遍、自评和计时；操作不可撤销。建议先导出备份。确定清空吗？")) return;
  pauseTimer();store.answers={};store.assessments={};store.rubric={};store.submitted=false;
  store.annotations={};store.revisions={};store.attemptViews={};store.feedback=null;store.practiceAnswers={};store.feedbackHidden=false;
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
}

// 用户在第一遍的改错层输入完整 (...) 时，自动套用红色批注样式。
// 仅处理同一文本节点的非嵌套括号，避免破坏手工已有的 <del> 与红色批注。
function autoHighlightParentheses(editor,event) {
  if(event.isComposing || event.inputType!=="insertText" || event.data!==")")return;
  const selection=window.getSelection();
  if(!selection?.rangeCount)return;
  const range=selection.getRangeAt(0),node=range.startContainer;
  if(node.nodeType!==Node.TEXT_NODE || !editor.contains(node) || node.parentElement?.closest(".annotation-add,del"))return;
  const offset=range.startOffset,text=node.textContent;
  if(text[offset-1]!==")")return;
  const start=text.lastIndexOf("(",offset-2);
  if(start<0 || /[()]/.test(text.slice(start+1,offset-1)))return;
  const wrap=document.createRange();wrap.setStart(node,start);wrap.setEnd(node,offset);
  const span=document.createElement("span");span.className="annotation-add";
  wrap.surroundContents(span);
  const after=document.createRange();after.setStartAfter(span);after.collapse(true);
  selection.removeAllRanges();selection.addRange(after);
}

// 委托事件绑定，新增课程/题目时不需要增加新的监听器。
ui.addEventListener("mouseup",rememberAnnotationSelection);
ui.addEventListener("keyup",rememberAnnotationSelection);
ui.addEventListener("touchend",rememberAnnotationSelection);
ui.addEventListener("input",event=>{
  const el=event.target;
  // 富文本批注和第二遍独立保存；第一遍在提交后继续保持只读。
  if(el.matches("[data-annotation-editor]") && store.current && store.submitted) {
    autoHighlightParentheses(el,event);
    store.annotations[el.dataset.annotationEditor]=sanitizeAnnotationHTML(el.innerHTML);
    saveRecord();return;
  }
  if(el.matches("textarea[data-practice]") && store.current && store.submitted) {
    store.practiceAnswers[el.dataset.practice]=el.value;
    saveRecord();return;
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
  if(el.id==="backup-import" || el.id==="backup-import-home") {importBackup(el.files?.[0]);el.value="";return;}
  if(el.id==="course-json-file") {importCourseFile(el.files?.[0]);el.value="";return;}
  // AI 批改文件是独立的输入，不会触发“恢复学习记录”的覆盖操作。
  if(el.id==="feedback-file-input") {importFeedbackFile(el.files?.[0]);el.value="";return;}
  if (el.matches("input[data-rubric]")) {store.rubric[el.dataset.rubric]=el.checked;saveRecord();return;}
  if (!store.current || store.submitted || !el.matches('input[type="radio"][data-answer]'))return;
  store.answers[el.dataset.answer]=el.value;saveRecord();updateProgress();
});
ui.addEventListener("click",event=>{
  const button=event.target.closest("button"); if(!button)return;
  // 首页操作不依赖 store.current；课程导入后立即可见，无须 Git push。
  if(button.dataset.courseExport) {exportCustomCourse(button.dataset.courseExport);return;}
  if(button.dataset.courseDelete) {deleteCustomCourse(button.dataset.courseDelete);return;}
  switch(button.dataset.action) {
    case "copy-course-prompt":
  // 复制完整的 AI 生成要求和 sections 模板。
  copyCourseTemplate("prompt");
  return;


case "copy-course-template":
// 只复制合法的课程 JSON 示例。
copyCourseTemplate("json");
return;
    case "course-import": importCourseFromHome();return;
    case "course-file": document.getElementById("course-json-file")?.click();return;
    case "course-example": document.getElementById("course-json-input").value=JSON.stringify(CUSTOM_COURSE_EXAMPLE,null,2);return;
    case "course-clear": document.getElementById("course-json-input").value="";return;
    case "backup": exportBackup();return;
    case "import": (document.getElementById("backup-import-home")||document.getElementById("backup-import"))?.click();return;
  }
  if(!store.current)return;
  if(button.dataset.attempt) {
    store.attemptViews[button.dataset.attempt]=Number(button.dataset.round);
    saveRecord();
    const position=window.scrollY;
    renderDay(store.current.id);window.scrollTo(0,position);
    return;
  }
  if(button.dataset.applyFeedback) {applyFeedbackToAnnotation(button.dataset.applyFeedback);return;}
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
    case "feedback-import": importFeedbackJSON();break;
    case "feedback-open": showFeedbackImporter();break;
    case "feedback-file": document.getElementById("feedback-file-input")?.click();break;
    case "feedback-template": copyFeedbackTemplate();break;
    case "feedback-toggle": toggleFeedbackVisibility();break;
    case "feedback-clear": clearImportedFeedback();break;
    case "feedback-input-clear": clearFeedbackPasteBox();break;
    case "feedback-scroll-practice": document.getElementById("feedback-practice")?.scrollIntoView({behavior:"smooth"});break;
  }
});
addEventListener("hashchange",navigate);
loadCourses().then(navigate).catch(e=>showError(e.message));

