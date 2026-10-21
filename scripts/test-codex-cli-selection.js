'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the real resolver without starting the HTTP server or a Codex process.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const resolver = source.slice(source.indexOf('function codexCliCandidatePaths()'), source.indexOf('function codexCliSetupMessage()'));
const root = 'C:\\mini';
const portable = path.win32.join(root, '.runtime', 'codex-cli-bin', 'node_modules', '.bin', 'codex.cmd');
const legacy = 'C:\\profile\\AppData\\Roaming\\npm\\codex.cmd';

function harness(configured = '', available = {}) {
  const calls = [];
  const context = {
    IS_WINDOWS: true, IS_MAC: false, __dirname: root,
    process: { env: { APPDATA: 'C:\\profile\\AppData\\Roaming', USERPROFILE: 'C:\\profile', CODEX_MINI_CODEX_CLI: configured } },
    path: path.win32,
    fs: { existsSync: command => Object.hasOwn(available, command) },
    runCodexCliWithTimeout: async command => {
      calls.push(command);
      if (!available[command]) throw new Error('missing or unusable CLI');
      return { stdout: available[command], stderr: '' };
    },
  };
  vm.createContext(context);
  vm.runInContext(resolver, context);
  return { context, calls };
}

async function main() {
  const pinned = harness('C:\\selected\\codex.exe', { 'C:\\selected\\codex.exe': 'codex-cli 0.159.0', [legacy]: 'codex-cli 0.149.0' });
  assert.strictEqual((await pinned.context.findCodexCli()).command, 'C:\\selected\\codex.exe');
  assert.strictEqual(pinned.calls.length, 1, 'the checked CLI must be used without probing another installation');

  const broken = harness('C:\\missing\\codex.exe', { [legacy]: 'codex-cli 0.149.0' });
  const unavailable = await broken.context.findCodexCli();
  assert.strictEqual(unavailable.available, false, 'an invalid explicit CLI must not silently fall back to an old npm CLI');
  assert(unavailable.errors.length, 'an invalid explicit CLI needs an actionable error');
  const unusable = harness('C:\\broken\\codex.exe', { 'C:\\broken\\codex.exe': '', [legacy]: 'codex-cli 0.149.0' });
  assert.strictEqual((await unusable.context.findCodexCli()).available, false, 'a failed explicit CLI must not fall back');
  assert.strictEqual(unusable.calls.length, 1);

  const local = harness('', { [portable]: 'codex-cli 0.159.0', [path.win32.join(root, '.runtime', 'codex-cli-bin', 'codex.exe')]: 'codex-cli 0.148.0', 'codex.exe': 'codex-cli 0.154.0', [legacy]: 'codex-cli 0.149.0' });
  assert.strictEqual((await local.context.findCodexCli()).command, portable, 'the project runtime upgrade must take precedence');

  const system = harness('', { 'codex.exe': 'codex-cli 0.154.0', [legacy]: 'codex-cli 0.149.0' });
  assert.strictEqual((await system.context.findCodexCli()).command, 'codex.exe', 'PATH must be checked before the stale fixed npm path');

  const health = {
    USE_CODEX_APP_SERVER: true, IS_WINDOWS: true,
    isAuthorized: () => true,
    json: (_res, status, data) => ({ status, data }),
    relayStatusPayload: () => ({ ok: true, connected: true }),
    getCodexAppServerBackend: () => ({ connectionStatus: () => ({ connected: true }) }),
    windowsAssertInteractiveDesktop: () => { throw new Error('App Server status must not inspect or control the desktop'); },
  };
  vm.createContext(health);
  vm.runInContext(source.slice(source.indexOf('async function handleRelayStatus('), source.indexOf('function clearRelayHeartbeat(')), health);
  const state = await health.handleRelayStatus({}, {});
  assert.strictEqual(state.status, 200);
  assert.strictEqual(state.data.backend, 'app-server');
  assert.strictEqual(state.data.appServer.connected, true);
  console.log('Codex CLI selection regression test passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
