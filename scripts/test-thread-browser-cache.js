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
const pageState = () => ({ loaded: false, moreLoaded: false, nextCursor: null, request: null, at: 0 });
const row = (id, project = false) => ({ id, name: `Task ${id}`, isProjectThread: project,
  projectKey: project ? 'c:\\projects\\sample' : '__conversations__', projectName: project ? 'Sample' : '对话',
  cwd: project ? 'C:\\Projects\\Sample' : '', projectPath: project ? 'C:\\Projects\\Sample' : '',
  runtimeStatus: 'running', runtimeActive: true, runtimeTurnId: 'old-turn', preview: 'not cached', children: [] });

function cacheContext(storage = new Map()) {
  const context = vm.createContext({
    Date, Map, Set, URLSearchParams, currentApiBase: 'https://fixture/codex', publicRelayPage: true, logoutBusy: false,
    threadBrowserCacheKey: 'codexMini.threadBrowser.v1:https://fixture/codex:device-a',
    knownThreads: [row('project-1', true), row('old-conversation')],
    threadPages: { projects: { ...pageState(), loaded: true, nextCursor: 'project-cursor' },
      conversations: { ...pageState(), loaded: true, moreLoaded: true, nextCursor: 'conversation-cursor' } },
    threadMenuView: 'conversations', selectedProjectKey: 'c:\\projects\\sample',
    openProjectKeys: new Set(['c:\\projects\\sample']), expandedProjectThreadKeys: new Set(['c:\\projects\\sample']),
    threadSectionScroll: { 'conversations:conversations': 340, 'split:projects': 125 },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    refreshRelayStatus: async () => ({ ok: true, deviceId: 'device-a' }), updateThreadTitle() {}, renderThreadMenu() {},
    restoreOptionCache() {}, readOpenProjectKeys: () => new Set(), readExpandedProjectThreadKeys: () => new Set(), readCompletedThreadIds: () => new Set(),
    renderThreadMenuIfVisualChanged() {}, THREAD_PAGE_SIZE: 10, token: 'fixture',
  });
  context.flattenKnownThreads = (items = context.knownThreads) => items.flatMap(item => [item, ...context.flattenKnownThreads(item.children || [])]);
  vm.runInContext(['threadBrowserMetadata', 'persistThreadBrowserCache', 'restoreThreadBrowserCache',
    'initializeThreadBrowserCache', 'loadThreadPage'].map(uiFunction).join('\n'), context);
  return context;
}

