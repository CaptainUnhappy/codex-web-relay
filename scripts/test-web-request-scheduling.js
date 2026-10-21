'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('public/index.html', 'utf8');

function uiFunction(name) {
  const start = html.search(new RegExp(`    (?:async )?function ${name}\\(`));
  assert(start >= 0, `UI function ${name} exists`);
  const rest = html.slice(start + 1);
  const end = rest.search(/\n    (?:async )?function /);
  return html.slice(start, end < 0 ? html.lastIndexOf('</script>') : start + 1 + end);
}

const flush = () => new Promise(resolve => setImmediate(resolve));

async function checkReadLimitsAndBackoff() {
  const pending = [];
  let active = 0;
  let peak = 0;
  let now = 0;
  const context = vm.createContext({
    AbortController, Headers, Date: { now: () => now }, apiPauseUntil: 0, deviceSwitching: false, activeDeviceId: '', deviceStorageScope: 'fixture',
    activeReadRequests: 0, readRequestWaiters: [],
    window: { setTimeout, clearTimeout },
    fetch: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => pending.push(resolve));
      active--;
      return { status: 200, headers: new Headers() };
    },
  });
  vm.runInContext(uiFunction('fetchWithTimeout'), context);
  const reads = Array.from({ length: 12 }, (_, index) => context.fetchWithTimeout(`/read-${index}`));
  await flush();
  assert.strictEqual(peak, 3, 'different read requests must share a three-request limit');
  for (let index = 0; index < reads.length; index++) { pending.shift()(); await flush(); }
  await Promise.all(reads);
  assert.strictEqual(context.activeReadRequests, 0, 'read slots must be released');

  let calls = 0;
  context.fetch = async () => {
    calls++;
    return { status: 429, clone: () => ({ json: async () => ({ code: 'RATE_LIMITED' }) }), headers: { get: () => null } };
  };
  await context.fetchWithTimeout('/send', { method: 'POST' });
  assert.strictEqual(calls, 1, 'a rate-limited mutation must never be replayed');
  assert.strictEqual(context.apiPauseUntil, 60000, 'minute rate limits must pause background reads');
  const timers = [];
  context.window = { setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout() {} };
  context.fetch = async () => { calls++; return { status: 200, headers: new Headers() }; };
  const afterPause = context.fetchWithTimeout('/read');
  await flush();
  assert.strictEqual(calls, 1, 'reads must wait for the device cooldown');
  now = 60000;
  timers.shift().callback();
  await afterPause;
  assert.strictEqual(calls, 2);

  timers.length = 0;
  calls = 0;
  context.fetch = async () => {
    calls++;
    return { status: 429, clone: () => ({ json: async () => ({ code: 'DEVICE_BUSY' }) }), headers: { get: () => '2' } };
  };
  const limitedRead = context.fetchWithTimeout('/still-busy');
  await flush();
  assert.strictEqual(calls, 1);
  now += 2000;
  timers.find(item => item.ms === 2000).callback();
  assert.strictEqual((await limitedRead).status, 429);
  assert.strictEqual(calls, 2, 'a busy device gets one delayed read retry, never an endless retry loop');
}

async function checkSendProgressPolling() {
  const pending = [], intervals = [], notices = [];
  const context = vm.createContext({ URLSearchParams, document: { hidden: false }, token: 'fixture', activeAssistant: null,
    setInterval(callback, ms) { intervals.push({ callback, ms }); return 1; }, clearInterval() {},
    fetchApi: async () => new Promise(resolve => pending.push(resolve)), setNotice: text => notices.push(text) });
  vm.runInContext(uiFunction('startSendProgressPolling'), context);
  const stop = context.startSendProgressPolling('request-1');
  await flush();
  assert.strictEqual(intervals[0].ms, 1000, 'send progress polls once per second');
  for (let i = 0; i < 8; i++) await intervals[0].callback();
  assert.strictEqual(pending.length, 1, 'slow send-status responses cannot overlap');
  pending.shift()({ json: async () => ({ ok: true }) }); await flush();
  context.document.hidden = true;
  await intervals[0].callback();
  assert.strictEqual(pending.length, 0, 'hidden pages skip send-status requests');
  context.document.hidden = false;
  const late = intervals[0].callback(); await flush(); stop();
  pending.shift()({ json: async () => ({ ok: true, found: true, progress: { message: 'old phase' } }) });
  await late;
  assert.strictEqual(notices.length, 0, 'stopped sending cannot render a late progress notice');
}

