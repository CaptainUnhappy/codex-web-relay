'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function getJson(url, token, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'x-mobile-typer-token': token } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${body.slice(0, 400)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out requesting ${url}`));
    });
  });
}

async function waitForPort(port) {
  const deadline = Date.now() + 8000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
        socket.setTimeout(500, () => {
          socket.destroy(new Error('Timed out waiting for server port.'));
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError || new Error('Relay port did not open.');
}

async function waitForRelayStatus(port, token) {
  const deadline = Date.now() + 8000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${port}/codex/relay-status?token=${encodeURIComponent(token)}`, token);
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw lastError || new Error('Relay did not start.');
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mini-sync-e2e-'));
  const stateDir = path.join(tmp, 'state');
  const sessionsDir = path.join(tmp, 'sessions');
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  const threadId = '019e2a2f-0f46-7760-a1b5-bcc953a94d24';
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify({
    pendingDesktopThreadSyncs: {
      [threadId]: {
        threadId,
        cwd,
        scope: 'conversation',
        source: 'codex-app-server-locked',
        status: 'pending',
        createdAt: now,
        lastAttemptAt: now,
        attemptCount: 0,
        lastError: '',
      },
    },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(sessionsDir, `${threadId}.jsonl`), [
    { timestamp: now, type: 'session_meta', payload: { id: threadId, cwd } },
    { timestamp: now, type: 'event_msg', payload: { type: 'user_message', message: 'e2e user message' } },
    { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'e2e assistant message' }] } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');

  const port = await freePort();
  const token = 'desktop-sync-e2e-token';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MOBILE_TYPER_TOKEN: token,
      CODEX_MINI_AUTO_KEEP_AWAKE: '0',
      CODEX_MINI_RELAY_URL: '',
      CODEX_MINI_RELAY_SECRET: '',
      CODEX_MINI_RELAY_DEVICE_ID: '',
      CODEX_MINI_CODEX_BACKEND: 'legacy_gui',
      CODEX_MINI_STATE_DIR: stateDir,
      CODEX_MINI_CODEX_SESSIONS_DIR: sessionsDir,
      CODEX_MINI_TEST_SKIP_CODEX_APP_ACTIONS: '1',
      CODEX_MINI_TEST_DESKTOP_PROMPT_RESPONSE: 'yes',
      CODEX_MINI_TEST_DESKTOP_PROMPT_DELAY_MS: '1800',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await waitForPort(port);
    const statusStart = Date.now();
    const firstStatus = await getJson(`http://127.0.0.1:${port}/codex/relay-status?token=${encodeURIComponent(token)}`, token, 1500);
    const statusElapsed = Date.now() - statusStart;
    if (!firstStatus.json.ok) throw new Error(`Relay status failed: ${JSON.stringify(firstStatus.json)}`);
    if (statusElapsed > 1400) {
      throw new Error(`relay-status was blocked by the desktop restart prompt for ${statusElapsed}ms.`);
    }
    await waitForRelayStatus(port, token);
    const deadline = Date.now() + 8000;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await getJson(`http://127.0.0.1:${port}/codex/relay-status?token=${encodeURIComponent(token)}`, token);
      const data = latest.json;
      if (data.ok && data.pendingDesktopThreadSyncCount === 0 && data.lastDesktopThreadSyncStatus?.status === 'synced') {
        if (data.lastDesktopThreadSyncStatus.threadId !== threadId) throw new Error('Synced wrong thread id.');
        return;
      }
      await delay(250);
    }
    throw new Error(`Expected pending desktop sync to complete after desktop restart confirmation. Last status: ${JSON.stringify(latest && latest.json)}\nServer output:\n${output}`);
  } finally {
    child.kill('SIGTERM');
    await delay(200);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