async function checkCache() {
  const storage = new Map();
  const saved = cacheContext(storage);
  saved.knownThreads[0].children.push(row('child', true));
  saved.persistThreadBrowserCache();
  const serialized = storage.get(saved.threadBrowserCacheKey);
  for (const staleField of ['runtimeStatus', 'runtimeActive', 'runtimeTurnId', 'preview', 'request']) {
    assert(!serialized.includes(`"${staleField}"`), `${staleField} must not become stale UI state after reload`);
  }
  const restored = cacheContext(storage);
  restored.knownThreads = [];
  restored.threadMenuView = 'split';
  restored.threadSectionScroll = {};
  restored.openProjectKeys.clear();
  assert(restored.restoreThreadBrowserCache());
  assert.strictEqual(restored.knownThreads.length, 2);
  assert.strictEqual(restored.knownThreads[0].children[0].id, 'child');
  assert.strictEqual(restored.threadPages.projects.nextCursor, 'project-cursor');
  assert.strictEqual(restored.threadPages.projects.at, 0, 'cached lists must still refresh their latest page');
  assert.strictEqual(restored.threadPages.projects.moreLoaded, true, 'head refresh must retain cached older folders and conversations');
  assert.strictEqual(restored.threadMenuView, 'conversations');
  assert.strictEqual(restored.threadSectionScroll['conversations:conversations'], 340);
  assert(restored.openProjectKeys.has('c:\\projects\\sample'));

  const requests = [];
  restored.fetchApi = async url => {
    requests.push(new URL(url, 'https://fixture'));
    return { ok: true, json: async () => ({ ok: true, scope: 'conversations', threads: [row('new-conversation')], nextCursor: 'head-cursor' }) };
  };
  await restored.loadThreadPage('conversations');
  assert(restored.knownThreads.some(item => item.id === 'old-conversation'));
  assert(restored.knownThreads.some(item => item.id === 'new-conversation'));
  assert.strictEqual(restored.threadPages.conversations.nextCursor, 'head-cursor', 'a gap of newly created threads must not be skipped');
  assert.strictEqual(restored.threadPages.conversations.resumeCursor, 'conversation-cursor');
  restored.fetchApi = async () => ({ ok: true, json: async () => ({ ok: true, scope: 'conversations',
    threads: [row('gap-conversation'), row('old-conversation')], nextCursor: 'overlap-cursor' }) });
  await restored.loadThreadPage('conversations', { more: true });
  assert.strictEqual(restored.threadPages.conversations.nextCursor, 'conversation-cursor', 'after reaching cached history resume the old continuation');
  assert.strictEqual(restored.threadPages.conversations.resumeCursor, undefined);
  restored.fetchApi = async url => {
    const parsed = new URL(url, 'https://fixture');
    requests.push(parsed);
    return parsed.searchParams.has('cursor')
      ? { ok: false, status: 410, json: async () => ({ ok: false, message: 'cursor expired' }) }
      : { ok: true, json: async () => ({ ok: true, scope: 'conversations', threads: [row('new-conversation')], nextCursor: 'restarted-cursor' }) };
  };
  await restored.loadThreadPage('conversations', { more: true });
  assert.strictEqual(requests.length, 3, 'expired continuation gets exactly one head restart');
  assert.strictEqual(restored.threadPages.conversations.nextCursor, 'restarted-cursor');
  assert(restored.knownThreads.some(item => item.id === 'old-conversation'), 'cursor restart must preserve usable cached records');

  const otherDevice = cacheContext(storage);
  otherDevice.knownThreads = [];
  otherDevice.refreshRelayStatus = async () => ({ ok: true, deviceId: 'device-b' });
  await otherDevice.initializeThreadBrowserCache();
  assert.strictEqual(otherDevice.knownThreads.length, 0, 'same relay origin must not restore another device cache');
  const unauthenticated = cacheContext(storage);
  unauthenticated.knownThreads = [];
  unauthenticated.threadBrowserCacheKey = '';
  unauthenticated.refreshRelayStatus = async () => ({ ok: false });
  await assert.rejects(unauthenticated.initializeThreadBrowserCache(), /尚未确认当前设备/);
  assert.strictEqual(unauthenticated.knownThreads.length, 0);
  assert.strictEqual(unauthenticated.threadBrowserCacheKey, '');
  const loggingOut = cacheContext(storage);
  loggingOut.threadBrowserCacheKey = '';
  let finishStatus;
  loggingOut.refreshRelayStatus = () => new Promise(resolve => { finishStatus = resolve; });
  const initializing = loggingOut.initializeThreadBrowserCache();
  loggingOut.logoutBusy = true;
  finishStatus({ ok: true, deviceId: 'device-a' });
  await assert.rejects(initializing, /尚未确认当前设备/);
  assert.strictEqual(loggingOut.threadBrowserCacheKey, '', 'a late device check cannot re-enable caching after logout');
  const old = JSON.parse(serialized);
  old.at = Date.now() - 8 * 86400000;
  storage.set(saved.threadBrowserCacheKey, JSON.stringify(old));
  assert.strictEqual(saved.restoreThreadBrowserCache(), false, 'expired snapshots are ignored');
  storage.set(saved.threadBrowserCacheKey, '{broken');
  assert.strictEqual(saved.restoreThreadBrowserCache(), false);
  saved.localStorage.setItem = () => { throw new Error('quota full'); };
  assert.doesNotThrow(() => saved.persistThreadBrowserCache());

  const pendingHead = cacheContext();
  const pendingCalls = [];
  let finishHead;
  pendingHead.fetchApi = url => {
    const parsed = new URL(url, 'https://fixture');
    pendingCalls.push(parsed);
    if (!parsed.searchParams.has('cursor')) return new Promise(resolve => { finishHead = resolve; });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, scope: 'conversations', threads: [row('older')], nextCursor: null }) });
  };
  const head = pendingHead.loadThreadPage('conversations');
  const more = pendingHead.loadThreadPage('conversations', { more: true });
  finishHead({ ok: true, json: async () => ({ ok: true, scope: 'conversations', threads: [row('old-conversation')], nextCursor: 'head-cursor' }) });
  await Promise.all([head, more]);
  assert.strictEqual(pendingCalls.length, 2, 'load-more during a head refresh must still read the continuation afterwards');
  assert.strictEqual(pendingCalls[1].searchParams.get('cursor'), 'conversation-cursor');
  assert(pendingHead.knownThreads.some(item => item.id === 'older'));

  const failedMore = cacheContext();
  failedMore.fetchApi = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, message: 'older page unavailable' }) });
  await assert.rejects(failedMore.loadThreadPage('conversations', { more: true }), /older page unavailable/);
  failedMore.fetchApi = async () => ({ ok: true, json: async () => ({ ok: true, scope: 'conversations', threads: [row('old-conversation')], nextCursor: 'head-cursor' }) });
  await failedMore.loadThreadPage('conversations');
  assert.strictEqual(failedMore.threadPages.conversations.error, 'older page unavailable', 'an unrelated successful head refresh cannot erase the retry state');
  failedMore.fetchApi = async () => ({ ok: true, json: async () => ({ ok: true, scope: 'conversations', threads: [], nextCursor: null }) });
  await failedMore.loadThreadPage('conversations');
  assert.strictEqual(failedMore.knownThreads.filter(item => !item.isProjectThread).length, 0, 'an authoritative complete empty list must remove archived/deleted cached entries');
  assert.strictEqual(failedMore.knownThreads.filter(item => item.isProjectThread).length, 1, 'a complete category refresh cannot erase the other category');
  assert.strictEqual(failedMore.threadPages.conversations.error, '');
}