async function checkDeviceBinding() {
  const requests = [];
  let responseDevice = 'device-a', reloads = 0;
  const context = vm.createContext({ AbortController, Headers, Date, apiPauseUntil: 0,
    activeReadRequests: 0, readRequestWaiters: [], deviceSwitching: false, activeDeviceId: 'device-a', deviceStorageScope: 'scope-a',
    window: { setTimeout, clearTimeout }, reloadForDeviceChange() { context.deviceSwitching = true; reloads++; },
    fetch: async (url, options) => { requests.push(options); return new Response('{}', { headers: { 'x-codex-mini-device-id': responseDevice } }); } });
  vm.runInContext(uiFunction('fetchWithTimeout'), context);
  await context.fetchWithTimeout('/status');
  assert.strictEqual(requests[0].headers.get('x-codex-mini-device-id'), 'device-a');
  responseDevice = 'device-b';
  await assert.rejects(context.fetchWithTimeout('/status'), /设备已切换/);
  assert.strictEqual(reloads, 1);
  await assert.rejects(context.fetchWithTimeout('/send', { method: 'POST' }), /切换设备/);
  assert.strictEqual(requests.length, 2, 'switching tabs cannot submit to the new cookie device');
  context.deviceSwitching = false; context.deviceStorageScope = '';
  await assert.rejects(context.fetchWithTimeout('/send', { method: 'POST' }), /确认设备/);
  assert.strictEqual(requests.length, 2, 'no mutation is allowed before device confirmation');
}

async function checkPolling() {
  const pending = [];
  const context = vm.createContext({
    goalEpoch: 0, resetGoalForThread() {},
    URLSearchParams, Date, document: { hidden: false }, token: 'fixture', pollGeneration: 1,
    selectedThreadId: 'thread-1', activeAssistant: {}, pollAttempts: 0, pollStatusBusy: false,
    apiPauseUntil: 0, clientReady: true,
    fetchApi: async () => new Promise(resolve => pending.push(resolve)),
    setNotice() {}, stopPolling() {},
  });
  vm.runInContext(uiFunction('pollStatus'), context);
  const calls = Array.from({ length: 12 }, () => context.pollStatus({ threadId: 'thread-1' }, 1));
  await flush();
  assert.strictEqual(pending.length, 1, 'timer ticks must not overlap an outstanding status request');
  pending[0]({ json: async () => ({ ok: false, message: 'fixture completed' }) });
  await Promise.all(calls);
  const next = context.pollStatus({ threadId: 'thread-1' }, 1);
  await flush();
  assert.strictEqual(pending.length, 2, 'polling must recover after a failed response');
  pending[1]({ json: async () => ({ ok: false }) });
  await next;
  context.document.hidden = true;
  await context.pollStatus({ threadId: 'thread-1' }, 1);
  assert.strictEqual(pending.length, 2, 'hidden tabs must not poll');
}

