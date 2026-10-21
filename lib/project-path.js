'use strict';

const fs = require('fs');
const path = require('path');
const cache = new Map();

function normalizedPath(value) {
  const input = String(value || '').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(input);
  const format = windows ? path.win32 : path;
  const normalized = input ? format.normalize(input) : '';
  return normalized === format.parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/, '');
}

function projectPathKey(value) {
  const normalized = normalizedPath(value);
  return /^[a-z]:[\\/]|^\\\\/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

// Worktrees share a project, but same-named independent repositories do not.
function canonicalProjectPath(value) {
  const original = normalizedPath(value);
  if (!original) return '';
  const cached = cache.get(original);
  if (cached && Date.now() - cached.at < 300000) return cached.path;
  let result = original;
  let directory = original;
  for (let depth = 0; depth < 20; depth++) {
    try {
      const marker = path.join(directory, '.git');
      const stat = fs.statSync(marker);
      if (stat.isFile() && stat.size < 4096) {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(marker, 'utf8'));
        if (match) {
          const gitDir = path.resolve(directory, match[1].trim());
          const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
          if (path.basename(common).toLowerCase() === '.git') {
            result = normalizedPath(path.resolve(path.dirname(common), path.relative(directory, original)));
          }
        }
      }
      break;
    } catch { /* An ordinary folder or submodule keeps its own project identity. */ }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (cache.size >= 256) cache.delete(cache.keys().next().value);
  cache.set(original, { path: result, at: Date.now() });
  return result;
}

module.exports = { canonicalProjectPath, projectPathKey };
