'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexAppServerBackend } = require('../lib/codex-app-server-backend');
const { projectPathKey } = require('../lib/project-path');

const THREAD_ID = '019e2a2f-0f46-7760-a1b5-bcc953a94d24';
const PROJECTLESS_ID = '019e2a2f-0f46-7760-a1b5-bcc953a94d25';

class FakeChild extends EventEmitter {
  constructor(handler) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.killed = false;
    this.pid = 1234;
    let buffer = '';
    this.stdin.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        handler(JSON.parse(line), this);
      }
    });
    this.stdin.on('finish', () => this.kill());
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    this.emit('close', 0);
  }
}

function createHarness(options = {}) {
  const requests = [];
  const responses = [];
  const queue = options.queue || [];
  let spawnCount = 0;
  let active = options.active !== false;
  let goal = options.goal || null;
  const loaded = new Set(options.cold ? [] : [THREAD_ID]);
  let child = null;
  const respond = (message, process) => {
    requests.push(message);
    if (Object.prototype.hasOwnProperty.call(message, 'result') || message.error) {
      responses.push(message);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    if (options.ignoreMethod === message.method) return;
    if (options.writerLock?.value && ['thread/resume', 'turn/start', 'thread/queue/start'].includes(message.method)) {
      queueMicrotask(() => process.send({ id: message.id, error: { code: -32600, message: `thread ${message.params.threadId} already has an active writer` } }));
      return;
    }
    if (options.errorMethod === message.method) {
      queueMicrotask(() => process.send({ id: message.id, error: { code: options.errorCode ?? -32000, message: options.errorMessage || `${message.method} rejected` } }));
      return;
    }
    if (['turn/start', 'thread/queue/start'].includes(message.method) && !loaded.has(message.params.threadId)) {
      queueMicrotask(() => process.send({ id: message.id, error: { code: -32600, message: 'thread not loaded; resume it before turn/start' } }));
      return;
    }
    let result = {};
    if (message.method === 'initialize') {
      result = { userAgent: 'fake', codexHome: 'C:\\fake' };
    } else if (message.method === 'config/read') {
      result = { config: { approval_policy: 'on-request', approvals_reviewer: 'auto_review', sandbox_mode: 'workspace-write', model: 'gpt-test', model_reasoning_effort: 'high' }, origins: {} };
    } else if (message.method === 'configRequirements/read') {
      result = { requirements: options.requirements || null };
    } else if (message.method === 'permissionProfile/list') {
      result = { data: [':workspace', ':danger-full-access'].map(id => ({ id, allowed: true })), nextCursor: null };
    } else if (message.method === 'account/rateLimits/read') {
      result = { rateLimits: { primary: { usedPercent: options.quotaUsed ?? 8, windowDurationMins: 10080 } } };
    } else if (message.method === 'model/list') {
      result = { data: [{ id: 'gpt-test', displayName: 'GPT Test', isDefault: true, hidden: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: ['low', 'high'] }], nextCursor: null };
    } else if (message.method === 'thread/goal/get') {
      result = { goal };
    } else if (message.method === 'thread/goal/set') {
      const { origin, threadId, ...changes } = message.params;
      goal = { ...goal, ...changes, threadId };
      result = { goal };
    } else if (message.method === 'thread/goal/clear') {
      result = { cleared: Boolean(goal) }; goal = null;
    } else if (message.method === 'project/list') {
      result = { data: options.projects || [{ id: 'project-1', name: 'Demo', roots: [{ path: 'C:\\Projects\\Demo' }], metadata: {}, position: 0, createdAt: 1, updatedAt: 1 }], nextCursor: null };
    } else if (message.method === 'thread/list') {
      const threads = options.threads || [
          { id: THREAD_ID, name: '项目线程', projectId: 'project-1', cwd: 'C:\\Projects\\Demo', status: { type: active ? 'active' : 'idle' }, recencyAt: '2026-08-27T01:00:00.000Z' },
          { id: PROJECTLESS_ID, name: '未命名线程', preview: '第一条用户消息', projectId: null, cwd: 'C:\\internal-folder', status: { type: 'idle' }, recencyAt: '2026-08-27T00:00:00.000Z' },
        ];
      const after = message.params.cursor ? threads.findIndex(thread => thread.id === message.params.cursor) + 1 : 0;
      const data = threads.slice(after, after + message.params.limit);
      result = { data, nextCursor: after + data.length < threads.length ? data.at(-1)?.id : null };
    } else if (message.method === 'thread/read') {
      const id = message.params.threadId;
      result = { thread: {
        id,
        projectId: id === PROJECTLESS_ID ? null : 'project-1',
        cwd: id === PROJECTLESS_ID ? 'C:\\internal-folder' : 'C:\\Projects\\Demo',
        status: { type: options.threadStatus || (active ? 'active' : 'idle') },
        updatedAt: options.updatedAt,
        recencyAt: options.recencyAt,
        turns: [{
          id: 'turn-1',
          status: active ? 'inProgress' : 'completed',
          startedAt: '2026-08-27T01:00:00.000Z',
          completedAt: active ? null : '2026-08-27T01:00:01.000Z',
          items: [
            { type: 'userMessage', content: [{ type: 'text', text: '你好' }] },
            { type: 'agentMessage', phase: 'final_answer', text: '完成' },
          ],
        }],
      } };
    } else if (message.method === 'thread/turns/list') {
      const turns = options.turns || [{ id: 'turn-1', status: active ? 'inProgress' : 'completed', startedAt: '2026-08-27T01:00:00.000Z', items: [
        { type: 'userMessage', content: [{ type: 'text', text: '你好' }] },
        { type: 'agentMessage', phase: 'final_answer', text: '完成' },
      ] }];
      const after = message.params.cursor ? turns.findIndex(turn => turn.id === message.params.cursor) + 1 : 0;
      const data = turns.slice(after, after + message.params.limit);
      result = { data, nextCursor: after + data.length < turns.length ? data.at(-1)?.id : null };
    } else if (message.method === 'thread/items/list') {
      const items = options.items || [];
      result = { data: [...items].reverse().slice(0, message.params.limit), nextCursor: null };
    } else if (message.method === 'thread/timeline/list') {
      result = { data: options.timeline || [], nextCursor: null };
    } else if (message.method === 'thread/loaded/list') {
      result = { data: [...loaded] };
    } else if (message.method === 'thread/resume') {
      loaded.add(message.params.threadId);
      result = { thread: { id: message.params.threadId, status: { type: 'idle' }, turns: [] } };
    } else if (message.method === 'thread/start') {
      loaded.add(PROJECTLESS_ID);
      result = { thread: { id: PROJECTLESS_ID, projectId: message.params.projectId, status: { type: 'idle' }, turns: [] } };
    } else if (message.method === 'turn/start') {
      result = { turn: { id: 'turn-new', status: 'inProgress', startedAt: new Date().toISOString(), items: [] } };
    } else if (message.method === 'thread/queue/add') {
      const item = { id: `queue-${queue.length + 1}`, clientUserMessageId: message.params.clientUserMessageId, input: message.params.input };
      queue.push(item);
      result = { queuedSubmission: item };
    } else if (message.method === 'thread/queue/list') {
      result = { data: [...queue], nextCursor: null };
    } else if (message.method === 'thread/queue/delete') {
      const index = queue.findIndex(item => item.id === message.params.queuedSubmissionId);
      if (index >= 0) queue.splice(index, 1);
      result = { deleted: index >= 0 };
    } else if (message.method === 'turn/steer') {
      result = { turnId: message.params.expectedTurnId };
    } else if (message.method === 'thread/queue/start') {
      const item = queue.shift();
      active = true;
      result = { turn: { id: item ? 'turn-queued' : 'turn-empty', status: 'inProgress', items: [] } };
    } else if (message.method === 'turn/interrupt') {
      active = false;
      result = {};
    } else if (message.method === 'thread/settings/update' || message.method === 'thread/name/set' || message.method === 'thread/archive') {
      result = {};
    }
    const sendResponse = () => {
      if (message.method === 'turn/start') active = true;
      process.send({ id: message.id, result });
    };
    if (message.method === 'turn/start' && options.turnStartDelayMs) setTimeout(sendResponse, options.turnStartDelayMs);
    else queueMicrotask(sendResponse);
  };
  const backend = new CodexAppServerBackend({
    resolveCli: async () => ({ available: true, command: 'codex' }),
    spawnCli: () => {
      spawnCount += 1;
      child = new FakeChild(respond);
      return { child, cleanup: null };
    },
    requestTimeoutMs: options.requestTimeoutMs || 200,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    sessionIdleMs: options.sessionIdleMs,
    readIdleMs: options.readIdleMs,
    maxConcurrency: options.maxConcurrency || 3,
    clientVersion: 'test',
    writerRetryMs: options.writerRetryMs,
    savedWriterWaits: options.savedWriterWaits,
    saveWriterWaits: options.saveWriterWaits,
    savedDesktopHandoffs: options.savedDesktopHandoffs,
    saveDesktopHandoffs: options.saveDesktopHandoffs,
  });
  return { backend, requests, responses, queue, child: () => child, spawnCount: () => spawnCount };
}

async function checkGoals() {
  const initial = { threadId: THREAD_ID, objective: '测试目标', status: 'active', tokenBudget: 1000, tokensUsed: 5, createdAt: 1, updatedAt: 2, timeUsedSeconds: 8 };
  const { backend, requests } = createHarness({ goal: initial, cold: true, active: false });
  try {
    assert.deepStrictEqual((await backend.status(THREAD_ID)).goal, initial);
    let current = (await backend.changeGoal(THREAD_ID, { action: 'pause', expectedGoal: initial })).goal;
    assert.strictEqual(current.status, 'paused');
    await assert.rejects(backend.changeGoal(THREAD_ID, { action: 'clear', expectedGoal: initial }), error => error.code === 'GOAL_CHANGED');
    current = (await backend.changeGoal(THREAD_ID, { action: 'update', expectedGoal: current, objective: '新的目标\n保留换行' })).goal;
    assert.strictEqual(current.status, 'paused');
    assert.strictEqual(current.tokensUsed, 5);
    assert.strictEqual(current.objective, '新的目标\n保留换行');
    current = (await backend.changeGoal(THREAD_ID, { action: 'resume', expectedGoal: current })).goal;
    assert.strictEqual(current.status, 'active');
    await assert.rejects(backend.changeGoal(THREAD_ID, { action: 'update', expectedGoal: current, objective: '' }), error => error.code === 'BAD_GOAL_OBJECTIVE');
    await backend.changeGoal(THREAD_ID, { action: 'clear', expectedGoal: current });
    assert.strictEqual(await backend.readGoal(THREAD_ID), null);
    await assert.rejects(backend.changeGoal(THREAD_ID, { action: 'pause', expectedGoal: current }), error => error.code === 'GOAL_NOT_FOUND');
    assert(requests.filter(row => ['thread/goal/set', 'thread/goal/clear'].includes(row.method)).every(row => row.params.origin === 'user'));
    assert(!requests.some(row => ['thread/resume', 'turn/start', 'turn/interrupt'].includes(row.method)), 'goal controls must not claim the writer or start/interrupt turns');
    assert.strictEqual(backend.connectionStatus().ownedThreadId, '');
  } finally { await backend.close(); }
  const unavailable = createHarness({ errorMethod: 'thread/goal/get' });
  try {
    const status = await unavailable.backend.status(THREAD_ID);
    assert(status.ok && status.goalError, 'a goal read failure must not break progress or masquerade as goal cleared');
    assert(!Object.prototype.hasOwnProperty.call(status, 'goal'));
  } finally { await unavailable.backend.close(); }
  const timeout = createHarness({ goal: initial, ignoreMethod: 'thread/goal/set', requestTimeoutMs: 20 });
  try {
    await assert.rejects(timeout.backend.changeGoal(THREAD_ID, { action: 'pause', expectedGoal: initial }), error => error.code === 'CODEX_APP_SERVER_OUTCOME_UNKNOWN');
    assert.strictEqual(timeout.requests.filter(row => row.method === 'thread/goal/set').length, 1, 'unknown writes must not auto-retry');
  } finally { await timeout.backend.close(); }
}

async function checkUsageAndPermissions() {
  const options = { active: false, cold: true, quotaUsed: 8 };
  const h = createHarness(options);
  try {
    const [a, b] = await Promise.all([h.backend.accountQuota(), h.backend.accountQuota()]);
    assert.equal(a.remainingPercent, 92); assert.equal(b.remainingPercent, 92);
    assert.equal(h.requests.filter(r => r.method === 'account/rateLimits/read').length, 1, 'coalesce account reads across threads');
    options.quotaUsed = 12;
    assert.equal((await h.backend.accountQuota(true)).remainingPercent, 88);
    h.child().send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 1 } } } });
    assert.equal((await h.backend.accountQuota()).remainingPercent, 99, '1 means one percent, not a fraction');
    await h.backend.permissionMenu(THREAD_ID);
    assert(!h.requests.some(r => r.method === 'thread/resume'), 'viewing permissions never claims a writer');
    const p = await h.backend.changePermissions(THREAD_ID, 'ask');
    assert.equal(p.mode, 'ask');
    assert.deepEqual(h.requests.find(r => r.method === 'thread/settings/update').params,
      { threadId: THREAD_ID, approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: ':workspace' });
    assert(h.requests.some(r => r.method === 'thread/resume'), 'explicit write must use the native thread');
    assert(!h.requests.some(r => ['turn/start', 'config/value/write', 'config/batchWrite'].includes(r.method)), 'no turn or global config writes');
    await assert.rejects(h.backend.changePermissions(PROJECTLESS_ID, 'auto'), e => e.code === 'MINI_SESSION_BUSY');
    assert.equal(h.backend.permissionSnapshots.has(PROJECTLESS_ID), false);
  } finally { await h.backend.close(); }
  for (const options of [
    { requirements: { allowedApprovalPolicies: ['on-request'] } },
    { errorMethod: 'configRequirements/read' },
    { writerLock: { value: true }, cold: true },
  ]) {
    const x = createHarness({ active: false, ...options });
    try {
      await assert.rejects(x.backend.changePermissions(THREAD_ID, 'full'));
      assert(!x.requests.some(r => r.method === 'thread/settings/update'));
      assert.equal(x.backend.permissionSnapshots.size, 0);
      assert.equal(x.backend.ownedThreadId, '', 'a rejected settings edit must not reserve a session');
    } finally { await x.backend.close(); }
  }
  const timeout = createHarness({ ignoreMethod: 'thread/settings/update', requestTimeoutMs: 20 });
  try {
    await assert.rejects(timeout.backend.changePermissions(THREAD_ID, 'ask'), e => e.code === 'CODEX_APP_SERVER_OUTCOME_UNKNOWN');
    assert.equal(timeout.requests.filter(r => r.method === 'thread/settings/update').length, 1);
    assert.equal(timeout.backend.permissionSnapshots.size, 0, 'unknown write is never displayed as saved');
  } finally { await timeout.backend.close(); }
  const unavailable = createHarness({ errorMethod: 'account/rateLimits/read' });
  try { assert.equal((await unavailable.backend.accountQuota()).available, false); }
  finally { await unavailable.backend.close(); }
}