async function checkThreadPages() {
  const requests = [];
  const pending = [];
  const context = vm.createContext({
    URLSearchParams, Date, Map, token: 'fixture', knownThreads: [], selectedThreadId: '', pendingNewThread: null,
    legacySelectedThreadId: '', SELECTED_THREAD_STORAGE_KEY: 'fixture.selectedThread',
    THREAD_PAGE_SIZE: 5, threadMenuView: 'split', threadSearchQuery: '',
    threadPages: {
      projects: { nextCursor: null, loaded: false, moreLoaded: false, request: null, at: 0 },
      conversations: { nextCursor: null, loaded: false, moreLoaded: false, request: null, at: 0 },
    },
    localStorage: { setItem() {} },
    fetchApi: async url => { requests.push(url); return new Promise(resolve => pending.push(resolve)); },
    flattenKnownThreads(items = context.knownThreads) { return items; },
    applyThreadRuntimeState() {}, runtimeSnapshotFromThread() {}, pruneCompletedThreadNotices() {},
    setThreadCompleteNotice() {}, updateThreadTitle() {}, renderThreadMenuIfVisualChanged() {}, renderThreadMenu() {}, persistThreadBrowserCache() {},
  });
  vm.runInContext(['sortThreadsByTime', 'selectedThreadPlaceholder', 'loadThreadPage', 'loadThreads'].map(uiFunction).join('\n'), context);
  const first = context.loadThreads();
  const concurrent = context.loadThreads();
  await flush();
  assert.strictEqual(requests.length, 2, 'initialization and foreground refresh must share one request per category');
  assert.strictEqual(new URL(requests[0], 'http://fixture').searchParams.get('limit'), '5');
  assert.deepStrictEqual(requests.map(url => new URL(url, 'http://fixture').searchParams.get('scope')), ['projects', 'conversations']);
  const page = (scope, start, end) => Array.from({ length: end - start }, (_, index) => ({ id: `${scope}-${start + index}`, name: 'Fixture', isProjectThread: scope === 'projects' }));
  const reply = (scope, start, end, nextCursor, ok = true) => pending.shift()({ ok, json: async () => ({ ok, scope, threads: page(scope, start, end), nextCursor, message: 'fixture failure' }) });
  reply('projects', 1, 6, 'older-projects');
  reply('conversations', 1, 6, 'older-conversations');
  await Promise.all([first, concurrent]);
  assert.strictEqual(context.knownThreads.length, 10);
  context.threadMenuView = 'projects';
  const more = context.loadThreads({ scope: 'projects', more: true });
  const sameMore = context.loadThreads({ scope: 'projects', more: true });
  await flush();
  assert.strictEqual(requests.length, 3, 'double taps must not advance two pages');
  assert.strictEqual(new URL(requests[2], 'http://fixture').searchParams.get('scope'), 'projects');
  assert.strictEqual(new URL(requests[2], 'http://fixture').searchParams.get('cursor'), 'older-projects');
  reply('projects', 6, 11, null);
  await Promise.all([more, sameMore]);
  assert.strictEqual(context.knownThreads.length, 15);
  assert.strictEqual(context.knownThreads.filter(row => !row.isProjectThread).length, 5, 'project pagination must not add conversations');
  assert.strictEqual(context.threadPages.conversations.nextCursor, 'older-conversations');
  const refresh = context.loadThreads();
  await flush();
  assert.strictEqual(requests.length, 4, 'a focused category must not refresh the collapsed category');
  reply('projects', 1, 6, 'older-projects');
  await refresh;
  assert.strictEqual(context.knownThreads.length, 15, 'background refresh must preserve explicitly loaded older pages');
  assert.strictEqual(context.threadPages.projects.nextCursor, null, 'refreshing page one must not rewind the category cursor');
  await context.loadThreads({ useCache: true });
  assert.strictEqual(requests.length, 4, 'reopening a category must reuse its snapshot');

  const failed = context.loadThreads({ scope: 'conversations', more: true });
  const failure = assert.rejects(failed, /fixture failure/);
  await flush();
  reply('conversations', 6, 11, null, false);
  await failure;
  assert.strictEqual(context.threadPages.conversations.nextCursor, 'older-conversations', 'failed pages must remain retryable');
  assert.strictEqual(context.threadPages.conversations.request, null);
  const retry = context.loadThreads({ scope: 'conversations', more: true });
  await flush();
  assert.strictEqual(new URL(requests.at(-1), 'http://fixture').searchParams.get('cursor'), 'older-conversations');
  reply('conversations', 6, 11, null);
  await retry;
  assert.strictEqual(context.knownThreads.filter(row => row.isProjectThread).length, 10);
  assert.strictEqual(context.knownThreads.filter(row => !row.isProjectThread).length, 10);

  context.threadSearchQuery = 'fixture';
  const searchRefresh = context.loadThreads({ force: true });
  await flush();
  assert.deepStrictEqual(requests.slice(-2).map(url => new URL(url, 'http://fixture').searchParams.get('scope')), ['projects', 'conversations'], 'search must cover both categories even after focusing one');
  reply('projects', 1, 6, 'older-projects');
  reply('conversations', 1, 6, 'older-conversations');
  await searchRefresh;
  assert.strictEqual(context.knownThreads.length, 20, 'clearing or refreshing search cannot erase loaded history');
}

