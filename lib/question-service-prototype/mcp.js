'use strict';

// Minimal stdio MCP adapter, confined to one pre-bound isolated question.
const fs = require('node:fs');
const readline = require('node:readline');
const { createHash, randomUUID } = require('node:crypto');
const { askQuestion } = require('./ask');
const { normalizeQuestion } = require('./server');

function serve(binding, input = process.stdin, output = process.stdout) {
  const url = new URL(binding.baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/question-prototype' ||
      ![binding.questionId,binding.threadId].every(id=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) || typeof binding.toolToken !== 'string' || binding.toolToken.length < 16 || binding.toolToken.length > 512) throw new Error('Invalid isolated MCP binding.');
  let initialized = false;
  const pending = new Map(), inFlight = new Set();
  const trace = (event, details = {}) => {
    if (binding.traceFile) fs.appendFileSync(binding.traceFile, JSON.stringify({time:new Date().toISOString(),event,questionId:binding.questionId,...details})+'\n');
  };
  const write = value => new Promise((resolve,reject)=>output.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n',error=>error?reject(error):resolve()));
  const result = (id,value) => write({id,result:value});
  const error = (id,code,message) => write({id,error:{code,message}});
  const tool = {
    name:'ask_question', title:'统一提问',
    description:'Ask the user one question through the isolated synchronized desktop/mobile card, then wait for the answer. Use only for the authorized test. Do not also call request_user_input_async. This binding permits one stable question. Normal use needs one call; authorized duplicate-call tests and retries return status only after the answer was claimed.',
    inputSchema:{type:'object',properties:{prompt:{type:'string',minLength:1,maxLength:16000},options:{type:'array',maxItems:8,items:{type:'object',properties:{label:{type:'string',minLength:1,maxLength:500},description:{type:'string',maxLength:1000}},required:['label'],additionalProperties:false}}},required:['prompt'],additionalProperties:false},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  };
  async function call(message) {
    const id = message.id, params = message.params;
    if (params?.name !== 'ask_question') return error(id,-32602,'Unknown tool.');
    const args = params.arguments;
    if (!args || typeof args.prompt !== 'string' || Object.keys(args).some(key=>!['prompt','options'].includes(key))) return error(id,-32602,'Invalid question arguments.');
    let question;
    try { question = normalizeQuestion({id:binding.questionId,threadId:binding.threadId,prompt:args.prompt,options:args.options ?? []}); }
    catch { return error(id,-32602,'Invalid question arguments.'); }
    const controller = new AbortController();
    pending.set(id,controller);
    trace('tool_call',{rpcId:id,prompt:args.prompt,options:args.options || []});
    let claimed = false, deliveryAttempted = false, responseAttempted = false;
    try {
      const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(160000)]);
      await askQuestion({baseUrl:binding.baseUrl,token:binding.toolToken,question,signal});
      signal.throwIfAborted();
      const invocationId = createHash('sha256').update(JSON.stringify([binding.threadId,id,randomUUID()])).digest('hex');
      deliveryAttempted = true;
      const response = await fetch(`${binding.baseUrl}/api/questions/${binding.questionId}/claim-delivery`,{
        method:'POST',headers:{authorization:`Bearer ${binding.toolToken}`,'content-type':'application/json'},signal,
        body:JSON.stringify({consumerId:binding.threadId,invocationId}),
      });
      if (!response.ok) throw new Error(`DELIVERY_HTTP_${response.status}`);
      const delivery = await response.json();
      claimed = delivery.status === 'answer';
      trace(claimed?'delivery_claimed':'duplicate_tool_call',{rpcId:id,receiptId:delivery.receiptId,deliveryId:delivery.deliveryId});
      // Do not repeat the answer after a prior claim, including an uncertain
      // process crash. Reconcile the original tool result before another run.
      const payload = claimed ? delivery : {...delivery,message:'The answer was already claimed by a previous tool call. Do not ask or answer again. Inspect the original tool result if its delivery is uncertain.'};
      responseAttempted = true;
      await result(id,{content:[{type:'text',text:JSON.stringify(payload)}],isError:!claimed});
      trace(claimed?'answer_emitted':'duplicate_rejected',{rpcId:id,receiptId:delivery.receiptId,deliveryId:delivery.deliveryId});
    } catch (cause) {
      trace('tool_error',{rpcId:id,claimed,deliveryAttempted,message:cause.message});
      if (!responseAttempted) await result(id,{content:[{type:'text',text:JSON.stringify({status:deliveryAttempted?'delivery_uncertain':'not_delivered',message:cause.message})}],isError:true});
    } finally { pending.delete(id); }
  }
  async function handle(line) {
    let message;
    try { if (line.length > 65536) throw new Error(); message = JSON.parse(line); }
    catch { return error(null,-32700,'Invalid JSON message.'); }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id ?? null,-32600,'Invalid request.');
    if (message.method === 'notifications/cancelled') { pending.get(message.params?.requestId)?.abort(new Error('Tool call cancelled.')); return; }
    if (!Object.hasOwn(message,'id')) return;
    if (!['string','number'].includes(typeof message.id) || (typeof message.id === 'number' && !Number.isFinite(message.id))) return error(null,-32600,'Invalid request id.');
    if (inFlight.has(message.id)) { trace('duplicate_rpc_ignored',{rpcId:message.id}); return; }
    inFlight.add(message.id);
    try {
      if (message.method === 'initialize') {
        initialized = true; trace('initialized');
        return await result(message.id,{protocolVersion:message.params?.protocolVersion || '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'unified-question-isolated',version:'0.2.0'},instructions:'This server is restricted to one isolated test question. Use ask_question once for normal flow and wait for its result. Explicit duplicate-call verification is allowed: the server returns status only after the first claim. Do not create a native async question in parallel or invent an answer.'});
      }
      if (!initialized) return await error(message.id,-32000,'Initialize first.');
      if (message.method === 'ping') return await result(message.id,{});
      if (message.method === 'tools/list') return await result(message.id,{tools:[tool]});
      if (message.method === 'tools/call') return await call(message);
      return await error(message.id,-32601,'Method not found.');
    } finally { inFlight.delete(message.id); }
  }
  const lines = readline.createInterface({input,crlfDelay:Infinity});
  lines.on('line',line=>handle(line).catch(cause=>{ trace('transport_error',{message:cause.message}); lines.close(); }));
  lines.on('close',()=>{ for (const controller of pending.values()) controller.abort(new Error('MCP transport closed.')); });
  trace('started');
  return lines;
}

if (require.main === module) {
  try {
    const file = process.argv[process.argv.indexOf('--binding')+1];
    if (!process.argv.includes('--binding') || !file) throw new Error('--binding is required.');
    serve(JSON.parse(fs.readFileSync(file,'utf8')));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
module.exports = {serve};
