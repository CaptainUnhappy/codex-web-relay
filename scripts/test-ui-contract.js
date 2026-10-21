'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const backend = fs.readFileSync('lib/codex-app-server-backend.js', 'utf8');
const scriptStart = html.indexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');

assert(scriptStart >= 0 && scriptEnd > scriptStart, 'inline UI script must exist');
new Function(html.slice(scriptStart + '<script>'.length, scriptEnd));

assert(html.includes('Math.max(3, Math.min(10, Math.floor((height - 250) / 58)))'), 'thread preview rows must adapt to viewport height');
assert(html.includes('sortThreadsByTime(conversations)'), 'conversations must use recent-message sorting');
assert(html.includes(".sort((a, b) => b.latest - a.latest)"), 'projects must use recent-message sorting');
assert(html.includes("rank.textContent = index === 0 ? '队首消息'"), 'queue head must be labelled');
assert(html.includes('queueGuideButton.disabled = queueActionBusy || queuePaused || queueWaitingForWriter || !count'), 'guide must defer activity validation to the server except for confirmed external writer waits');
assert(html.includes("queueContinueButton.addEventListener('click', () => runQueueAction('continue'))"), 'paused queues must expose continue');
assert(html.includes("title.textContent = item.submittedAt ? '审批结果待确认'"), 'submitted approvals must remain visible until confirmed');
assert(!html.includes("item.name || '新对话'"), 'the UI must not synthesize unnamed list entries');
assert(backend.includes("if (!normalized.isProjectThread) normalized.cwd = '';"), 'projectless internal paths must be removed at the backend boundary');

console.log('UI contract test passed.');