function checkMenuPagingFocusAndScroll() {
  const document = { body: {}, activeElement: null };
  const makeButton = (key, disabled = false) => ({ dataset: { focusKey: key }, disabled,
    focus() { if (!this.disabled) document.activeElement = this; } });
  let buttons = [makeButton('more:projects')];
  let bodies = [{ dataset: { scrollKey: 'projects' }, scrollTop: 120, hidden: false }];
  document.activeElement = buttons[0];
  let loading = true;
  let collapsed = false;
  let nextView = 'projects';
  const context = vm.createContext({
    Map, document, threadMenuView: 'projects', threadSectionScroll: {}, scheduleThreadBrowserCache() {}, scheduleThreadMenuFill() {},
    threadSearch: { focus() { document.activeElement = this; } },
    threadMenuList: {
      dataset: { view: 'projects' }, scrollTop: 0,
      contains: node => buttons.includes(node),
      querySelectorAll: selector => selector === '[data-focus-key]' ? buttons : bodies,
      querySelector: () => buttons.find(button => button.dataset.focusKey === 'section:projects' && !button.disabled),
    },
    renderThreadMenuContents() {
      document.activeElement = document.body;
      context.threadMenuList.dataset.view = nextView;
      buttons = [makeButton('section:projects')];
      if (loading) buttons.push(makeButton('more:projects', true));
      bodies = [{ dataset: { scrollKey: 'projects' }, scrollTop: 0, hidden: collapsed }];
    },
  });
  vm.runInContext(uiFunction('renderThreadMenu'), context);
  context.renderThreadMenu();
  assert.strictEqual(document.activeElement.dataset.focusKey, 'section:projects', 'a disabled loading button must hand focus to its section heading');
  assert.strictEqual(bodies[0].scrollTop, 120);
  loading = false;
  collapsed = true;
  context.renderThreadMenu();
  assert.strictEqual(document.activeElement.dataset.focusKey, 'section:projects', 'the final page must not drop keyboard focus to the document');
  collapsed = false;
  context.renderThreadMenu();
  assert.strictEqual(bodies[0].scrollTop, 120, 'collapsing and reopening a category must retain its scroll position');
  nextView = 'split';
  context.renderThreadMenu();
  bodies[0].scrollTop = 150;
  nextView = 'projects';
  context.renderThreadMenu();
  bodies[0].scrollTop = 0; // A taller focused section can fit all rows and clamp scrollTop.
  nextView = 'split';
  context.renderThreadMenu();
  assert.strictEqual(bodies[0].scrollTop, 150, 'a focused view must not overwrite the split view scroll position');
}

function checkSectionToggleDoesNotCloseMenu() {
  const node = () => ({ dataset: {}, children: [], handlers: {},
    setAttribute() {}, append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    addEventListener(type, callback) { this.handlers[type] = callback; },
  });
  let stopped = false;
  const context = vm.createContext({
    document: { createElement: node }, threadMenuView: 'conversations', threadAutoFillPaused: new Set(),
    appendMoreThreadsButton() {}, createNewThreadInCurrentProject() {}, setNotice() {},
    renderThreadMenu() { assert(stopped, 'a category toggle must stop the click before replacing its own DOM node'); },
    loadThreads: () => Promise.resolve(),
  });
  vm.runInContext(uiFunction('createThreadSection'), context);
  for (const nextView of ['projects', 'split']) {
    stopped = false;
    const { section } = context.createThreadSection('projects', false, null);
    section.children[0].children[0].handlers.click({ preventDefault() {}, stopPropagation() { stopped = true; } });
    assert.strictEqual(context.threadMenuView, nextView);
  }
}

