'use strict';

// Isolated relay + synthetic desktops. Never reads the user's device registry.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const { hmac, hashPassphrase } = require('../relay-server/lib/crypto');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-device-switch-'));
const port = Number(process.argv[2] || 19088), controlPort = Number(process.argv[3] || port + 1);
const devices = ['a', 'b'].map(letter => ({ deviceId: `fixture-${letter}`, name: `Device ${letter.toUpperCase()}`,
  relaySecret: `fixture-secret-${letter}`, passphraseHash: hashPassphrase(`fixture-key-${letter}`), approved: true }));
fs.writeFileSync(path.join(directory, 'devices.json'), JSON.stringify({ devices }));
const requests = [], sockets = new Map(), delayed = [];
let delayA = false;
const ids = { a: ['01a14dcb-3bf7-7c60-9e10-ebb350f80a21', '01a14dcb-3bf7-7c60-9e10-ebb350f80a22'], b: ['01a14dcb-3bf7-7c60-9e10-ebb350f80b21'] };
const child = spawn(process.execPath, [path.join(root, 'relay-server/server.js')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CODEX_MINI_RELAY_DEVICES: path.join(directory, 'devices.json'),
    ADMIN_PASSWORD: '', CODEX_MINI_RELAY_ADMIN_PASSWORD: '', CODEX_MINI_RELAY_ADMIN_TOKEN: '', ADMIN_TOKEN: '', CODEX_MINI_RELAY_REGISTRATION_KEY: '',
    CODEX_MINI_RELAY_MAX_REQUESTS_PER_MINUTE: '10000', CODEX_MINI_RELAY_MAX_CONCURRENCY: '100' } });
async function connect(device) {
  const timestamp = Date.now(), nonce = `fixture-${timestamp}`;
  const query = new URLSearchParams({ deviceId: device.deviceId, timestamp, nonce, signature: hmac(device.relaySecret, `${device.deviceId}.${timestamp}.${nonce}`) });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel?${query}`);
  sockets.set(device.deviceId, ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', raw => {
    const req = JSON.parse(raw); if (req.type !== 'request') return;
    const letter = device.deviceId.slice(-1), url = new URL(req.path, 'http://fixture');
    const endpoint = url.pathname.split('/').pop();
    const body = req.bodyBase64 ? JSON.parse(Buffer.from(req.bodyBase64, 'base64')) : {};
    const threadId = url.searchParams.get('thread') || body.threadId || '';
    requests.push({ device: letter, endpoint, method: req.method, threadId, expected: req.headers['x-codex-mini-device-id'] || '' });
    let data = { ok: true }, status = 200, type = 'application/json';
    const state = { ok: true, available: true, threadId: threadId || ids[letter][0], active: false, status: 'complete', final: `Device ${letter.toUpperCase()} reply`, queue: [], approvals: [], desktopQuestions: [] };
    if (!endpoint || endpoint === 'index.html') { data = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'); type = 'text/html'; }
    else if (endpoint === 'relay-status') data = { ok: true, deviceId: device.deviceId, configured: true, connected: true, backend: 'app-server' };
    else if (endpoint === 'config') data = { ok: true, backend: 'app-server', localOnly: false, relayApiBases: [`http://127.0.0.1:${port}/codex`], capabilities: {} };
    else if (endpoint === 'threads') data = { ok: true, scope: url.searchParams.get('scope'), threads: url.searchParams.get('scope') === 'projects' ? [] : ids[letter].map((id, i) => ({ id, name: `${letter.toUpperCase()} conversation ${i + 1}`, isProjectThread: false, updatedAt: 1800000000000 - i })), nextCursor: null };
    else if (threadId && !ids[letter].includes(threadId)) { status = 404; data = { ok: false, code: 'THREAD_NOT_FOUND', message: '该设备没有这个 session_id' }; }
    else if (endpoint === 'thread-bootstrap') data = { ok: true, threadId: state.threadId, status: state, history: { ok: true, threadId: state.threadId, available: true, messages: [{ id: `m-${letter}`, role: 'assistant', text: `Device ${letter.toUpperCase()} reply` }], nextCursor: null } };
    else if (endpoint === 'status') data = state;
    const reply = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'response', id: req.id, status, headers: { 'content-type': type, 'cache-control': 'no-store' }, bodyBase64: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64') })); };
    if (delayA && letter === 'a' && endpoint === 'thread-bootstrap') delayed.push(reply); else reply();
  });
}
const control = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/delay-a') delayA = true;
  if (url.pathname === '/release') { delayA = false; delayed.splice(0).forEach(reply => reply()); }
  if (url.pathname === '/offline-a') sockets.get('fixture-a')?.terminate();
  if (url.pathname === '/online-a' && sockets.get('fixture-a')?.readyState !== 1) await connect(devices[0]);
  if (url.pathname === '/reset') requests.length = 0;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ requests, delayed: delayed.length, ids }));
});
child.stderr.on('data', () => {});
let started = false;
child.stdout.on('data', async data => {
  if (started || !String(data).includes('relay_listening')) return;
  started = true;
  await Promise.all(devices.map(connect));
  control.listen(controlPort, '127.0.0.1', () => console.log(`Fixture ready on ${port}; control on ${controlPort}. Synthetic devices only.`));
});
function close() { sockets.forEach(ws => ws.terminate()); control.close(); child.kill(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
child.on('exit', code => { fs.rmSync(directory, { recursive: true, force: true }); process.exit(code || 0); });
