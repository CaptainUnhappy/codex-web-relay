'use strict';

// Adapted for this fork from Codex Mini by CoimgRain, v5.8.5.
// https://github.com/CoimgRain/Codex-Mini — repository LICENSE applies.
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const cache = new Map();
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;
let cacheBytes = 0;

function acceptsGzip(value = '') {
  const encodings = String(value).toLowerCase().split(',').map(part => {
    const [name, ...params] = part.trim().split(';');
    const weight = params.find(param => /^\s*q\s*=/.test(param));
    return { name, quality: weight ? Number(weight.split('=')[1]) : 1 };
  });
  const encoding = encodings.find(item => item.name === 'gzip') || encodings.find(item => item.name === '*');
  return Boolean(encoding && encoding.quality > 0 && encoding.quality <= 1);
}

async function staticEntry(filePath, contentType) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('Not a file');
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const previous = cache.get(filePath);
  if (previous?.signature === signature) return previous;
  const data = await fs.promises.readFile(filePath);
  const clientScript = contentType.startsWith('text/html') ? data.toString('utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1] : null;
  const compressible = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/.test(contentType);
  const gzip = compressible && data.length >= 1024 ? zlib.gzipSync(data) : null;
  const entry = {
    signature, data, gzip,
    // Weak validation deliberately describes the same document across encodings.
    etag: `W/"${crypto.createHash('sha256').update(data).digest('base64url')}"`,
    clientVersion: clientScript == null ? null : crypto.createHash('sha256').update(clientScript.replace(/\r\n?/g, '\n')).digest('hex'),
    bytes: data.length + (gzip?.length || 0),
  };
  // A concurrent read may have filled this slot while readFile was pending.
  const replaced = cache.get(filePath);
  if (replaced) { cacheBytes -= replaced.bytes; cache.delete(filePath); }
  if (entry.bytes <= MAX_CACHE_BYTES) {
    while (cache.size && (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + entry.bytes > MAX_CACHE_BYTES)) {
      const key = cache.keys().next().value;
      cacheBytes -= cache.get(key).bytes;
      cache.delete(key);
    }
    cache.set(filePath, entry);
    cacheBytes += entry.bytes;
  }
  return entry;
}

async function serveStaticFile(req, res, filePath, contentType, extraHeaders = {}) {
  let entry;
  try { entry = await staticEntry(filePath, contentType); }
  catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : 'Not found');
  }
  const headers = {
    'content-type': contentType,
    'cache-control': 'private, no-cache, must-revalidate',
    vary: 'Accept-Encoding',
    etag: entry.etag,
    ...extraHeaders,
  };
  if (entry.clientVersion) headers['x-codex-mini-client-version'] = entry.clientVersion;
  const matches = String(req.headers['if-none-match'] || '').split(',').some(tag =>
    tag.trim() === '*' || tag.trim().replace(/^W\//, '') === entry.etag.replace(/^W\//, ''));
  if (matches) {
    res.writeHead(304, headers);
    return res.end();
  }
  const compressed = acceptsGzip(req.headers['accept-encoding']) && entry.gzip;
  const body = compressed || entry.data;
  if (compressed) headers['content-encoding'] = 'gzip';
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

module.exports = { serveStaticFile };
