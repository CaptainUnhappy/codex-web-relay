'use strict';
// Count only model-visible outputs and matching MCP events, never whole-message
// string occurrences (the rollout stores several projections of each event).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const [directory,rollout,outputFile]=process.argv.slice(2);
if(!directory||!rollout)throw new Error('Usage: node audit-app-run.js <test directory> <rollout.jsonl> [report.json]');
const binding=JSON.parse(fs.readFileSync(path.join(directory,'mcp-binding.json'),'utf8'));
const trace=fs.readFileSync(path.join(directory,'mcp-trace.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const records=fs.readFileSync(rollout,'utf8').split('\n').filter(Boolean).map((line,index)=>({line:index+1,...JSON.parse(line)}));
function extract(value,depth=0) {
  if(depth>8||value==null)return [];
  if(typeof value==='string'){try{return extract(JSON.parse(value),depth+1);}catch{return [];}}
  if(Array.isArray(value))return value.flatMap(item=>extract(item,depth+1));
  if(value.questionId===binding.questionId&&typeof value.status==='string')return [value];
  return ['content','output','text'].flatMap(key=>extract(value[key],depth+1));
}
const visible=records.filter(row=>row.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(row.payload?.type))
  .flatMap(row=>extract(row.payload.output).map(result=>({line:row.line,turnId:row.payload.internal_chat_message_metadata_passthrough?.turn_id,...result})));
const answers=visible.filter(item=>item.status==='answer'),duplicates=visible.filter(item=>item.status==='already_claimed');
assert.equal(answers.length,1);assert(duplicates.length>=1);assert(duplicates.every(item=>!Object.hasOwn(item,'value')));
const events=records.filter(row=>row.type==='event_msg'&&row.payload?.type==='item_completed'&&row.payload.item?.type==='McpToolCall'&&row.payload.item.server==='unified_question_isolated')
  .flatMap(row=>extract(row.payload.item.result).map(result=>({line:row.line,itemId:row.payload.item.id,turnId:row.payload.turn_id,...result})));
assert.equal(events.filter(item=>item.status==='answer').length,1);
const finals=records.filter(row=>row.type==='response_item'&&row.payload?.type==='message'&&row.payload.role==='assistant'&&row.payload.phase==='final_answer')
  .map(row=>({line:row.line,id:row.payload.id,text:row.payload.content.map(part=>part.text||'').join('')}));
const success=finals.filter(item=>item.text.includes(answers[0].receiptId)&&item.text.includes(answers[0].value));
assert.equal(success.length,1);assert(finals.some(item=>item.text==='DUPLICATE_RESULT_SUPPRESSED'));
const db=new DatabaseSync(path.join(directory,'PROTOTYPE-questions.sqlite'),{readOnly:true});
let durable;
try{durable={answers:db.prepare('SELECT COUNT(*) AS n FROM answers WHERE question_id=?').get(binding.questionId).n,deliveries:db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE question_id=?').get(binding.questionId).n,integrity:db.prepare('PRAGMA integrity_check').get().integrity_check};}finally{db.close();}
assert.equal(durable.answers,1);assert.equal(durable.deliveries,1);
assert.equal(trace.filter(row=>row.event==='answer_emitted').length,1);
const report={passed:true,threadId:binding.threadId,questionId:binding.questionId,receiptId:answers[0].receiptId,deliveryId:answers[0].deliveryId,
  realAppMcp:true,modelVisibleAnswers:answers.length,modelVisibleDuplicateRejections:duplicates.length,answerBodyOnDuplicate:false,
  mcpAnswerEvents:events.filter(item=>item.status==='answer').length,answerEmitted:trace.filter(row=>row.event==='answer_emitted').length,durable,
  successTurnId:events.find(item=>item.status==='answer').turnId,duplicateTurnIds:events.filter(item=>item.status==='already_claimed').map(item=>item.turnId),
  evidenceLines:{modelAnswer:answers[0].line,duplicateOutputs:duplicates.map(item=>item.line),modelFinal:success[0].line},
  physicalPhone:false,desktopSurface:'Codex in-app browser, independent unified question card',nativeAsyncCard:false};
if(outputFile)fs.writeFileSync(outputFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
