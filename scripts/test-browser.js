'use strict';

// Only serves repository assets and synthetic devices; never starts the user's desktop server.
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
process.chdir(root);

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function main() {
  fs.mkdirSync('output/playwright', { recursive: true });
  const assets = new Map([
    ['/', ['text/html', fs.readFileSync('public/index.html')]],
    ['/icons/icon-512.png', ['image/png', fs.readFileSync('public/icons/icon-512.png')]],
  ]);
  const server = http.createServer((req, res) => {
    const asset = assets.get(req.url);
    res.writeHead(asset ? 200 : 404, { 'content-type': asset?.[0] || 'text/plain' });
    res.end(asset?.[1] || 'Not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const options = { sourceUrl: `http://127.0.0.1:${server.address().port}/` };
  let browser, fixture, fixtureOutput = '';
  const results = [];
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    for (const name of ['session-metadata', 'composer-actions', 'composer-navigation', 'composer-viewport', 'question', 'goal-image', 'device-switch']) {
      if (name === 'device-switch') {
        const port = await freePort(), controlPort = await freePort();
        options.relayUrl = `http://127.0.0.1:${port}/codex/`;
        options.controlUrl = `http://127.0.0.1:${controlPort}`;
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/^(CODEX_MINI_|RELAY_|ADMIN_)/.test(key)) delete env[key];
        fixture = spawn(process.execPath, ['scripts/serve-device-switch-fixture.js', String(port), String(controlPort)],
          { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${fixtureOutput}`)), 15000);
          fixture.once('error', error => { clearTimeout(timer); reject(error); });
          fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${fixtureOutput}`)); });
          fixture.stderr.on('data', chunk => { fixtureOutput = (fixtureOutput + chunk).slice(-8000); });
          fixture.stdout.on('data', chunk => {
            fixtureOutput = (fixtureOutput + chunk).slice(-8000);
            if (fixtureOutput.includes('Fixture ready')) { clearTimeout(timer); resolve(); }
          });
        });
      }
      const filename = `scripts/test-${name}-ui.js`;
      const test = vm.runInThisContext(fs.readFileSync(filename, 'utf8'), { filename });
      const page = await browser.newPage();
      try {
        results.push({ test: name, result: await test(page, options) });
        console.log(`PASS: browser ${name}`);
      } finally { await page.close(); }
    }
    fs.writeFileSync('output/playwright/results.json', JSON.stringify(results, null, 2) + '\n');
  } finally {
    await browser?.close();
    if (fixture && fixture.exitCode === null) {
      const exited = once(fixture, 'exit');
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(fixture.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else fixture.kill('SIGTERM');
      await exited;
    }
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
