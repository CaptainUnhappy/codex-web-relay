'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, createHmac } = require('crypto');
const { fileURLToPath } = require('url');

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))) return 'image/avif';
  return '';
}

function markdownImagePath(target) {
  let value = String(target || '').trim();
  try {
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      if (url.hostname || url.search || url.hash) return '';
      value = fileURLToPath(url);
    } else {
      value = decodeURIComponent(value);
      // Markdown escapes are not Windows path separators.
      if (!/^[a-z]:\\/i.test(value)) value = value.replace(/\\([ ()\[\]<>])/g, '$1');
    }
  } catch { return ''; }
  if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  if (!path.isAbsolute(value) || /^[\\/]{2}/.test(value) || value.includes('\0') || !/\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(value)) return '';
  return path.normalize(value);
}

// Only image references in authenticated history/status can enter this map.
// Browser requests never supply filesystem paths. IDs expire on service restart.
function createThreadImages({ maxBytes = 20 * 1024 * 1024, maxEntries = 2048 } = {}) {
  const secret = randomBytes(32);
  const files = new Map();
  function register(threadId, filePath, name = '图片') {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || /^[\\/]{2}/.test(filePath) || filePath.includes('\0')) return { name };
    filePath = path.normalize(filePath);
    const id = createHmac('sha256', secret).update(`${threadId}\0${filePath}`).digest('base64url');
    files.delete(id);
    files.set(id, filePath);
    while (files.size > maxEntries) files.delete(files.keys().next().value);
    return { name, previewId: id };
  }
  function markdownImages(text, threadId) {
    if (typeof text !== 'string' || !text.includes('![')) return text;
    let fence = '', inlineTicks = '';
    return text.split(/(\r?\n)/).map(line => {
      if (/^\r?\n$/.test(line)) return line;
      if (!line.trim()) { inlineTicks = ''; return line; }
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
        return line;
      }
      if (marker && !inlineTicks) { fence = marker[1]; return line; }
      if (!inlineTicks && /^(?: {4}|\t)/.test(line)) return line;
      return line.replace(/`+|!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^>\r\n]+)>|((?:\\.|[^\\()\r\n]|\([^()\r\n]*\))+?))(?:[ \t]+["'][^"'\r\n]*["'])?\s*\)/g, (match, alt, angleTarget, target) => {
        if (match[0] === '`') { if (!inlineTicks) inlineTicks = match; else if (match === inlineTicks) inlineTicks = ''; return match; }
        if (inlineTicks) return match;
        const filePath = markdownImagePath(angleTarget || target);
        if (!filePath) return match;
        return `![${alt}](codex-image:${register(threadId, filePath).previewId})`;
      });
    }).join('');
  }
  function withImages(history) {
    return { ...history, messages: (history.messages || []).map(message => ({
      ...message,
      ...(message.role === 'assistant' ? { text: markdownImages(message.text, history.threadId) } : {}),
      attachments: (message.attachments || []).map(item => {
        const filePath = item.filePath;
        const name = item.name || (typeof filePath === 'string' ? path.basename(filePath) : '图片');
        return register(history.threadId, filePath, name);
      }),
    })) };
  }
  function withStatusImages(status, threadId = status.threadId) {
    return { ...status, preview: markdownImages(status.preview, threadId), final: markdownImages(status.final, threadId),
      steps: (status.steps || []).map(step => ['assistant', 'thinking'].includes(step.kind) ? { ...step, text: markdownImages(step.text, threadId) } : step) };
  }
  async function read(id) {
    const filePath = files.get(id);
    if (!filePath) throw Object.assign(new Error('图片链接已失效，请刷新聊天记录。'), { status: 404 });
    const handle = await fs.promises.open(filePath, 'r').catch(() => { throw Object.assign(new Error('原图片已不存在或无法读取。'), { status: 404 }); });
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw Object.assign(new Error('图片过大或格式不支持预览。'), { status: 415 });
      const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      const data = bytes.subarray(0, bytesRead);
      const contentType = imageType(data);
      if (!contentType || bytesRead > maxBytes) throw Object.assign(new Error('图片格式不支持预览。'), { status: 415 });
      return { data, contentType };
    } finally { await handle.close(); }
  }
  return { withImages, withStatusImages, read };
}

module.exports = { createThreadImages };