async function checkLiveProgress() {
  const turns = [{ id: 'progress-turn', status: 'inProgress', startedAt: '2026-09-29T01:00:00Z', items: [], itemsView: 'summary' }];
  const items = [
    { turnId: 'progress-turn', item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '正在检查更新链路。' } },
    { turnId: 'progress-turn', item: { id: 'command', type: 'commandExecution', status: 'inProgress', command: 'check', commandActions: [] } },
    { turnId: 'progress-turn', item: { id: 'reasoning', type: 'reasoning', content: ['private reasoning'], summary: ['private summary'] } },
  ];
  const options = { turns, items };
  const harness = createHarness(options);
  try {
    const cold = await harness.backend.status(THREAD_ID);
    assert(cold.steps.some(step => step.text.includes('正在检查更新链路')), 'opening an existing running task must recover public progress');
    assert(cold.steps.some(step => step.callId === 'command' && step.kind === 'tool'), 'read-only item snapshots must restore tool progress');
    assert(!JSON.stringify(cold.steps).includes('private'), 'reasoning internals must not be exposed as public progress');
    assert(!harness.requests.some(row => ['thread/resume', 'turn/start'].includes(row.method)), 'observing progress must not acquire the desktop writer');
    const itemRead = harness.requests.find(row => row.method === 'thread/items/list');
    assert.strictEqual(itemRead.params.turnId, 'progress-turn');
    assert(itemRead.params.limit <= 40 && itemRead.params.sortDirection === 'desc', 'only recent progress items are read');

    const notify = (method, params) => harness.child().send({ method, params: { threadId: THREAD_ID, turnId: 'progress-turn', ...params } });
    notify('turn/started', { turn: turns[0] });
    notify('item/started', { item: { id: 'message-1', type: 'agentMessage', phase: 'commentary', text: '' } });
    notify('item/agentMessage/delta', { itemId: 'message-1', delta: '第一段进度。' });
    notify('item/completed', { item: { id: 'message-1', type: 'agentMessage', phase: 'commentary', text: '第一段进度。' } });
    notify('item/started', { item: { id: 'message-2', type: 'agentMessage', phase: 'commentary', text: '' } });
    notify('item/agentMessage/delta', { itemId: 'message-2', delta: '第二段' });
    notify('item/agentMessage/delta', { itemId: 'message-2', delta: '实时进度。' });
    notify('item/started', { item: { id: 'tool-live', type: 'mcpToolCall', server: 'fixture', tool: 'inspect', status: 'inProgress' } });
    notify('item/completed', { item: { id: 'tool-live', type: 'mcpToolCall', server: 'fixture', tool: 'inspect', status: 'completed' } });
    notify('turn/plan/updated', { plan: [{ step: '检查更新链路', status: 'completed' }, { step: '验证显示', status: 'inProgress' }] });
    const live = await harness.backend.status(THREAD_ID);
    assert.strictEqual(live.preview, '第二段实时进度。', 'separate agent items must not concatenate into one preview');
    assert(live.steps.some(step => step.text === '第一段进度。'));
    assert(live.steps.some(step => step.text === '第二段实时进度。'));
    assert.strictEqual(live.steps.filter(step => step.callId === 'tool-live').length, 1, 'tool completion must update, not duplicate, its progress row');
    assert(live.steps.some(step => step.callId === 'tool-live' && step.text.includes('已完成')));
    assert(live.steps.some(step => step.text.includes('验证显示')));

    turns[0] = { id: 'next-turn', status: 'inProgress', items: [] };
    items.length = 0;
    const next = await harness.backend.status(THREAD_ID);
    assert(!JSON.stringify(next.steps).includes('第二段'), 'a new turn must not inherit the previous turn progress');
    assert(!next.preview.includes('第二段'), 'a new turn must not inherit the previous turn preview');
    notify('turn/started', { turnId: 'next-turn', turn: turns[0] });
    for (let index = 0; index < 80; index++) harness.child().send({ method: 'item/started', params: {
      threadId: THREAD_ID, turnId: 'next-turn', item: { id: `bounded-${index}`, type: 'dynamicToolCall', tool: 'check', status: 'inProgress' },
    } });
    const bounded = await harness.backend.status(THREAD_ID);
    assert.strictEqual(bounded.steps.length, 30, 'long tasks keep a bounded recent progress feed');
    assert.strictEqual(bounded.steps.at(-1).callId, 'bounded-79');
    options.errorMethod = 'thread/items/list';
    const unavailable = await harness.backend.status(THREAD_ID);
    assert(unavailable.progressUnavailable && unavailable.active, 'a progress read failure must not mark the task complete');
    assert.strictEqual(unavailable.steps.length, 30, 'keep the latest received progress while the snapshot read retries');
    options.errorMethod = 'thread/read';
    options.errorMessage = 'failed to read session metadata: rollout at fixture.jsonl is empty';
    harness.backend.ownedThreadId = THREAD_ID;
    const starting = await harness.backend.status(THREAD_ID);
    assert(starting.active && starting.steps.length === 30, 'live owner progress must survive the initial rollout flush gap');
    options.errorMethod = 'thread/turns/list';
    options.errorCode = -32601;
    options.errorMessage = 'list_turns is not supported yet';
    assert((await harness.backend.status(THREAD_ID)).active, 'the starting native store can temporarily lack list_turns');
    harness.backend.ownedThreadId = '';
    await assert.rejects(harness.backend.status(THREAD_ID), /not supported yet/, 'stale or external progress cannot replace unavailable records');
    harness.backend.ownedThreadId = THREAD_ID;
    options.errorMessage = 'unexpected storage failure';
    await assert.rejects(harness.backend.status(THREAD_ID), /unexpected storage failure/, 'unrelated read failures must remain visible');
  } finally { await harness.backend.close(); }
}

