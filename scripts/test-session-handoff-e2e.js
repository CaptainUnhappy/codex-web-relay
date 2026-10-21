'use strict';

// Opt-in native protocol check. No user Codex state, login, or model API is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { CodexAppServerBackend } = require('../lib/codex-app-server-backend');

async function main() {
  const command = process.argv[2] || process.env.CODEX_MINI_SESSION_TEST_CLI;
  assert(command && fs.existsSync(command), 'Pass the official Codex CLI path as the first argument.');
  // Exercise the production launcher too, including Windows npm .cmd wrappers.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const launcher = vm.createContext({ fs, os, path, crypto, spawn, process, IS_WINDOWS: process.platform === 'win32' });
  vm.runInContext([
    source.slice(source.indexOf('function spawnCodexCliProcess('), source.indexOf('function getCodexAppServerBackend(')),
    source.slice(source.indexOf('function powerShellSingleQuote('), source.indexOf('async function runWindowsPowerShell(')),
  ].join('\n'), launcher);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mini-handoff-test-'));
  const sockets = new Set();
  let requestSeen;
  const providerCalled = new Promise(resolve => { requestSeen = resolve; });
  const provider = http.createServer((_req, _res) => { requestSeen(); }); // Deliberately keep the test turn active.
  provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(directory, 'config.toml'), `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const makeBackend = clientName => new CodexAppServerBackend({
    clientName, requestTimeoutMs: 15000, shutdownTimeoutMs: 10000,
    resolveCli: async () => ({ available: true, command }),
    spawnCli: (file, args) => launcher.spawnCodexCliProcess(file, args, {
      env: { ...process.env, CODEX_HOME: directory }, cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }),
  });
  const mini = makeBackend('mini-handoff-fixture');
  const app = makeBackend('app-handoff-fixture');
  try {
    const thread = await mini.createThread({ projectPath: directory, model: 'fixture' });
    await mini.request('thread/inject_items', { threadId: thread.id,
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Isolated writer-lock fixture.' }] }],
    });
    await assert.rejects(app.ensureThreadLoaded(thread.id), error => error.code === 'THREAD_WRITER_BUSY');
    await mini.request('thread/unsubscribe', { threadId: thread.id });
    await assert.rejects(app.ensureThreadLoaded(thread.id), error => error.code === 'THREAD_WRITER_BUSY');
    console.log('PASS: native writer contention reproduced; unsubscribe does not release it.');
    // Restore notifications, then exercise handoff while the local fake provider is busy.
    await mini.request('thread/resume', { threadId: thread.id, excludeTurns: true });
    await mini.send({ threadId: thread.id, text: 'Wait for the isolated local test provider.' });
    let timeout;
    try {
      await Promise.race([providerCalled, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('local fixture provider was not reached')), 10000); })]);
    } finally { clearTimeout(timeout); }
    mini.setIdleReleaseSeconds(0);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(mini.connectionStatus().ownedThreadId, thread.id);
    console.log('PASS: immediate idle release does not interrupt a running native turn.');
    await mini.releaseSession();
    await app.ensureThreadLoaded(thread.id);
    console.log('PASS: manual release closes an active Mini session; another native client immediately resumes it.');
    await mini.readThread(thread.id, false);
    assert.equal(mini.connectionStatus().ownedThreadId, '');
    assert.deepEqual((await mini.request('thread/loaded/list', {}, { mutating: false })).data, []);
    console.log('PASS: reading the handed-off thread does not reacquire its writer.');
    await app.releaseSession();
    mini.setIdleReleaseSeconds(60);
    await mini.ensureThreadLoaded(thread.id);
    mini.setIdleReleaseSeconds(0);
    const releaseDeadline = Date.now() + 15000;
    while (mini.connectionStatus().ownedThreadId && Date.now() < releaseDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(mini.connectionStatus().ownedThreadId, '', JSON.stringify({ connection: mini.connectionStatus(), runtime: mini.threadRuntime.get(thread.id) }));
    assert.equal(mini.connectionStatus().lastReleaseReason, 'idle');
    await app.ensureThreadLoaded(thread.id);
    console.log('PASS: automatic idle release lets another native client resume the same thread.');
    mini.setIdleReleaseSeconds(60);
    const fresh = await mini.createThread({ projectPath: directory, model: 'fixture' });
    await mini.send({ threadId: fresh.id, text: 'Check progress before the new rollout is flushed.' });
    assert.equal((await mini.status(fresh.id)).active, true);
    await mini.releaseSession();
    console.log('PASS: a fresh native turn exposes progress before its first persisted snapshot.');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => provider.close(resolve));
    await Promise.all([mini.close(), app.close()]);
    // This directory was created by this test, and contains no user state.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
