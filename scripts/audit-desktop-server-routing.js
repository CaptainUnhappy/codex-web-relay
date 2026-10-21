'use strict';

// Read-only installed-code audit. Transport constructors are recording stubs;
// no App process, configuration, sockets or credentials are touched.
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');
const archive = process.argv[2];
if (!archive) throw Error('Usage: node scripts/audit-desktop-server-routing.js <path-to-app.asar>');
const fd = fs.openSync(archive, 'r');
const sources = {};
try {
  const prefix = Buffer.alloc(8); fs.readSync(fd, prefix, 0, 8, 0);
  const size = prefix.readUInt32LE(4), header = Buffer.alloc(size);
  fs.readSync(fd, header, 0, size, 8);
  const tree = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString());
  const entries = tree.files['.vite'].files.build.files;
  const read = name => {
    const entry = entries[name]; assert(entry && !entry.unpacked, name);
    const bytes = Buffer.alloc(entry.size);
    fs.readSync(fd, bytes, 0, bytes.length, 8 + size + Number(entry.offset));
    return { name, text: bytes.toString(), sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  sources.main = read(Object.keys(entries).find(name => /^main-.*\.js$/.test(name)));
  const hostModule = sources.main.text.match(/r=require\("\.\/([^"/]+)"\)/)?.[1];
  assert(hostModule, 'Host module binding changed; re-audit this version');
  sources.host = read(hostModule);
  sources.network = read(Object.keys(entries).find(name => /^application-network-startup-.*\.js$/.test(name)));
} finally { fs.closeSync(fd); }

function extract(asset, symbol, next) {
  const text = sources[asset].text, start = text.indexOf(`function ${symbol}(`), end = text.indexOf(next, start + 1);
  assert(start >= 0 && end > start, `${symbol}: symbols changed; re-audit this version`);
  return text.slice(start, end);
}
assert(sources.host.text.includes('Object.defineProperty(exports,"Wi",{enumerable:!0,get:function(){return Mi}})'), 'Wi must resolve to Mi');
assert(sources.host.text.includes('Object.defineProperty(exports,"Li",{enumerable:!0,get:function(){return bi}})'), 'Li must resolve to durable-host predicate');
assert(sources.network.text.includes('Object.defineProperty(exports,"D",{enumerable:!0,get:function(){return Yo}})'), 'D must resolve to WS URL selector');

const code = [
  extract('host', 'Mi', 'function Ni('),
  extract('host', 'bi', 'function xi('),
  extract('network', 'Yo', 'var Xo'),
  extract('main', 'A5', 'function xYe('),
  extract('main', 'xYe', 'function SYe('),
  extract('main', 'j5', 'var wYe'),
].join('\n');
function route(env, hostConfig = { id: 'local', kind: 'local' }) {
  class WebsocketTransport { constructor(options) { this.kind = 'websocket'; this.url = options.websocketUrl; this.hasHandshake = Boolean(options.getWebsocketHandshake); } }
  class StdioTransport { constructor() { this.kind = 'stdio'; } }
  class WslTransport { constructor() { this.kind = 'wsl-stdio'; } }
  const context = vm.createContext({ URL, process: { platform: 'win32', env }, T6: () => null,
    CYe: { info() {} }, vYe: WslTransport, WebsocketTransport, StdioTransport,
  });
  vm.runInContext(`const _i = 'durable', k5 = 'socks5h://127.0.0.1:1080';\n${code}\nconst r = { Wi: Mi, Li: bi }; const c = { D: Yo, E: WebsocketTransport, _: StdioTransport };`, context);
  return context.j5({ hostConfig, transportKind: 'standard' });
}
const url = 'ws://127.0.0.1:4500';
const results = {
  windowsDefault: route({}),
  windowsExternalWs: route({ CODEX_APP_SERVER_WS_URL: url }),
  forceCli: route({ CODEX_APP_SERVER_WS_URL: url, CODEX_APP_SERVER_FORCE_CLI: '1' }),
  wsl: route({ CODEX_APP_SERVER_WS_URL: url }, { id: 'remote-wsl:fixture', kind: 'wsl', distro: 'fixture' }),
};
assert.equal(results.windowsDefault.kind, 'stdio');
assert.equal(results.windowsExternalWs.kind, 'websocket');
assert.equal(results.windowsExternalWs.url, url);
assert.equal(results.forceCli.kind, 'stdio');
assert.equal(results.wsl.kind, 'wsl-stdio');
console.log(JSON.stringify({ readOnly: true, actualAppRelaunched: false,
  assets: Object.values(sources).map(({ name, sha256 }) => ({ name, sha256 })), results,
  limitation: 'Routing only: does not prove external-server authentication, full Desktop tool integration or question-card closure.',
}, null, 2));
