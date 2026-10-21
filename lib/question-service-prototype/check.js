'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startPrototype, openStore, DATA_ROOT } = require('./server');
const { askQuestion } = require('./ask');

if (process.argv[2] === '--race-worker') {
  const store = openStore(process.argv[3]);
  process.send('ready');
  process.once('message', () => {
    try { process.send(store.answer('process-race', { requestId:process.argv[4], value:process.argv[4], client:'desktop' })); }
    catch (error) { process.send({ code:error.code }); }
    finally { store.close(); process.disconnect(); }
  });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
  fs.mkdirSync(DATA_ROOT,{ recursive:true });
  const directory = fs.mkdtempSync(path.join(DATA_ROOT,'PROTOTYPE-check-'));
  let service;
  const passed = [];
  const question = id => ({ id, threadId:'isolated-check', prompt:`测试 ${id}`, options:[{ label:'确认一次' }] });
  const answer = (id, value = id, client = 'phone') => ({ requestId:id, value, client });
  async function request(route, value, headers = {}) {
    const response = await fetch(`${service.baseUrl}/api/${route}`, { method:value ? 'POST' : 'GET', headers:{ authorization:`Bearer ${service.token}`, 'content-type':'application/json', ...headers }, body:value ? JSON.stringify(value) : undefined });
    return { status:response.status, body:await response.json() };
  }
  try {
    service = await startPrototype({ directory });
    assert.equal((await fetch(`${service.baseUrl}/api/questions`)).status,401);
    assert.equal((await request('questions',undefined,{ origin:'https://untrusted.invalid' })).status,403);
    assert.equal((await fetch(`${service.baseUrl}/api/session`,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
    assert.equal((await request('questions',{ ...question('invalid'), options:[{}] })).status,400);
    passed.push('auth-origin-validation');

    assert.equal((await request('questions',question('race'))).status,201);
    assert.equal((await request('questions',question('race'))).body.created,false);
    assert.equal((await request('questions',{ ...question('race'), prompt:'different' })).status,409);
    const race = await Promise.all(Array.from({length:20},(_,i)=>request('questions/race/answer',answer(`race-${i}`))));
    assert.equal(race.filter(r=>r.body.accepted).length,1);
    assert.equal(race.filter(r=>r.status===409).length,19);
    const winner = race.find(r=>r.body.accepted).body.questions[0].answer;
    const replay = await request('questions/race/answer',answer(winner.requestId,winner.value));
    assert.equal(replay.body.duplicate,true);
    assert.equal(replay.body.questions[0].answer.receiptId,winner.receiptId);
    assert.equal((await request('questions/race/answer',answer(winner.requestId,'changed'))).body.code,'REQUEST_ID_REUSED');
    assert.equal((await request('questions')).body.revision,2);
    passed.push('twenty-way-race-one-answer','same-request-id-replay','changed-retry-rejected','read-only-does-not-acknowledge');

    const dbFile = path.join(directory,'PROTOTYPE-questions.sqlite');
    await request('questions',question('disk-error'));
    const inspector = new DatabaseSync(dbFile);
    try {
      inspector.exec("CREATE TRIGGER fail_commit BEFORE INSERT ON events WHEN NEW.kind='answered' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
      assert.equal((await request('questions/disk-error/answer',answer('disk-attempt'))).status,503);
      assert.equal(inspector.prepare("SELECT COUNT(*) AS n FROM answers WHERE question_id='disk-error'").get().n,0);
      assert.equal((await request('questions/disk-error/result')).body.question.answer,null);
      inspector.exec('DROP TRIGGER fail_commit');
      assert.equal((await request('questions/disk-error/answer',answer('disk-attempt'))).body.accepted,true);
    } finally { inspector.close(); }
    passed.push('failed-transaction-rolls-back-answer-and-event');

    let consumed = 0;
    const consumer = askQuestion({ baseUrl:service.baseUrl, token:service.token, question:question('consumer'), signal:AbortSignal.timeout(10000) }).then(result=>{ consumed++; return result; });
    for (let i=0;i<100 && !(await request('questions')).body.questions.some(q=>q.id==='consumer');i++) await new Promise(resolve=>setTimeout(resolve,10));
    const delivered = await request('questions/consumer/answer',answer('consumer-answer','第一行 <beta>\n第二行'));
    assert.equal(delivered.body.accepted,true);
    const result = await consumer;
    assert.equal(result.value,'第一行 <beta>\n第二行');
    await request('questions/consumer/answer',answer('consumer-answer','第一行 <beta>\n第二行'));
    assert.equal(consumed,1);
    passed.push('agent-consumer-returns-one-canonical-result');

    await request('questions',question('process-race'));
    const workers = ['process-a','process-b'].map(id=>fork(__filename,['--race-worker',dbFile,id],{stdio:['ignore','ignore','pipe','ipc']}));
    try {
      await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{ worker.once('message',resolve); worker.once('error',reject); })));
      const outcomes = workers.map(worker=>new Promise((resolve,reject)=>{ worker.once('message',resolve); worker.once('error',reject); }));
      const exits = workers.map(worker=>new Promise(resolve=>worker.once('exit',resolve)));
      workers.forEach(worker=>worker.send('go'));
      const outcomesValue = await Promise.all(outcomes);
      await Promise.all(exits);
      assert.equal(outcomesValue.filter(value=>value.accepted).length,1);
      assert.equal(outcomesValue.filter(value=>value.code==='QUESTION_ALREADY_ANSWERED').length,1);
    } finally { workers.forEach(worker=>{ if (worker.exitCode === null) worker.kill(); }); }
    passed.push('two-processes-share-sqlite-one-answer');

    const before = (await request('questions')).body;
    const token = service.token;
    await service.close(); service = null;
    service = await startPrototype({ directory, token });
    assert.deepEqual((await request('questions')).body,before);
    assert.equal((await request('questions/race/answer',answer(winner.requestId,winner.value))).body.duplicate,true);
    const finalDb = new DatabaseSync(dbFile);
    try {
      assert.equal(finalDb.prepare('SELECT COUNT(*) AS n FROM answers').get().n,4);
      assert.equal(finalDb.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='answered'").get().n,4);
      assert.equal(finalDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    } finally { finalDb.close(); }
    passed.push('restart-preserves-receipts-and-rejects-replay','durable-answer-count-equals-consumed-questions');
    console.log(JSON.stringify({ passed:true, checks:passed, canonicalAnswers:4, productionUsed:false },null,2));
  } finally {
    if (service) await service.close();
    const relative = path.relative(DATA_ROOT,directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
