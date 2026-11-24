/* Optional real-browser smoke test. Run after npm install --no-save playwright
 * and npx playwright install chromium. Production site remains dependency-free.
 */
"use strict";
const assert=require("node:assert/strict");
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const {chromium}=require("playwright");
const root=path.resolve(__dirname,"..");
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,"http://localhost");
  const file=path.resolve(root,"."+decodeURIComponent(url.pathname==="/" ? "/index.html" : url.pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){
    res.writeHead(404);res.end();return;
  }
  const types={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json"};
  res.setHeader("Content-Type",(types[path.extname(file)]||"application/octet-stream")+"; charset=utf-8");
  fs.createReadStream(file).pipe(res);
});
async function main(){
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
  try{
    const context=await browser.newContext();
    const page=await context.newPage();
    const errors=[];
    page.on("pageerror",e=>errors.push(String(e)));
    page.on("dialog",d=>d.accept());
    const url="http://127.0.0.1:"+server.address().port;
    await page.goto(url);
    await page.locator("#lab-catalog").waitFor();
    await page.locator('#lab-catalog a[href="#/day01"]').click();
    await page.locator(".task").first().waitFor();
    await page.locator("a.back").click();
    await page.locator("#lab-catalog").waitFor();
    const importFile=async filename=>{
      await page.locator("#course-json-input").fill(fs.readFileSync(path.join(root,"examples",filename),"utf8"));
      await page.locator('[data-action="course-import"]').click();
      await page.locator("#course-import-status").filter({hasText:"已添加"}).waitFor();
    };
    await importFile("spanish-a1-day01.json");
    await importFile("spanish-a1-week01-exam.json");
    await page.locator("#lab-language").selectOption("es-ES");
    assert.equal(await page.locator('#lab-catalog a[href="#/day01"]').count(),0);
    await page.locator('#lab-catalog a[href="#/custom-spanish-a1-day01"]').click();
    await page.locator("#answer-g1").fill("Buenos días");
    await page.locator("#answer-s1").fill("soy");
    assert(await page.locator(".lab-study-notes").count()>0);
    assert(await page.locator('#task-p3 [data-lab="speak"]').count()>0);
    assert(await page.locator('#task-c2 [data-lab="mic"]').count()>0);
    await page.locator('[data-action="submit"]').click();
    await page.locator("#task-g1 .review-box").waitFor();
    assert.match(await page.locator("#task-g1 .review-box").innerText(),/✓ 正确/);
    await page.reload();
    assert.equal(await page.locator("#answer-g1").inputValue(),"Buenos días");
    await page.locator("a.back").click();
    await page.locator("#lab-review").waitFor();
    await page.locator('[data-lab="review-mode"][data-value="wrong"]').click();
    await page.locator("#lab-review details summary").first().click();
    await page.locator('#lab-review details[open] [data-lab="rate"][data-value="known"]').first().click();
    const key="writelab.languageLab.v1";
    assert(await page.evaluate(k=>Object.keys(JSON.parse(localStorage.getItem(k)).reviews).length>0,key));
    await page.locator('[data-lab="exam-course"][data-id="custom-spanish-a1-week01-exam"]').click();
    await page.locator("#lab-exam-q1").fill("eres");
    await page.locator("#lab-exam-q2").fill("Gracias");
    assert.equal(await page.locator("#lab-exams .review-box").count(),0);
    await page.reload();
    await page.locator('[data-lab="exam-open"]').first().click();
    assert.equal(await page.locator("#lab-exam-q1").inputValue(),"eres");
    assert.equal(await page.locator("#lab-exams .review-box").count(),0);
    await page.locator('[data-lab="exam-submit"]').click();
    await page.locator("#lab-exams .review-box").first().waitFor();
    assert.match(await page.locator("#lab-exams .review-box").first().innerText(),/✓ 正确/);
    await page.locator('[data-lab="exam-close"]').click();
    // Use a generated final exam and force an elapsed deadline to exercise resume.
    await page.locator("#lab-exam-program").selectOption("spanish-a1");
    await page.locator("#lab-exam-mode").selectOption("final");
    await page.locator("#lab-exam-count").fill("2");
    await page.locator('[data-lab="exam-start"]').click();
    await page.locator("#lab-clock").waitFor();
    await page.evaluate(k=>{
      const s=JSON.parse(localStorage.getItem(k)),e=s.exams.find(x=>x.finished===null);
      e.started=Date.now()-120000;e.deadline=Date.now()-1000;
      localStorage.setItem(k,JSON.stringify(s));
    },key);
    await page.reload();
    await page.locator("#lab-exams").waitFor();
    assert(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).exams.every(e=>e.finished!==null),key));
    const original=await page.evaluate(()=>JSON.parse(localStorage.getItem("writelab.progress.v1.custom-spanish-a1-day01")).answers);
    assert.equal(original.g1,"Buenos días");
    assert.equal(original.s1,"soy");
    assert.deepEqual(errors,[]);
    console.log("Browser smoke passed: legacy navigation, import, filter, notes, speech controls, grading, review, exam resume/expiry and independent answers.");
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