async function checkExternalProgress() {
  // A second App Server reconstructs an unclosed desktop turn as interrupted.
  // Its canonical timeline still has no turnCompleted boundary.
  const turns = [{ id: 'desktop-turn', status: 'interrupted', startedAt: 100, completedAt: null, items: [] }];
  const items = [{ turnId: 'desktop-turn', item: { id: 'desktop-tool', type: 'mcpToolCall', tool: 'inspect', status: 'inProgress' } }];
  const options = { active: false, threadStatus: 'notLoaded', turns, items, updatedAt: 200, recencyAt: 100, timeline: [
    { type: 'item', turnId: 'desktop-turn', position: 10, item: items[0].item },
  ] };
  const harness = createHarness(options);
  try {
    const first = await harness.backend.bootstrap(THREAD_ID);
    assert.strictEqual(first.status.status, 'waiting', 'unloaded does not prove a desktop turn was interrupted');
    assert.strictEqual(first.status.observing, true, 'keep a read-only progress watch until an explicit end');
    assert.strictEqual(first.status.active, false, 'observation does not claim ownership of the desktop run');
    assert.strictEqual(first.status.error, '');
    assert.strictEqual(first.status.steps[0].status, 'running', 'an unloaded tool must not be forced complete');
    assert.strictEqual(first.status.updatedAt, new Date(200000).toISOString(), 'recency is not the latest activity timestamp');
    items[0].item.status = 'completed';
    items.push({ turnId: 'desktop-turn', item: { id: 'public-update', type: 'agentMessage', phase: 'commentary', text: '检查已完成，继续验证。' } });
    const second = await harness.backend.status(THREAD_ID);
    assert(second.steps.some(step => step.text === '检查已完成，继续验证。'));
    assert.strictEqual(second.steps[0].status, 'completed');
    assert.notStrictEqual(second.progressVersion, first.status.progressVersion, 'new progress changes the revision even when timestamps stay fixed');
    assert.strictEqual((await harness.backend.status(THREAD_ID)).progressVersion, second.progressVersion, 'unchanged progress must keep a stable revision');
    options.errorMethod = 'thread/timeline/list';
    const unavailable = await harness.backend.status(THREAD_ID);
    assert(unavailable.observing && unavailable.progressUnavailable, 'a missing timeline must not invent a terminal state');
    options.errorMethod = '';
    options.timeline.push({ type: 'turnCompleted', turnId: 'desktop-turn', status: 'interrupted', position: 11, completedAt: 201 });
    const interrupted = await harness.backend.status(THREAD_ID);
    assert.strictEqual(interrupted.status, 'interrupted', 'an explicit interruption ends the watch');
    assert.strictEqual(interrupted.observing, false);
    assert.strictEqual(interrupted.completedAt, new Date(201000).toISOString());
    options.timeline.at(-1).status = 'completed';
    items.push({ turnId: 'desktop-turn', item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '验证完成。' } });
    const completed = await harness.backend.status(THREAD_ID);
    assert.strictEqual(completed.status, 'complete');
    assert.strictEqual(completed.final, '验证完成。', 'a canonical completion keeps the latest final message');
    assert(!harness.requests.some(row => ['thread/resume', 'turn/start', 'thread/queue/start'].includes(row.method)), 'observing another client must never acquire its writer or dispatch its queue');
  } finally { await harness.backend.close(); }
}

