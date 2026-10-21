'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { writeJsonAtomically } = require('../lib/atomic-state');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mini-atomic-state-'));
const stateFile = path.join(directory, 'state.json');
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
try {
  writeJsonAtomically(stateFile, { counter: 1 });
  for (let counter = 2; counter <= 8; counter++) {
    writeJsonAtomically(stateFile, { counter });
    assert.strictEqual(read().counter, counter, 'repeated replacements must persist');
  }
  for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const original = fs[operation];
    try {
      fs[operation] = () => { throw Object.assign(new Error(`injected ${operation} failure`), { code: 'EPERM' }); };
      assert.throws(() => writeJsonAtomically(stateFile, { counter: 9 }), /injected/);
    } finally { fs[operation] = original; }
    assert.strictEqual(read().counter, 8, `${operation} failure must preserve the previous state`);
    assert.deepStrictEqual(fs.readdirSync(directory), ['state.json'], 'failed writes must clean up their temporary file');
  }
  writeJsonAtomically(stateFile, { counter: 10 });
  assert.strictEqual(read().counter, 10, 'writes recover after an error');

  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function writeCodexMiniState(');
  const end = source.indexOf('\nfunction ', start + 1);
  let invalidations = 0;
  const context = vm.createContext({
    fs, STATE_DIR: directory, STATE_FILE: stateFile, writeJsonAtomically,
    isCodexThreadId: value => value === 'thread-1',
    normalizeGuiFailureReports: value => value || {}, normalizePendingDesktopThreadSyncs: value => value || {},
    normalizeAppServerThreads: value => value || {}, invalidateCodexThreadListCache: () => invalidations++,
  });
  vm.runInContext(source.slice(start, end), context);
  context.writeCodexMiniState({ pinnedThreadIds: ['thread-1', 'thread-1', 'invalid'], waitingWriterThreadIds: ['thread-1'], desktopHandoffThreadIds: ['thread-1', 'thread-1', 'invalid'], sessionIdleSeconds: 0, titleOverrides: { 'thread-1': '测试任务' } });
  assert.deepStrictEqual(read().pinnedThreadIds, ['thread-1']);
  assert.deepStrictEqual(read().waitingWriterThreadIds, ['thread-1']);
  assert.deepStrictEqual(read().desktopHandoffThreadIds, ['thread-1'], 'manual handoff intent must survive normalized state writes');
  assert.strictEqual(read().sessionIdleSeconds, 0, 'immediate idle release must survive normalized state writes');
  assert.strictEqual(read().titleOverrides['thread-1'], '测试任务');
  assert.strictEqual(invalidations, 1);
  context.writeJsonAtomically = () => { throw new Error('persist failed'); };
  assert.throws(() => context.writeCodexMiniState({}), /persist failed/);
  assert.strictEqual(invalidations, 1, 'failed persistence must not invalidate as if it succeeded');
  assert.deepStrictEqual(read().waitingWriterThreadIds, ['thread-1']);
  console.log('Atomic state passed: repeated saves, failure preservation, temporary cleanup and normalized server state.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