async function checkLiveProgressPolling() {
  let rendered = [];
  let stopped = 0;
  let finished = 0;
  let data = { ok: true, available: true, active: true, status: 'running', threadId: 'thread-1',
    preview: '公开的实时回复', steps: [{ kind: 'start', text: '已开始' }], durationMs: 700000 };
  const assistant = { bubble: {}, meta: {}, article: { classList: { remove() { finished++; } } } };
  const context = vm.createContext({
    goalEpoch: 0, resetGoalForThread() {},
    URLSearchParams, Date, document: { hidden: false }, token: 'fixture', pollGeneration: 1,
    selectedThreadId: 'thread-1', activeAssistant: assistant, activeWatch: { threadId: 'thread-1' },
    pollAttempts: 181, pollStatusBusy: false, apiPauseUntil: 0, lastPreview: '',
    pendingNewThread: null, queuedSends: [], lastStatusSignature: '',
    approvalResponseSequences: new WeakMap(), applyApprovalSnapshot() {},
    fetchApi: async () => ({ ok: true, json: async () => data }),
    updateContextFromStatus() {}, applyThreadRuntimeState() {}, renderThreadMenuIfVisualChanged() {},
    runtimeSnapshotFromStatusData: value => value, codexStatusSignature: () => 'signature',
    setActiveRunStart() {}, updateActiveRunDuration() {}, setTopStatus() {}, setMetaLabel() {},
    setNotice(message) { throw new Error(message); }, scrollBottom() {},
    renderProcessSteps(_bubble, steps) { rendered = steps; },
    stopPolling() { stopped++; }, setMarkdown() {}, addDetails() {}, serializeMessages() {}, promoteNextQueuedSendAfterCurrent() {},
    formatDuration: () => '12m', finalRunDurationMs: () => 700000,
  });
  vm.runInContext(['commandUi', 'stepMarkdown', 'runningProgressSteps', 'pollStatus'].map(uiFunction).join('\n'), context);
  await context.pollStatus(context.activeWatch);
  assert.strictEqual(context.activeAssistant, assistant, 'long-running tasks must remain attached past 180 polls');
  assert.strictEqual(stopped, 0, 'only an explicit terminal status stops polling');
  assert.strictEqual(finished, 0, 'elapsed time must never mark a task complete');
  assert(rendered.some(step => step.text === data.preview), 'live preview must render even with only a start step');

  assistant.commandKind = 'compact';
  data = { ...data, preview: '', steps: [{ kind: 'tool', text: '正在压缩上下文' }] };
  await context.pollStatus(context.activeWatch);
  assert(rendered.some(step => step.text === '正在压缩上下文'), 'command placeholders must not hide real progress');
  data = { ...data, steps: [{ id: 'tool-1', kind: 'tool', text: '读取文件', status: 'running' }] };
  await context.pollStatus(context.activeWatch);
  data = { ...data, steps: [{ id: 'tool-1', kind: 'tool', text: '读取文件', status: 'completed' }] };
  await context.pollStatus(context.activeWatch);
  assert.strictEqual(rendered[0].status, 'completed', 'a tool state change must render even when its label is unchanged');
  data = { ...data, steps: [{ id: 'tool-2', kind: 'tool', text: '读取文件', status: 'completed' }] };
  await context.pollStatus(context.activeWatch);
  assert.strictEqual(rendered[0].id, 'tool-2', 'successive tools with identical labels must not retain the previous tool');
  const normalized = context.runningProgressSteps({ preview: '公开进度', steps: [{ kind: 'assistant', text: '公开进度' }] });
  assert.strictEqual(normalized.length, 1, 'preview must not duplicate normalized assistant steps');
  assert(context.runningProgressSteps({ progressUnavailable: true }).some(step => step.kind === 'error'), 'progress read failures must be visible while polling continues');

  data = { ...data, status: 'waiting', active: false, observing: true, preview: '桌面端的新进度', steps: [] };
  await context.pollStatus(context.activeWatch);
  assert.strictEqual(stopped, 0, 'a desktop progress watch must remain attached without local active ownership');
  assert.strictEqual(assistant.observing, true);
  assert(rendered.some(step => step.text === '桌面端的新进度'));
  vm.runInContext(uiFunction('codexStatusSignature'), context);
  assert.notStrictEqual(context.codexStatusSignature({ available: true, ...data, progressVersion: 'first' }),
    context.codexStatusSignature({ available: true, ...data, progressVersion: 'second' }), 'new content must invalidate an unchanged metadata timestamp');

  data = { ...data, status: 'complete', active: false, final: '完成' };
  await context.pollStatus(context.activeWatch);
  assert.strictEqual(stopped, 1);
  assert.strictEqual(finished, 1);
  assert.strictEqual(context.activeAssistant, null);

  let resumedPolls = 0;
  context.clientReady = true;
  context.activeAssistant = assistant;
  context.appResumeRefreshTimer = null;
  context.pruneCompletedThreadNotices = context.refreshApiConfigIfNeeded = context.refreshThreadRuntimeStates = context.checkClientVersion = context.refreshCodexQuota = () => {};
  context.refreshCurrentThreadIfChanged = () => { throw new Error('active task must refresh its current watch'); };
  context.pollStatus = watch => { assert.strictEqual(watch, context.activeWatch); resumedPolls++; };
  context.window = { clearTimeout() {}, setTimeout(callback) { callback(); } };
  vm.runInContext(uiFunction('scheduleForegroundStateRefresh'), context);
  context.scheduleForegroundStateRefresh();
  assert.strictEqual(resumedPolls, 1, 'returning to the foreground immediately refreshes live progress');
}