async function checkNewTurnAheadOfSnapshot() {
  const turns = [{ id: 'old-turn', status: 'completed', startedAt: 100, completedAt: 101, items: [{ type: 'agentMessage', text: '旧回复' }] }];
  const harness = createHarness({ active: false, turns });
  try {
    await harness.backend.start();
    harness.child().send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: 'new-turn', startedAt: 200 } } });
    harness.child().send({ method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId: 'new-turn', itemId: 'new-message', delta: '当前进度' } });
    await harness.backend.listThreads();
    const running = await harness.backend.status(THREAD_ID);
    assert.strictEqual(running.turnId, 'new-turn', 'a stale history read must not replace the new live turn');
    assert.strictEqual(running.status, 'running');
    assert.strictEqual(running.preview, '当前进度');
    assert(!JSON.stringify(running.steps).includes('旧回复'));
    assert.strictEqual(harness.requests.filter(row => row.method === 'thread/items/list').at(-1).params.turnId, 'new-turn');
    turns[0] = { id: 'newer-turn', status: 'inProgress', startedAt: 300, items: [] };
    const newer = await harness.backend.status(THREAD_ID);
    assert.strictEqual(newer.turnId, 'newer-turn', 'a truly newer native turn supersedes cached notifications');
    harness.child().kill();
    turns[0] = { id: 'new-turn', status: 'completed', startedAt: 200, completedAt: 201, items: [] };
    const reconnected = await harness.backend.status(THREAD_ID);
    assert.strictEqual(reconnected.status, 'complete', 'a disconnected running cache cannot override a confirmed terminal snapshot');
    assert.strictEqual(harness.backend.threadRuntime.get(THREAD_ID).live, false);
  } finally { await harness.backend.close(); }
}

async function checkSingleSessionAndHandoff() {
  const concurrent = createHarness({ active: false, cold: true });
  try {
    const results = await Promise.allSettled([
      concurrent.backend.ensureThreadLoaded(THREAD_ID),
      concurrent.backend.ensureThreadLoaded(PROJECTLESS_ID),
    ]);
    assert.strictEqual(results.filter(row => row.status === 'fulfilled').length, 1, 'direct concurrent acquisition must have a single owner');
    assert.strictEqual(results.filter(row => row.reason?.code === 'MINI_SESSION_BUSY').length, 1);
    assert.strictEqual(concurrent.requests.filter(row => row.method === 'thread/resume').length, 1);
  } finally { await concurrent.backend.close(); }

  const handoffs = [];
  const harness = createHarness({ active: false, cold: true, saveDesktopHandoffs: ids => handoffs.push([...ids]) });
  const { backend, requests } = harness;
  try {
    await backend.send({ threadId: THREAD_ID, text: 'Mini owns one session' });
    await assert.rejects(backend.send({ threadId: PROJECTLESS_ID, text: 'Do not acquire a second session' }), error => error.code === 'MINI_SESSION_BUSY');
    await assert.rejects(backend.createThread(), error => error.code === 'MINI_SESSION_BUSY');
    await assert.rejects(backend.guideQueueHead(PROJECTLESS_ID), error => error.code === 'MINI_SESSION_BUSY');
    await assert.rejects(backend.stop(PROJECTLESS_ID), error => error.code === 'MINI_SESSION_BUSY');
    await assert.rejects(backend.updateThreadSettings(PROJECTLESS_ID, { model: 'other' }), error => error.code === 'MINI_SESSION_BUSY');
    assert(!requests.some(row => row.method === 'thread/resume' && row.params.threadId === PROJECTLESS_ID));
    const owner = harness.child();
    await backend.releaseSession();
    assert(owner.stdin.writableEnded, 'handoff must close the owner transport, not merely unsubscribe');
    assert(owner.killed, 'handoff must wait until the owner process exits');
    assert.strictEqual(backend.connectionStatus().ownedThreadId, '');
    assert(handoffs.at(-1).includes(THREAD_ID), 'manual handoff must persist the no-auto-reacquire intent');
    const beforeReads = requests.length;
    await backend.status(THREAD_ID);
    await backend.dispatchWaitingQueues();
    assert(!requests.slice(beforeReads).some(row => ['thread/resume', 'turn/start', 'thread/queue/start'].includes(row.method)), 'observing a released session must not take it back');
  } finally { await backend.close(); }

  const restored = createHarness({ active: false, cold: true, writerRetryMs: 25, errorMethod: 'thread/list',
    savedWriterWaits: [THREAD_ID], savedDesktopHandoffs: [THREAD_ID],
    queue: [{ id: 'retained', input: [{ type: 'text', text: 'Keep for the user' }] }],
  });
  try {
    await restored.backend.start();
    await restored.backend.listQueue(THREAD_ID);
    await restored.backend.dispatchWaitingQueues();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert(!restored.requests.some(row => row.method === 'thread/resume'), 'restart and read-only queue refresh must respect manual handoff');
    assert.strictEqual(restored.queue.length, 1, 'handoff must retain native queued input');
    await restored.backend.continueQueue(THREAD_ID);
    assert(restored.requests.some(row => row.method === 'thread/resume'), 'explicit continue can acquire a handed-off session again');
  } finally { await restored.backend.close(); }

  const timeout = createHarness({ active: false, cold: true, shutdownTimeoutMs: 25 });
  try {
    await timeout.backend.ensureThreadLoaded(THREAD_ID);
    timeout.child().stdin.removeAllListeners('finish');
    await assert.rejects(timeout.backend.releaseSession(), error => error.code === 'MINI_SESSION_RELEASE_TIMEOUT');
    assert.strictEqual(timeout.backend.connectionStatus().ownedThreadId, THREAD_ID, 'unconfirmed exit must retain ownership');
    assert.strictEqual(timeout.backend.connectionStatus().releasing, true);
    await assert.rejects(timeout.backend.readThread(THREAD_ID), error => error.code === 'MINI_SESSION_RELEASING');
    assert.strictEqual(timeout.spawnCount(), 1, 'an exit timeout must not spawn another writer process');
  } finally { timeout.child().kill(); await timeout.backend.close(); }

  const saveFailure = createHarness({ active: false, cold: true, saveDesktopHandoffs() { throw new Error('handoff write failed'); } });
  try {
    await saveFailure.backend.ensureThreadLoaded(THREAD_ID);
    await assert.rejects(saveFailure.backend.releaseSession(), /handoff write failed/);
    assert.strictEqual(saveFailure.child().stdin.writableEnded, false, 'failed persistence must not claim a successful handoff');
    assert.strictEqual(saveFailure.backend.ownedThreadId, THREAD_ID);
  } finally { await saveFailure.backend.close(); }
}

