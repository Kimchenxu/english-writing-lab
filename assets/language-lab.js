"use strict";

/* LanguageLab extension: keep the existing WriteLab engine and its v1 storage
 * keys intact. Review and exam records are independent from lesson answers.
 * No runtime dependencies; Web Speech features are progressive enhancements.
 */
const LanguageLab = (() => {
  const KEY = "writelab.languageLab.v1";
  const DAY = 86400000;
  const INTERVALS = [1, 3, 7, 14, 30, 60];
  const KINDS = ["choice","write","fill","conjugation","listening","speaking","flashcard"];
  const TYPES = ["learning","review","weekly","unit","final"];
  const LABELS = {learning:"新课",review:"复习",weekly:"周测",unit:"单元考试",final:"期末考试"};
  const KIND_LABELS = {choice:"选择",write:"开放作答",fill:"填空",conjugation:"动词变位",listening:"听力",speaking:"口语",flashcard:"词汇"};
  const isObject = x => x && typeof x === "object" && !Array.isArray(x);
  const text = (v, name, max=200, fallback="") => {
    if (v == null) return fallback;
    if (typeof v !== "string" || v.length > max) throw Error(name+" 必须是长度不超过 "+max+" 的字符串");
    return v.trim() || fallback;
  };
  const strings = (v, name, max=20, len=160) => {
    if(v == null) return [];
    if(!Array.isArray(v)||v.length>max) throw Error(name+" 必须是数组（最多 "+max+" 项）");
    return [...new Set(v.map(x=>text(x,name,len)).filter(Boolean))];
  };
  const integer = (v,name,min,max,fallback) => {
    if(v==null) return fallback;
    if(!Number.isInteger(v)||v<min||v>max) throw Error(name+" 必须为 "+min+"–"+max+" 的整数");
    return v;
  };
  const locale = v => {
    const s=text(v,"language",35,"und");
    try { return Intl.getCanonicalLocales(s)[0] || "und"; }
    catch (_) { throw Error("language 应为 BCP-47，例如 es-ES 或 en-US"); }
  };
  // Canonical equivalents and whitespace are normalized; accents and punctuation
  // remain meaningful. Optional acceptedAnswers handle genuine alternatives.
  function normalizeText(v, sensitive=false) {
    const s=String(v??"").normalize("NFC").trim().replace(/\s+/gu," ");
    return sensitive?s:s.toLowerCase();
  }
  const kind = t => t.kind || t.type;
  const objective = t => t.type==="choice" || ["fill","conjugation","listening","flashcard"].includes(kind(t));
  function grade(t, answer) {
    if(!String(answer??"").trim()) return false;
    if(t.type==="choice") return answer===t.answer;
    if(!objective(t)) return null;
    const norm=x=>normalizeText(x,t.caseSensitive===true);
    return [t.answer,...(t.acceptedAnswers||[])].some(x=>norm(x)===norm(answer));
  }
  function schedule(previous, known, now=Date.now()) {
    const step=known?Math.min((previous?.step??-1)+1,INTERVALS.length-1):-1;
    return {step,due:now+(known?INTERVALS[step]*DAY:600000),last:now,known:!!known,
      count:(previous?.count||0)+1};
  }
  // Normalize through the existing validator: it already enforces section/task
  // limits, IDs, choice integrity, and escaping rules. Preserve v2 metadata.
  function normalizeCourse(input, legacy) {
    if(!isObject(input)) throw Error("课程必须是 JSON 对象");
    if(input.version!=null && ![1,2].includes(input.version)) throw Error("仅支持课程 version 1 或 2");
    const rawSections=input.sections || (Array.isArray(input.questions)?[{id:"practice",title:"Practice · 练习",subtitle:"独立完成后再核对参考答案",minutes:input.minutes||30,tasks:input.questions}]:null);
    if(!Array.isArray(rawSections)) return legacy({...input,version:1});
    const sections=rawSections.map(sec=>{
      if(!isObject(sec)||!Array.isArray(sec.tasks)) throw Error("sections.tasks 必须是数组");
      return {...sec,tasks:sec.tasks.map(t=>{
        if(!isObject(t)) throw Error("题目必须为对象");
        const raw=String(t.kind||t.type||"write").toLowerCase();
        const k=({multiple_choice:"choice","multiple-choice":"choice",quiz:"choice",essay:"write",text:"write",short:"write",short_answer:"write",open:"write"})[raw]||raw;
        if(!KINDS.includes(k)) throw Error("不支持题型 "+raw);
        const type=k==="choice" || (k==="listening" && Array.isArray(t.options)&&t.options.length)?"choice":"write";
        const accepted=strings(t.acceptedAnswers,"acceptedAnswers",20,12000);
        const answer=text(t.answer,"answer",12000,accepted[0]||"");
        if((["fill","conjugation","listening","flashcard"].includes(k)||type==="choice")&&!answer) throw Error(k+" 需要 answer");
        const audioText=text(t.audioText,"audioText",3000);
        if(k==="listening"&&!audioText) throw Error("listening 需要 audioText");
        return {...t,type,answer,kind:k,acceptedAnswers:accepted,
          tags:strings(t.tags,"task.tags"),audioText,caseSensitive:t.caseSensitive===true};
      })};
    });
    const base=legacy({...input,version:1,sections});
    const language=locale(input.language || (input.version===1 && /english|英语/i.test(base.subject)?"en-US":"und"));
    const lessonType=text(input.lessonType,"lessonType",30,"learning");
    if(!TYPES.includes(lessonType)) throw Error("无效 lessonType: "+lessonType);
    const level=text(input.level,"level",30,"");
    const program=text(input.program,"program",100,base.subject);
    return {...base,version:2,language,level,program,
      category:text(input.category,"category",80,"综合"),
      unit:integer(input.unit,"unit",0,999,0),
      week:integer(input.week,"week",0,999,0),
      day:integer(input.day,"day",0,9999,0),
      lessonType,examMinutes:integer(input.examMinutes,"examMinutes",1,180,30),
      prerequisites:strings(input.prerequisites,"prerequisites"),
      objectives:strings(input.objectives,"objectives"),
      sections:base.sections.map((sec,i)=>({...sec,tasks:sec.tasks.map((t,j)=>{
        const raw=sections[i].tasks[j];
        return {...t,kind:raw.kind,tags:raw.tags,acceptedAnswers:raw.acceptedAnswers,audioText:raw.audioText,caseSensitive:raw.caseSensitive};
      })}))};
  }
  const metadata = l => ({language:l.language||(!l.custom?"en-US":"und"),
    level:l.level||"",program:l.program||(!l.custom?"english-writing":l.subject||"综合学习"),
    category:l.category||(!l.custom?"写作":"综合"),unit:l.unit||(!l.custom?1:0),
    week:l.week||(!l.custom?1:0),day:l.day||0,lessonType:l.lessonType||"learning"});
  const empty = () => ({version:1,reviews:{},exams:[]});
  // Validate imported backup data before it reaches localStorage or the DOM.
  function validateState(value) {
    if(!isObject(value)||value.version!==1||!isObject(value.reviews)||!Array.isArray(value.exams)) throw Error("复习/考试备份格式错误");
    if(Object.keys(value.reviews).length>50000||value.exams.length>200||JSON.stringify(value).length>2000000) throw Error("复习/考试备份过大");
    const reviews=Object.create(null), exams=[], ids=new Set();
    for(const [key,r] of Object.entries(value.reviews)){
      if(key.length>400||!isObject(r)||!Number.isInteger(r.step)||r.step< -1||r.step>=INTERVALS.length||
        !Number.isFinite(r.due)||!Number.isFinite(r.last)||typeof r.known!=="boolean"||!Number.isInteger(r.count)||r.count<1)
        throw Error("复习记录无效");
      reviews[key]={step:r.step,due:r.due,last:r.last,known:r.known,count:r.count};
    }
    for(const e of value.exams){
      if(!isObject(e)||typeof e.id!=="string"||!/^[a-z0-9-]{1,80}$/.test(e.id)||ids.has(e.id)||
        !["weekly","unit","final"].includes(e.mode)||typeof e.program!=="string"||
        !Number.isFinite(e.started)||!Number.isFinite(e.deadline)||e.deadline<=e.started||
        (e.finished!==null&&!Number.isFinite(e.finished))||!Array.isArray(e.items)||!e.items.length||e.items.length>100||
        !isObject(e.answers)||!isObject(e.marks)) throw Error("考试记录无效");
      ids.add(e.id);
      const items=e.items.map((t,i)=>{
        if(!isObject(t)||t.id!=="q"+(i+1)||!KINDS.includes(kind(t))||!["choice","write"].includes(t.type)) throw Error("考试题目无效");
        const result={id:t.id,type:t.type,kind:kind(t),prompt:text(t.prompt,"prompt",12000),
          answer:text(t.answer,"answer",12000),explanation:text(t.explanation,"explanation",7000),
          options:strings(t.options,"options",8,400),acceptedAnswers:strings(t.acceptedAnswers,"acceptedAnswers",20,12000),
          audioText:text(t.audioText,"audioText",3000),language:locale(t.language),caseSensitive:t.caseSensitive===true,
          source:text(t.source,"source",200)};
        if(!result.prompt||!result.answer||(result.type==="choice"&&!result.options.includes(result.answer))||
          (result.kind==="listening"&&!result.audioText)) throw Error("考试题目缺少必要字段");
        return result;
      });
      const answers={},marks={};
      for(const t of items){
        if(Object.hasOwn(e.answers,t.id)) answers[t.id]=text(e.answers[t.id],"exam.answer",12000);
        if(["good","revise"].includes(e.marks[t.id])) marks[t.id]=e.marks[t.id];
      }
      exams.push({id:e.id,mode:e.mode,program:text(e.program,"program",100),scope:integer(e.scope,"scope",0,999,0),
        started:e.started,deadline:e.deadline,finished:e.finished,items,answers,marks});
    }
    return {version:1,reviews,exams};
  }
  function read() {
    try {const raw=localStorage.getItem(KEY);return raw?validateState(JSON.parse(raw)):empty();}
    catch(e){console.warn("LanguageLab: 无法读取复习记录",e);return empty();}
  }
  function write(state) {
    try {
      // Refuse to overwrite unreadable existing records.
      const old=localStorage.getItem(KEY);
      if(old) validateState(JSON.parse(old));
      localStorage.setItem(KEY,JSON.stringify(validateState(state)));return true;
    } catch(e){alert("复习/考试记录保存失败："+e.message+"。请先备份并检查浏览器存储。");return false;}
  }
  function expire(state,now=Date.now()){
    let changed=false;
    for(const e of state.exams) if(e.finished===null&&now>=e.deadline){e.finished=e.deadline;changed=true;}
    return changed;
  }
  function examScore(e){
    let correct=0,graded=0;
    for(const t of e.items){
      if(objective(t)){graded++;if(grade(t,e.answers[t.id]))correct++;}
      else if(e.marks[t.id]){graded++;if(e.marks[t.id]==="good")correct++;}
    }
    return {correct,graded,total:e.items.length};
  }
  // Adapter is invoked after legacy globals are initialized but before courses load.
  function install(){
    const esc=escapeHTML, oldNormalize=normalizeCustomCourse, oldHome=renderHome,
      oldTask=renderTask, oldDay=renderDay, oldWriting=renderWritingAttempt, oldPrompt=feedbackJSONPrompt,
      oldRubric=renderRubric, oldGeneration=buildCourseGenerationPrompt;
    let filter="*", category="*", level="*", reviewMode="due", examId=null, recognition=null;
    normalizeCustomCourse=input=>normalizeCourse(input,oldNormalize);
    allStats=()=>{
      const tasks=getTasks(), auto=tasks.filter(objective), open=tasks.filter(t=>!objective(t));
      const choiceGood=auto.filter(t=>grade(t,store.answers[t.id])).length;
      const marked=open.filter(t=>["good","revise"].includes(store.assessments[t.id]));
      const writtenGood=marked.filter(t=>store.assessments[t.id]==="good").length;
      return {tasks:tasks.length,choice:auto.length,written:open.length,choiceGood,marked:marked.length,
        writtenGood,score:choiceGood+writtenGood,allMarked:marked.length===open.length,
        mistakes:tasks.filter(t=>objective(t)?!grade(t,store.answers[t.id]):store.assessments[t.id]==="revise")};
    };
    feedbackJSONPrompt=()=>oldPrompt().replace("WriteLab 英语训练答案","WriteLab "+metadata(store.current).language+" / "+store.current.subject+" 训练答案")
      .replace("生成 5 组搭配和 5 道针对性复练题","根据本课程语言和目标生成最多 5 组词汇或知识点及 5 道针对性复练题；非段落课程 paragraph 可留空");
    renderRubric=()=>metadata(store.current).language.startsWith("en")?oldRubric():"";
    renderWritingAttempt=(t,i,essay,v)=>oldWriting(t,i,essay,v).replace("英文答案","作答")
      .replace("不要先看答案。用英文写出你的表达…","不要先看答案。使用课程要求的语言作答…");
    const speakButton=(value,lang,label="🔊 播放")=>value?'<button type="button" class="mini-button" data-lab="speak" data-value="'+esc(value)+'" data-lang="'+esc(lang)+'">'+label+'</button>':"";
    const micButton=(target,lang)=>'<button type="button" class="mini-button" data-lab="mic" data-target="'+esc(target)+'" data-lang="'+esc(lang)+'">🎙 语音转文字</button>';
    function speechTools(t,lang,submitted,target){
      const k=kind(t);
      return '<div class="lab-tools">'+(k==="listening"?speakButton(t.audioText,lang,"🔊 播放听力"):"")+
        (k==="speaking"&&!submitted?micButton(target,lang):"")+
        (submitted&&lang!=="und"?speakButton(t.answer,lang,"🔊 朗读参考答案"):"")+'</div>';
    }
    renderTask=(t,i,section)=>{
      const lang=metadata(store.current).language, v=store.answers[t.id]||"", submitted=store.submitted;
      const tools=speechTools(t,lang,submitted,"answer-"+t.id);
      if(!objective(t)||t.type==="choice"){
        const html=oldTask(t,i,section);
        const end=html.lastIndexOf("</article>");
        return html.slice(0,end)+tools+html.slice(end);
      }
      const correct=grade(t,v), alternatives=(t.acceptedAnswers||[]).filter(a=>a!==t.answer);
      const feedback=store.feedbackHidden?null:store.feedback?.tasks.find(x=>x.taskId===t.id);
      return '<article class="task" id="task-'+esc(t.id)+'"><div class="task-top"><span class="task-num">'+i+'</span><div class="task-body"><div class="eyebrow">'+KIND_LABELS[kind(t)]+'</div><div class="task-prompt">'+esc(t.prompt)+'</div></div></div>'+
        '<textarea class="answer-editor lab-short" rows="2" id="answer-'+esc(t.id)+'" data-answer="'+esc(t.id)+'" lang="'+esc(lang)+'" spellcheck="false" autocomplete="off" '+(submitted?"readonly":"")+' aria-label="第 '+i+' 题答案">'+esc(v)+'</textarea>'+
        (!submitted&&t.hint?'<details><summary>提示</summary>'+esc(t.hint)+'</details>':"")+tools+
        (submitted?'<div class="review-box"><strong>'+ (correct?"✓ 正确":"✕ 需要复习")+'</strong><p>'+esc(t.answer)+'</p>'+
          (alternatives.length?'<p>其他接受答案：'+esc(alternatives.join(" / "))+'</p>':"")+
          '<p>'+esc(t.explanation)+'</p>'+(feedback?'<p>AI 批改：'+esc(feedback.comment)+'</p>':"")+'</div>':"")+'</article>';
    };
    renderDay=id=>{
      oldDay(id);
      if(!store.current||store.current.id!==id)return;
      const lang=metadata(store.current).language;
      ui.querySelectorAll("textarea[data-answer],textarea[data-revision]").forEach(el=>el.lang=lang);
      if(store.submitted)ui.querySelectorAll(".kit-head").forEach((el,i)=>{
        const entry=store.current.languageKit[i];
        if(entry&&lang!=="und")el.insertAdjacentHTML("afterend",speakButton(entry[0],lang));
      });
      const hero=ui.querySelector(".lesson-hero");
      if(hero)hero.insertAdjacentHTML("beforeend",'<p class="lab-meta">'+esc(metadata(store.current).program)+' · '+esc(lang)+' · '+esc(metadata(store.current).level)+' · '+esc(metadata(store.current).category)+'</p>');
      const desc=document.getElementById("results-desc");
      if(desc&&store.submitted)desc.textContent=desc.textContent.replace("选择题正确","客观题正确").replace("写作已核对","开放题已核对");
    };
    // Supply a real v2 template instead of teaching AI the obsolete two-type schema.
    Object.assign(COURSE_SECTION_TEMPLATE,{version:2,id:"spanish-a1-day01",subject:"西班牙语",language:"es-ES",level:"A1",
      program:"spanish-a1",unit:1,week:1,day:1,category:"综合",lessonType:"learning",objectives:["greetings"],prerequisites:[],
      title:"Saludos y presentaciones",subtitle:"问候与自我介绍",track:"Spanish A1",focus:"问候与发音",topic:"greetings",
      canDo:["能够简单问候"],framework:"问候 → 自我介绍 → 结束语",coach:"先独立作答，再朗读。",
      languageKit:[["Hola","你好","Hola, ¿qué tal?",""]],
      sections:[{id:"basics",title:"练习",subtitle:"拼写、听力与口语",minutes:15,tasks:[
        {id:"es-q1",type:"fill",prompt:"用西语写：你好",answer:"Hola",acceptedAnswers:["¡Hola!"],tags:["greetings"],explanation:"Hola 用于日常问候。"},
        {id:"es-q2",type:"conjugation",prompt:"yo ___ (ser)",answer:"soy",tags:["ser"],explanation:"ser 的第一人称单数是 soy。"},
        {id:"es-q3",type:"listening",prompt:"听录音并写出所听到的内容",audioText:"Buenos días",answer:"Buenos días",tags:["listening"]},
        {id:"es-q4",type:"speaking",prompt:"向朋友用西语问好并自我介绍。",answer:"Hola, me llamo Ana.",tags:["speaking"]}
      ]}]});
    buildCourseGenerationPrompt=()=>oldGeneration().replace('type 只能使用 "choice" 或 "write"。','type 支持 choice、write、fill、conjugation、listening、speaking、flashcard。fill/conjugation/flashcard/listening 需 answer，可有 acceptedAnswers；listening 必须有 audioText，可选 options；speaking 为开放题。每题添加 tags，课程添加 language、program、level、unit、week、day、category、lessonType、objectives。考试 lessonType 可为 weekly、unit、final，并添加 examMinutes。');

    function sourceStatus(l,t,r){
      if(!r.submitted)return null;
      if(objective(t))return grade(t,r.answers[t.id]);
      const verdict=r.feedback?.tasks?.find(x=>x.taskId===t.id)?.verdict;
      if(["wrong","weak"].includes(verdict))return false;
      if(["good","excellent"].includes(verdict))return true;
      return r.assessments[t.id]==="good"?true:r.assessments[t.id]==="revise"?false:null;
    }
    const keyFor=(l,t)=>l.id+"/"+t.id;
    const cardsFor=(lessons,state)=>{
      const out=[];
      for(const l of lessons){
        const r=loadRecord(l.id), m=metadata(l);
        if(!r.submitted)continue;
        for(const t of getTasks(l)){
          const original=sourceStatus(l,t,r), key=keyFor(l,t);
          if(original===null&&!state.reviews[key])continue;
          out.push({key,l,t,original,review:state.reviews[key],language:m.language,tags:t.tags?.length?t.tags:l.objectives?.length?l.objectives:[l.focus||m.category]});
        }
        l.languageKit.forEach((row,i)=>{
          if(!row[0]||!row[1])return;
          // Include content in the key so editing a card cannot inherit old ratings.
          const key=l.id+"/vocab/"+i+"/"+row[0].slice(0,100)+"/"+row[1].slice(0,100);
          out.push({key,l,t:{kind:"flashcard",prompt:row[1],answer:row[0],explanation:row[2]},original:null,
            review:state.reviews[key],language:m.language,tags:["词汇"]});
        });
      }
      return out;
    };
    const options=(values,selected)=>values.map(([v,label])=>'<option value="'+esc(v)+'" '+(v===selected?"selected":"")+'>'+esc(label)+'</option>').join("");
    const allLessons=()=>[...store.lessons.values()];
    const matching=()=>allLessons().filter(l=>filter==="*"||metadata(l).program===filter);
    function examView(e){
      const finished=e.finished!==null, score=examScore(e);
      return '<div class="lab-exam"><h3>'+esc(LABELS[e.mode])+' · '+esc(e.program)+'</h3>'+
        '<p>'+(finished?'已交卷 · '+score.correct+'/'+score.graded+' 已评分（共 '+score.total+' 题）':'剩余 <strong id="lab-clock">--:--</strong> · 离开页面仍继续计时')+'</p>'+
        e.items.map((t,i)=>{
          const v=e.answers[t.id]||"", name="lab-exam-"+t.id;
          const input=t.type==="choice"?t.options.map(a=>'<label class="quiz-option"><input type="radio" data-lab-answer="'+t.id+'" name="'+name+'" value="'+esc(a)+'" '+(a===v?"checked ":"")+(finished?"disabled":"")+'>'+esc(a)+'</label>').join(""):
            '<textarea class="answer-editor lab-short" rows="2" data-lab-answer="'+t.id+'" id="'+name+'" lang="'+esc(t.language)+'" '+(finished?"readonly":"")+'>'+esc(v)+'</textarea>';
          return '<article class="task"><strong>'+(i+1)+'. '+esc(t.prompt)+'</strong>'+speechTools(t,t.language,finished,name)+input+
            (finished?'<div class="review-box"><p>参考答案：'+esc(t.answer)+'</p><p>'+esc(t.explanation)+'</p>'+
              (objective(t)?'<strong>'+(grade(t,v)?"✓ 正确":"✕ 错误")+'</strong>':
                '<button class="mini-button" data-lab="exam-mark" data-q="'+t.id+'" data-value="good">✓ 达到要求</button> <button class="mini-button" data-lab="exam-mark" data-q="'+t.id+'" data-value="revise">↻ 需要重练</button> '+esc(e.marks[t.id]||"待自评"))+'</div>':"")+'</article>';
        }).join("")+
        (finished?'<button class="button outline" data-lab="exam-export">导出本次考试 JSON</button>':'<button class="button primary" data-lab="exam-submit">交卷</button>')+
        ' <button class="button outline" data-lab="exam-close">返回复习中心</button></div>';
    }
    function cardHTML(c){
      const m=metadata(c.l), isExam=["weekly","unit","final"].includes(m.lessonType), qs=getTasks(c.l), record=loadRecord(c.l.id);
      const done=qs.filter(t=>String(record.answers[t.id]??"").trim()).length;
      return '<article class="lesson-card custom-lesson-card"><a class="custom-lesson-link" href="#/'+esc(c.l.id)+'"><div class="card-top"><span class="card-day">'+esc([m.language,m.level,m.category,LABELS[m.lessonType]].filter(Boolean).join(" · "))+'</span><span class="card-state">'+(record.submitted?"已提交":done+"/"+qs.length+" 已答")+'</span></div>'+
        '<h3>'+esc(c.l.title)+'</h3><p>'+esc(c.l.subtitle)+'</p><div class="card-foot"><span>'+esc((m.unit?"U"+m.unit+" · ":"")+(m.week?"W"+m.week+" · ":"")+(m.day?"D"+m.day+" · ":"")+qs.length+" 题")+'</span><span>↗</span></div></a>'+
        (c.l.prerequisites?.length?'<p class="lab-meta">建议先学：'+esc(c.l.prerequisites.join("、"))+'</p>':"")+
        (isExam?'<button class="button outline" data-lab="exam-course" data-id="'+esc(c.l.id)+'">按考试模式开始</button>':"")+
        (c.l.custom?'<div class="custom-card-actions"><button data-course-export="'+esc(c.l.id)+'">↓ 导出 JSON</button><button class="custom-delete" data-course-delete="'+esc(c.l.id)+'">移除</button></div>':"")+'</article>';
    }
    function renderWorkspace(){
      const root=document.getElementById("language-lab");if(!root)return;
      const state=read();if(expire(state))write(state);
      const lessons=allLessons(), programs=[...new Set(lessons.map(l=>metadata(l).program))].sort();
      if(filter!=="*"&&!programs.includes(filter))filter="*";
      const scoped=matching(), categories=[...new Set(scoped.map(l=>metadata(l).category))].sort(), levels=[...new Set(scoped.map(l=>metadata(l).level).filter(Boolean))].sort();
      const visible=scoped.filter(l=>(category==="*"||metadata(l).category===category)&&(level==="*"||metadata(l).level===level));
      const groups=new Map();
      visible.sort((a,b)=>metadata(a).unit-metadata(b).unit||metadata(a).week-metadata(b).week||metadata(a).day-metadata(b).day||a.title.localeCompare(b.title)).forEach(l=>{
        const m=metadata(l), k=m.program+" · "+(m.level||m.language);
        if(!groups.has(k))groups.set(k,[]);groups.get(k).push(l);
      });
      const cards=cardsFor(scoped,state), due=cards.filter(c=>!c.review||c.review.due<=Date.now());
      const mistakes=cards.filter(c=>c.review?!c.review.known:c.original===false);
      const chosen=reviewMode==="wrong"?mistakes:reviewMode==="vocab"?cards.filter(c=>kind(c.t)==="flashcard"):due;
      const skills=new Map();
      cards.forEach(c=>{
        const outcome=c.review?.known??c.original;if(outcome===null) return;
        c.tags.forEach(tag=>{const key=metadata(c.l).program+" / "+tag, s=skills.get(key)||[0,0];s[1]++;if(outcome)s[0]++;skills.set(key,s);});
      });
      const active=state.exams.find(e=>e.id===examId);
      const program=filter==="*"?programs[0]:filter;
      root.innerHTML='<section class="panel lab-panel"><div class="eyebrow">LANGUAGE LAB · 学习工作台</div><h2>课程分类</h2><div class="lab-tools">'+
        '<label>学习计划 <select id="lab-program">'+options([["*","全部计划"],...programs.map(p=>[p,p])],filter)+'</select></label>'+
        '<label>分类 <select id="lab-category">'+options([["*","全部分类"],...categories.map(p=>[p,p])],category)+'</select></label>'+
        '<label>等级 <select id="lab-level">'+options([["*","全部等级"],...levels.map(p=>[p,p])],level)+'</select></label></div>'+
        ([...groups].map(([name,ls])=>'<h3>'+esc(name)+'</h3><div class="lesson-grid">'+ls.map(l=>cardHTML({l})).join("")+'</div>').join("")||'<p>暂无符合条件的课程。</p>')+'</section>'+
        '<section class="panel lab-panel" id="lab-review"><div class="eyebrow">REVIEW CENTER</div><h2>复习中心</h2><div class="lab-tools">'+
        [["due","到期复习 ("+due.length+")"],["wrong","错题本 ("+mistakes.length+")"],["vocab","词汇卡片"]].map(([v,label])=>'<button class="mini-button '+(v===reviewMode?"active":"")+'" data-lab="review-mode" data-value="'+v+'">'+label+'</button>').join("")+'</div>'+
        '<p class="lab-meta">先回忆，再展开答案。认识后间隔为 1、3、7、14、30、60 天；忘记后 10 分钟再练。原始作答不变。</p>'+
        (chosen.slice(0,30).map(c=>'<details class="lab-card"><summary>'+esc(c.t.prompt)+' <small>· '+esc(c.l.title)+'</small></summary>'+
          (kind(c.t)==="listening"?speakButton(c.t.audioText,c.language,"播放听力"):"")+
          '<p><strong>'+esc(c.t.answer)+'</strong> '+(c.language!=="und"?speakButton(c.t.answer,c.language):"")+'</p><p>'+esc(c.t.explanation||"")+'</p>'+
          '<button class="mini-button" data-lab="rate" data-key="'+esc(c.key)+'" data-value="again">× 忘记</button> <button class="mini-button" data-lab="rate" data-key="'+esc(c.key)+'" data-value="known">✓ 记得</button></details>').join("")||'<p>暂无待复习内容。提交课程并核对开放题后会出现。</p>')+
        (chosen.length>30?'<p>当前显示前 30 项；完成后继续。</p>':"")+
        '<h3>知识点表现</h3><p class="lab-meta">按每道题/词卡最近一次已评分表现统计，并非预测掌握率。</p>'+
        ([...skills].sort((a,b)=>a[1][0]/a[1][1]-b[1][0]/b[1][1]).map(([tag,[good,total]])=>'<div class="lab-skill"><span>'+esc(tag)+'</span><progress max="'+total+'" value="'+good+'"></progress><span>'+good+'/'+total+'</span></div>').join("")||'<p>暂无已评分知识点。</p>')+'</section>'+
        '<section class="panel lab-panel" id="lab-exams"><div class="eyebrow">EXAM CENTER</div><h2>考试中心</h2>'+
        (active?examView(active):'<div class="lab-tools"><label>计划 <select id="lab-exam-program">'+options(programs.map(p=>[p,p]),program)+'</select></label>'+
          '<label>考试 <select id="lab-exam-mode">'+options([["weekly","每周测试"],["unit","单元考试"],["final","期末考试"]],"weekly")+'</select></label>'+
          '<label>周/单元编号 <input id="lab-exam-scope" type="number" min="1" max="999" value="1"></label>'+
          '<label>限时分钟 <input id="lab-exam-minutes" type="number" min="1" max="180" value="30"></label>'+
          '<label>题数上限 <input id="lab-exam-count" type="number" min="1" max="100" value="20"></label><button class="button primary" data-lab="exam-start">组卷并开始</button></div>'+
          '<p class="lab-meta">周测按 week、单元考试按 unit、期末覆盖整个计划；优先使用导入的对应试卷，否则从新课/复习课题库抽取。交卷前不显示答案或提示。非防作弊系统。</p>'+
          (state.exams.slice().reverse().map(e=>'<div class="lab-history"><span>'+esc(LABELS[e.mode]+" · "+e.program+" · "+new Date(e.started).toLocaleString())+'</span><button class="mini-button" data-lab="exam-open" data-id="'+esc(e.id)+'">'+(e.finished===null?"继续考试":examScore(e).correct+"/"+examScore(e).graded+" · 查看记录")+'</button></div>').join("")||'<p>暂无考试记录。</p>'))+'</section>';
      updateClock();
    }
    renderHome=()=>{
      oldHome();
      document.title="WriteLab · LanguageLab";
      siteStatus.textContent=allLessons().length+" COURSES";
      const hero=ui.querySelector(".hero");
      if(hero)hero.innerHTML='<div><div class="eyebrow">ACTIVE LEARNING · MULTILINGUAL</div><h1>LanguageLab.</h1><p class="hero-intro">从语言基础到真实表达：学习、复习、测试、持续进步。</p></div><aside class="hero-aside"><div class="aside-label">ONE WORKSPACE</div><div class="aside-num">'+allLessons().length+' <small>COURSES</small></div><p>保留原 WriteLab 学习记录。</p></aside>';
      const library=document.getElementById("custom-lessons");
      if(library){
        // Legacy library is followed by the old English header, grid, week strip.
        let next=library.nextElementSibling;
        for(let i=0;i<3&&next;i++){const n=next.nextElementSibling;next.remove();next=n;}
        library.remove();
      }
      const panel=document.createElement("div");panel.id="language-lab";
      (hero||ui.firstElementChild).insertAdjacentElement("afterend",panel);
      renderWorkspace();
    };
    function startExam(mode,program,scope,minutes,count,explicit){
      if(!["weekly","unit","final"].includes(mode)||!program||
         !Number.isInteger(minutes)||minutes<1||minutes>180||
         !Number.isInteger(count)||count<1||count>100||
         !Number.isInteger(scope)||scope<0||scope>999){alert("请检查考试范围、时间与题数。");return;}
      const state=read();expire(state);
      if(state.exams.length>=200){alert("考试记录已达上限，请先备份。");return;}
      if(state.exams.some(e=>e.finished===null)){alert("还有未完成考试，请继续或交卷后再开始。");return;}
      const inScope=l=>metadata(l).program===program&&(mode==="final"||metadata(l)[mode==="weekly"?"week":"unit"]===scope);
      const available=allLessons().filter(inScope);
      const authored=explicit?[explicit]:available.filter(l=>metadata(l).lessonType===mode);
      const bank=authored.length?authored:available.filter(l=>["learning","review"].includes(metadata(l).lessonType));
      const pool=bank.flatMap(l=>getTasks(l).map(t=>({...t,language:metadata(l).language,source:l.id+"/"+t.id})));
      if(!pool.length){alert("当前范围没有题目，请先导入相应课程，或选择正确周/单元。");return;}
      // Fisher–Yates samples from source questions without modifying their order.
      if(!authored.length)for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
      const items=pool.slice(0,count).map((t,i)=>({...t,id:"q"+(i+1),kind:kind(t)}));
      const now=Date.now(), id="exam-"+now.toString(36)+"-"+Math.random().toString(36).slice(2,9);
      state.exams.push({id,mode,program,scope,started:now,deadline:now+minutes*60000,finished:null,items,answers:{},marks:{}});
      if(write(state)){examId=id;renderWorkspace();document.getElementById("lab-exams")?.scrollIntoView();}
    }
    function updateClock(){
      const clock=document.getElementById("lab-clock");if(!clock||!examId)return;
      const state=read(), e=state.exams.find(x=>x.id===examId);if(!e)return;
      if(e.finished!==null||expire(state)){
        if(write(state))renderWorkspace();return;
      }
      const s=Math.ceil((e.deadline-Date.now())/1000);
      clock.textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");
    }
    setInterval(updateClock,1000);
    // Voice recognition is a transcription aid, not a pronunciation score.
    // The browser/OS may use an external recognition provider.
    function speak(value,lang){
      if(!("speechSynthesis" in window)||!("SpeechSynthesisUtterance" in window)){alert("当前浏览器不支持 TTS。");return;}
      const utterance=new SpeechSynthesisUtterance(value);if(lang!=="und")utterance.lang=lang;
      const voices=speechSynthesis.getVoices();
      const voice=voices.find(v=>v.lang.toLowerCase()===lang.toLowerCase())||voices.find(v=>v.lang.split("-")[0]===lang.split("-")[0]);
      if(lang!=="und"&&voices.length&&!voice){alert("设备没有 "+lang+" 语音，请安装对应语言的系统语音包。");return;}
      if(voice)utterance.voice=voice;utterance.rate=0.85;
      utterance.onerror=e=>{if(!["interrupted","canceled"].includes(e.error))alert("语音播放失败："+e.error);};
      speechSynthesis.cancel();speechSynthesis.speak(utterance);
    }
    function mic(target,lang){
      const C=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(!C){alert("当前浏览器不支持语音识别，可手动输入。建议使用支持 Web Speech 的浏览器。");return;}
      const el=document.getElementById(target);
      if(!el||el.readOnly)return;
      if(!confirm("语音可能由浏览器或系统的在线识别服务处理；WriteLab 不上传录音，也不保存音频。允许本次识别吗？"))return;
      recognition?.abort();
      if("speechSynthesis" in window)speechSynthesis.cancel();
      const rec=new C();recognition=rec;rec.lang=lang==="und"?"en-US":lang;rec.interimResults=false;rec.continuous=false;
      rec.onresult=e=>{
        if(!el.isConnected||el.readOnly||recognition!==rec)return;
        el.value=(el.value?el.value+" ":"")+Array.from(e.results).map(x=>x[0].transcript).join(" ");
        el.dispatchEvent(new Event("input",{bubbles:true}));
      };
      rec.onerror=e=>{if(e.error!=="aborted")alert("语音识别失败："+e.error+"；可以手动输入。");};
      rec.onend=()=>{if(recognition===rec)recognition=null;};
      try{rec.start();}catch(e){recognition=null;alert(e.message);}
    }
    addEventListener("hashchange",()=>{recognition?.abort();recognition=null;if("speechSynthesis" in window)speechSynthesis.cancel();});
    ui.addEventListener("change",e=>{
      const el=e.target;
      if(el.id==="lab-program"){filter=el.value;category=level="*";renderWorkspace();}
      else if(el.id==="lab-category"){category=el.value;renderWorkspace();}
      else if(el.id==="lab-level"){level=el.value;renderWorkspace();}
      else if(el.matches('input[type="radio"][data-lab-answer]')) saveExamAnswer(el);
    });
    ui.addEventListener("input",e=>{if(e.target.matches("textarea[data-lab-answer]"))saveExamAnswer(e.target);});
    function saveExamAnswer(el){
      const state=read(), e=state.exams.find(x=>x.id===examId);if(!e||e.finished!==null)return;
      if(expire(state)){if(write(state))renderWorkspace();return;}
      if(el.value.length>12000){el.value=el.value.slice(0,12000);}
      e.answers[el.dataset.labAnswer]=el.value;write(state);
    }
    ui.addEventListener("click",event=>{
      const b=event.target.closest("button[data-lab]");if(!b)return;
      event.preventDefault();event.stopImmediatePropagation();
      const a=b.dataset.lab;
      if(a==="speak"){speak(b.dataset.value,b.dataset.lang);return;}
      if(a==="mic"){mic(b.dataset.target,b.dataset.lang);return;}
      if(a==="review-mode"){reviewMode=b.dataset.value;renderWorkspace();return;}
      if(a==="rate"){
        const state=read(), key=b.dataset.key;
        if(!cardsFor(matching(),state).some(c=>c.key===key))return;
        state.reviews[key]=schedule(state.reviews[key],b.dataset.value==="known");
        if(write(state))renderWorkspace();return;
      }
      if(a==="exam-start"){
        const val=id=>document.getElementById(id).value, mode=val("lab-exam-mode");
        startExam(mode,val("lab-exam-program"),mode==="final"?0:Number(val("lab-exam-scope")),Number(val("lab-exam-minutes")),Number(val("lab-exam-count")));return;
      }
      if(a==="exam-course"){
        const l=store.lessons.get(b.dataset.id);if(!l)return;
        const m=metadata(l);
        startExam(m.lessonType,m.program,m.lessonType==="weekly"?m.week:m.lessonType==="unit"?m.unit:0,l.examMinutes||30,Math.min(100,getTasks(l).length),l);return;
      }
      if(a==="exam-open"){examId=b.dataset.id;renderWorkspace();return;}
      if(a==="exam-close"){recognition?.abort();examId=null;renderWorkspace();return;}
      const state=read(), e=state.exams.find(x=>x.id===examId);if(!e)return;
      expire(state);
      if(a==="exam-submit"){
        if(e.finished===null&&!confirm("确认交卷？提交后答案不可修改。"))return;
        e.finished=e.finished??Date.now();
        recognition?.abort();
      }else if(a==="exam-mark"&&e.finished!==null&&["good","revise"].includes(b.dataset.value)&&e.items.some(t=>t.id===b.dataset.q&&!objective(t))){
        e.marks[b.dataset.q]=b.dataset.value;
      }else if(a==="exam-export"&&e.finished!==null){
        downloadJSON({format:"writelab-exam-result",version:1,...e,score:examScore(e)},e.id+".json");return;
      }else return;
      if(write(state))renderWorkspace();
    },true);
  }
  return {KEY,install,normalizeCourse,normalizeText,objective,grade,schedule,metadata,validateState,read,expire,examScore};
})();
