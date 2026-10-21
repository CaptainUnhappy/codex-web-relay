'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { historyMessages } = require('../lib/codex-app-server-backend');
const { questionReplies, readableQuestionReply, desktopQuestionRequests, createDesktopQuestionReader, queuedQuestionIds } = require('../lib/user-input');
const THREAD = '01a14dcb-3bf7-7c60-9e10-ebb350f80a24';
const OTHER = '01a14dcb-3bf7-7c60-9e10-ebb350f80a25';
const record = { type: 'event_msg', timestamp: '2026-10-18T06:55:37.147Z', payload: {
  type: 'item_completed', thread_id: THREAD, item: { type: 'AgentMessage', id: 'call-fixture', delivery: 'async',
    questions: [{ title: '颜色？\n```text\nblue\n```', options: ['橙色', '蓝色'] }, { title: '补充说明？' }] },
} };
const [request] = desktopQuestionRequests([record, record], THREAD);
const answers = Object.fromEntries(request.params.questions.map((q, index) => [q.id, { answers: [index ? '自定义 <文字>' : '蓝色'] }]));
const replyRows = request.params.questions.map(q => ({ questionItemId: q.id, question: q.question, answer: answers[q.id].answers[0] }));
const reply = `<send_user_message_question_reply>\n${JSON.stringify(replyRows)}\n</send_user_message_question_reply>`;
const singleReply = `<send_user_message_question_reply>\n${JSON.stringify(replyRows[0])}\n</send_user_message_question_reply>`;

