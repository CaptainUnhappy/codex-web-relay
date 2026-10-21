'use strict';

const fs = require('fs');

function questionReplies(text) {
  const match = String(text || '').match(/^\s*<send_user_message_question_reply>\s*([\s\S]*)\s*<\/send_user_message_question_reply>\s*$/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter(row => typeof row?.questionItemId === 'string'
      && typeof row.question === 'string' && typeof row.answer === 'string');
  } catch { return []; }
}

function readableQuestionReply(text) {
  const rows = questionReplies(text);
  return rows.length ? rows.map(row => `**Codex 提问**\n\n${row.question}\n\n**你的回答**\n\n${row.answer}`).join('\n\n---\n\n') : text;
}

function textContent(content) {
  return (Array.isArray(content) ? content : []).map(item => typeof item?.text === 'string' ? item.text : '').join('\n');
}

function desktopQuestionRequests(records, threadId) {
  const groups = new Map();
  const answered = new Set();
  const seenQuestions = new Set();
  const turnTriggers = new Map();
  let currentTurnId = '';
  for (const record of records) {
    const payload = record?.payload || {};
    if (payload.thread_id && payload.thread_id !== threadId) continue;
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      currentTurnId = payload.turn_id || payload.turn_attribution?.turn_id || '';
      turnTriggers.set(currentTurnId, payload.turn_attribution?.turn_trigger || '');
    } else if (record.type === 'turn_context') {
      currentTurnId = payload.turn_id || '';
    }
    const item = payload.item;
    if (record.type === 'event_msg' && payload.type === 'item_completed'
        && item?.type === 'AgentMessage' && item.delivery === 'async' && Array.isArray(item.questions) && item.id && !seenQuestions.has(item.id)) {
      seenQuestions.add(item.id);
      const questions = item.questions.map((question, index) => ({
        id: JSON.stringify(['request_user_input_async', item.id, index]),
        question: typeof question.title === 'string' ? question.title : '',
        options: (Array.isArray(question.options) ? question.options : []).map(option => typeof option === 'string'
          ? { label: option } : { label: option?.label || '', description: option?.description || '' }).filter(option => option.label),
        isOther: true,
      })).filter(question => question.question);
      if (questions.length) groups.set(item.id, {
        id: `desktop-question:${item.id}`, method: 'desktop/requestUserInput', createdAt: record.timestamp || '',
        params: { threadId, questions },
      });
    }
    const text = record.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
      ? textContent(payload.content)
      : record.type === 'event_msg' && payload.type === 'user_message' ? payload.message
        : record.type === 'event_msg' && payload.type === 'item_completed' && item?.type === 'UserMessage' ? textContent(item.content) : '';
    const replies = questionReplies(text);
    for (const reply of replies) answered.add(reply.questionItemId);
    // Canonical UserMessages also carry scheduled heartbeats. Supersede only
    // when turn attribution proves the instruction came from the composer;
    // unknown/truncated attribution preserves pending questions. Explicit
    // replies still resolve their IDs regardless of the enclosing turn source.
    const userEvent = record.type === 'event_msg' && (payload.type === 'user_message'
      || (payload.type === 'item_completed' && item?.type === 'UserMessage'));
    if (userEvent && !replies.length && turnTriggers.get(payload.turn_id || currentTurnId) === 'composer') groups.clear();
  }
  return [...groups.values()].map(group => ({ ...group, params: { ...group.params,
    questions: group.params.questions.filter(question => !answered.has(question.id)),
  } })).filter(group => group.params.questions.length);
}

function createDesktopQuestionReader({ findFile, readItems, statFile = fs.statSync }) {
  const cache = new Map();
  return threadId => {
    if (!threadId) return [];
    try {
      const cached = cache.get(threadId);
      const file = cached?.file || findFile(threadId);
      if (!file) return [];
      const stat = statFile(file);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.requests;
      const requests = desktopQuestionRequests(readItems(file), threadId);
      cache.set(threadId, { file, size: stat.size, mtimeMs: stat.mtimeMs, requests });
      while (cache.size > 32) cache.delete(cache.keys().next().value);
      return requests;
    } catch { cache.delete(threadId); return []; }
  };
}

function queuedQuestionIds(queue) {
  const ids = new Set();
  for (const item of queue || []) for (const reply of questionReplies(textContent(item.input))) ids.add(reply.questionItemId);
  return ids;
}

module.exports = { questionReplies, readableQuestionReply, desktopQuestionRequests, createDesktopQuestionReader, queuedQuestionIds };
