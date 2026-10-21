'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const { serveStaticFile } = require('../lib/static-assets');

function sourceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mini-web-delivery-'));
  const original = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'));
  fs.writeFileSync(path.join(directory, 'index.html'), original);
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const context = vm.createContext({ URL, path, PUBLIC_DIR: directory, TOKEN: 'fixture', serveStaticFile, mimeTypes: { '.html': 'text/html; charset=utf-8' } });
  vm.runInContext(sourceFunction(source, 'serveStatic') + sourceFunction(source, 'stripStaticBasePath'), context);
  const server = http.createServer((req, res) => context.serveStatic(req, res));
  const request = (pathname = '/', headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('HTTP test timed out')));
    req.end();
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const plain = await request('/?token=fixture');
    assert.strictEqual(plain.status, 200);
    assert(plain.body.equals(original));
    assert(plain.headers['set-cookie'][0].startsWith('codexMiniToken=fixture;'));
    assert.strictEqual(plain.headers['cache-control'], 'private, no-cache, must-revalidate');
    const script = original.toString('utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
    const version = crypto.createHash('sha256').update(script).digest('hex');
    assert.strictEqual(plain.headers['x-codex-mini-client-version'], version, 'served version must identify the actual client code');
    const compressed = await request('/', { 'accept-encoding': 'br, gzip' });
    assert.strictEqual(compressed.headers['content-encoding'], 'gzip');
    assert.strictEqual(compressed.headers.vary, 'Accept-Encoding');
    assert(zlib.gunzipSync(compressed.body).equals(original));
    assert(compressed.body.length < original.length / 2);
    const unchanged = await request('/?token=fixture', { 'if-none-match': `"unrelated", ${plain.headers.etag}`, 'accept-encoding': 'gzip' });
    assert.strictEqual(unchanged.status, 304);
    assert.strictEqual(unchanged.body.length, 0);
    assert.strictEqual(unchanged.headers['content-length'], undefined);
    assert(unchanged.headers['set-cookie'], '304 retains the requested token cookie');
    assert.strictEqual((await request('/', { 'if-none-match': plain.headers.etag.replace('W/', '') })).status, 304);
    assert.strictEqual((await request('/', { 'if-none-match': '*' })).status, 304);
    for (const encoding of ['gzip;q=0', 'gzip;q=0, *;q=1', 'gzip;q=invalid', 'br', '']) {
      const response = await request('/', { 'accept-encoding': encoding });
      assert.strictEqual(response.headers['content-encoding'], undefined, encoding);
      assert(response.body.equals(original));
    }
    const head = await request('/', { 'accept-encoding': 'gzip' }, 'HEAD');
    assert.strictEqual(head.body.length, 0);
    assert.strictEqual(head.headers['x-codex-mini-client-version'], version, 'HEAD lets long-lived clients check their loaded code without downloading HTML');
    assert.strictEqual(Number(head.headers['content-length']), compressed.body.length);
    for (const prefix of ['/mini/', '/codex-mini/', '/codex/', '/r/fixture/']) {
      assert((await request(prefix)).body.equals(original), prefix);
    }
    assert.strictEqual((await request('/%E0%A4%A')).status, 400);
    assert.strictEqual((await request('/%2e%2e%5csecret')).status, 403);
    assert.strictEqual((await request('/missing.html', { 'if-none-match': '*' })).status, 404);
    const updatedBody = Buffer.concat([original, Buffer.from('\n<!-- updated -->')]);
    fs.writeFileSync(path.join(directory, 'index.html'), updatedBody);
    const updated = await request('/', { 'if-none-match': plain.headers.etag });
    assert.strictEqual(updated.status, 200);
    assert.notStrictEqual(updated.headers.etag, plain.headers.etag);
    assert(updated.body.equals(updatedBody));

    // Exercise the real relay header sanitizer: 304 has no representation body,
    // while HEAD must keep the GET representation length rather than zero it.
    const relay = fs.readFileSync(path.join(__dirname, '..', 'relay-server', 'server.js'), 'utf8');
    const relayContext = vm.createContext({ HOP_BY_HOP_HEADERS: new Set(['connection', 'transfer-encoding']) });
    vm.runInContext(sourceFunction(relay, 'sanitizeResponseHeaders'), relayContext);
    const proxyHeaders = relayContext.sanitizeResponseHeaders(compressed.headers, compressed.body.length, 200, 'GET');
    assert.strictEqual(proxyHeaders['content-encoding'], 'gzip');
    assert.strictEqual(proxyHeaders.etag, compressed.headers.etag);
    assert.strictEqual(relayContext.sanitizeResponseHeaders(head.headers, 0, 200, 'HEAD')['content-length'], String(compressed.body.length));
    assert.strictEqual(relayContext.sanitizeResponseHeaders(plain.headers, 0, 304, 'GET')['content-length'], undefined);
    assert(!('set-cookie' in relayContext.sanitizeResponseHeaders(plain.headers, plain.body.length)));
    console.log(`Web delivery passed: ${original.length} -> ${compressed.body.length} bytes (gzip); revalidation 304, 0 body bytes; HEAD, invalidation, paths and relay headers passed.`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