function checkParsing() {
  assert.strictEqual(desktopQuestionRequests([record, record], THREAD).length, 1, 'duplicate completed events must not duplicate questions');
  assert.strictEqual(desktopQuestionRequests([{ ...record, payload: { ...record.payload, thread_id: OTHER } }], THREAD).length, 0, 'a misnamed rollout cannot contribute another thread question');
  assert.strictEqual(request.params.questions[0].id, '["request_user_input_async","call-fixture",0]');
  assert.strictEqual(request.params.questions[0].options[1].label, '蓝色');
  assert.strictEqual(questionReplies(reply)[1].answer, '自定义 <文字>');
  assert(!readableQuestionReply(reply).includes('questionItemId'));
  assert(readableQuestionReply(reply).includes('**你的回答**\n\n蓝色'));
  assert.strictEqual(readableQuestionReply('example: '+reply), 'example: '+reply, 'ordinary quoted examples must remain ordinary text');
  assert.strictEqual(questionReplies('<send_user_message_question_reply>bad</send_user_message_question_reply>').length, 0);
  assert.deepStrictEqual(questionReplies(singleReply), [replyRows[0]], 'Desktop accepts single-object reply envelopes too');
  const userRecords = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: reply } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'Text', text: reply }] } } },
  ];
  for (const userRecord of userRecords) assert.strictEqual(desktopQuestionRequests([record, userRecord], THREAD).length, 0);
  const instruction = { type: 'event_msg', timestamp: '2026-10-18T07:00:00Z', payload: {
    type: 'item_completed', thread_id: THREAD, turn_id: 'later-turn',
    item: { type: 'UserMessage', id: 'later-message', content: [{ type: 'text', text: '更新了代码 打包成 ZIP' }] },
  } };
  const start = (turnId, trigger) => ({ type: 'event_msg', payload: {
    type: 'task_started', turn_id: turnId, turn_attribution: { turn_id: turnId, turn_trigger: trigger },
  } });
  const humanStart = start('later-turn', 'composer');
  const heartbeatStart = start('heartbeat-turn', 'automation_heartbeat_scheduled');
  const heartbeat = { ...instruction, payload: { ...instruction.payload, turn_id: 'heartbeat-turn', item: {
    ...instruction.payload.item, content: [{ type: 'text', text: '<heartbeat>\n<automation_id>fixture</automation_id>\n</heartbeat>' }],
  } } };
  assert.strictEqual(desktopQuestionRequests([record, heartbeatStart, heartbeat], THREAD).length, 1, 'scheduled heartbeat UserMessages must not dismiss a pending App question');
  const plainAutomation = { ...heartbeat, payload: { ...heartbeat.payload, item: instruction.payload.item } };
  assert.strictEqual(desktopQuestionRequests([record, heartbeatStart, plainAutomation], THREAD).length, 1, 'automatic origin, not text markup, determines whether an instruction can dismiss questions');
  assert.strictEqual(desktopQuestionRequests([record, heartbeatStart, humanStart, heartbeat], THREAD).length, 1, 'an interleaved heartbeat must use its own turn origin');
  assert.strictEqual(desktopQuestionRequests([record, instruction], THREAD).length, 1, 'unknown origin must preserve a pending question');
  assert.strictEqual(desktopQuestionRequests([record, start('later-turn', 'goal_continuation'), instruction], THREAD).length, 1);
  assert.strictEqual(desktopQuestionRequests([record, humanStart, instruction], THREAD).length, 0, 'a proven composer instruction supersedes an old unanswered question');
  assert.strictEqual(desktopQuestionRequests([record, humanStart, instruction, record], THREAD).length, 0, 'replayed question events cannot resurrect a superseded question');
  const humanWithMarkup = { ...heartbeat, payload: { ...heartbeat.payload, turn_id: 'later-turn' } };
  assert.strictEqual(desktopQuestionRequests([record, humanStart, humanWithMarkup], THREAD).length, 0, 'human text mentioning heartbeat is still a human instruction');
  const nextQuestion = { ...record, payload: { ...record.payload, item: { ...record.payload.item, id: 'next-question' } } };
  assert.strictEqual(desktopQuestionRequests([record, humanStart, instruction, nextQuestion], THREAD)[0].id, 'desktop-question:next-question');
  const partial = { ...instruction, payload: { ...instruction.payload, item: { ...instruction.payload.item, content: [{ type: 'text', text: singleReply }] } } };
  assert.strictEqual(desktopQuestionRequests([record, humanStart, partial], THREAD)[0].params.questions.length, 1, 'partial answers leave unanswered questions pending');
  const legacyInstruction = { type: 'event_msg', payload: { type: 'user_message', message: '继续下一项' } };
  assert.strictEqual(desktopQuestionRequests([record, humanStart, legacyInstruction], THREAD).length, 0);
  assert.strictEqual(desktopQuestionRequests([record, heartbeatStart, legacyInstruction], THREAD).length, 1);
  assert.strictEqual(desktopQuestionRequests([record, humanStart, start('unknown-turn', undefined), legacyInstruction], THREAD).length, 1, 'a new turn without origin must not inherit the previous composer origin');
  assert.strictEqual(desktopQuestionRequests([record, humanStart, { type: 'turn_context', payload: { turn_id: 'truncated-turn' } }, legacyInstruction], THREAD).length, 1, 'a truncated task start must remain unknown');
  assert.strictEqual(desktopQuestionRequests([record, heartbeat, ...userRecords], THREAD).length, 0, 'explicit question replies still resolve questions without turn attribution');
  const contextInjection = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>workspace</environment_context>' }] } };
  const completion = { type: 'event_msg', payload: { type: 'task_complete' } };
  assert.strictEqual(desktopQuestionRequests([record, contextInjection, completion], THREAD).length, 1, 'context injection and assistant completion are not user instructions');
  assert.strictEqual(desktopQuestionRequests([record, { ...instruction, payload: { ...instruction.payload, thread_id: OTHER } }], THREAD).length, 1);
  const queued = queuedQuestionIds([{ input: [{ type: 'text', text: reply }] }]);
  assert.strictEqual(queued.size, 2);
  const history = historyMessages({ turns: [{ id: 'turn', items: [{ type: 'userMessage', content: [{ type: 'text', text: reply }] }] }] });
  assert(history[0].text.includes('你的回答'));
  assert(!history[0].text.includes('<send_user_message_question_reply>'));
  assert.deepStrictEqual(history[0].questionReplies, questionReplies(reply), 'history must retain structured answers for compact question/answer rendering');
  let reads = 0, stats = { mtimeMs: 1, size: 100 }, records = [record];
  const read = createDesktopQuestionReader({ findFile: () => 'fixture.jsonl', statFile: () => stats, readItems: () => { reads++; return records; } });
  assert.strictEqual(read(THREAD).length, 1);
  read(THREAD);
  assert.strictEqual(reads, 1, 'unchanged rollouts reuse parsed questions');
  stats = { mtimeMs: 2, size: 200 }; records = [record, heartbeatStart, heartbeat];
  assert.strictEqual(read(THREAD).length, 1, 'rereading an appended heartbeat must retain the pending card');
  assert.strictEqual(reads, 2);
  stats = { mtimeMs: 3, size: 300 }; records.push(userRecords[0]);
  assert.strictEqual(read(THREAD).length, 0);
  assert.strictEqual(reads, 3);
}

const source = fs.readFileSync('server.js', 'utf8');
function serverFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:async )?function /);
  return source.slice(start, start + 1 + end);
}

function handlerFixture({ queue = [], sendError = null } = {}) {
  let sends = 0;
  const sent = [];
  const context = vm.createContext({
    Date, Map, Promise, URL, questionReplies, queuedQuestionIds,
    threadImages: require('../lib/thread-images').createThreadImages(),
    recentSendRequests: new Map(), MAX_TEXT_LENGTH: 100000, RECENT_SEND_TTL_MS: 600000,
    isAuthorized: req => req.authorized !== false,
    readJsonRequest: async req => req.body,
    isCodexThreadId: id => [THREAD, OTHER].includes(id),
    readDesktopQuestions: id => id === THREAD ? [request] : [],
    decodeAttachments: () => [],
    json: (res, status, body) => Object.assign(res, { status, body }),
    getCodexAppServerBackend: () => ({
      listApprovals: () => [],
      listQueue: async () => ({ data: queue }),
      send: async payload => {
        sends++; sent.push(payload);
        if (sendError) throw sendError;
        return { threadId: THREAD, turn: { id: 'reply-turn' }, queued: false };
      },
    }),
  });
  vm.runInContext(['normalizeClientRequestId', 'cleanupRecentSendRequests', 'updateSendProgress', 'sendProgressMessageForPhase',
    'setSendProgress', 'appServerErrorResponse', 'withDesktopQuestions', 'handleAppServerSend', 'handleAppServerApprovals'].map(serverFunction).join('\n'), context);
  const body = { threadId: THREAD, target: 'codex', text: 'Readable response', questionReply: { id: request.id, answers } };
  const post = async (overrides = {}, authorized = true) => {
    const res = {};
    await context.handleAppServerSend({ body: { ...body, ...overrides }, authorized }, res);
    return res;
  };
  return { context, post, sent, sends: () => sends };
}

