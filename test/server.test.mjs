import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
let child,base;
before(async()=>{
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,SEAT_MARKET_PORT:'0'},windowsHide:true});
  base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Server did not start')),10000);child.once('error',reject);child.stdout.on('data',buf=>{output+=buf;const url=output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];if(url){clearTimeout(timer);resolve(url);}});child.once('exit',code=>{clearTimeout(timer);if(!base)reject(Error(`Server exited ${code}`));});});
});
after(()=>child?.kill());
test('loopback preview serves HTML with external connections disabled',async()=>{const response=await fetch(base);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);assert.match(await response.text(),/Seat Market/);});
test('source modules are served as JavaScript and HEAD has no body',async()=>{const response=await fetch(base+'model.js',{method:'HEAD'});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.equal(await response.text(),'');});
test('no write endpoints or private project files are served',async()=>{for(const file of ['review/claude-scoped.md','package.json','.env','../server.mjs'])assert.equal((await fetch(base+file)).status,404);assert.equal((await fetch(base,{method:'POST',body:'test'})).status,405);});
test('malformed absolute URL returns 400 and server remains alive',async()=>{const url=new URL(base);const status=await new Promise((resolve,reject)=>{const request=http.request({hostname:url.hostname,port:url.port,path:'http://[bad',method:'GET'},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});assert.equal(status,400);assert.equal((await fetch(base)).status,200);});