function fillContext() {
  const bodies = {
    projects: { hidden: true, clientHeight: 0, scrollHeight: 180, scrollTop: 0 },
    conversations: { hidden: false, clientHeight: 480, scrollHeight: 176, scrollTop: 0 },
  };
  const requests = [];
  const context = vm.createContext({
    Date, Set, clientReady: true, apiPauseUntil: 0, threadSearchQuery: '', threadFillPromise: null,
    window: { setTimeout: callback => { callback(); return 1; } },
    threadAutoFillPaused: new Set(),
    threadPages: { projects: { ...pageState(), loaded: true, nextCursor: 'p1' },
      conversations: { ...pageState(), loaded: true, nextCursor: 'c1' } },
    document: { hidden: false, getElementById: id => bodies[id.replace('thread-section-', '')] },
    loadThreads: async ({ scope }) => {
      requests.push(scope);
      bodies[scope].scrollHeight += 220;
      context.threadPages[scope].nextCursor += 'n';
    },
  });
  vm.runInContext(['threadSectionNeedsMore', 'fillThreadMenu'].map(uiFunction).join('\n'), context);
  return { context, bodies, requests };
}

async function checkFill() {
  const { context, bodies, requests } = fillContext();
  await Promise.all([context.fillThreadMenu(), context.fillThreadMenu()]);
  assert.deepStrictEqual(requests, ['conversations', 'conversations'], 'fill a tall category once without reading its collapsed sibling');
  await context.fillThreadMenu();
  assert.strictEqual(requests.length, 2, 'filled views must not fetch the whole account');
  bodies.conversations.scrollTop = 200;
  await context.fillThreadMenu();
  assert.strictEqual(requests.length, 3, 'scrolling near the bottom should continue the same category');
  for (const block of ['hidden', 'search', 'closed', 'cooldown']) {
    bodies.conversations.scrollHeight = 200;
    bodies.conversations.scrollTop = 0;
    context.document.hidden = block === 'hidden';
    context.threadSearchQuery = block === 'search' ? 'query' : '';
    bodies.conversations.clientHeight = block === 'closed' ? 0 : 480;
    context.apiPauseUntil = block === 'cooldown' ? Date.now() + 60000 : 0;
    await context.fillThreadMenu();
    assert.strictEqual(requests.length, 3, `${block} must stop automatic loading`);
  }
  const sparse = fillContext();
  let scans = 0;
  sparse.context.loadThreads = async ({ scope }) => { scans++; sparse.context.threadPages[scope].nextCursor += 'n'; };
  await sparse.context.fillThreadMenu();
  await sparse.context.fillThreadMenu();
  assert.strictEqual(scans, 10, 'empty advancing pages have a finite automatic scan budget');
  assert(sparse.context.threadAutoFillPaused.has('conversations'));
  const failed = fillContext();
  let attempts = 0;
  failed.context.loadThreads = async () => { attempts++; throw new Error('offline'); };
  await failed.context.fillThreadMenu();
  await failed.context.fillThreadMenu();
  assert.strictEqual(attempts, 2, 'one delayed retry is allowed; repeated failures then wait for explicit retry');
  const transient = fillContext();
  let retries = 0;
  transient.context.loadThreads = async () => {
    if (++retries === 1) throw new Error('one slow native read');
    transient.bodies.conversations.scrollHeight = 900;
    transient.context.threadPages.conversations.nextCursor = 'advanced';
  };
  await transient.context.fillThreadMenu();
  assert.strictEqual(retries, 2);
  assert(!transient.context.threadAutoFillPaused.has('conversations'), 'a transient failure must recover automatically');
  const stalled = fillContext();
  let repeatedCursor = 0;
  stalled.context.loadThreads = async () => { repeatedCursor++; };
  await stalled.context.fillThreadMenu();
  assert.strictEqual(repeatedCursor, 1, 'a repeated cursor must never form an automatic request loop');
}

(async () => {
  await checkCache();
  await checkFill();
  console.log('Thread browser cache and automatic paging passed: restore, device isolation, metadata freshness, cursor recovery, viewport fill and bounded retries.');
})().catch(error => { console.error(error); process.exitCode = 1; });
