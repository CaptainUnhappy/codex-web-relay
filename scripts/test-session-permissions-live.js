'use strict';

// Native protocol verification in a disposable Codex home. No account or model turn is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CodexAppServerBackend } = require('../lib/codex-app-server-backend');
const command = path.resolve(process.argv[2] || '.runtime/codex-cli-bin/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const root = path.resolve(__dirname, '../output');
fs.mkdirSync(root, { recursive: true });
const home = fs.mkdtempSync(path.join(root, 'permission-native-test-'));
const makeBackend = () => new CodexAppServerBackend({ resolveCli: async () => ({ available: true, command }),
  spawnCli: (cmd, args, options) => ({ child: spawn(cmd, args, { ...options, windowsHide: true, env: { ...process.env, CODEX_HOME: home } }) }) });
let b = makeBackend();
(async () => {
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), 'approval_policy = "on-request"\napprovals_reviewer = "user"\nsandbox_mode = "read-only"\n');
    const created = await b.request('thread/start', { cwd: home, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
    const id = created.thread.id;
    await b.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Permission settings fixture. Do not run a model turn.' }] }] });
    const observer = makeBackend();
    let crossInstanceUpdate;
    try {
      await observer.updateThreadSettings(id, { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', permissions: ':workspace' });
      crossInstanceUpdate = 'accepted';
    } catch (error) { crossInstanceUpdate = { code: error.code, message: error.message }; }
    finally { await observer.close(); }
    console.log('cross-instance settings:', JSON.stringify(crossInstanceUpdate));
    const results = [];
    for (const mode of ['ask', 'auto', 'full', 'custom']) {
      const applied = await b.changePermissions(id, mode);
      const readback = await b.request('thread/resume', { threadId: id, excludeTurns: true });
      assert.equal(readback.approvalPolicy, applied.approvalPolicy);
      assert(['auto_review', 'guardian_subagent'].includes(applied.approvalsReviewer)
        ? ['auto_review', 'guardian_subagent'].includes(readback.approvalsReviewer)
        : readback.approvalsReviewer === applied.approvalsReviewer);
      const expected = { ask: 'workspaceWrite', auto: 'workspaceWrite', full: 'dangerFullAccess', custom: 'readOnly' }[mode];
      assert.equal(readback.sandbox.type, expected);
      results.push({ mode, approvalPolicy: readback.approvalPolicy, approvalsReviewer: readback.approvalsReviewer, sandbox: readback.sandbox.type });
    }
    await b.changePermissions(id, 'auto');
    await b.close(); b = makeBackend();
    const recovered = await b.request('thread/resume', { threadId: id, excludeTurns: true });
    assert.equal(recovered.approvalsReviewer, 'auto_review', 'native permission selection survives process release');
    assert.equal(recovered.sandbox.type, 'workspaceWrite');
    const saved = fs.readFileSync(recovered.thread.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const snapshot = require('../lib/codex-permissions').permissionsFromEvents(saved, id);
    assert.equal(snapshot?.mode, 'auto', 'read-only permission snapshot must survive restart');
    console.log(JSON.stringify({ isolatedCodexHome: true, modelTurns: 0, globalConfigChanged: false, survivesRelease: true, results }, null, 2));
  } finally {
    await b.close();
    assert(path.dirname(home) === root && path.basename(home).startsWith('permission-native-test-'));
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