async function checkSending() {
  const desktop = handlerFixture();
  const blocked = await desktop.post();
  assert.strictEqual(blocked.status, 409, 'desktop async answers cannot bypass the App confirmation path');
  assert.strictEqual(blocked.body.code, 'DESKTOP_QUESTION_REQUIRES_APP');
  assert.strictEqual((await desktop.post({ questionReply: undefined, text: reply })).status, 409, 'raw array envelopes cannot bypass the guard');
  assert.strictEqual((await desktop.post({ questionReply: undefined, text: singleReply })).status, 409, 'raw single-object envelopes cannot bypass the guard');
  assert.strictEqual((await desktop.post({ clientRequestId: 'another-browser' })).status, 409);
  assert.strictEqual(desktop.sends(), 0, 'blocking an unsupported answer must happen before any native send');
  const status = desktop.context.withDesktopQuestions({ approvals: [], queue: [] }, THREAD);
  assert.strictEqual(status.approvals.length, 0, 'rollout history must not masquerade as an active App approval');
  assert.strictEqual(status.desktopQuestions[0].canSubmit, false);
  assert.strictEqual(status.desktopQuestions[0].responseOwner, 'codex-app');
  assert.strictEqual(status.desktopQuestions[0].stateSource, 'rollout-history');
  assert.strictEqual(status.desktopQuestions[0].currentState, 'unknown');
  const nativeRequest = { id: 'native-request', method: 'item/tool/requestUserInput' };
  const mixed = desktop.context.withDesktopQuestions({ approvals: [nativeRequest] }, THREAD);
  assert.strictEqual(mixed.approvals.length, 1);
  assert.strictEqual(mixed.approvals[0], nativeRequest, 'native requests remain in the authoritative approvals channel');
  const ordinary = { questionReply: undefined, text: '普通消息', clientRequestId: 'ordinary-message' };
  const fixture = handlerFixture();
  assert.strictEqual((await fixture.post(ordinary)).status, 200);
  assert.strictEqual((await fixture.post(ordinary)).body.duplicate, true);
  assert.strictEqual(fixture.sends(), 1, 'ordinary message idempotency is unchanged');
  assert.strictEqual(fixture.sent[0].text, '普通消息');

  const queued = handlerFixture({ queue: [{ input: [{ type: 'text', text: reply }] }] });
  assert.strictEqual((await queued.post()).status, 409, 'a queued answer cannot be submitted again after restarting Mini');
  assert.strictEqual(queued.sends(), 0);
  assert.strictEqual(queued.context.withDesktopQuestions({ queue: [{ input: [{ type: 'text', text: reply }] }] }, THREAD).desktopQuestions[0].submissionState, 'queued');
  const approvals = {};
  await queued.context.handleAppServerApprovals({ method: 'GET', url: `/codex/approvals?thread=${THREAD}`, headers: {} }, approvals);
  assert.strictEqual(approvals.status, 200);
  assert.strictEqual(approvals.body.approvals.length, 0);
  assert.strictEqual(approvals.body.desktopQuestions[0].submissionState, 'queued', 'history may report a queued reply without claiming App confirmation');
  const invalid = handlerFixture();
  assert.strictEqual((await invalid.post({ threadId: 'bad' })).status, 400);
  assert.strictEqual((await invalid.post({ questionReply: { id: 123 } })).status, 400);
  assert.strictEqual((await invalid.post({}, false)).status, 401);
  assert.strictEqual(invalid.sends(), 0);
  const unknown = handlerFixture({ sendError: Object.assign(new Error('response lost'), { code: 'CODEX_APP_SERVER_OUTCOME_UNKNOWN', status: 409 }) });
  await unknown.post(ordinary);
  const retried = await unknown.post(ordinary);
  assert.strictEqual(retried.status, 409);
  assert.strictEqual(unknown.sends(), 1, 'an uncertain answer must not be replayed');
}

(async () => {
  checkParsing();
  await checkSending();
  console.log('User input passed: desktop questions are App-owned, answer bypasses cannot send, history sync and ordinary send idempotency remain intact.');
})().catch(error => { console.error(error); process.exitCode = 1; });