async function checkIdleReleaseAndCaching() {
  const resumed = createHarness({ active: false, cold: true, sessionIdleMs: 0 });
  try {
    Object.assign(resumed.backend._runtime(THREAD_ID), { status: 'running', live: false, turnId: 'closed-process-turn' });
    await resumed.backend.ensureThreadLoaded(THREAD_ID);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(resumed.backend.ownedThreadId, '', 'a stale turn from the previous process must not prevent idle release after resume');
  } finally { await resumed.backend.close(); }

  const idle = createHarness({ active: false, cold: true, sessionIdleMs: 45, readIdleMs: 20 });
  try {
    await idle.backend.ensureThreadLoaded(THREAD_ID);
    const owner = idle.child();
    for (let i = 0; i < 4; i++) {
      await idle.backend.readThread(THREAD_ID, false);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(owner.killed, 'read-only polling must not extend writer ownership');
    assert.strictEqual(idle.backend.ownedThreadId, '');
    assert.strictEqual(idle.backend.connectionStatus().lastReleaseReason, 'idle');
    await idle.backend.listThreads({ useCache: true });
    const listCount = idle.requests.filter(row => row.method === 'thread/list').length;
    await new Promise(resolve => setTimeout(resolve, 50));
    const spawnCount = idle.spawnCount();
    const cached = await idle.backend.listThreads({ useCache: true });
    assert.strictEqual(cached.cached, true);
    assert.strictEqual(idle.spawnCount(), spawnCount, 'cached menus must not restart the background process');
    assert.strictEqual(idle.requests.filter(row => row.method === 'thread/list').length, listCount);
    await idle.backend.listThreads({ useCache: false });
    assert.strictEqual(idle.requests.filter(row => row.method === 'thread/list').length, listCount + 1, 'manual refresh bypasses the snapshot');
  } finally { await idle.backend.close(); }

  const running = createHarness({ active: false, sessionIdleMs: 0 });
  try {
    await running.backend.send({ threadId: THREAD_ID, text: 'Keep the active reply' });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.strictEqual(running.backend.ownedThreadId, THREAD_ID, 'automatic release cannot interrupt a running turn');
    running.child().send({ id: 901, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD_ID } });
    running.child().send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: 'turn-new', status: 'completed', items: [] } } });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.strictEqual(running.backend.ownedThreadId, THREAD_ID, 'unresolved approvals must retain their channel');
    running.child().send({ method: 'serverRequest/resolved', params: { threadId: THREAD_ID, requestId: 901 } });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.strictEqual(running.backend.ownedThreadId, '', 'completion and approval resolution allow immediate release');
  } finally { await running.backend.close(); }

  const queued = createHarness({ active: false, sessionIdleMs: 0, errorMethod: 'thread/list' });
  try {
    await queued.backend.send({ threadId: THREAD_ID, text: 'First turn' });
    await queued.backend.send({ threadId: THREAD_ID, text: 'Already queued follow-up' });
    queued.child().send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: 'turn-new', status: 'completed', items: [] } } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(queued.backend.ownedThreadId, THREAD_ID, 'immediate release must allow an already queued turn to run');
    assert.strictEqual(queued.backend._runtime(THREAD_ID).status, 'running');
    assert.strictEqual(queued.requests.filter(row => row.method === 'thread/queue/start').length, 1);
    queued.child().send({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: 'turn-queued', status: 'completed', items: [] } } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(queued.backend.ownedThreadId, '', 'release after the queued turn finishes');
    assert(!queued.requests.some(row => row.method === 'thread/list'), 'send, queue dispatch and release must not depend on an expensive global list');
  } finally { await queued.backend.close(); }
}

