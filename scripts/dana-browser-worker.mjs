// HTTP browser protocol for browser.task; loopback-only, one task at a time.
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const state='/home/dana-browser';
await mkdir(state+'/responses',{recursive:true});
const browser=await chromium.launchPersistentContext(state+'/profile',{headless:false,viewport:{width:1280,height:900},proxy:{server:'http://127.0.0.1:9224',bypass:'<-loopback>'},args:['--disable-quic','--proxy-bypass-list=<-loopback>','--no-sandbox']});
browser.setDefaultTimeout(4000);
let page=browser.pages()[0] || await browser.newPage();
browser.on('page',opened=>{page=opened;});
let activeTask=null;
let taskExpires=0;
const submittedTasks=new Set();
let serial=Promise.resolve();
const finalButton=/\b(confirm(?: reservation| booking)?|reserve now|book now|complete (?:booking|reservation)|submit (?:booking|reservation)|pay)\b/i;
const blockedPage=/verify (?:you are|your (?:phone|identity))|not a robot|verification code|one[- ]time (?:code|password)|sign in to (?:continue|book)|log in to (?:continue|book)|please (?:complete|solve) (?:the )?captcha/i;
async function snapshot() {
  const content=await page.evaluate(()=>{
    let counter=Number(document.documentElement.dataset.fabricCounter||0);
    const elements=[];
    for(const element of document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="combobox"]')) {
      if(!element.getClientRects().length) continue;
      if(!element.dataset.fabricRef) element.dataset.fabricRef=String(++counter);
      elements.push({ref:element.dataset.fabricRef,role:element.getAttribute('role')||element.tagName.toLowerCase(),text:(element.getAttribute('aria-label')||element.innerText||element.labels?.[0]?.innerText||element.getAttribute('placeholder')||(element.type==='submit'?element.value:'')||'').trim().slice(0,300),type:element.getAttribute('type')||undefined,value:element.value||undefined});
    }
    document.documentElement.dataset.fabricCounter=String(counter);
    return {dom:(document.body?.innerText||'').slice(0,24000),elements};
  });
  const screenshotBase64=(await page.screenshot({type:'png',timeout:2000})).toString('base64');
  return {url:page.url(),...content,screenshotBase64};
}
function confirmationFrom(snap,confirmed=false) {
  const values=snap.elements.map(e=>`${e.text} ${e.value||''}`).join('\n');
  const text=values+'\n'+snap.dom;
  const date=text.match(/\b(?:20\d\d-\d\d-\d\d|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+20\d\d)?)\b/i)?.[0];
  const time=text.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i)?.[0];
  const size=text.match(/\b(\d{1,2})\s*(?:guests?|people|diners?|persons?)\b/i)?.[1]||text.match(/(?:party size|guests|people)\s*[:\n]?\s*(\d{1,2})\b/i)?.[1];
  const candidate=confirmed?snap.dom.match(/(?:confirmation (?:number|code|reference)|(?:booking|reservation) reference|reference(?: number|code)?)\s*(?:[:#]|is)?\s*([A-Z0-9-]{3,})\b/i)?.[1]:undefined;
  // Only an explicitly labelled observed code, never a generated/default reference.
  const reference=candidate&&(/\d/.test(candidate)||/^[A-Z]{4,}$/.test(candidate))?candidate:undefined;
  return date&&time&&size?{date,time,partySize:Number(size),...(reference?{reference}:{})}:undefined;
}
async function action(input) {
  if(typeof input.taskId!=='string'||!input.taskId||typeof input.id!=='string'||!input.id) throw new Error('taskId and id are required strings');
  if(input.ref!==undefined&&!/^\d+$/.test(String(input.ref))) throw new Error('ref must be a snapshot reference id');
  if(activeTask && Date.now()>taskExpires) {activeTask=null;await page.goto('about:blank');}
  if(activeTask && activeTask!==input.taskId) throw new Error('Dana browser is busy with another task');
  const file=state+'/responses/'+createHash('sha256').update(input.taskId+'\0'+input.id).digest('hex')+'.json';
  try {const stored=JSON.parse(await readFile(file,'utf8'));if(stored.pending)throw new Error('previous action outcome unknown; do not repeat submission');return stored;} catch(error){if(error.code!=='ENOENT')throw error;}
  activeTask=input.taskId;taskExpires=Date.now()+5*60*1000;
  const submittedFile=state+'/responses/'+createHash('sha256').update('submitted\\0'+input.taskId).digest('hex')+'.json';
  try {await readFile(submittedFile);submittedTasks.add(input.taskId);}catch(error){if(error.code!=='ENOENT')throw error;}
  // A durable pending marker prevents replaying a click after a worker restart or lost response.
  await writeFile(file,JSON.stringify({pending:true}));
  let result;
  try {
    const before=await snapshot();
    if(['click','type','select','key'].includes(input.action)&&blockedPage.test(before.dom)) {
      result={...before,error:'Human intervention required: CAPTCHA, login, or phone verification. No interaction attempted.'};
    } else {
      const locator=input.ref?page.locator(`[data-fabric-ref="${String(input.ref).replace(/[^0-9]/g,'')}"]`):null;
      const item=before.elements.find(e=>e.ref===String(input.ref));
      const submitKey=input.action==='key'&&(/(?:^|\+)Enter$/i.test(input.key||'')||input.key==='Space'||input.key===' ');
      const submitter=item;
      const hasContact=before.elements.some(e=>e.type==='email'||e.type==='tel');
      const explicitButton=item&&(item.role==='button'||item.type==='submit'||item.type==='button');
      const isFinal=(input.action==='click'||submitKey)&&explicitButton&&(finalButton.test(submitter.text)||(hasContact&&/\b(reserve|book|confirm|complete)\b/i.test(submitter.text)));
      if(submitKey&&!explicitButton) {
        result={...before,error:'This key can implicitly submit a form; target an explicit visible button and use click for submission.'};
      } else if(submitKey&&input.guardSubmit) {
        result={...before,error:'Use an explicit button click so final submission is guarded.'};
      } else if(isFinal&&submittedTasks.has(input.taskId)) {
        result={...before,error:'A final reservation action has already been attempted for this task; do not submit twice.'};
      } else if(isFinal&&input.guardSubmit&&!input.approvedSubmit) {
        result={...before,needsConfirmation:true,pendingAction:{action:'click',ref:submitter.ref},confirmation:confirmationFrom(before)};
      } else if(isFinal&&input.guardSubmit&&input.approvedSubmit&&!confirmationFrom(before)) {
        result={...before,error:'Cannot verify reservation date, time, and party size from current page; submission blocked.'};
      } else {
        if(isFinal) {
          submittedTasks.add(input.taskId);
          await writeFile(submittedFile,JSON.stringify({attempted:true}));
        }
        switch(input.action) {
          case 'navigate': {const url=new URL(input.url);if(!['http:','https:'].includes(url.protocol))throw new Error('Only HTTP(S) navigation permitted');await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:8000});break;}
          case 'snapshot':case 'screenshot':break;
          case 'click':if(!locator)throw new Error('ref required');await locator.click({timeout:5000});break;
          case 'type':if(!locator)throw new Error('ref required');await locator.fill(input.text||'');break;
          case 'select':if(!locator)throw new Error('ref required');await locator.selectOption(input.value);break;
          case 'key':await (locator||page.locator('body')).press(input.key);break;
          case 'close':await page.goto('about:blank');activeTask=null;break;
          default:throw new Error('Unsupported browser action');
        }
        result={...await snapshot(),submitted:Boolean(isFinal)};
        const evidence=result.dom.match(/[^\n]*(?:reservation (?:is )?confirmed|booking (?:is )?confirmed|confirmation (?:number|code|reference)|(?:booking|reservation) reference|you're booked|you are booked)[^\n]*/i)?.[0];
        if(evidence){result.confirmationEvidence=evidence;result.confirmation=confirmationFrom(result,true);}
      }
    }
  } catch(error) {result={error:error.message,url:page.url()};try{Object.assign(result,await snapshot());}catch{}}
  await writeFile(file,JSON.stringify(result));
  return result;
}
const server=http.createServer((request,response)=>{
  if(request.method==='GET'&&request.url==='/health'){
    const probe=http.get('http://127.0.0.1:9224/health',upstream=>{upstream.resume();response.writeHead(upstream.statusCode===200?200:503);response.end(JSON.stringify({ok:upstream.statusCode===200,headed:true,viewerUrl:null}));});
    probe.on('error',()=>{response.writeHead(503);response.end(JSON.stringify({ok:false,error:'Public egress proxy unavailable'}));});
    probe.setTimeout(1000,()=>probe.destroy());return;
  }
  if(request.method!=='POST'||request.url!=='/action'){response.writeHead(404);response.end();return;}
  let body='';request.on('data',chunk=>{body+=chunk;if(body.length>128*1024)request.destroy();});
  request.on('end',()=>{
    const job=serial.then(async()=>{try{const result=await action(JSON.parse(body));response.setHeader('content-type','application/json');response.end(JSON.stringify(result));}catch(error){response.writeHead(409,{'content-type':'application/json'});response.end(JSON.stringify({error:error.message}));}});
    serial=job.catch(()=>{});
  });
});
server.listen(9223,'127.0.0.1',()=>console.log('Dana headed browser worker ready'));
