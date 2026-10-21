'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const http = require('node:http');
const {DatabaseSync} = require('node:sqlite');
const {startPrototype,DATA_ROOT} = require('./server');

function connect(bindingFile) {
  const child=spawn(process.execPath,[path.join(__dirname,'mcp.js'),'--binding',bindingFile],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const pending=new Map(), received=[];
  const reader=readline.createInterface({input:child.stdout});
  reader.on('line',line=>{const message=JSON.parse(line);received.push(message);pending.get(message.id)?.(message);pending.delete(message.id);});
  let next=0;
  const raw=message=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
  const request=(method,params,id=++next)=>new Promise(resolve=>{pending.set(id,resolve);raw({id,method,params});});
  const close=async()=>{const done=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();await done;reader.close();};
  return {request,raw,close,received};
}
async function main() {
  const service=await startPrototype({toolBinding:{questionId:'mcp-question',threadId:'mcp-check'}});
  const bindingFile=path.join(service.directory,'binding.json');
  fs.writeFileSync(bindingFile,JSON.stringify({baseUrl:service.baseUrl,toolToken:service.toolToken,threadId:'mcp-check',questionId:'mcp-question'}));
  let client=connect(bindingFile);
  const parameters={name:'ask_question',arguments:{prompt:'请选择一次。',options:[{label:'确认一次'}]}};
  try {
    const init=await client.request('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'isolated-check',version:'1'},capabilities:{}});
    assert.equal(init.result.serverInfo.name,'unified-question-isolated');
    assert.equal((await client.request('tools/list',{})).result.tools[0].name,'ask_question');
    assert.equal((await client.request('ping',{},null)).error.code,-32600);
    await client.request('ping',{},'reusable-id');await client.request('ping',{},'reusable-id');
    assert.equal(client.received.filter(item=>item.id==='reusable-id').length,2);
    for (const args of [{prompt:' '},{prompt:'x',options:'invalid'},{prompt:'x',options:Array(9).fill({label:'x'})},{prompt:'x',options:[{label:'x',extra:true}]},{prompt:'x',options:[{label:'x'.repeat(501)}]}]) {
      assert.equal((await client.request('tools/call',{name:'ask_question',arguments:args})).error.code,-32602);
    }
    const first=client.request('tools/call',parameters,'pending-id');
    client.raw({id:'pending-id',method:'tools/call',params:parameters});
    const concurrent=client.request('tools/call',parameters);
    for(let i=0;i<100 && service.store.snapshot().questions.length===0;i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(service.store.snapshot().questions.length,1);
    const headers={authorization:`Bearer ${service.token}`,'content-type':'application/json'};
    const toolHeaders={...headers,authorization:`Bearer ${service.toolToken}`};
    assert.equal((await fetch(`${service.baseUrl}/api/questions/other/result`,{headers:toolHeaders})).status,403);
    assert.equal((await fetch(`${service.baseUrl}/api/questions/mcp-question/answer`,{method:'POST',headers:toolHeaders,body:JSON.stringify({requestId:'self-answer',value:'cannot answer',client:'phone'})})).status,403);
    assert.equal((await fetch(`${service.baseUrl}/api/questions`,{method:'POST',headers:toolHeaders,body:JSON.stringify({id:'other',threadId:'other',prompt:'bad'})})).status,403);
    assert.equal((await fetch(`${service.baseUrl}/api/questions/mcp-question/claim-delivery`,{method:'POST',headers,body:JSON.stringify({consumerId:'mcp-check',invocationId:'attempt'})})).status,403);
    const answer={requestId:'phone-reply',value:'真实路径 <beta>\n第二行',client:'phone'};
    const results=await Promise.all(Array.from({length:10},(_,i)=>fetch(`${service.baseUrl}/api/questions/mcp-question/answer`,{method:'POST',headers,body:JSON.stringify({...answer,requestId:`phone-${i}`})})));
    assert.equal(results.filter(r=>r.status===200).length,1);
    const pair=await Promise.all([first,concurrent]);
    const payloads=pair.map(reply=>JSON.parse(reply.result.content[0].text));
    assert.equal(payloads.filter(payload=>payload.status==='answer').length,1);
    assert.equal(payloads.filter(payload=>payload.status==='already_claimed').length,1);
    assert.equal(client.received.filter(item=>item.id==='pending-id').length,1);
    const payload=payloads.find(payload=>payload.status==='answer');
    assert.equal(payload.status,'answer');assert.equal(payload.value,answer.value);
    const duplicate=await client.request('tools/call',parameters);
    assert.equal(JSON.parse(duplicate.result.content[0].text).status,'already_claimed');
    assert(!duplicate.result.content[0].text.includes(answer.value));
    await client.close();client=connect(bindingFile);
    await client.request('initialize',{protocolVersion:'2025-06-18'});
    const restarted=await client.request('tools/call',parameters);
    assert.equal(JSON.parse(restarted.result.content[0].text).status,'already_claimed');
    const db=new DatabaseSync(path.join(service.directory,'PROTOTYPE-questions.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM answers').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,1);db.close();
    console.log(JSON.stringify({passed:true,realStdioMcp:true,answers:1,deliveries:1,concurrentToolCalls:'one-answer',duplicateToolCall:'rejected',mcpProcessRestart:'no-replay',browserCannotClaim:true,toolScopeEnforced:true,rpcIds:'pending-dedup-completed-reuse',invalidInputRejected:true}));
  } finally {
    await client.close();await service.close();
    const relative=path.relative(DATA_ROOT,service.directory);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    fs.rmSync(service.directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
async function checkLostClaimResponse() {
  const service=await startPrototype({toolBinding:{questionId:'lost-claim',threadId:'mcp-check'}});
  service.store.create({id:'lost-claim',threadId:'mcp-check',prompt:'已回答的问题'});
  service.store.answer('lost-claim',{requestId:'phone-claim',value:'只允许投递一次',client:'phone'});
  let client, claims=0;
  const proxy=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const response=await fetch(service.origin+req.url,{method:req.method,headers:{authorization:`Bearer ${service.toolToken}`,'content-type':'application/json'},body:req.method==='POST'?Buffer.concat(chunks):undefined});
    const data=await response.text();
    if(req.url.endsWith('/claim-delivery')){claims++;res.destroy();return;}
    res.writeHead(response.status,{'content-type':'application/json'});res.end(data);
  });
  try {
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    const bindingFile=path.join(service.directory,'lost-claim-binding.json');
    const binding={baseUrl:`http://127.0.0.1:${proxy.address().port}/question-prototype`,toolToken:service.toolToken,threadId:'mcp-check',questionId:'lost-claim'};
    fs.writeFileSync(bindingFile,JSON.stringify(binding));client=connect(bindingFile);
    await client.request('initialize',{protocolVersion:'2025-06-18'});
    const first=await client.request('tools/call',{name:'ask_question',arguments:{prompt:'已回答的问题'}});
    assert.equal(JSON.parse(first.result.content[0].text).status,'delivery_uncertain');
    assert(!first.result.content[0].text.includes('只允许投递一次'));assert.equal(claims,1);
    await client.close();client=null;
    fs.writeFileSync(bindingFile,JSON.stringify({...binding,baseUrl:service.baseUrl}));client=connect(bindingFile);
    await client.request('initialize',{protocolVersion:'2025-06-18'});
    const retried=await client.request('tools/call',{name:'ask_question',arguments:{prompt:'已回答的问题'}});
    const retryBody=JSON.parse(retried.result.content[0].text);
    assert.equal(retryBody.status,'already_claimed');assert(!Object.hasOwn(retryBody,'value'));
    console.log(JSON.stringify({lostClaimResponse:'delivery_uncertain',restartAfterUncertainClaim:'no-answer-replay',claims}));
  } finally {
    if(client)await client.close();
    await new Promise(resolve=>{proxy.close(resolve);proxy.closeAllConnections();});await service.close();
    const relative=path.relative(DATA_ROOT,service.directory);assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
    fs.rmSync(service.directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
main().then(checkLostClaimResponse).catch(error=>{console.error(error);process.exitCode=1;});
