'use strict';

// Isolated experiment only. No Codex process, production state, or relay is used.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PREFIX = '/question-prototype';
const DATA_ROOT = path.resolve(__dirname, '../../output/question-prototype');
const publicFiles = { '/': ['index.html', 'text/html'], '/client.js': ['client.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function normalizeQuestion(input) {
  if (!input || !validId(input.id) || !validId(input.threadId) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000) {
    throw fail(400, 'INVALID_QUESTION', '问题编号、会话编号或问题内容无效。');
  }
  const options = input.options ?? [];
  if (!Array.isArray(options) || options.length > 8 || options.some(item => !item || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 500 || Object.keys(item).some(key=>!['label','description'].includes(key)) || (item.description != null && (typeof item.description !== 'string' || item.description.length > 1000)))) {
    throw fail(400, 'INVALID_OPTIONS', '选项格式无效。');
  }
  return { id: input.id, threadId: input.threadId, prompt: input.prompt, options: options.map(item => ({ label: item.label, description: item.description || '' })) };
}

function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, spec TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS answers (question_id TEXT PRIMARY KEY REFERENCES questions(id), request_id TEXT NOT NULL,
      value TEXT NOT NULL, client TEXT NOT NULL, accepted_at TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS events (revision INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL REFERENCES questions(id), kind TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (question_id TEXT PRIMARY KEY REFERENCES answers(question_id), consumer_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL, delivery_id TEXT NOT NULL UNIQUE, claimed_at TEXT NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO metadata VALUES (1, ?)').run(randomUUID());
  const instance = db.prepare('SELECT instance FROM metadata').get().instance;
  function transaction(fn, write = true) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function snapshot() {
    return transaction(() => ({ instance, revision: db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM events').get().n,
      questions: db.prepare(`SELECT q.spec, q.created_at, a.request_id, a.value, a.client, a.accepted_at, a.receipt_id
        FROM questions q LEFT JOIN answers a ON a.question_id=q.id ORDER BY q.rowid`).all().map(row => ({
        ...JSON.parse(row.spec), createdAt: row.created_at, answer: row.receipt_id ? {
          requestId: row.request_id, value: row.value, client: row.client, acceptedAt: row.accepted_at, receiptId: row.receipt_id,
        } : null,
      })),
    }), false);
  }
  function create(input) {
    const spec = normalizeQuestion(input), serialized = JSON.stringify(spec);
    return transaction(() => {
      const existing = db.prepare('SELECT spec FROM questions WHERE id=?').get(spec.id);
      if (existing) {
        if (existing.spec !== serialized) throw fail(409, 'QUESTION_ID_REUSED', '同一问题编号不能用于不同内容。');
        return false;
      }
      db.prepare('INSERT INTO questions VALUES (?, ?, ?)').run(spec.id, serialized, new Date().toISOString());
      db.prepare("INSERT INTO events (question_id,kind) VALUES (?, 'created')").run(spec.id);
      return true;
    });
  }
  function answer(id, input) {
    if (!input || !validId(input.requestId) || typeof input.value !== 'string' || !input.value.trim() || input.value.length > 16000 || !['phone', 'desktop'].includes(input.client)) {
      throw fail(400, 'INVALID_ANSWER', '回答内容或提交编号无效。');
    }
    return transaction(() => {
      if (!db.prepare('SELECT id FROM questions WHERE id=?').get(id)) throw fail(404, 'QUESTION_NOT_FOUND', '问题不存在。');
      const existing = db.prepare('SELECT * FROM answers WHERE question_id=?').get(id);
      if (existing) {
        if (existing.request_id === input.requestId && existing.value === input.value && existing.client === input.client) return { accepted: false, duplicate: true };
        throw fail(409, existing.request_id === input.requestId ? 'REQUEST_ID_REUSED' : 'QUESTION_ALREADY_ANSWERED', '这个问题已经回答，请查看同步后的结果。');
      }
      db.prepare('INSERT INTO answers VALUES (?, ?, ?, ?, ?, ?)').run(id, input.requestId, input.value, input.client, new Date().toISOString(), randomUUID());
      db.prepare("INSERT INTO events (question_id,kind) VALUES (?, 'answered')").run(id);
      return { accepted: true, duplicate: false };
    });
  }
  function claimDelivery(id, input) {
    if (!input || !validId(input.consumerId) || !validId(input.invocationId)) throw fail(400, 'INVALID_CONSUMER', '工具调用编号无效。');
    return transaction(() => {
      const answered = db.prepare('SELECT * FROM answers WHERE question_id=?').get(id);
      if (!answered) throw fail(409, 'ANSWER_NOT_READY', '问题尚未回答。');
      const prior = db.prepare('SELECT * FROM deliveries WHERE question_id=?').get(id);
      if (prior) return { status:'already_claimed', questionId:id, receiptId:answered.receipt_id, deliveryId:prior.delivery_id };
      const deliveryId = randomUUID();
      db.prepare('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?)').run(id, input.consumerId, input.invocationId, deliveryId, new Date().toISOString());
      return { status:'answer', questionId:id, receiptId:answered.receipt_id, deliveryId, value:answered.value, client:answered.client };
    });
  }
  return { snapshot, create, answer, claimDelivery, close: () => db.close() };
}

function prepareDirectory(directory) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const root = fs.realpathSync(DATA_ROOT);
  const target = directory ? path.resolve(directory) : fs.mkdtempSync(path.join(root, 'PROTOTYPE-'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Prototype data must be in a child of output/question-prototype.');
  fs.mkdirSync(target, { recursive: true });
  const real = fs.realpathSync(target), realRelative = path.relative(root, real);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('Prototype data directory escapes its root.');
  return real;
}

async function startPrototype({ port = 0, directory, token = randomBytes(32).toString('base64url'), toolToken = randomBytes(32).toString('base64url'), toolBinding = null, demo = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || [8787, 8788].includes(port)) throw new Error('Choose an isolated port, not a production port.');
  if (toolBinding && (!validId(toolBinding.questionId) || !validId(toolBinding.threadId))) throw new Error('Invalid tool scope.');
  const dataDirectory = prepareDirectory(directory);
  const store = openStore(path.join(dataDirectory, 'PROTOTYPE-questions.sqlite'));
  if (demo) store.create({ id: 'preview-question', threadId: 'isolated-preview', prompt: '这张提问卡片的显示与交互是否符合预期？', options: [
    { label: '显示正常', description: '选项、输入和发送都清楚。' }, { label: '需要调整', description: '可以在下方补充你的建议。' },
  ] });
  let origin, cookieName;
  const secretMatches = (value, secret = token) => {
    const candidate = Buffer.from(value || ''), expected = Buffer.from(secret);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  };
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const body = async req => {
    let size = 0, chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw fail(413, 'BODY_TOO_LARGE', '内容过长。');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail(400, 'INVALID_JSON', '请求格式无效。'); }
  };
  const server = http.createServer(async (req, res) => {
    let toolRequest = false;
    const scopedSnapshot = () => {
      const snapshot = store.snapshot();
      if (toolRequest) snapshot.questions = snapshot.questions.filter(question=>question.id === toolBinding?.questionId);
      return snapshot;
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) throw fail(403, 'ORIGIN_DENIED', '来源无效。');
      const url = new URL(req.url, origin);
      const route = url.pathname.slice(PREFIX.length);
      if (!url.pathname.startsWith(`${PREFIX}/`)) throw fail(404, 'NOT_FOUND', '页面不存在。');
      if (req.method === 'GET' && publicFiles[route]) {
        const [file, type] = publicFiles[route];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(fs.readFileSync(path.join(__dirname, file)));
      }
      if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) throw fail(415, 'JSON_REQUIRED', '请求必须为 JSON。');
      if (route === '/api/session' && req.method === 'POST') {
        if (!secretMatches((await body(req)).token)) throw fail(401, 'UNAUTHORIZED', '访问链接已失效。');
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${PREFIX}/`);
        return send(res, 200, { ok: true });
      }
      const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim());
      const cookie = cookies.find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const authorization = req.headers.authorization?.replace(/^Bearer /, '');
      const isTool = secretMatches(authorization, toolToken);
      toolRequest = isTool;
      if (!isTool && !secretMatches(authorization) && !secretMatches(cookie)) throw fail(401, 'UNAUTHORIZED', '请用启动窗口里的访问链接打开。');
      if (route === '/api/questions' && req.method === 'GET') {
        return send(res, 200, scopedSnapshot());
      }
      if (route === '/api/questions' && req.method === 'POST') {
        const input = await body(req);
        if (isTool && (input.id !== toolBinding?.questionId || input.threadId !== toolBinding?.threadId)) throw fail(403, 'TOOL_SCOPE_DENIED', '工具不能操作其他问题。');
        const created = store.create(input);
        return send(res, created ? 201 : 200, { created, ...scopedSnapshot() });
      }
      const match = /^\/api\/questions\/([a-zA-Z0-9_-]{1,100})\/(answer|result|claim-delivery)$/.exec(route);
      if (isTool && match && (match[1] !== toolBinding?.questionId || match[2] === 'answer')) throw fail(403, 'TOOL_SCOPE_DENIED', '提问工具不能代替用户回答或操作其他问题。');
      if (match?.[2] === 'claim-delivery' && req.method === 'POST') {
        if (!isTool) throw fail(403, 'TOOL_ONLY', '只有提问工具可以领取结果。');
        const input = await body(req);
        if (input.consumerId !== toolBinding.threadId) throw fail(403, 'TOOL_SCOPE_DENIED', '工具不能领取其他会话的结果。');
        return send(res, 200, store.claimDelivery(match[1], input));
      }
      if (match?.[2] === 'answer' && req.method === 'POST') {
        const result = store.answer(match[1], await body(req));
        return send(res, 200, { ...result, ...store.snapshot() });
      }
      if (match?.[2] === 'result' && req.method === 'GET') {
        const snapshot = store.snapshot(), question = snapshot.questions.find(item => item.id === match[1]);
        if (!question) throw fail(404, 'QUESTION_NOT_FOUND', '问题不存在。');
        return send(res, 200, { instance: snapshot.instance, revision: snapshot.revision, question });
      }
      throw fail(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      const status = error.status || 503;
      const canonical = status === 409 ? scopedSnapshot() : {};
      if (!res.headersSent) send(res, status, { code: error.code || 'STORE_UNAVAILABLE', message: error.status ? error.message : '暂时无法保存，请核对状态后重试。', ...canonical });
      else res.end();
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { store.close(); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  cookieName = `codex_question_prototype_${server.address().port}`;
  return { origin, baseUrl: `${origin}${PREFIX}`, token, toolToken, directory: dataDirectory, store,
    close: async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); store.close(); },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  startPrototype({ port: Number(value('--port') || 18789), directory: value('--data-dir'), demo: true }).then(service => {
    console.log(`Isolated question prototype\nData: ${service.directory}\nDesktop: ${service.baseUrl}/?client=desktop#key=${service.token}\nPhone view: ${service.baseUrl}/?client=phone#key=${service.token}`);
    let closing = false;
    const stop = () => { if (!closing) { closing = true; service.close().then(() => process.exit(0)); } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { startPrototype, openStore, normalizeQuestion, DATA_ROOT };