async function checkWorktreeGrouping() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-project-group-'));
  const repository = path.join(directory, 'repository');
  const worktree = path.join(directory, 'worktree');
  const gitDir = path.join(repository, '.git', 'worktrees', 'worktree');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  const harness = createHarness({ active: false,
    projects: [{ id: 'main-project', name: 'Shared project', roots: [{ path: repository }] }],
    threads: [{ id: THREAD_ID, projectId: 'main-project', cwd: repository }, { id: PROJECTLESS_ID, projectId: null, cwd: worktree }],
  });
  try {
    const result = await harness.backend.listThreads();
    assert.strictEqual(result.threads[0].projectKey, result.threads[1].projectKey, 'a managed worktree belongs to the original project group');
    assert.strictEqual(result.threads[1].projectPath, repository);
    assert.strictEqual(result.threads[1].cwd, worktree, 'grouping must not change the task working directory');
    for (const value of ['C:\\Projects\\Demo', 'c:/projects/DEMO/', '\\\\?\\C:\\Projects\\Demo']) {
      assert.strictEqual(projectPathKey(value), 'c:\\projects\\demo');
    }
    assert.notStrictEqual(projectPathKey('C:\\one\\Demo'), projectPathKey('C:\\two\\Demo'), 'matching labels do not establish project identity');
  } finally {
    await harness.backend.close();
    assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function checkScopedThreadPages() {
  const threads = Array.from({ length: 18 }, (_, index) => ({
    id: `scoped-${index}`, name: `Thread ${index}`, projectId: index % 2 ? null : 'project-1',
    cwd: index % 2 ? 'C:\\internal-folder' : 'C:\\Projects\\Demo',
  }));
  const harness = createHarness({ active: false, cold: true, threads });
  try {
    const projects = await harness.backend.listThreads({ limit: 3, scope: 'projects', useCache: true });
    const conversations = await harness.backend.listThreads({ limit: 3, scope: 'conversations', useCache: true });
    assert.deepStrictEqual(projects.threads.map(row => row.id), ['scoped-0', 'scoped-2', 'scoped-4']);
    assert.deepStrictEqual(conversations.threads.map(row => row.id), ['scoped-1', 'scoped-3', 'scoped-5']);
    const more = await harness.backend.listThreads({ limit: 3, scope: 'projects', cursor: projects.nextCursor });
    assert.deepStrictEqual(more.threads.map(row => row.id), ['scoped-6', 'scoped-8', 'scoped-10']);
    const cache = await harness.backend.listThreads({ limit: 3, scope: 'conversations', useCache: true });
    assert.strictEqual(cache.cached, true, 'category snapshots must have separate cache keys');
    assert.deepStrictEqual(cache.threads, conversations.threads, 'project pagination cannot advance the conversation cursor');
    assert(!harness.requests.some(row => ['thread/resume', 'turn/start', 'thread/queue/start'].includes(row.method)), 'category browsing must remain read-only');
    await assert.rejects(harness.backend.listThreads({ scope: 'invalid' }), error => error.code === 'BAD_THREAD_SCOPE');
  } finally { await harness.backend.close(); }

  const sparse = createHarness({ active: false, cold: true, threads: [
    ...Array.from({ length: 40 }, (_, index) => ({ id: `project-${index}`, projectId: 'project-1', cwd: 'C:\\Projects\\Demo' })),
    { id: PROJECTLESS_ID, projectId: null, cwd: 'C:\\internal-folder' },
  ] });
  try {
    const first = await sparse.backend.listThreads({ limit: 10, scope: 'conversations' });
    assert.strictEqual(first.threads.length, 0);
    assert(first.nextCursor, 'an empty category page must keep its continuation');
    assert.strictEqual(sparse.requests.filter(row => row.method === 'thread/list').length, 4, 'sparse category reads must be bounded');
    const next = await sparse.backend.listThreads({ limit: 10, scope: 'conversations', cursor: first.nextCursor });
    assert.strictEqual(next.threads[0].id, PROJECTLESS_ID);
    assert.strictEqual(next.nextCursor, null);
  } finally { await sparse.backend.close(); }

  const mixedFamily = createHarness({ active: false, threads: [
    { id: THREAD_ID, projectId: 'project-1', cwd: 'C:\\Projects\\Demo' },
    { id: PROJECTLESS_ID, parentThreadId: THREAD_ID, projectId: null, cwd: 'C:\\internal-folder' },
  ] });
  try {
    const result = await mixedFamily.backend.listThreads({ scope: 'conversations' });
    assert.strictEqual(result.threads[0].id, PROJECTLESS_ID, 'a child from another category must remain visible');
    assert.strictEqual(result.threads[0].children.length, 0);
  } finally { await mixedFamily.backend.close(); }
}

async function main() {
  await checkScopedThreadPages();
  await checkIdleReleaseAndCaching();
  await checkWorktreeGrouping();
  await checkSingleSessionAndHandoff();
  await checkExternalProgress();
  await checkNewTurnAheadOfSnapshot();
  await checkLiveProgress();
  const writerLock = { value: true };
  const savedWaits = [];
  const writer = createHarness({ active: false, cold: true, writerLock, writerRetryMs: 25, saveWriterWaits: rows => savedWaits.push([...rows]) });
  const waiting = await writer.backend.send({ threadId: THREAD_ID, text: 'Wait for desktop', clientRequestId: 'writer-1' });
  assert.strictEqual(waiting.queued, true);
  assert.strictEqual(waiting.waitingForWriter, true);
  await assert.rejects(writer.backend.send({ threadId: PROJECTLESS_ID, text: 'Keep one pending target' }), error => error.code === 'MINI_SESSION_BUSY');
  assert.strictEqual(writer.queue.length, 1);
  assert(!writer.requests.some(row => row.method === 'turn/start'), 'writer conflict must not start a duplicate turn');
  assert.strictEqual((await writer.backend.listQueue(THREAD_ID)).waitingForWriter, true);
  await writer.backend.send({ threadId: THREAD_ID, text: 'Keep FIFO', clientRequestId: 'writer-2' });
  assert.strictEqual(writer.queue.length, 2);
  assert.strictEqual(writer.requests.filter(row => row.method === 'thread/resume').length, 1, 'additional sends must append without competing for the writer again');
  writerLock.value = false;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.strictEqual(writer.requests.filter(row => row.method === 'thread/queue/start').length, 1, 'releasing the writer must automatically start exactly the queue head');
  assert.strictEqual(writer.queue[0].clientUserMessageId, 'writer-2');
  assert(savedWaits.some(rows => rows.includes(THREAD_ID)), 'confirmed writer waits must survive service restarts');
  assert.deepStrictEqual(savedWaits.at(-1), [], 'clear persisted retry intent before dispatching a turn');
  writer.backend.close();

  const interruptedWait = createHarness({ active: false, cold: true, writerLock: {value:true}, writerRetryMs:25 });
  await interruptedWait.backend.send({ threadId: THREAD_ID, text: 'Remain paused', clientRequestId: 'writer-stop' });
  interruptedWait.backend.pausedQueues.add(THREAD_ID);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.strictEqual(interruptedWait.requests.filter(row => row.method === 'thread/resume').length, 1, 'paused queues must never retry writer acquisition');
  interruptedWait.backend.close();

  const unknownResume = createHarness({ active: false, cold: true, ignoreMethod:'thread/resume', requestTimeoutMs:25 });
  await assert.rejects(unknownResume.backend.send({threadId:THREAD_ID,text:'Unknown resume'}), e=>e.code==='CODEX_APP_SERVER_OUTCOME_UNKNOWN');
  assert(!unknownResume.requests.some(row=>row.method==='thread/queue/add'), 'unknown resume must not silently queue a second operation');
  unknownResume.backend.close();

  const restored = createHarness({ active:false, cold:true, savedWriterWaits:[THREAD_ID], writerRetryMs:25,
    queue:[{id:'saved-queue',clientUserMessageId:'saved',input:[{type:'text',text:'Persisted input'}]}] });
  await restored.backend.start();
  await new Promise(resolve=>setTimeout(resolve,90));
  assert.strictEqual(restored.requests.filter(row=>row.method==='thread/queue/start').length,1, 'a saved writer wait must resume after service restart');
  restored.backend.close();

  const uncertainDispatch = createHarness({ active:false, cold:true, savedWriterWaits:[THREAD_ID], writerRetryMs:25, requestTimeoutMs:25,
    ignoreMethod:'thread/queue/start', queue:[{id:'uncertain-queue',input:[{type:'text',text:'Only once'}]}] });
  await uncertainDispatch.backend.start();
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.strictEqual(uncertainDispatch.requests.filter(row=>row.method==='thread/queue/start').length,1, 'unknown queue/start must never be replayed');
  assert.strictEqual(uncertainDispatch.backend.writerWaits.size,0);
  assert.strictEqual(uncertainDispatch.backend.pausedQueues.has(THREAD_ID),true);
  uncertainDispatch.backend.close();

  const uncertainResumeSaved = [];
  const uncertainResumeWait = createHarness({active:false,cold:true,savedWriterWaits:[THREAD_ID],writerRetryMs:25,requestTimeoutMs:25,
    ignoreMethod:'thread/resume',queue:[{id:'waiting-unknown',input:[{type:'text',text:'Pause unknown acquire'}]}],saveWriterWaits:rows=>uncertainResumeSaved.push([...rows])});
  await uncertainResumeWait.backend.start();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.deepStrictEqual(uncertainResumeSaved.at(-1),[], 'unknown acquisition must clear persisted auto-resume intent');
  assert.strictEqual(uncertainResumeWait.requests.filter(row=>row.method==='thread/queue/start').length,0);
  uncertainResumeWait.backend.close();

  const rejectedStart = createHarness({active:false,writerLock:{value:true}});
  assert.strictEqual((await rejectedStart.backend.send({threadId:THREAD_ID,text:'Start rejected before acceptance'})).waitingForWriter,true);
  await assert.rejects(rejectedStart.backend.send({threadId:PROJECTLESS_ID,text:'Do not switch a pending claim'}), error=>error.code==='MINI_SESSION_BUSY');
  assert.strictEqual(rejectedStart.backend.pausedQueues.has(THREAD_ID),false);
  rejectedStart.backend.close();

  const saveFailure = createHarness({active:false,cold:true,writerLock:{value:true},writerRetryMs:25,
    saveWriterWaits(){throw new Error('state write unavailable');}});
  const savedButPaused = await saveFailure.backend.send({threadId:THREAD_ID,text:'Keep acknowledged input'});
  assert.strictEqual(savedButPaused.queued,true, 'a state-file failure must not turn acknowledged queue/add into a failed send');
  assert.strictEqual(savedButPaused.queuePaused,true);
  assert.strictEqual(savedButPaused.waitingForWriter,false);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.strictEqual(saveFailure.requests.filter(row=>row.method==='thread/resume').length,1);
  saveFailure.backend.close();

  const historyTurns = Array.from({ length: 20 }, (_, index) => ({
    id: `turn-${20 - index}`, status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: `question-${20 - index}` }] },
      { type: 'agentMessage', phase: 'final_answer', text: `answer-${20 - index}` },
    ],
  }));
  const historyHarness = createHarness({ active: false, turns: historyTurns });
  const recent = await historyHarness.backend.history(THREAD_ID, 5);
  assert.deepStrictEqual(recent.messages.map(item => item.text), ['answer-18', 'question-19', 'answer-19', 'question-20', 'answer-20']);
  assert.strictEqual(recent.truncated, true, 'older messages must remain available on demand');
  const status = await historyHarness.backend.status(THREAD_ID);
  assert.strictEqual(status.final, 'answer-20');
  assert(!historyHarness.requests.some(item => item.method === 'thread/read' && item.params.includeTurns), 'history and polling must never hydrate every turn');
  assert(historyHarness.requests.some(item => item.method === 'thread/turns/list' && item.params.limit === 1), 'status must read only the latest turn');
  historyTurns.unshift({ id: 'turn-21', status: 'completed', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'new question' }] },
    { type: 'agentMessage', text: 'new answer' },
  ] });
  const second = await historyHarness.backend.history(THREAD_ID, { limit: 5, cursor: recent.nextCursor });
  assert.deepStrictEqual(second.messages.map(item => item.text), ['question-16', 'answer-16', 'question-17', 'answer-17', 'question-18']);
  assert.deepStrictEqual(await historyHarness.backend.history(THREAD_ID, { limit: 5, cursor: recent.nextCursor }), second, 'retry must preserve the page and its cursor');
  await assert.rejects(historyHarness.backend.history(PROJECTLESS_ID, { limit: 5, cursor: recent.nextCursor }), error => error.code === 'HISTORY_CURSOR_EXPIRED');
  const third = await historyHarness.backend.history(THREAD_ID, { limit: 5, cursor: second.nextCursor });
  assert.deepStrictEqual(third.messages.map(item => item.text), ['answer-13', 'question-14', 'answer-14', 'question-15', 'answer-15'], 'native cursor must continue behind the original snapshot after a new turn');
  const ids = [...third.messages, ...second.messages, ...recent.messages].map(row => row.id);
  assert.strictEqual(new Set(ids).size, 15, 'message identities must be stable and distinct');
  historyHarness.backend.historyPages.get(third.nextCursor).createdAt = 0;
  await assert.rejects(historyHarness.backend.history(THREAD_ID, { limit: 5, cursor: third.nextCursor }), error => error.status === 410);
  const beforeBootstrap = historyHarness.requests.length;
  const bootstrap = await historyHarness.backend.bootstrap(THREAD_ID);
  assert.strictEqual(bootstrap.history.messages.length, 5);
  assert.strictEqual(bootstrap.status.final, 'new answer');
  assert.deepStrictEqual(bootstrap.status.queue, []);
  assert.deepStrictEqual(bootstrap.status.approvals, []);
  assert.strictEqual(historyHarness.requests.slice(beforeBootstrap).filter(row => row.method === 'thread/turns/list').length, 1, 'bootstrap must share the latest-turn read');
  historyHarness.backend.close();

  const sparse = createHarness({ active: false, turns: [
    ...Array.from({ length: 30 }, (_, index) => ({ id: `tools-${index}`, items: [] })),
    { id: 'older-text', items: [{ type: 'agentMessage', text: 'older final answer' }] },
  ] });
  const empty = await sparse.backend.history(THREAD_ID);
  assert.strictEqual(empty.messages.length, 0);
  assert(empty.nextCursor, 'an empty tool-only page must retain its continuation');
  assert.strictEqual(sparse.requests.filter(row => row.method === 'thread/turns/list').length, 5, 'sparse history must have bounded work');
  const sparseNext = await sparse.backend.history(THREAD_ID, { cursor: empty.nextCursor });
  assert.strictEqual(sparseNext.messages[0].text, 'older final answer');
  sparse.backend.close();

  const orphanHarness = createHarness({ threads: [{ id: THREAD_ID, parentThreadId: 'outside-this-page', name: 'Recent child' }] });
  assert.strictEqual((await orphanHarness.backend.listThreads({ limit: 5 })).threads[0].id, THREAD_ID, 'a recent child must not disappear when its parent is on an older page');
  orphanHarness.backend.close();

  const cold = createHarness({ active: false, cold: true });
  await cold.backend.send({ threadId: THREAD_ID, text: 'Resume an existing conversation', clientRequestId: 'cold-send-1' });
  const resumeIndex = cold.requests.findIndex(item => item.method === 'thread/resume');
  const sendIndex = cold.requests.findIndex(item => item.method === 'turn/start');
  assert(resumeIndex >= 0 && resumeIndex < sendIndex, 'persisted threads must be resumed before a new turn');
  assert.strictEqual(cold.requests[resumeIndex].params.excludeTurns, true, 'resuming for send should not hydrate all history');
  cold.backend.close();

  const resumeFailure = createHarness({ active: false, cold: true, errorMethod: 'thread/resume' });
  await assert.rejects(resumeFailure.backend.send({ threadId: THREAD_ID, text: 'Do not send after a resume failure' }), /thread\/resume rejected/);
  assert(!resumeFailure.requests.some(item => item.method === 'turn/start'), 'resume failure must block sending');
  resumeFailure.backend.close();

  const coldQueue = createHarness({ active: false, cold: true });
  await coldQueue.backend.continueQueue(THREAD_ID);
  assert(coldQueue.requests.findIndex(item => item.method === 'thread/resume') < coldQueue.requests.findIndex(item => item.method === 'thread/queue/start'), 'a persisted queue must resume its thread before starting');
  coldQueue.backend.close();

  const harness = createHarness();
  const { backend, requests, queue } = harness;
  await backend.start();
  const initialized = requests.find(item => item.method === 'initialize');
  assert.strictEqual(initialized.params.capabilities.experimentalApi, true, 'experimental API capability must be enabled');

  const info = await backend.readConfigAndModels();
  assert.strictEqual(info.effectiveApprovalPolicy, 'on-request');
  assert.strictEqual(info.effectiveApprovalsReviewer, 'auto_review');
  assert.deepStrictEqual(info.models.map(item => item.id), ['gpt-test']);

  const listed = await backend.listThreads({ limit: 10 });
  assert.strictEqual(listed.threads.length, 2);
  assert.strictEqual(listed.threads[1].name, '第一条用户消息', 'placeholder title must use preview');
  assert.strictEqual(listed.threads[1].projectName, '对话', 'projectless thread must stay in virtual conversations group');
  assert.strictEqual(listed.threads[1].projectPath, '', 'internal projectless cwd must not leak');
  assert.strictEqual(listed.threads[1].cwd, '', 'internal projectless cwd must not leak through the legacy cwd field');

  const history = await backend.history(THREAD_ID, 20);
  assert.deepStrictEqual(history.messages.map(item => item.role), ['user', 'assistant']);

  const queued = await backend.send({ threadId: THREAD_ID, text: '排队消息', clientRequestId: 'client-1' });
  assert.strictEqual(queued.queued, true, 'active thread sends must enter native queue');
  assert.strictEqual(queue.length, 1);
  await backend.guideQueueHead(THREAD_ID, 'steer-client-1');
  assert.strictEqual(queue.length, 0, 'guided queue head must be deleted only after steer succeeds');
  const steerIndex = requests.findIndex(item => item.method === 'turn/steer');
  const deleteIndex = requests.findIndex(item => item.method === 'thread/queue/delete');
  assert(steerIndex >= 0 && deleteIndex > steerIndex, 'steer confirmation must precede queue deletion');

  harness.child().send({
    id: 900,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: THREAD_ID, turnId: 'turn-1', itemId: 'item-1', startedAtMs: Date.now(), command: 'npm test' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(backend.listApprovals(THREAD_ID).length, 1, 'reverse approval must be exposed');
  await backend.respondApproval('900', { decision: 'accept' });
  assert.deepStrictEqual(harness.responses.find(item => item.id === 900).result, { decision: 'accept' });
  assert(backend.listApprovals(THREAD_ID)[0].submittedAt, 'approval must remain visible until server confirmation');
  harness.child().send({ method: 'serverRequest/resolved', params: { threadId: THREAD_ID, requestId: 900 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(backend.listApprovals(THREAD_ID).length, 0, 'resolved notification must clear submitted approval');
  assert.strictEqual(harness.spawnCount(), 1, 'all operations must share one long-lived App Server process');

  const directHarness = createHarness({ active: false });
  await directHarness.backend.send({ threadId: THREAD_ID, text: '直接消息', clientRequestId: 'client-2' });
  const turnStart = directHarness.requests.find(item => item.method === 'turn/start');
  assert(turnStart, 'idle thread must start a turn');
  assert(!Object.prototype.hasOwnProperty.call(turnStart.params, 'approvalPolicy'), 'effective approval policy must be inherited, not overridden');
  assert(!Object.prototype.hasOwnProperty.call(turnStart.params, 'sandboxPolicy'), 'effective sandbox must be inherited, not overridden');

  const unknownHarness = createHarness({ active: false, ignoreMethod: 'turn/start', requestTimeoutMs: 30 });
  await assert.rejects(
    unknownHarness.backend.send({ threadId: THREAD_ID, text: '结果未知', clientRequestId: 'client-3' }),
    error => error && error.code === 'CODEX_APP_SERVER_OUTCOME_UNKNOWN',
    'mutating timeout must fail closed as outcome unknown',
  );
  assert.strictEqual((await unknownHarness.backend.listQueue(THREAD_ID)).paused, true, 'unknown turn start must pause that thread queue');

  const concurrencyHarness = createHarness({ active: false, maxConcurrency: 1, turnStartDelayMs: 25 });
  const concurrentResults = await Promise.allSettled([
    concurrencyHarness.backend.send({ threadId: THREAD_ID, text: '并发一', clientRequestId: 'concurrent-1' }),
    concurrencyHarness.backend.send({ threadId: PROJECTLESS_ID, text: '并发二', clientRequestId: 'concurrent-2' }),
  ]);
  assert.strictEqual(concurrencyHarness.requests.filter(item => item.method === 'turn/start').length, 1, 'scheduler must reserve the only slot before another send can start');
  assert.strictEqual(concurrentResults.filter(item => item.status === 'rejected' && item.reason.code === 'MINI_SESSION_BUSY').length, 1, 'a concurrent second session must be refused before acquisition');

  const terminalHarness = createHarness({ active: true });
  await terminalHarness.backend.send({ threadId: THREAD_ID, text: '等待异常完成', clientRequestId: 'terminal-1' });
  terminalHarness.child().send({
    method: 'turn/completed',
    params: { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'cancelled', items: [] } },
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  const terminalQueue = await terminalHarness.backend.listQueue(THREAD_ID);
  assert.strictEqual(terminalQueue.paused, true, 'unknown terminal status must pause the queue');
  assert.strictEqual(terminalHarness.requests.filter(item => item.method === 'thread/queue/start').length, 0, 'unknown terminal status must not auto-dispatch');

  const steerFailureHarness = createHarness({ active: true, errorMethod: 'turn/steer' });
  await steerFailureHarness.backend.send({ threadId: THREAD_ID, text: '保留队首', clientRequestId: 'steer-failure-1' });
  await assert.rejects(steerFailureHarness.backend.guideQueueHead(THREAD_ID), /turn\/steer rejected/);
  assert.strictEqual((await steerFailureHarness.backend.listQueue(THREAD_ID)).paused, true, 'known steer failure must pause and retain the queue');

  const stopFailureHarness = createHarness({ active: true, errorMethod: 'turn/interrupt' });
  await assert.rejects(stopFailureHarness.backend.stop(THREAD_ID), /turn\/interrupt rejected/);
  assert.strictEqual((await stopFailureHarness.backend.listQueue(THREAD_ID)).paused, true, 'manual stop intent must pause the queue even when interrupt is rejected');

  await backend.close();
  await directHarness.backend.close();
  await unknownHarness.backend.close();
  await concurrencyHarness.backend.close();
  await terminalHarness.backend.close();
  await steerFailureHarness.backend.close();
  await stopFailureHarness.backend.close();
  await checkGoals();
  await checkUsageAndPermissions();
  console.log('App Server backend contract test passed.');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
