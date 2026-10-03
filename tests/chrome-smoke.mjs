// Node.js 22 以上；啟動本機 Python 網站及 Chrome 無頭模式，不安裝套件。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:net';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const chrome=process.env.CHROME_BIN || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'google-chrome');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const profile=await mkdtemp(join(tmpdir(),'deid-chrome-'));
let server,browser,ws,stderr='',serverErrors='',seq=0;const pending=new Map(),requests=[],errors=[];
async function until(fn,ms=30000){const start=Date.now();while(Date.now()-start<ms){const value=await fn();if(value)return value;await sleep(100)}throw Error('等待逾時');}
function call(method,params={},sessionId){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP 逾時：'+method))},120000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})}
async function evalJS(sessionId,expression){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;}
async function page(url){const{targetId}=await call('Target.createTarget',{url:'about:blank'});const{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});await call('Runtime.enable',{},sessionId);await call('Network.enable',{},sessionId);await call('Page.enable',{},sessionId);await call('Page.navigate',{url},sessionId);await until(()=>evalJS(sessionId,"!!window.deid && document.getElementById('model-status').dataset.state !== 'loading'"),120000);return sessionId}
try{
 const port=await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})});
 const origin='http://127.0.0.1:'+port;
 server=spawn('python3',['-u','-m','http.server',String(port),'--bind','127.0.0.1'],{cwd:root,stdio:['ignore','ignore','pipe']});
 server.stderr.on('data',d=>serverErrors+=d);server.on('error',e=>serverErrors+=e.message);
 await until(async()=>{if(server.exitCode!==null)throw Error(serverErrors);try{return(await fetch(origin+'/index.html')).ok}catch{return false}});
 browser=spawn(chrome,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--metrics-recording-only','about:blank'],{stdio:['ignore','ignore','pipe']});
 browser.stderr.on('data',d=>stderr+=d);browser.on('error',e=>stderr+=e.message);
 const active=await until(async()=>{if(browser.exitCode!==null||browser.signalCode!==null||stderr.includes('Permission denied'))throw Error('Chrome 無法啟動：\n'+stderr);try{return await readFile(join(profile,'DevToolsActivePort'),'utf8')}catch{return false}},15000);
 const [debugPort,endpoint]=active.trim().split('\n');ws=new WebSocket('ws://127.0.0.1:'+debugPort+endpoint);
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}else if(m.method==='Network.requestWillBeSent'){requests.push({url:m.params.request.url,method:m.params.request.method})}else if(m.method==='Runtime.exceptionThrown'){errors.push(m.params.exceptionDetails)}});
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
 const web=await page(origin+'/index.html');
 const status=await evalJS(web,"document.getElementById('model-status').textContent");assert(status.includes('已啟用人名辨識模型'),status);console.log('PASS 真實模型載入：'+status);
 const text='陳美玲在會議中介紹王小明。\n王小明住在臺南市北區公園路，明天開會。電話+886 936 802 417，護照K8732601。';
 const result=await evalJS(web,`window.deid.runAuto(${JSON.stringify(text)}, {})`);
 assert(result.modelNames.length>0,'真實模型沒有找出任何人名');for(const name of result.modelNames){assert(text.includes(name));assert(result.mapping.some(m=>m.value===name&&m.type==='姓名'))};
 assert.equal(await evalJS(web,`window.deid.restore(${JSON.stringify(result.masked)},${JSON.stringify(result.mapping)})`),text);
 console.log('PASS 真實 runAuto 人名與逐字還原：'+result.modelNames.join('、'));
 await evalJS(web,`document.getElementById('original').value=${JSON.stringify(text)};document.getElementById('run-button').click();true`);
 await until(()=>evalJS(web,"!document.getElementById('run-button').disabled"),120000);
 const choices=await evalJS(web,"[...document.querySelectorAll('.choice')].filter(l=>l.querySelector('.model-source')).map(l=>({name:l.children[1].textContent,checked:l.children[0].checked}))");assert(choices.length>0);assert(choices.every(c=>c.checked));console.log('PASS 網頁模型候選預設勾選與來源標註');
 const file=await page(pathToFileURL(join(root,'index.html')).href);
 const fileResult=await evalJS(file,"(async()=>{const text='身分證A123456789，手機0936802417';const r=await deid.runAuto(text);document.getElementById('original').value=text;document.getElementById('run-button').click();return{status:document.getElementById('model-status').textContent,state:document.getElementById('model-status').dataset.state,modelNames:r.modelNames,masked:document.getElementById('masked').value,restored:deid.restore(r.masked,r.mapping)}})()");
 assert.equal(fileResult.state,'unavailable');assert(fileResult.status.includes('雙擊打開檔案時瀏覽器不允許讀取模型'));assert.deepEqual(fileResult.modelNames,[]);assert(fileResult.masked.includes('[身分證1]'));assert.equal(fileResult.restored,'身分證A123456789，手機0936802417');console.log('PASS 雙擊模式顯示未載入、遮罩與還原正常');
 assert.deepEqual(errors,[]);const remote=requests.filter(r=>!r.url.startsWith(origin+'/')&&!r.url.startsWith('file:'));assert.deepEqual(remote,[]);assert(requests.every(r=>r.method==='GET'));console.log('PASS 沒有外站請求、資料傳送或未捕捉的 JavaScript 例外');
 console.log(JSON.stringify({modelNames:result.modelNames,masked:result.masked,file:fileResult,requests},null,2));
}catch(e){console.error(e.message);process.exitCode=1}
finally{if(ws){try{await call('Browser.close')}catch{}ws.close()}for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('測試結束'))}pending.clear();browser?.kill('SIGTERM');server?.kill('SIGTERM');await sleep(300);await rm(profile,{recursive:true,force:true})}
