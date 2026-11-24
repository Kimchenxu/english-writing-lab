/* Node 18+ smoke tests; no npm dependencies required.
 * Uses the real classic-script engine with a minimal DOM/storage harness.
 * This is not a substitute for browser/microphone E2E testing.
 */
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const bootstrap="loadCourses().then(navigate).catch(e=>showError(e.message));";
const app=read("assets/app.js");
assert(app.includes(bootstrap));
const source=read("assets/language-lab.js")+"\n"+app.replace(bootstrap,"");
const ui={addEventListener(){},querySelectorAll(){return[]}};
const document={getElementById(){return ui},addEventListener(){}};
const map=new Map(), messages=[];
const localStorage={get length(){return map.size},key:i=>[...map.keys()][i],
  getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};
const api=new Function("document","window","localStorage","location","addEventListener","setInterval","alert","confirm",source+
  "\nreturn {LanguageLab,normalizeCustomCourse,wordCount,store,allStats,copyText,buildCourseGenerationPrompt,exportBackup,importBackup,loadRecord,setDownloader:fn=>{downloadJSON=fn;}};"
)(document,{},localStorage,{hash:"",reload(){}},()=>{},()=>{},msg=>messages.push(msg),()=>true);

async function main(){
  const L=api.LanguageLab;
  const old=api.normalizeCustomCourse({id:"old",title:"Old",subject:"英语",questions:[
    {id:"q1",type:"choice",prompt:"Select",options:["a","b"],answer:"a"},
    {id:"q2",type:"write",prompt:"Explain"}
  ]});
  assert.equal(old.sections[0].tasks.length,2);
  assert.equal(old.language,"en-US");
  assert.equal(old.sections[0].tasks[1].type,"write");
  const input={format:"writelab-course",version:2,id:"spanish-a1-day01",title:"Saludos",subject:"西班牙语",
    language:"es-ES",level:"A1",program:"spanish-a1",unit:1,week:1,day:1,category:"grammar",
    lessonType:"learning",objectives:["ser"],studyNotes:["Study"],sections:[{id:"s1",title:"Practice",notes:["Note"],tasks:[
      {id:"q1",type:"conjugation",prompt:"yo (ser)",answer:"soy",tags:["ser"]},
      {id:"q2",type:"listening",prompt:"listen",audioText:"sí",answer:"sí"},
      {id:"q3",type:"speaking",prompt:"speak",answer:"Hola"},
      {id:"q4",type:"fill",prompt:"hello",answer:"Hola",acceptedAnswers:["¡Hola!"]}
    ]}]};
  const lesson=api.normalizeCustomCourse(input);
  assert.equal(lesson.language,"es-ES");
  assert.equal(lesson.program,"spanish-a1");
  assert.equal(lesson.week,1);
  assert.deepEqual(lesson.studyNotes,["Study"]);
  assert.deepEqual(lesson.sections[0].notes,["Note"]);
  assert.deepEqual(lesson,api.normalizeCustomCourse(JSON.parse(JSON.stringify(lesson))));
  api.store.current=lesson;
  api.store.answers={q1:"SOY",q2:"si",q3:"Hola",q4:"¡Hola!"};
  api.store.assessments={q3:"good"};
  const stats=api.allStats();
  assert.equal(stats.choice,3);
  assert.equal(stats.choiceGood,2);
  assert.equal(stats.written,1);
  assert.equal(stats.score,3);
  assert(api.copyText().includes("✕ needs review"));
  assert.equal(api.wordCount("¡Buenos días! ¿Cómo estás?"),4);
  assert(api.buildCourseGenerationPrompt().includes("conjugation"));
  assert.equal(L.grade({type:"write",kind:"fill",answer:"sí"},"si"),false);
  assert.equal(L.grade({type:"write",kind:"fill",answer:"sí"},"si\u0301"),true);
  assert.equal(L.grade({type:"write",kind:"fill",answer:"Hola",caseSensitive:true},"hola"),false);
  assert.equal(L.grade({type:"choice",answer:"A"},"a"),false);
  assert.equal(L.grade({type:"write",kind:"speaking",answer:"Hola"},"Hola"),null);
  assert.throws(()=>api.normalizeCustomCourse({...input,sections:[{tasks:[{type:"listening",prompt:"bad",answer:"x"}]}]}),/audioText/);
  assert.throws(()=>api.normalizeCustomCourse({...input,language:"not_a_locale"}),/BCP-47/);
  assert.throws(()=>api.normalizeCustomCourse({...input,version:99}),/version/);
  assert.throws(()=>api.normalizeCustomCourse({...input,unit:-1}),/unit/);
  const first=L.schedule(null,true,0);
  assert.equal(first.due,86400000);
  assert.equal(L.schedule(first,true,0).due,3*86400000);
  assert.equal(L.schedule(first,false,0).due,600000);
  const state=L.validateState({version:1,reviews:{"lesson/q1":first},exams:[
    {id:"exam-test",mode:"weekly",program:"spanish-a1",scope:1,started:1,deadline:10,finished:null,
      items:[{id:"q1",type:"write",kind:"fill",prompt:"hi",answer:"hola",language:"es-ES"},
        {id:"q2",type:"write",kind:"speaking",prompt:"speak",answer:"Hola",language:"es-ES"}],
      answers:{q1:"  Hola  ",q2:"Hola"},marks:{}}
  ]});
  assert.equal(state.exams[0].answers.q1,"  Hola  ");
  assert.deepEqual(L.examScore(state.exams[0]),{correct:1,graded:1,total:2});
  assert(L.expire(state,12));
  assert.equal(state.exams[0].finished,10);
  state.exams[0].marks.q2="good";
  assert.deepEqual(L.examScore(state.exams[0]),{correct:2,graded:2,total:2});
  assert.throws(()=>L.validateState({...state,version:99}),/格式/);
  // Verify actual backup/restore entrypoints and non-destructive legacy restore.
  api.store.customLessons.set(lesson.id,lesson);
  const originalKey="writelab.progress.v1."+lesson.id;
  localStorage.setItem(originalKey,JSON.stringify({answers:{q1:"soy"}}));
  localStorage.setItem(L.KEY,JSON.stringify(state));
  let backup;
  api.setDownloader(x=>backup=x);
  api.exportBackup();
  assert.equal(backup.languageLab.exams.length,1);
  assert.equal(backup.courses[0].language,"es-ES");
  assert.equal(JSON.parse(backup.records[originalKey]).answers.q1,"soy");
  localStorage.removeItem(L.KEY);localStorage.removeItem(originalKey);
  await api.importBackup({text:async()=>JSON.stringify(backup)});
  assert.equal(L.read(true).exams[0].finished,10);
  assert.equal(api.loadRecord(lesson.id).answers.q1,"soy");
  await api.importBackup({text:async()=>JSON.stringify({format:"writelab-local-backup",version:1,records:backup.records})});
  assert.equal(L.read(true).exams.length,1);
  // The examples must pass the same runtime validator as real imports.
  for(const file of ["examples/spanish-a1-day01.json","examples/spanish-a1-week01-exam.json"]){
    const sample=api.normalizeCustomCourse(JSON.parse(read(file)));
    assert.equal(sample.language,"es-ES");
    assert(sample.sections.flatMap(s=>s.tasks).length>0);
  }
  const manifest=JSON.parse(read("lessons/index.json"));
  for(const id of manifest.lessons){
    const l=JSON.parse(read("lessons/"+id+"/lesson.json"));
    assert.equal(l.id,id);
    const tasks=l.sections.flatMap(s=>s.tasks);
    assert(tasks.length>0);
    assert.equal(new Set(tasks.map(t=>t.id)).size,tasks.length);
    assert(tasks.every(t=>["choice","write"].includes(t.type)));
  }
  console.log("LanguageLab smoke tests passed: legacy lessons, v1/v2 imports, Unicode, grading, review schedule, exam deadline, backup, examples.");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
