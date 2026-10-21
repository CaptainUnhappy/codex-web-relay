'use strict';

// Opt-in: two real WebSocket clients, one native app-server, a local deterministic
// Responses provider and a disposable CODEX_HOME. No real model or user state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = check(); if (value) return value; await delay(25); }
  throw Error(`Timed out: ${label}`);
}
class Client {
  constructor(socket, name) {
    this.socket = socket; this.name = name; this.next = 1; this.messages = []; this.pending = new Map();
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); this.messages.push(message);
      const pending = this.pending.get(message.id);
      if (!pending || message.method) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      message.error ? pending.reject(Object.assign(Error(message.error.message), message.error)) : pending.resolve(message.result);
    });
    socket.on('error', error => { this.error = error; });
    socket.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error(`${name} closed`)); }
      this.pending.clear();
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  request(method, params = {}) {
    const id = `${this.name}-${this.next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timeout`)); }, 12000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, 'close');
    const timeout = setTimeout(() => this.socket.terminate(), 2000);
    this.socket.close();
    try { await closed; } finally { clearTimeout(timeout); }
  }
}

async function main() {
  const command = process.argv[2];
  assert(command && fs.existsSync(command), 'Pass the native Codex executable as the first argument.');
  const root = path.resolve(__dirname, '..', 'output', 'protocol-audit'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'shared-server-'));
  let native, a, b, result, stderr = '', providerError = '';
  const providerCalls = [], sockets = new Set();
  const provider = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString()); providerCalls.push(body);
      if (!req.url.endsWith('/responses')) throw Error(`Unexpected provider path ${req.url}`);
      const first = providerCalls.length === 1;
      const availableTools = (body.tools || []).flatMap(tool => tool.type === 'namespace' ? (tool.tools || []).map(t => ({ ...t, name: `${tool.name}.${t.name}` })) : [tool]);
      const questionTool = availableTools.find(tool => /(?:^|\.)request_user_input$/.test(tool.name || ''));
      if (first && !questionTool) throw Error(`request_user_input missing; tools=${availableTools.map(t => t.name).join(',')}`);
      const item = first ? {
        type: 'function_call', id: 'fc-shared-question', call_id: 'call-shared-question', name: questionTool.name,
        arguments: JSON.stringify({ questions: [{ id: 'choice', header: 'Shared', question: 'Choose once for this local fixture.', options: [
          { label: 'First', description: 'First fixture choice.' }, { label: 'Second', description: 'Second fixture choice.' },
        ] }] }),
      } : { type: 'message', id: `msg-shared-done-${providerCalls.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SHARED_SERVER_FIXTURE_DONE', annotations: [] }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const response = { id: `response-${providerCalls.length}`, object: 'response', model: 'fixture', status: 'in_progress', output: [] };
      event('response.created', { response });
      event('response.output_item.added', { output_index: 0, item });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
      res.end();
    } catch (error) { providerError = error.message; res.writeHead(500); res.end(error.message); }
  });
  provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(directory, 'config.toml'), `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
    const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const url = `ws://127.0.0.1:${port}`;
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { CODEX_HOME: directory, HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, TMP: directory, TEMP: directory, NO_PROXY: '127.0.0.1,localhost' });
    native = spawn(command, ['app-server', '--listen', url], { env, cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    native.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-18000); });
    native.stdout.on('data', () => {});
    const connect = async name => {
      let socket;
      for (let i = 0; i < 50; i++) {
        if (native.exitCode !== null) throw Error(`Native server exited: ${stderr}`);
        socket = new WebSocket(url);
        try { await once(socket, 'open'); break; } catch { socket.terminate(); await delay(100); }
      }
      assert(socket?.readyState === WebSocket.OPEN, stderr);
      const client = new Client(socket, name);
      await client.request('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } });
      client.send({ method: 'initialized', params: {} });
      return client;
    };
    a = await connect('shared-fixture-app'); b = await connect('shared-fixture-web');
    const { thread } = await a.request('thread/start', { cwd: directory, model: 'fixture', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = thread.id;
    await a.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Isolated shared-server fixture seed.' }] }] });
    const rejoin = await b.request('thread/resume', { threadId, excludeTurns: true });
    assert.equal(rejoin.thread.id, threadId);
    await a.request('thread/goal/set', { threadId, objective: 'Isolated shared server metadata fixture.', status: 'paused', origin: 'user' });
    await until(() => a.messages.some(m => m.method === 'thread/goal/updated') && b.messages.some(m => m.method === 'thread/goal/updated'), 'shared goal notification');
    const { turn } = await a.request('turn/start', { threadId, input: [{ type: 'text', text: 'Use the local question fixture.' }],
      collaborationMode: { mode: 'plan', settings: { model: 'fixture', reasoning_effort: 'low', developer_instructions: null } } });
    const method = 'item/tool/requestUserInput';
    let requestA, requestB;
    try {
      await until(() => { requestA = a.messages.find(m => m.method === method); requestB = b.messages.find(m => m.method === method); return requestA && requestB; }, 'native question on both clients');
    } catch (error) { throw Error(`${error.message}; provider=${providerError}; eventsA=${a.messages.map(m => m.method).filter(Boolean).join(',')}; eventsB=${b.messages.map(m => m.method).filter(Boolean).join(',')}; stderr=${stderr.slice(-1800)}`); }
    assert.equal(requestA.id, requestB.id);
    b.send({ id: requestB.id, result: { answers: { choice: { answers: ['SHARED_NATIVE_ANSWER_ONCE'] } } } });
    await until(() => a.messages.some(m => m.method === 'serverRequest/resolved' && m.params.requestId === requestA.id)
      && b.messages.some(m => m.method === 'serverRequest/resolved' && m.params.requestId === requestB.id), 'resolved event on both clients');
    // The other client attempts to respond to the already-resolved native request.
    a.send({ id: requestA.id, result: { answers: { choice: { answers: ['DUPLICATE_MUST_NOT_REACH_MODEL'] } } } });
    await until(() => a.messages.some(m => m.method === 'turn/completed' && m.params.turn.id === turn.id), 'turn completed');
    assert(!providerError, providerError);
    assert.equal(providerCalls.length, 2, 'one tool call and one final response');
    const outputs = (providerCalls[1].input || []).filter(item => item.type === 'function_call_output' && item.call_id === 'call-shared-question');
    assert.equal(outputs.length, 1, 'model receives one native answer');
    assert(JSON.stringify(outputs).includes('SHARED_NATIVE_ANSWER_ONCE'));
    assert(!JSON.stringify(providerCalls).includes('DUPLICATE_MUST_NOT_REACH_MODEL'));
    // A Desktop async answer is a user-message envelope, not a native RPC reply.
    // This protocol control uses a synthetic question ID; it does not render an
    // actual Desktop card. The separate installed-function audit covers that UI.
    const envelope = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: '["request_user_input_async","fixture-async-question",0]', question: 'Shared server duplicate control', answer: 'SAME_ASYNC_ANSWER' }])}\n</send_user_message_question_reply>`;
    for (const client of [a, b]) {
      const { turn: reply } = await client.request('turn/start', { threadId, input: [{ type: 'text', text: envelope }] });
      await until(() => client.messages.some(m => m.method === 'turn/completed' && m.params.turn.id === reply.id), 'ordinary envelope reply completed');
    }
    const stored = await a.request('thread/read', { threadId, includeTurns: true });
    const duplicateMessages = stored.thread.turns.flatMap(t => t.items || []).filter(item => item.type === 'userMessage' && (item.content || []).some(content => content.text === envelope));
    assert.equal(duplicateMessages.length, 2, 'shared server alone does not deduplicate an async envelope sent as ordinary text');
    await b.close(); b = null;
    assert.equal((await a.request('thread/goal/get', { threadId })).goal.status, 'paused');
    assert.equal(native.exitCode, null, 'disconnecting Web must leave the shared server alive');
    result = { passed: true, usesRealNativeServer: true, usesRealModel: false, clients: 2,
      sameThreadResume: true, goalBroadcast: true, nativeQuestionBroadcast: true, resolutionBroadcast: true,
      acceptedNativeAnswers: outputs.length, duplicateNativeAnswerRejected: true, webDisconnectKeepsServerAlive: true,
      ordinaryEnvelopeDuplicateMessages: duplicateMessages.length, desktopAsyncCardTested: false, providerCalls: providerCalls.length,
    };
  } finally {
    if (native && native.exitCode === null && native.signalCode === null) {
      const exited = once(native, 'exit');
      // The fixture may start plugin/git helpers. End only this known child tree
      // before its parent disappears, so helpers cannot retain the temp HOME.
      if (process.platform === 'win32') {
        const stopped = spawnSync('taskkill.exe', ['/PID', String(native.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
        if (stopped.status !== 0) native.kill();
      } else native.kill();
      await exited;
    }
    native?.stdout.destroy(); native?.stderr.destroy();
    await Promise.allSettled([a?.close(), b?.close()]);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => provider.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), root, 'cleanup is restricted to the disposable fixture directory');
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