async function checkHistoryPages() {
  const nodes = [];
  const requests = [];
  const replies = [];
  const snapshots = [];
  const thread = {
    scrollTop: 40,
    classList: { add() {}, remove() {} },
    get scrollHeight() { return nodes.length * 100; },
    querySelector() { return nodes[0] || null; },
  };
  const context = vm.createContext({
    goalEpoch: 0, resetGoalForThread() {},
    URLSearchParams, Set, token: 'fixture', apiBackend: 'app-server', selectedThreadId: 'one',
    HISTORY_PAGE_SIZE: 5, historyRequestId: 0, historyDisplayThreadId: '', historyDisplayLimit: 5,
    historyNextCursor: null, historyUsesCursor: false, historyMessageIds: new Set(), historyLoadPromise: null, historyLoadingThreadId: '',
    historyMoreButton: {}, thread, requestAnimationFrame: callback => callback(),
    approvalResponseSequences: new WeakMap(),
    fetchApi: async url => { requests.push(url); return new Promise(resolve => replies.push(resolve)); },
    messageEl: (role, text, options = {}) => {
      const article = { text, get isConnected() { return nodes.includes(this); },
        getBoundingClientRect() { return { top: nodes.indexOf(this) * 100 - thread.scrollTop }; },
        remove() { const index = nodes.indexOf(this); if (index >= 0) nodes.splice(index, 1); },
      };
      const before = options.before ? nodes.indexOf(options.before) : nodes.length;
      nodes.splice(before, 0, article);
      return { article };
    },
    clearThreadMessages() { nodes.length = 0; },
    restoreMessages() { throw new Error('existing messages must survive failed older reads'); },
    beginHistoryRenderAtBottom() {}, finishHistoryRenderAtBottom() {}, setNotice() {},
    resumeActiveThreadStatus: async (id, requestId, status) => { snapshots.push(status); return false; },
    loadQueue() { throw new Error('bootstrap already contains queue'); },
    loadApprovals() { throw new Error('bootstrap already contains approvals'); },
  });
  vm.runInContext(['loadThreadHistory', 'readThreadHistoryPage', 'loadThreadView'].map(uiFunction).join('\n'), context);
  const rows = (from, to) => Array.from({ length: to - from }, (_, i) => ({ id: `m-${from + i}`, role: 'user', text: `message-${from + i}` }));
  const reply = body => replies.shift()({ ok: body.ok !== false, json: async () => body });
  const first = context.loadThreadView('one');
  await flush();
  assert(requests[0].startsWith('/codex/thread-bootstrap?'));
  reply({ ok: true, status: { ok: true, status: 'complete' }, history: { ok: true, available: true, messages: rows(5, 10), nextCursor: 'older', truncated: true } });
  await first;
  const originals = [...nodes];
  const originalTop = originals[0].getBoundingClientRect().top;
  const more = context.loadThreadHistory('one', { more: true });
  const duplicate = context.loadThreadHistory('one', { more: true });
  await flush();
  assert.strictEqual(requests.length, 2, 'overlapping older-page reads must coalesce');
  const query = new URL(requests[1], 'http://fixture').searchParams;
  assert.strictEqual(query.get('limit'), '5');
  assert.strictEqual(query.get('cursor'), 'older');
  reply({ ok: true, available: true, messages: rows(0, 6), nextCursor: 'oldest', truncated: true });
  await Promise.all([more, duplicate]);
  assert.deepStrictEqual(nodes.slice(5), originals, 'older pages must preserve existing DOM nodes');
  assert.deepStrictEqual(nodes.map(node => node.text), rows(0, 10).map(row => row.text), 'boundary message must not duplicate');
  assert.strictEqual(originals[0].getBoundingClientRect().top, originalTop, 'prepend must preserve visible scroll anchor');
  assert.strictEqual(snapshots.length, 1, 'older pages must not re-read status or create a second active reply');
  const failed = context.loadThreadHistory('one', { more: true });
  await flush();
  reply({ ok: false, message: 'temporary failure' });
  await failed;
  assert.strictEqual(nodes.length, 10);
  assert.strictEqual(context.historyNextCursor, 'oldest', 'failed page must remain retryable');
  const expired = context.loadThreadHistory('one', { more: true });
  await flush();
  reply({ ok: false, code: 'HISTORY_CURSOR_EXPIRED' });
  await flush();
  assert(requests.at(-1).startsWith('/codex/thread-bootstrap?'));
  reply({ ok: true, status: { ok: true }, history: { ok: true, available: true, messages: rows(10, 15), nextCursor: null } });
  await expired;
  assert.deepStrictEqual(nodes.map(node => node.text), rows(10, 15).map(row => row.text));
  assert.strictEqual(context.historyMoreButton.hidden, true);
  const fallback = context.loadThreadView('one');
  await flush();
  reply({ ok: true, status: { ok: true }, history: { ok: true, available: true, messages: rows(5, 10), truncated: true, recoveredFromJsonl: true } });
  await fallback;
  const fallbackMore = context.loadThreadHistory('one', { more: true });
  await flush();
  const fallbackQuery = new URL(requests.at(-1), 'http://fixture').searchParams;
  assert.strictEqual(fallbackQuery.get('limit'), '10', 'JSONL recovery must keep its legacy older-history fallback');
  assert.strictEqual(fallbackQuery.has('cursor'), false);
  reply({ ok: true, available: true, messages: rows(0, 10), truncated: false, recoveredFromJsonl: true });
  await fallbackMore;
  assert.strictEqual(nodes.length, 10);
}

