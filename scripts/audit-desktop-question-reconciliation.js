'use strict';

// Version-specific, read-only diagnostic. Runs installed pure state functions
// against an in-memory atom store; never attaches to or changes the running App.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const { createHash } = require('crypto');

const archive = process.argv[2];
if (!archive) throw Error('Usage: node scripts/audit-desktop-question-reconciliation.js <path-to-app.asar>');

function readAssets(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(8); fs.readSync(fd, prefix, 0, 8, 0);
    const size = prefix.readUInt32LE(4), header = Buffer.alloc(size);
    fs.readSync(fd, header, 0, size, 8);
    const tree = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString());
    const assets = tree.files.webview.files.assets.files;
    return Object.fromEntries(['initial', 'primary', 'shared'].map(kind => {
      const names = Object.keys(assets).filter(name => new RegExp(`^app-${kind}-.*\\.js$`).test(name));
      assert.strictEqual(names.length, 1, `Expected one ${kind} asset; re-audit this App version`);
      const name = names[0], entry = assets[name];
      assert(!entry.unpacked);
      const bytes = Buffer.alloc(entry.size);
      fs.readSync(fd, bytes, 0, bytes.length, 8 + size + Number(entry.offset));
      return [kind, { name, source: bytes.toString(), sha256: createHash('sha256').update(bytes).digest('hex') }];
    }));
  } finally { fs.closeSync(fd); }
}

const assets = readAssets(archive), locations = [];
function extract(kind, name, next) {
  const asset = assets[kind], start = asset.source.indexOf(`function ${name}(`);
  const end = asset.source.indexOf(next, start + 1);
  assert(start >= 0 && end > start, `${name}: installed symbols changed; re-audit before use`);
  locations.push({ asset: asset.name, symbol: name, characterOffset: start });
  return asset.source.slice(start, end);
}
const source = [
  extract('shared', 'F5t', 'function I5t('),
  extract('shared', 'qH', 'function Bmn('),
  extract('shared', 'Bmn', 'function Vmn('),
  extract('shared', 'Vmn', 'function JH('),
  extract('shared', 'exr', 'function txr('),
  extract('initial', 'mIt', 'function hIt('),
  extract('initial', 'hIt', 'function gIt('),
  extract('initial', 'HS', 'function SIt('),
  extract('primary', 'A$e', 'var j$e'),
].join('\n');

function scenario() {
  const entries = new Map();
  const atom = (name, fallback) => {
    const item = { name, fallback };
    item.resolve = (_node, _chain, key) => ({ get: () => store.get(item, key) });
    return item;
  };
  const DIt = atom('panel-by-host', () => new Map()), WS = atom('question-state', () => null), US = atom('question-ids', () => []);
  const OIt = atom('selected-panel', () => null);
  const keyOf = (a, key) => `${a.name}:${typeof key === 'object' ? JSON.stringify([key.hostId, key.threadId, key.entityKey, key.itemId]) : key}`;
  const store = {
    node: null, chain: null,
    get(a, key) {
      if (a === OIt) return this.get(DIt, key.hostId).get(key.threadId) || null;
      const id = keyOf(a, key);
      if (!entries.has(id)) entries.set(id, a.fallback());
      return entries.get(id);
    },
    set(a, key, value) { entries.set(keyOf(a, key), typeof value === 'function' ? value(this.get(a, key)) : value); },
  };
  const context = vm.createContext({ Map, Set, DIt, WS, US, Gw: OIt, nT: WS,
    Pc: (_store, callback) => callback(), ru: (_store, callback) => callback(),
    // The response parser is a fixture for an already-valid envelope; this audit
    // exercises the installed reconciliation functions, not the Zod parser.
    tV: text => JSON.parse(text.slice('<send_user_message_question_reply>'.length, -'</send_user_message_question_reply>'.length)),
    jue: () => { throw Error('Unexpected duplicate-content branch'); },
  });
  vm.runInContext(source + '\nconst yue = exr, zie = Vmn, DRe = HS;', context);
  const scope = { hostId: 'local', threadId: 'fixture-thread', entityKey: 'turn:fixture-turn' };
  const question = { type: 'agentMessage', id: 'fixture-question', delivery: 'async', questions: [{ title: '请选择一次', options: ['确认一次'] }] };
  const questionId = context.F5t(question.id, 0);
  context.hIt(store, scope, context.Vmn([question]), 'fixture-turn');
  const answers = [{ questionItemId: questionId, question: '请选择一次', answer: '确认一次' }];
  const text = `<send_user_message_question_reply>${JSON.stringify(answers)}</send_user_message_question_reply>`;
  return { context, store, scope, question, questionId, answers, text, WS, OIt };
}

const same = scenario();
same.context.mIt(same.store, same.scope, { turnId: 'fixture-turn', items: [same.question,
  { type: 'steeringUserMessage', id: 'external-reply', status: 'accepted', input: [{ type: 'text', text: same.text }] }] });
const sameState = same.store.get(same.WS, { ...same.scope, itemId: same.questionId });
const sameResult = { answerRecognized: sameState.lastSubmission === '确认一次', selectedCardRemains: Boolean(same.store.get(same.OIt, same.scope)) };
assert(sameResult.answerRecognized && sameResult.selectedCardRemains, 'Installed behavior changed: review whether external reconciliation now closes the panel');

const next = scenario();
next.context.mIt(next.store, { ...next.scope, entityKey: 'turn:next-turn' }, { turnId: 'next-turn', items: [
  { type: 'userMessage', id: 'new-turn-reply', content: [{ type: 'text', text: next.text }] }] });
const nextResult = { originalAnswerRecognized: next.store.get(next.WS, { ...next.scope, itemId: next.questionId }).lastSubmission !== null,
  selectedCardRemains: Boolean(next.store.get(next.OIt, next.scope)) };
assert(!nextResult.originalAnswerRecognized && nextResult.selectedCardRemains);

const local = scenario();
const key = { ...local.scope, itemId: local.questionId };
local.store.set(local.WS, key, { ...local.store.get(local.WS, key), draft: '确认一次' });
local.context['A$e'](local.store, local.scope, local.answers);
const localResult = { answerRecognized: local.store.get(local.WS, key).lastSubmission === '确认一次', selectedCardRemains: Boolean(local.store.get(local.OIt, local.scope)) };
assert(localResult.answerRecognized && !localResult.selectedCardRemains);

console.log(JSON.stringify({ readOnly: true, runtimeUiTest: false,
  assets: Object.values(assets).map(({ name, sha256 }) => ({ name, sha256 })), locations,
  sameTurnExternalAnswer: sameResult, nextTurnExternalAnswer: nextResult, localSubmitCallback: localResult,
}, null, 2));
