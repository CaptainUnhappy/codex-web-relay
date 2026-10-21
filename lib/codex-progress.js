'use strict';

const MAX_STEPS = 30;
const text = value => typeof value === 'string' ? value : '';
const brief = value => text(value).replace(/\s+/g, ' ').trim().slice(0, 160);
const filename = value => brief(value).split(/[\\/]/).pop();

function itemProgress(item, options = {}) {
  if (!item || !item.id) return null;
  const state = text(item.status).toLowerCase();
  const failed = state === 'failed' || state === 'declined' || item.success === false;
  const completed = options.completed || state === 'completed' || failed;
  const verb = failed ? '失败' : completed ? '已完成' : '正在';
  const step = { callId: item.id, kind: 'tool', label: '工具', status: failed ? 'failed' : completed ? 'completed' : 'running', time: options.time || '' };
  let action = '';
  switch (item.type) {
    case 'agentMessage':
      if (!text(item.text)) return null;
      return { ...step, kind: 'assistant', label: item.phase === 'commentary' ? '进度' : '回复', text: item.text.slice(-8000) };
    case 'plan':
      if (!text(item.text)) return null;
      return { ...step, kind: 'thinking', label: '计划', text: item.text.slice(-8000) };
    case 'reasoning':
      // Expose activity, never the model's internal reasoning content.
      return { ...step, kind: 'start', label: '状态', text: completed ? '已完成分析' : '正在分析请求' };
    case 'commandExecution': {
      const actions = item.commandActions || [];
      const read = actions.find(entry => entry.type === 'read');
      action = read ? `读取 ${filename(read.name || read.path) || '文件'}`
        : actions.some(entry => entry.type === 'search') ? '搜索文件'
          : actions.some(entry => entry.type === 'listFiles') ? '查看文件列表' : '执行命令';
      break;
    }
    case 'fileChange':
      action = `编辑文件 ${(item.changes || []).slice(0, 3).map(change => filename(change.path)).filter(Boolean).join('、')}`.trim();
      break;
    case 'mcpToolCall':
    case 'dynamicToolCall':
      action = `调用 ${brief(item.tool) || '工具'}`;
      break;
    case 'collabAgentToolCall': action = '协作任务'; break;
    case 'webSearch': action = '搜索网页'; break;
    case 'imageView': action = '查看图片'; break;
    case 'imageGeneration': action = '生成图片'; break;
    case 'contextCompaction': action = '压缩上下文'; break;
    default: return null;
  }
  return { ...step, text: `${verb} · ${action}` };
}

function planProgress(turnId, plan = [], time = '') {
  const labels = { pending: '待处理', inProgress: '进行中', completed: '已完成' };
  const lines = plan.slice(0, 20).map(row => `- ${labels[row.status] || '待处理'}：${brief(row.step)}`);
  return lines.length ? { callId: `plan:${turnId}`, kind: 'thinking', label: '计划', text: lines.join('\n'), time } : null;
}

function upsertProgress(steps, step) {
  if (!step) return;
  const index = steps.findIndex(existing => existing.callId === step.callId);
  if (index < 0) steps.push(step);
  else steps[index] = step;
  if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
}

function mergeProgress(snapshot, live = []) {
  const steps = [];
  for (const step of snapshot) upsertProgress(steps, step);
  for (const step of live) {
    const saved = steps.find(existing => existing.callId === step.callId);
    // A terminal item in the authoritative snapshot supersedes a stale delta.
    if (saved && saved.status !== 'running') continue;
    upsertProgress(steps, step);
  }
  return steps;
}

module.exports = { MAX_STEPS, itemProgress, planProgress, upsertProgress, mergeProgress };