async function checkLateHistoryCannotEraseLiveReply(queued = false) {
  const nodes = [];
  const pendingReads = [];
  const context = vm.createContext({
    goalEpoch: 0, resetGoalForThread() {},
    URLSearchParams, Date, Math, Set,
    token: 'fixture', target: 'codex', apiBackend: 'app-server', selectedThreadId: 'one',
    pendingNewThread: null, pendingAttachments: [], activeAssistant: null, pollTimer: null, sendRequestBusy: false,
    HISTORY_PAGE_SIZE: 5, historyRequestId: 0, historyDisplayThreadId: '', historyDisplayLimit: 5,
    historyNextCursor: null, historyUsesCursor: false, historyMessageIds: new Set(),
    historyLoadPromise: null, historyLoadingThreadId: '', historyMoreButton: {},
    thread: { querySelector: () => nodes[0] || null }, sendButton: {}, releaseSessionButton: {},
    fetchApi: async url => {
      if (url === '/send') return { ok: true, json: async () => ({ ok: true, queued, watch: { threadId: 'one' } }) };
      return new Promise(resolve => pendingReads.push(resolve));
    },
    messageEl(role, text) {
      const article = { role, text, get isConnected() { return nodes.includes(this); },
        remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); } };
      nodes.push(article);
      return { article, bubble: {} };
    },
    clearThreadMessages() { nodes.length = 0; },
    beginHistoryRenderAtBottom() {}, finishHistoryRenderAtBottom() {}, restoreMessages() {},
    resumeActiveThreadStatus: async () => false,
    commandKindForText: () => '', commandUi: () => null,
    addQueuedSend: () => 'queued-1', updateQueuedSend() {}, loadQueue: async () => {},
    clearLocalStopSuppression() {}, setNotice() {}, setWorkingDot() {}, appendImagesToBubble() {},
    setActiveRunStart() {}, applyThreadRuntimeState() {}, renderThreadMenu() {}, updateComposerAction() {}, updateComposerButtons() {},
    ensureRouteForSend: async () => {}, startSendProgressPolling: () => () => {},
    serializeMessages() {}, restoreLayoutAfterKeyboard() {},
    scrollBottom(options) { assert.strictEqual(options.force, true, 'an explicit send returns to the latest messages'); },
    startPolling() { context.pollTimer = 1; },
  });
  vm.runInContext(['loadThreadHistory', 'readThreadHistoryPage', 'sendText'].map(uiFunction).join('\n'), context);
  if (queued) context.activeAssistant = context.messageEl('assistant', '当前回复');
  const history = context.loadThreadHistory('one');
  await flush();
  await context.sendText({ text: '新任务' });
  const currentReply = context.activeAssistant;
  assert(currentReply.article.isConnected);
  pendingReads.shift()({ ok: true, json: async () => ({ ok: true, status: { ok: true, status: 'complete' },
    history: { ok: true, available: true, messages: [{ id: 'old', role: 'assistant', text: '上一轮结果' }] } }) });
  await history;
  assert(currentReply.article.isConnected, 'a history response started before sending must not detach the live reply');
  if (!queued) assert(nodes.some(node => node.text === '新任务'), 'the newly submitted message must remain visible');
  assert.strictEqual(context.activeAssistant, currentReply, 'the live polling target must remain attached');
  assert(!nodes.some(node => node.text === '正在加载聊天记录…'), 'discarded history reads must remove their loading placeholder');
  assert.strictEqual(context.historyMoreButton.disabled, false, 'invalidating an older read must release the history button');
}

async function checkLateIdleRefreshCannotReplaceLiveReply() {
  let respond;
  let historyReads = 0;
  const context = vm.createContext({
    goalEpoch: 0, historyRequestId: 0, resetGoalForThread() {},
    URLSearchParams, Date, token: 'fixture', selectedThreadId: 'one', activeAssistant: null,
    clientReady: true, autoRefreshBusy: false, historyLoadPromise: null, document: { hidden: false },
    apiPauseUntil: 0, lastStatusSignature: 'old', pollTimer: null,
    fetchApi: async () => new Promise(resolve => { respond = resolve; }),
    updateContextFromStatus() {}, applyThreadRuntimeState() {}, renderThreadMenuIfVisualChanged() {},
    runtimeSnapshotFromStatusData: data => data, isLocalStopSuppressed: () => false,
    codexStatusSignature: () => 'new', isRunningStatus: data => data.active,
    setWorkingDot() {}, setNotice() {}, console,
    loadThreadHistory: async () => { historyReads++; },
  });
  vm.runInContext(uiFunction('refreshCurrentThreadIfChanged'), context);
  const refresh = context.refreshCurrentThreadIfChanged();
  await flush();
  context.activeAssistant = { article: {} };
  respond({ ok: true, json: async () => ({ ok: true, available: true, active: true }) });
  await refresh;
  assert.strictEqual(historyReads, 0, 'an idle status response must not start a history replacement after a live reply attaches');
}

async function checkManualSessionRelease() {
  let submitted = 0;
  let stopped = 0;
  let allowRelease = true;
  const reply = { article: { classList: { remove() {} } }, meta: {} };
  const context = vm.createContext({
    releaseSessionButton: { disabled: false, textContent: '' }, token: 'fixture', selectedThreadId: 'one',
    activeAssistant: reply, historyRequestId: 0,
    fetchApi: async (url, options) => {
      assert.strictEqual(url, '/codex/release');
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.retryRoute, false, 'handoff must never be replayed against a newly acquired session');
      submitted++;
      await flush();
      return { ok: allowRelease, json: async () => ({ ok: allowRelease, threadId: 'one', message: 'fixture' }) };
    },
    setNotice() {}, setMetaLabel() {}, updateComposerAction() {}, loadThreadView: async () => {}, loadQueue: async () => {},
    stopPolling() { stopped++; },
  });
  vm.runInContext(uiFunction('releaseCodexSession'), context);
  const first = context.releaseCodexSession();
  await context.releaseCodexSession();
  await first;
  assert.strictEqual(submitted, 1, 'double taps must submit only one handoff');
  assert.strictEqual(stopped, 1);
  assert.strictEqual(context.activeAssistant, null);
  assert.strictEqual(context.releaseSessionButton.disabled, false);
  context.activeAssistant = reply;
  allowRelease = false;
  await context.releaseCodexSession();
  assert.strictEqual(context.activeAssistant, reply, 'a failed handoff must not pretend the active session was released');
  assert.strictEqual(stopped, 1);

  let routeProbes = 0;
  context.apiUrl = path => path;
  context.fetchWithTimeout = async () => { throw new Error('response lost'); };
  context.chooseApiCandidate = async () => { routeProbes++; };
  vm.runInContext(uiFunction('fetchApi'), context);
  await assert.rejects(context.fetchApi('/codex/release', { method: 'POST', retryRoute: false }), /response lost/);
  assert.strictEqual(routeProbes, 0, 'handoff network errors must remain uncertain instead of replaying the write');
}

(async () => {
  await checkReadLimitsAndBackoff();
  await checkSendProgressPolling();
  await checkDeviceBinding();
  await checkPolling();
  await checkLiveProgressPolling();
  await checkThreadPages();
  checkMenuPagingFocusAndScroll();
  checkSectionToggleDoesNotCloseMenu();
  await checkHistoryPages();
  await checkLateHistoryCannotEraseLiveReply();
  await checkLateHistoryCannotEraseLiveReply(true);
  await checkLateIdleRefreshCannotReplaceLiveReply();
  await checkManualSessionRelease();
  console.log('Web request scheduling and pagination tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
