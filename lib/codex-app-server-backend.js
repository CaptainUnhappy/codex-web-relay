'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { canonicalProjectPath, projectPathKey } = require('./project-path');
const { MAX_STEPS, itemProgress, planProgress, upsertProgress, mergeProgress } = require('./codex-progress');
const { readableQuestionReply, questionReplies } = require('./user-input');
const { quotaFromAccount, contextFromTokenUsage } = require('./codex-usage');
const { permissionOptions } = require('./codex-permissions');

const MUTATING_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'thread/archive',
  'thread/unarchive',
  'thread/name/set',
  'thread/settings/update',
  'thread/goal/set',
  'thread/goal/clear',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/queue/add',
  'thread/queue/update',
  'thread/queue/delete',
  'thread/queue/reorder',
  'thread/queue/start',
]);

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'execCommandApproval',
  'applyPatchApproval',
]);

const REQUEST_FAILURE_PAUSES_QUEUE = new Set([
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/queue/start',
]);

const UNKNOWN_OUTCOME_PAUSES_QUEUE = new Set([
  ...REQUEST_FAILURE_PAUSES_QUEUE,
  'thread/resume',
  'thread/queue/delete',
]);

function errorWithCode(message, code, status = 500, detail = '') {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (detail) error.detail = detail;
  return error;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function timestamp(value, fallback = '') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function inputText(input) {
  const rows = Array.isArray(input) ? input : [];
  return rows.map(item => {
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'text') return asString(item.text);
    if (item.type === 'localImage') return '';
    return asString(item.text || item.content);
  }).filter(Boolean).join('\n');
}

function inputAttachments(input) {
  const rows = Array.isArray(input) ? input : [];
  return rows.filter(item => item && item.type === 'localImage' && item.path).map(item => ({
    filePath: asString(item.path),
    name: path.basename(asString(item.path)),
  }));
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return '';
    return asString(item.text || item.content || item.output_text);
  }).filter(Boolean).join('\n');
}

function itemText(item) {
  if (!item || typeof item !== 'object') return '';
  return asString(item.text) || contentText(item.content) || inputText(item.input);
}

function turnStatus(turn) {
  const raw = typeof turn?.status === 'string' ? turn.status : turn?.status?.type;
  return asString(raw).toLowerCase();
}

function threadStatus(thread) {
  const raw = typeof thread?.status === 'string' ? thread.status : thread?.status?.type;
  return asString(raw).toLowerCase();
}

function isActiveThread(thread) {
  return threadStatus(thread) === 'active';
}

function isPlaceholderName(value) {
  const text = asString(value).trim().toLowerCase();
  return !text || text === 'untitled' || text === 'untitled thread' || text === '未命名线程' || text === 'new thread';
}

function shortTitle(value, limit = 48) {
  const text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function displayNameForThread(thread) {
  const explicit = asString(thread?.name).trim();
  if (!isPlaceholderName(explicit)) return explicit;
  const preview = shortTitle(thread?.preview);
  if (preview) return preview;
  const created = timestamp(thread?.createdAt || thread?.created_at);
  const suffix = created ? new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(created)) : '';
  return suffix ? `新对话 · ${suffix}` : '新对话';
}

function looksGeneratedProjectlessPath(value) {
  return /[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}(?:[\\/]|$)/i.test(asString(value));
}

function projectFields(thread, project = null) {
  const cwd = asString(thread?.cwd);
  if (looksGeneratedProjectlessPath(cwd) || (project?.roots || []).some(root => looksGeneratedProjectlessPath(root?.path))) {
    return {
      isProjectThread: false,
      projectKey: '__conversations__',
      projectName: '对话',
      projectPath: '',
    };
  }
  if (project && !project.roots?.some(root => looksGeneratedProjectlessPath(root?.path))) {
    const roots = (project.roots || []).map(root => canonicalProjectPath(root?.path)).filter(Boolean);
    const key = projectPathKey(canonicalProjectPath(cwd));
    const projectPath = roots.find(root => key === projectPathKey(root) || key.startsWith(`${projectPathKey(root)}${path.sep}`)) || roots[0] || canonicalProjectPath(cwd);
    return {
      isProjectThread: true,
      projectKey: projectPathKey(projectPath) || asString(project.id),
      projectName: asString(project.name) || path.basename(projectPath) || '项目',
      projectPath,
    };
  }
  const projectId = thread?.projectId == null ? '' : asString(thread.projectId);
  if (!projectId) {
    return {
      isProjectThread: false,
      projectKey: '__conversations__',
      projectName: '对话',
      projectPath: '',
    };
  }
  const projectPath = canonicalProjectPath(cwd);
  const projectName = path.basename(projectPath) || shortTitle(projectId, 40) || '项目';
  return {
    isProjectThread: true,
    projectKey: projectPathKey(projectPath) || projectId,
    projectName,
    projectPath,
  };
}

function normalizeThread(thread, project = null) {
  const updatedAt = timestamp(thread?.recencyAt || thread?.updatedAt || thread?.updated_at || thread?.createdAt || thread?.created_at, new Date(0).toISOString());
  const status = threadStatus(thread);
  const active = status === 'active';
  return {
    id: asString(thread?.id),
    name: displayNameForThread(thread),
    nameSource: isPlaceholderName(thread?.name) ? (thread?.preview ? 'preview' : 'created_at') : 'app_server',
    updatedAt,
    effectiveUpdatedAt: updatedAt,
    effectiveUpdatedMs: Date.parse(updatedAt) || 0,
    cwd: asString(thread?.cwd),
    source: typeof thread?.source === 'string' ? thread.source : asString(thread?.source?.type),
    parentThreadId: asString(thread?.parentThreadId),
    forkedFromId: asString(thread?.forkedFromId),
    projectId: thread?.projectId == null ? null : thread.projectId,
    runtimeStatus: active ? 'running' : status === 'systemerror' ? 'error' : 'idle',
    runtimeActive: active,
    runtimeTurnId: asString(thread?.turns?.[thread.turns.length - 1]?.id),
    pinned: false,
    ...projectFields(thread, project),
  };
}

function historyMessages(thread, limit = 120) {
  const messages = [];
  for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
    const startedAt = timestamp(turn.startedAt || turn.createdAt);
    const completedAt = timestamp(turn.completedAt || turn.updatedAt);
    const durationMs = startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : 0;
    const duration = durationMs ? `${Math.floor(durationMs / 60000) ? `${Math.floor(durationMs / 60000)}m ` : ''}${Math.floor(durationMs / 1000) % 60}s` : '';
    for (const [index, item] of (Array.isArray(turn.items) ? turn.items : []).entries()) {
      const id = `${turn.id}:${item?.id || index}`;
      if (item?.type === 'userMessage') {
        const content = item.content || item.input || [];
        const text = contentText(content) || inputText(content);
        const replies = questionReplies(text);
        const attachments = inputAttachments(content);
        if (text || attachments.length) messages.push({
          id,
          role: 'user',
          label: attachments.length ? `你 · ${attachments.length} 张图片` : '你',
          text: readableQuestionReply(text) || ' ',
          ...(replies.length ? { questionReplies: replies } : {}),
          attachments,
          timestamp: timestamp(item.createdAt, startedAt),
        });
      }
      if (item?.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer' || item.phase === 'finalAnswer')) {
        const text = itemText(item);
        if (text) messages.push({
          id,
          role: 'assistant',
          label: duration ? `Codex · 已处理 ${duration}` : 'Codex',
          text,
          timestamp: timestamp(item.createdAt, completedAt || startedAt),
        });
      }
    }
  }
  return limit === Infinity ? messages : messages.slice(-Math.max(1, Math.min(Number(limit) || 120, 240)));
}

function lastAgentText(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === 'agentMessage') {
      const text = itemText(items[index]);
      if (text) return text;
    }
  }
  return '';
}

class CodexAppServerBackend extends EventEmitter {
  constructor(options = {}) {
    super();
    this.resolveCli = options.resolveCli;
    this.spawnCli = options.spawnCli;
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 45000);
    this.maxConcurrency = 1;
    this.ownedThreadId = '';
    this.sessionClaimPending = false;
    this.disconnectPromise = null;
    this.connectionStopping = false;
    this.shutdownTimeoutMs = Number(options.shutdownTimeoutMs || 10000);
    this.clientName = options.clientName || 'codex-mini';
    this.clientVersion = options.clientVersion || '1';
    this.classifyProject = typeof options.classifyProject === 'function' ? options.classifyProject : null;
    this.child = null;
    this.cleanupChild = null;
    this.connecting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.reverseRequests = new Map();
    this.threadRuntime = new Map();
    this.queueThreads = new Set();
    this.pausedQueues = new Set();
    this.uncertainOperations = new Map();
    this.schedulerTail = Promise.resolve();
    this.dispatchPromise = null;
    this.reconnectTimer = null;
    this.closing = false;
    this.stderr = '';
    this.projectsCache = { at: 0, data: [] };
    this.knownProjectlessThreads = new Set();
    this.historyPages = new Map();
    this.writerRetryMs = Math.max(25, Number(options.writerRetryMs) || 15000);
    this.desktopHandoffs = new Set(options.savedDesktopHandoffs || []);
    this.saveDesktopHandoffs = options.saveDesktopHandoffs || (() => {});
    this.writerWaits = new Map((options.savedWriterWaits || []).filter(id => !this.desktopHandoffs.has(id)).map(threadId => [threadId, 0]));
    for (const id of this.desktopHandoffs) this.pausedQueues.add(id);
    for (const threadId of this.writerWaits.keys()) this.queueThreads.add(threadId);
    this.saveWriterWaits = options.saveWriterWaits || (() => {});
    this.writerRetryTimer = null;
    this.sessionIdleMs = options.sessionIdleMs ?? 60000;
    this.readIdleMs = options.readIdleMs ?? 10000;
    this.idleTimer = null;
    this.lastSessionActivityAt = Date.now();
    this.lastConnectionActivityAt = Date.now();
    this.idleRetryAt = 0;
    this.lastReleasedAt = '';
    this.lastReleaseReason = '';
    this.threadListCache = new Map();
    this.configCache = new Map();
    this.accountQuotaCache = null;
    this.accountQuotaRequest = null;
    this.accountQuotaVersion = 0;
    this.permissionSnapshots = new Map();
    this.readCacheVersion = 0;
  }

  connectionStatus() {
    return {
      connected: Boolean(this.child && !this.child.killed && !this.connectionStopping),
      approvals: this.reverseRequests.size,
      uncertainOperations: this.uncertainOperations.size,
      maxConcurrency: this.maxConcurrency,
      ownedThreadId: this.ownedThreadId,
      sessionLimit: 1,
      releasing: this.connectionStopping,
      idleReleaseSeconds: this.sessionIdleMs / 1000,
      lastReleasedAt: this.lastReleasedAt,
      lastReleaseReason: this.lastReleaseReason,
    };
  }

  async start() {
    await this.ensureConnected();
    return this.connectionStatus();
  }

  async ensureConnected() {
    if (this.closing) throw errorWithCode('Codex Mini 后台已关闭。', 'CODEX_APP_SERVER_CLOSED', 503);
    if (this.disconnectPromise) await this.disconnectPromise;
    if (this.connectionStopping) throw errorWithCode('仍在释放 Mini 会话，请稍后重试。', 'MINI_SESSION_RELEASING', 409);
    if (this.child && !this.child.killed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; this._scheduleIdleRelease(); });
    return this.connecting;
  }

  async _connect() {
    if (typeof this.resolveCli !== 'function' || typeof this.spawnCli !== 'function') {
      throw errorWithCode('Codex App Server 启动器未配置。', 'CODEX_APP_SERVER_NOT_CONFIGURED', 500);
    }
    const cli = await this.resolveCli();
    if (!cli?.available || !cli.command) {
      throw errorWithCode('没有找到可用的 Codex CLI，无法启动 Codex App Server。', 'CODEX_APP_SERVER_NOT_AVAILABLE', 409, (cli?.errors || []).join('\n'));
    }
    const spawned = this.spawnCli(cli.command, ['app-server', '--listen', 'stdio://'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = spawned.child;
    this.cleanupChild = spawned.cleanup || null;
    this.stderr = '';
    this._attachStreams(this.child);
    await this._requestRaw('initialize', {
      clientInfo: { name: this.clientName, version: this.clientVersion },
      capabilities: { experimentalApi: true },
    }, { mutating: false, timeoutMs: this.requestTimeoutMs });
    this._write({ method: 'initialized', params: {} });
    this.emit('connected');
    this._scheduleWriterRetry();
  }

  _attachStreams(child) {
    let buffer = '';
    child.stdin.on('error', error => this.emit('protocolError', error));
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this._handleMessage(JSON.parse(line)); } catch (error) { this.emit('protocolError', error); }
      }
    });
    child.stdout.on('end', () => {
      if (!buffer.trim()) return;
      try { this._handleMessage(JSON.parse(buffer)); } catch (error) { this.emit('protocolError', error); }
      buffer = '';
    });
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-24000);
    });
    child.on('error', error => { if (this.child === child) this._handleDisconnect(error); });
    child.on('close', code => { if (this.child === child) this._handleDisconnect(errorWithCode(
      this.stderr.trim() || `Codex App Server exited with code ${code}`,
      'CODEX_APP_SERVER_DISCONNECTED',
      503,
    )); });
  }

  _handleDisconnect(error) {
    if (!this.child) return;
    const intentionallyStopped = this.connectionStopping;
    const needsReconnect = Boolean(this.ownedThreadId || this.writerWaits.size);
    const cleanup = this.cleanupChild;
    this.child = null;
    this.cleanupChild = null;
    this.ownedThreadId = '';
    this.sessionClaimPending = false;
    this.connectionStopping = false;
    this.reverseRequests.clear();
    this.accountQuotaCache = null;
    this.accountQuotaVersion++;
    if (cleanup) cleanup();
    for (const runtime of this.threadRuntime.values()) runtime.live = false;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      const rejected = entry.mutating
        ? this._unknownError(entry.method, entry.params, '连接在收到确认前中断。')
        : errorWithCode(error.message || 'Codex App Server 连接已中断。', 'CODEX_APP_SERVER_DISCONNECTED', 503);
      entry.reject(rejected);
    }
    this.emit('disconnected', error);
    if (!this.closing && !intentionallyStopped && needsReconnect && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureConnected().catch(reconnectError => this.emit('reconnectError', reconnectError));
      }, 2000);
    }
  }

  _write(message) {
    if (!this.child?.stdin || this.child.killed || this.connectionStopping || this.child.stdin.writableEnded) {
      throw errorWithCode('Codex App Server 连接不可用。', 'CODEX_APP_SERVER_DISCONNECTED', 503);
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _unknownError(method, params, detail) {
    const operationId = `unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.uncertainOperations.set(operationId, {
      id: operationId,
      method,
      threadId: asString(params?.threadId),
      params,
      createdAt: new Date().toISOString(),
      detail,
    });
    const threadId = asString(params?.threadId);
    if (threadId && UNKNOWN_OUTCOME_PAUSES_QUEUE.has(method)) this.pausedQueues.add(threadId);
    return errorWithCode('操作结果尚未确认，请先刷新线程记录再决定是否重试。', 'CODEX_APP_SERVER_OUTCOME_UNKNOWN', 409, operationId);
  }

  async _withSchedulerLock(operation) {
    const previous = this.schedulerTail;
    let release;
    this.schedulerTail = new Promise(resolve => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      this._scheduleIdleRelease();
    }
  }

  _requestRaw(method, params = {}, options = {}) {
    const mutating = options.mutating ?? MUTATING_METHODS.has(method);
    if (mutating) { this.threadListCache.clear(); this.readCacheVersion++; }
    if (method === 'thread/settings/update') this.configCache.clear();
    const timeoutMs = Number(options.timeoutMs || this.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(mutating
          ? this._unknownError(method, params, `等待 ${method} 确认超时。`)
          : errorWithCode(`Codex App Server request ${method} timed out.`, 'CODEX_APP_SERVER_TIMEOUT', 504));
      }, timeoutMs);
      this.pending.set(id, { method, params, mutating, resolve, reject, timer });
      try {
        this._write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(mutating ? this._unknownError(method, params, error.message) : error);
      }
    });
  }

  async request(method, params = {}, options = {}) {
    await this.ensureConnected();
    try { return await this._requestRaw(method, params, options); }
    finally { this.lastConnectionActivityAt = Date.now(); this._scheduleIdleRelease(); }
  }

  setIdleReleaseSeconds(seconds) {
    this.sessionIdleMs = seconds * 1000;
    this._scheduleIdleRelease();
  }

  _touchSessionActivity() {
    this.lastSessionActivityAt = Date.now();
    this.idleRetryAt = 0;
  }

  _idleDelay() {
    if (this.closing || !this.child || this.connecting || this.connectionStopping || this.pending.size || this.sessionClaimPending || this.reverseRequests.size) return null;
    if (this.ownedThreadId && (this._runtime(this.ownedThreadId).status === 'running'
      || [...this.uncertainOperations.values()].some(item => !item.threadId || item.threadId === this.ownedThreadId))) return null;
    if (!this.ownedThreadId && this.writerWaits.size) return null;
    const due = this.ownedThreadId ? this.lastSessionActivityAt + this.sessionIdleMs : this.lastConnectionActivityAt + this.readIdleMs;
    return Math.max(0, Math.max(due, this.idleRetryAt) - Date.now());
  }

  _scheduleIdleRelease() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const delay = this._idleDelay();
    if (delay === null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this._withSchedulerLock(async () => {
        const remaining = this._idleDelay();
        if (remaining === null || remaining > 0) return;
        const owner = this.ownedThreadId;
        if (owner && this.queueThreads.has(owner) && !this.pausedQueues.has(owner) && !this.writerWaits.has(owner)) {
          const queue = await this.listQueue(owner);
          if (queue.data.length) { await this._continueQueueUnlocked(owner, false); return; }
        }
        if (this.ownedThreadId) await this._releaseSessionUnlocked('idle');
        else await this._disconnectOwnedProcess();
      }).catch(error => {
        this.idleRetryAt = Date.now() + 15000;
        this.emit('dispatchError', error);
        this._scheduleIdleRelease();
      });
    }, Math.max(10, delay));
    this.idleTimer.unref?.();
  }

  _handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const writerBusy = message.error.code === -32600
          && ['thread/resume', 'turn/start', 'thread/queue/start'].includes(entry.method)
          && /^thread [\w-]+ already has an active writer\b/i.test(message.error.message || '');
        const error = errorWithCode(
          writerBusy ? '这个任务正由桌面端或另一个客户端占用。' : message.error.message || `${entry.method} failed`,
          writerBusy ? 'THREAD_WRITER_BUSY' : message.error.code || 'CODEX_APP_SERVER_REQUEST_FAILED',
          writerBusy ? 409 : message.error.code === -32601 ? 501 : 500,
          JSON.stringify(message.error),
        );
        const threadId = asString(entry.params?.threadId);
        if (threadId && !writerBusy && REQUEST_FAILURE_PAUSES_QUEUE.has(entry.method)) this.pausedQueues.add(threadId);
        entry.reject(error);
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
      const method = asString(message.method);
      if (APPROVAL_METHODS.has(method)) {
        this.reverseRequests.set(String(message.id), {
          id: String(message.id),
          method,
          params: message.params || {},
          createdAt: new Date().toISOString(),
          submittedAt: '',
        });
        this.emit('approval', this.reverseRequests.get(String(message.id)));
      } else if (method === 'currentTime/read') {
        this._write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      } else {
        this._write({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
      }
      return;
    }
    if (message.method) this._handleNotification(asString(message.method), message.params || {});
  }

  _runtime(threadId) {
    if (!this.threadRuntime.has(threadId)) {
      this.threadRuntime.set(threadId, {
        threadId,
        turnId: '',
        status: 'idle',
        live: false,
        startedAt: '',
        completedAt: '',
        updatedAt: '',
        preview: '',
        previewItemId: '',
        final: '',
        error: '',
        steps: [],
      });
    }
    return this.threadRuntime.get(threadId);
  }

  _beginTurn(threadId, turn) {
    if (threadId === this.ownedThreadId) this._touchSessionActivity();
    const runtime = this._runtime(threadId);
    const turnId = asString(turn?.id);
    if (runtime.turnId !== turnId) Object.assign(runtime, {
      preview: '', previewItemId: '', final: '', error: '', steps: [], completedAt: '',
    });
    runtime.turnId = turnId;
    runtime.status = 'running';
    runtime.live = true;
    runtime.startedAt = timestamp(turn?.startedAt, new Date().toISOString());
    return runtime;
  }

  _handleNotification(method, params) {
    const threadId = asString(params.threadId || params.thread?.id);
    if (method === 'account/rateLimits/updated') {
      this.accountQuotaVersion++;
      this.accountQuotaCache = { at: Date.now(), value: quotaFromAccount(params) };
    }
    if (method === 'account/updated') { this.accountQuotaVersion++; this.accountQuotaCache = null; }
    if (method === 'thread/tokenUsage/updated' && threadId) {
      this._runtime(threadId).context = contextFromTokenUsage(params.tokenUsage);
      this._runtime(threadId).context.updatedAt = new Date().toISOString();
    }
    if (method === 'serverRequest/resolved') {
      const requestId = String(params.requestId ?? '');
      if (requestId) {
        this.reverseRequests.delete(requestId);
        this.emit('approvalResolved', { threadId, requestId });
      }
    }
    if (method === 'thread/queue/changed' && threadId) {
      this.queueThreads.add(threadId);
      this.emit('queueChanged', { threadId });
    }
    if (threadId) {
      const runtime = this._runtime(threadId);
      runtime.updatedAt = new Date().toISOString();
      const turnId = asString(params.turnId || params.turn?.id);
      if ((method.startsWith('item/') || method === 'turn/plan/updated') && turnId && runtime.turnId && turnId !== runtime.turnId) {
        this.emit('notification', { method, params });
        return;
      }
      if (method === 'turn/started') {
        this._beginTurn(threadId, { ...params.turn, id: turnId });
      } else if (method === 'item/agentMessage/delta') {
        if (!runtime.turnId) runtime.turnId = turnId;
        if (runtime.previewItemId !== params.itemId) runtime.preview = '';
        runtime.previewItemId = asString(params.itemId);
        runtime.preview += asString(params.delta || params.text);
        upsertProgress(runtime.steps, itemProgress({ id: runtime.previewItemId, type: 'agentMessage', text: runtime.preview }, { time: runtime.updatedAt }));
      } else if (method === 'item/started' || method === 'item/completed') {
        if (!runtime.turnId) runtime.turnId = turnId;
        const item = params.item;
        const completed = method === 'item/completed';
        if (item?.type === 'agentMessage') {
          if (runtime.previewItemId !== item.id) runtime.preview = '';
          runtime.previewItemId = asString(item.id);
          runtime.preview = itemText(item) || runtime.preview;
          if (completed && (item.phase === 'final_answer' || item.phase === 'finalAnswer')) runtime.final = runtime.preview;
        }
        upsertProgress(runtime.steps, itemProgress(item, { completed, time: runtime.updatedAt }));
      } else if (method === 'turn/plan/updated') {
        if (!runtime.turnId) runtime.turnId = turnId;
        upsertProgress(runtime.steps, planProgress(runtime.turnId, params.plan, runtime.updatedAt));
      } else if (method === 'turn/completed') {
        if (threadId === this.ownedThreadId) this._touchSessionActivity();
        const status = turnStatus(params.turn);
        runtime.turnId = asString(params.turn?.id) || runtime.turnId;
        runtime.completedAt = timestamp(params.turn?.completedAt, runtime.updatedAt);
        if (status === 'failed') {
          runtime.status = 'error';
          runtime.error = asString(params.turn?.error?.message || params.error?.message) || 'Codex 回复失败。';
          this.pausedQueues.add(threadId);
        } else if (status === 'interrupted') {
          runtime.status = 'interrupted';
          runtime.error = '已中断当前 Codex 回复。';
          this.pausedQueues.add(threadId);
        } else if (status === 'completed') {
          runtime.status = 'complete';
          runtime.final = lastAgentText(params.turn) || runtime.final || runtime.preview;
          const outcomeUnknown = [...this.uncertainOperations.values()].some(operation => operation.threadId === threadId);
          if (outcomeUnknown) {
            this.pausedQueues.add(threadId);
          } else {
            this.pausedQueues.delete(threadId);
            setImmediate(() => this.dispatchWaitingQueues().catch(error => this.emit('dispatchError', error)));
          }
        } else {
          runtime.status = 'error';
          runtime.error = 'Codex 返回了无法确认的结束状态，队列已暂停。';
          this.pausedQueues.add(threadId);
        }
      } else if (method === 'thread/status/changed') {
        const status = typeof params.status === 'string' ? params.status : params.status?.type;
        if (status === 'active') runtime.status = 'running';
      }
    }
    this.emit('notification', { method, params });
    this._scheduleIdleRelease();
  }

  listApprovals(threadId = '') {
    return [...this.reverseRequests.values()]
      .filter(item => !threadId || item.params?.threadId === threadId || item.params?.conversationId === threadId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async respondApproval(id, response) {
    const key = String(id || '');
    const item = this.reverseRequests.get(key);
    if (!item) throw errorWithCode('这个审批请求已不存在或已经处理。', 'APPROVAL_NOT_FOUND', 404);
    if (item.submittedAt) throw errorWithCode('审批结果已经提交，正在等待 Codex 确认。', 'APPROVAL_PENDING_CONFIRMATION', 409);
    await this.ensureConnected();
    item.submittedAt = new Date().toISOString();
    item.response = response || {};
    try {
      this._write({ id: Number.isFinite(Number(key)) ? Number(key) : key, result: response || {} });
    } catch (error) {
      throw this._unknownError(item.method, item.params, error.message);
    }
    return item;
  }

  async readConfigAndModels(cwd = '') {
    const cached = this.configCache.get(cwd);
    if (cached && Date.now() - cached.at < 300000) return cached.value;
    const [configResult, modelResult] = await Promise.all([
      this.request('config/read', cwd ? { cwd, includeLayers: true } : { includeLayers: true }, { mutating: false }),
      this.request('model/list', { includeHidden: false, limit: 100 }, { mutating: false }),
    ]);
    const config = configResult.config || {};
    const models = (modelResult.data || []).filter(model => !model.hidden).map(model => ({
      key: asString(model.id),
      id: asString(model.id),
      label: asString(model.displayName || model.id),
      displayName: asString(model.displayName || model.id),
      isDefault: Boolean(model.isDefault),
      defaultReasoningEffort: asString(model.defaultReasoningEffort),
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [],
      source: 'official',
    }));
    const value = {
      config,
      origins: configResult.origins || {},
      models,
      effectiveApprovalPolicy: config.approval_policy,
      effectiveApprovalsReviewer: config.approvals_reviewer,
      defaultModel: config.model || models.find(model => model.isDefault)?.id || '',
      defaultReasoningEffort: config.model_reasoning_effort || '',
    };
    if (this.configCache.size >= 8) this.configCache.clear();
    this.configCache.set(cwd, { at: Date.now(), value });
    return value;
  }

  async accountQuota(force = false) {
    if (!force && this.accountQuotaCache && Date.now() - this.accountQuotaCache.at < 15000) return this.accountQuotaCache.value;
    if (this.accountQuotaRequest) return this.accountQuotaRequest;
    const version = this.accountQuotaVersion;
    const unknown = () => ({ available: false, source: 'account', updatedAt: new Date().toISOString() });
    this.accountQuotaRequest = this.request('account/rateLimits/read', {}, { mutating: false })
      .then(result => {
        if (version !== this.accountQuotaVersion) return this.accountQuotaCache?.value || unknown();
        const value = quotaFromAccount(result);
        this.accountQuotaCache = { at: Date.now(), value };
        return value;
      }).catch(() => {
        if (version !== this.accountQuotaVersion) return this.accountQuotaCache?.value || unknown();
        const value = unknown();
        this.accountQuotaCache = { at: Date.now(), value };
        return value;
      }).finally(() => { this.accountQuotaRequest = null; });
    return this.accountQuotaRequest;
  }

  async listProjects() {
    if (Date.now() - this.projectsCache.at < 5000) return this.projectsCache.data;
    const projects = [];
    let cursor = null;
    do {
      const result = await this.request('project/list', { cursor, limit: 100 }, { mutating: false });
      projects.push(...(result.data || []));
      cursor = result.nextCursor || null;
    } while (cursor && projects.length < 500);
    this.projectsCache = { at: Date.now(), data: projects };
    return projects;
  }

  async listThreads(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 80, 240));
    const archived = options.archived === true;
    const scope = options.scope || 'all';
    if (!['all', 'projects', 'conversations'].includes(scope)) throw errorWithCode('会话分类无效。', 'BAD_THREAD_SCOPE', 400);
    const cacheKey = JSON.stringify([limit, archived, options.cursor || null, scope]);
    const cached = this.threadListCache.get(cacheKey);
    if (options.useCache && cached && Date.now() - cached.at < 30000) return { ...cached.value, cached: true, cacheUpdatedAt: cached.at };
    const version = this.readCacheVersion;
    let cursor = options.cursor || null;
    const rawThreads = [];
    const normalizedById = new Map();
    let pagesRead = 0;
    const scanStartedAt = Date.now();
    const projects = await this.listProjects().catch(() => []);
    const projectById = new Map(projects.map(project => [asString(project.id), project]));
    const projectForThread = thread => {
      const explicit = projectById.get(asString(thread?.projectId));
      if (explicit) return explicit;
      const cwd = projectPathKey(canonicalProjectPath(thread?.cwd));
      if (!cwd) return null;
      return projects
        .filter(project => !(project.roots || []).some(root => looksGeneratedProjectlessPath(root?.path)))
        .map(project => ({
          project,
          matchLength: Math.max(0, ...(project.roots || []).map(root => {
            const rootPath = projectPathKey(canonicalProjectPath(root?.path));
            return rootPath && (cwd === rootPath || cwd.startsWith(`${rootPath}${path.sep}`)) ? rootPath.length : 0;
          })),
        }))
        .filter(entry => entry.matchLength > 0)
        .sort((a, b) => b.matchLength - a.matchLength)[0]?.project || null;
    };
    const normalizeListedThread = thread => {
      const normalized = normalizeThread(thread, projectForThread(thread));
      const forcedProjectless = this.knownProjectlessThreads.has(thread.id) || looksGeneratedProjectlessPath(thread.cwd);
      if (!forcedProjectless && !normalized.isProjectThread && this.classifyProject) {
        const classified = this.classifyProject(asString(thread.cwd)) || {};
        if (classified.isProjectThread) Object.assign(normalized, classified);
      }
      if (forcedProjectless) Object.assign(normalized, {
        isProjectThread: false,
        projectKey: '__conversations__',
        projectName: '对话',
        projectPath: '',
      });
      if (normalized.isProjectThread) {
        normalized.projectPath = canonicalProjectPath(normalized.projectPath || normalized.cwd);
        normalized.projectKey = projectPathKey(normalized.projectPath) || normalized.projectKey;
      }
      if (!normalized.isProjectThread) normalized.cwd = '';
      return normalized;
    };
    do {
      const result = await this.request('thread/list', {
        cursor,
        limit: Math.min(100, limit - rawThreads.length),
        archived,
        sortKey: 'recency_at',
        sortDirection: 'desc',
      }, { mutating: false });
      pagesRead++;
      for (const thread of result.data || []) {
        if (!thread?.id) continue;
        const runtime = this._runtime(thread.id);
        // List metadata may lag a turn/started notification. It must not erase
        // the live turn used by both progress display and the native scheduler.
        if (!runtime.turnId || !runtime.live) runtime.status = isActiveThread(thread) ? 'running' : 'idle';
        const normalized = normalizeListedThread(thread);
        if (scope !== 'all' && normalized.isProjectThread !== (scope === 'projects')) continue;
        rawThreads.push(thread);
        normalizedById.set(thread.id, normalized);
        if (rawThreads.length >= limit) break;
      }
      cursor = result.nextCursor || null;
      // Native cursors cover mixed categories. Older pages can each take seconds:
      // return partial matches promptly instead of chaining slow reads to fill a page.
    } while (cursor && rawThreads.length < limit && (scope === 'all' || (pagesRead < 4 && Date.now() - scanStartedAt < 1000)));
    const childrenByParent = new Map();
    for (const thread of rawThreads) {
      const parentId = asString(thread.parentThreadId || thread.forkedFromId);
      if (!parentId) continue;
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(normalizedById.get(thread.id));
    }
    const pageIds = new Set(rawThreads.map(thread => thread.id));
    const threads = rawThreads
      .filter(thread => !pageIds.has(thread.parentThreadId || thread.forkedFromId))
      .map(thread => ({
        ...normalizedById.get(thread.id),
        children: (childrenByParent.get(thread.id) || []).sort((a, b) => b.effectiveUpdatedMs - a.effectiveUpdatedMs),
      }));
    const value = { threads, nextCursor: cursor, scope };
    if (version === this.readCacheVersion) {
      if (this.threadListCache.size >= 16) this.threadListCache.delete(this.threadListCache.keys().next().value);
      this.threadListCache.set(cacheKey, { at: Date.now(), value });
    }
    return { ...value, cached: false, cacheUpdatedAt: Date.now() };
  }

  async readThread(threadId, includeTurns = true) {
    const result = await this.request('thread/read', { threadId, includeTurns }, { mutating: false });
    return result.thread || result;
  }

  async ensureThreadLoaded(threadId) {
    return this._withSchedulerLock(() => { this._touchSessionActivity(); return this._ensureThreadLoadedUnlocked(threadId); });
  }

  async _ensureThreadLoadedUnlocked(threadId) {
    this._assertSessionAvailable(threadId);
    const loaded = await this.request('thread/loaded/list', {}, { mutating: false });
    if (!Array.isArray(loaded.data)) throw errorWithCode('Codex App Server 未返回已加载的线程列表。', 'THREAD_LOAD_STATE_UNKNOWN', 502);
    this.ownedThreadId = threadId;
    try {
      if (!loaded.data.includes(threadId)) {
        const resumed = await this.request('thread/resume', { threadId, excludeTurns: true });
        const runtime = this._runtime(threadId);
        // A closed process can leave an unfinished turn in the display cache.
        // Use the new owner's confirmed state without overwriting live events.
        if (!runtime.live && ['idle', 'active'].includes(threadStatus(resumed.thread))) {
          runtime.status = isActiveThread(resumed.thread) ? 'running' : 'idle';
        }
      }
    } catch (error) {
      if (!['CODEX_APP_SERVER_OUTCOME_UNKNOWN', 'THREAD_WRITER_BUSY'].includes(error.code)) this.ownedThreadId = '';
      throw error;
    }
  }

  async readRecentTurns(threadId, limit, cursor = null) {
    const result = await this.request('thread/turns/list', {
      threadId, limit, ...(cursor ? { cursor } : {}), sortDirection: 'desc', itemsView: 'summary',
    }, { mutating: false });
    if (!Array.isArray(result.data)) throw errorWithCode('Codex App Server 未返回分页聊天记录，请更新 Codex CLI。', 'THREAD_HISTORY_UNAVAILABLE', 502);
    return result;
  }

  async history(threadId, options = {}, recent = null) {
    if (typeof options !== 'object' || options === null) options = { limit: options };
    const limit = Math.max(1, Math.min(Math.floor(Number(options.limit)) || 5, 240));
    for (const [key, page] of this.historyPages) {
      if (Date.now() - page.createdAt > 15 * 60 * 1000) this.historyPages.delete(key);
    }
    let page = { threadId, limit, remaining: [], nativeCursor: null };
    if (options.cursor) {
      page = this.historyPages.get(options.cursor);
      if (!page || page.threadId !== threadId || page.limit !== limit) {
        throw errorWithCode('较早记录的分页已过期，请刷新后重试。', 'HISTORY_CURSOR_EXPIRED', 410);
      }
      // Retries share the exact same page, including its continuation token.
      if (page.request) return page.request;
    }
    const request = this._historyPage(page, recent);
    page.request = request;
    try { return await request; }
    catch (error) { page.request = null; throw error; }
  }

  async _historyPage(page, recent) {
    const { threadId, limit } = page;
    const remaining = [...page.remaining]; // newest first; never mutate a retryable snapshot
    let nativeCursor = page.nativeCursor;
    let needsRead = remaining.length < limit && (!page.createdAt || Boolean(nativeCursor));
    // Bound work even for long stretches of tool-only turns. An empty page can
    // still have a cursor; the UI must keep the older-page action available.
    for (let reads = 0; needsRead && reads < 5; reads++) {
      const result = recent || await this.readRecentTurns(threadId, limit, nativeCursor);
      recent = null;
      remaining.push(...result.data.flatMap(turn => historyMessages({ turns: [turn] }, Infinity).reverse()));
      const previousCursor = nativeCursor;
      nativeCursor = result.nextCursor || null;
      if (nativeCursor && nativeCursor === previousCursor) throw errorWithCode('Codex 返回了重复的历史游标。', 'HISTORY_CURSOR_STALLED', 502);
      needsRead = remaining.length < limit && Boolean(nativeCursor);
    }
    const messages = remaining.splice(0, limit).reverse();
    let nextCursor = null;
    if (remaining.length || nativeCursor) {
      nextCursor = randomUUID();
      this.historyPages.set(nextCursor, { threadId, limit, remaining, nativeCursor, createdAt: Date.now() });
      while (this.historyPages.size > 24) this.historyPages.delete(this.historyPages.keys().next().value);
    }
    return {
      ok: true,
      available: true,
      threadId,
      sessionFile: '',
      truncated: Boolean(nextCursor),
      nextCursor,
      messages,
    };
  }

  async bootstrap(threadId, limit = 5) {
    limit = Math.max(1, Math.min(Math.floor(Number(limit)) || 5, 240));
    const recent = await this.readRecentTurns(threadId, limit);
    const [history, status] = await Promise.all([
      this.history(threadId, { limit }, recent),
      this.status(threadId, { data: recent.data.slice(0, 1) }).catch(error => ({ ok: false, code: error.code, message: error.message })),
    ]);
    return { ok: true, threadId, history, status };
  }

  async readGoal(threadId) {
    const { goal = null } = await this.request('thread/goal/get', { threadId }, { mutating: false });
    for (const [id, operation] of this.uncertainOperations) {
      if (operation.threadId !== threadId) continue;
      const { method, params } = operation;
      if (method === 'thread/goal/clear' && !goal
        || method === 'thread/goal/set' && goal && ['status', 'objective'].every(key => params[key] === undefined || params[key] === goal[key])) {
        this.uncertainOperations.delete(id);
      }
    }
    return goal;
  }

  async goalSnapshot(threadId) {
    try { return { goal: await this.readGoal(threadId) }; }
    catch (error) { return { goalError: error.message || '暂时无法读取目标。' }; }
  }

  async changeGoal(threadId, { action, objective, expectedGoal } = {}) {
    if (!['pause', 'resume', 'update', 'clear'].includes(action)) throw errorWithCode('目标操作不正确。', 'BAD_GOAL_ACTION', 400);
    if (action === 'update' && (typeof objective !== 'string' || !objective.trim() || objective.length > 20000)) {
      throw errorWithCode('请填写目标，最多 20000 个字符。', 'BAD_GOAL_OBJECTIVE', 400);
    }
    // A read or a goal edit must never resume/claim the thread's writer session.
    return this._withSchedulerLock(async () => {
      const current = await this.readGoal(threadId);
      if (!current) throw errorWithCode('这个目标已结束或已被清除，请刷新。', 'GOAL_NOT_FOUND', 409);
      if (!expectedGoal || ['createdAt', 'objective', 'status', 'tokenBudget'].some(key => current[key] !== expectedGoal[key])) {
        throw errorWithCode('目标已在其他设备更新，请确认最新内容后再操作。', 'GOAL_CHANGED', 409);
      }
      if (action === 'clear') {
        const result = await this.request('thread/goal/clear', { threadId, origin: 'user' });
        return { goal: null, cleared: result.cleared };
      }
      const params = { threadId, origin: 'user' };
      if (action === 'update') params.objective = objective.trim();
      else params.status = action === 'pause' ? 'paused' : 'active';
      if (action === 'resume' && current.status !== 'paused') throw errorWithCode('只能继续已暂停的目标。', 'GOAL_NOT_PAUSED', 409);
      return this.request('thread/goal/set', params);
    });
  }

  async status(threadId, recentTurns = null) {
    const goalSnapshot = this.goalSnapshot(threadId);
    const [thread, recent] = await Promise.all([this.readThread(threadId, false), recentTurns || this.readRecentTurns(threadId, 1)]).catch(error => {
      const runtime = this.threadRuntime.get(threadId);
      // A newly started turn can emit live events before its rollout is flushed.
      // Only the current owner's live events can bridge that specific read gap.
      const startingStore = /rollout at [^\r\n]+ is empty/.test(error.message)
        || (error.code === -32601 && error.message === 'list_turns is not supported yet');
      if (this.ownedThreadId !== threadId || !runtime?.live || !startingStore) throw error;
      return [{ id: threadId, status: { type: runtime.status === 'running' ? 'active' : 'idle' } }, { data: [] }];
    });
    const turns = recent.data;
    let turn = turns[0] || null;
    const runtime = this.threadRuntime.get(threadId);
    const runtimeIsNewer = runtime?.live && runtime.turnId && (
      !turn || (runtime.turnId !== turn.id && Date.parse(runtime.startedAt) > Date.parse(timestamp(turn.startedAt)))
      || (runtime.turnId === turn.id && !turn.completedAt && !['completed', 'failed'].includes(turnStatus(turn)))
    );
    if (runtimeIsNewer) turn = {
      id: runtime.turnId,
      status: { running: 'inProgress', complete: 'completed', error: 'failed' }[runtime.status] || runtime.status,
      startedAt: runtime.startedAt, completedAt: runtime.completedAt, items: [],
    };
    const cached = runtime?.turnId === turn?.id ? { ...runtime, steps: [...runtime.steps] } : null;
    let observing = false;
    let progressUnavailable = false;
    if (threadStatus(thread) === 'notloaded' && turnStatus(turn) === 'interrupted' && !turn.completedAt) {
      // A read-only App Server reconstructs another client's open turn as
      // interrupted. Only an explicit canonical boundary proves it ended.
      // Observation never resumes the thread or changes scheduler state.
      observing = true;
      try {
        const timeline = await this.request('thread/timeline/list', { threadId, limit: MAX_STEPS }, { mutating: false });
        if (!Array.isArray(timeline.data)) throw new Error('Progress timeline unavailable');
        const end = [...timeline.data].reverse().find(entry => entry.turnId === turn.id && entry.type === 'turnCompleted');
        if (end) {
          turn = { ...turn, status: end.status, completedAt: end.completedAt, error: end.error };
          observing = false;
        }
      } catch { progressUnavailable = true; }
    }
    const rawStatus = turnStatus(turn);
    const active = isActiveThread(thread) || rawStatus === 'inprogress' || (!rawStatus && cached?.status === 'running');
    const failed = rawStatus === 'failed';
    const interrupted = rawStatus === 'interrupted';
    const completed = rawStatus === 'completed';
    const status = observing ? 'waiting' : active ? 'running' : failed ? 'error' : interrupted ? 'interrupted' : completed ? 'complete' : turn ? 'error' : 'idle';
    const startedAt = timestamp(turn?.startedAt, cached?.startedAt || '');
    const completedAt = timestamp(turn?.completedAt, cached?.completedAt || '');
    let final = lastAgentText(turn) || cached?.final || '';
    let preview = cached?.preview || final || (active || observing ? 'Codex 正在回复…' : '暂无可显示回复。');
    const error = observing ? '' : failed
      ? asString(turn?.error?.message) || cached?.error || 'Codex 回复失败。'
      : interrupted
        ? cached?.error || '已中断当前 Codex 回复。'
        : turn && !active && !completed
          ? cached?.error || 'Codex 返回了无法确认的结束状态。'
          : '';
    const queue = await this.listQueue(threadId).catch(() => ({ data: [] }));
    const userTexts = new Set();
    for (const candidateTurn of turns) {
      for (const item of Array.isArray(candidateTurn?.items) ? candidateTurn.items : []) {
        if (item?.type !== 'userMessage') continue;
        const text = contentText(item.content || item.input) || inputText(item.content || item.input);
        if (text) userTexts.add(text.trim());
      }
    }
    for (const [operationId, operation] of this.uncertainOperations) {
      if (operation.threadId !== threadId) continue;
      const params = operation.params || {};
      const expectedText = inputText(params.input).trim();
      const queuedMatch = (queue.data || []).some(item => (
        params.clientUserMessageId && item.clientUserMessageId === params.clientUserMessageId
      ));
      const deleteConfirmed = operation.method === 'thread/queue/delete' && !(queue.data || []).some(item => item.id === params.queuedSubmissionId);
      if ((expectedText && userTexts.has(expectedText)) || queuedMatch || deleteConfirmed) this.uncertainOperations.delete(operationId);
    }
    const approvals = this.listApprovals(threadId);
    let items = (turn?.items || []).map(item => ({ item, turnId: turn.id }));
    if (turn?.id) {
      try {
        const result = await this.request('thread/items/list', {
          threadId, turnId: turn.id, limit: MAX_STEPS, sortDirection: 'desc',
        }, { mutating: false });
        if (!Array.isArray(result.data)) throw new Error('Progress items unavailable');
        items = result.data.filter(entry => entry.turnId === turn.id).reverse();
      } catch { progressUnavailable = true; }
    }
    const latestMessage = [...items].reverse().find(entry => entry.item?.type === 'agentMessage' && itemText(entry.item));
    if (latestMessage && !cached?.preview) preview = itemText(latestMessage.item);
    if (latestMessage && ['final_answer', 'finalAnswer'].includes(latestMessage.item.phase)) final = itemText(latestMessage.item);
    const snapshotSteps = items.map(entry => itemProgress(entry.item, {
      completed: Boolean(entry.completedAtMs) || (!active && !observing),
      time: timestamp(entry.startedAtMs, startedAt),
    })).filter(Boolean);
    const steps = mergeProgress(snapshotSteps, cached?.steps);
    if (active && approvals.length) upsertProgress(steps, {
      callId: 'pending-approval', kind: 'start', label: '等待确认', text: '请处理下方的审批或问题后继续。',
    });
    const updatedAt = [thread?.updatedAt, thread?.recencyAt, cached?.updatedAt, startedAt, completedAt,
      ...items.flatMap(entry => [entry.startedAtMs, entry.completedAtMs])].map(value => timestamp(value)).filter(Boolean).sort().at(-1) || '';
    const progressVersion = createHash('sha256').update(JSON.stringify([turn?.id, status, preview, steps])).digest('hex').slice(0, 20);
    return {
      ok: true,
      available: Boolean(thread?.id),
      active,
      status,
      observing,
      threadId,
      turnId: asString(turn?.id || cached?.turnId),
      sessionFile: '',
      updatedAt,
      progressVersion,
      startedAt,
      completedAt,
      durationMs: startedAt ? Math.max(0, Date.parse(completedAt || new Date().toISOString()) - Date.parse(startedAt)) : 0,
      preview: error || preview,
      final: status === 'complete' ? final || preview : '',
      error,
      steps,
      progressUnavailable,
      queue: queue.data || [],
      queuePaused: this.pausedQueues.has(threadId),
      waitingForWriter: this.writerWaits.has(threadId),
      approvals,
      uncertainOperations: [...this.uncertainOperations.values()]
        .filter(item => item.threadId === threadId)
        .map(item => ({ id: item.id, method: item.method, createdAt: item.createdAt, detail: item.detail })),
      model: thread?.model ? { id: thread.model, label: thread.model, displayName: thread.model, source: 'official' } : null,
      reasoningMode: thread?.effort ? { key: thread.effort, label: thread.effort, displayName: thread.effort } : null,
      context: runtime?.live ? runtime.context || null : null,
      permissions: this.permissionSnapshots.get(threadId) || null,
      ...await goalSnapshot,
    };
  }

  async createThread(options = {}) {
    return this._withSchedulerLock(() => this._createThreadUnlocked(options));
  }

  async _createThreadUnlocked(options = {}) {
    this._assertSessionAvailable('');
    this._touchSessionActivity();
    const params = {};
    if (options.projectPath) params.cwd = options.projectPath;
    else params.projectId = null;
    if (options.model) params.model = options.model;
    if (options.effort) params.effort = options.effort;
    this.sessionClaimPending = true;
    let result;
    try { result = await this.request('thread/start', params); }
    catch (error) {
      if (error.code !== 'CODEX_APP_SERVER_OUTCOME_UNKNOWN') this.sessionClaimPending = false;
      throw error;
    }
    const thread = result.thread || result;
    if (!thread?.id) throw errorWithCode('Codex App Server 没有返回新线程 ID。', 'THREAD_CREATE_FAILED', 502);
    this.ownedThreadId = thread.id;
    this.sessionClaimPending = false;
    if (!options.projectPath) this.knownProjectlessThreads.add(thread.id);
    return thread;
  }

  buildInput(text, attachments = []) {
    const input = [];
    if (asString(text).trim()) input.push({ type: 'text', text: asString(text) });
    for (const attachment of attachments) {
      if (!attachment?.filePath) continue;
      input.push({ type: 'localImage', path: attachment.filePath });
    }
    return input;
  }

  activeCount() {
    return this.ownedThreadId && this.threadRuntime.get(this.ownedThreadId)?.status === 'running' ? 1 : 0;
  }

  async _refreshThreadRuntime(threadId) {
    const thread = await this.readThread(threadId, false);
    const runtime = this._runtime(threadId);
    if (!runtime.turnId || !runtime.live) runtime.status = isActiveThread(thread) ? 'running' : 'idle';
    return thread;
  }

  _assertSessionAvailable(threadId) {
    if (this.sessionClaimPending || (this.ownedThreadId && this.ownedThreadId !== threadId)) {
      throw errorWithCode('Mini 一次只能接管一个会话。请先点击“归还 Codex App”，再接管其他会话。', 'MINI_SESSION_BUSY', 409);
    }
  }

  _clearDesktopHandoff(threadId) {
    if (!this.desktopHandoffs.has(threadId)) return;
    const next = new Set(this.desktopHandoffs);
    next.delete(threadId);
    this.saveDesktopHandoffs([...next]);
    this.desktopHandoffs = next;
    if (![...this.uncertainOperations.values()].some(item => item.threadId === threadId)) this.pausedQueues.delete(threadId);
  }

  _rememberWriterWait(threadId) {
    this.writerWaits.set(threadId, Date.now() + this.writerRetryMs);
    this.queueThreads.add(threadId);
    try { this.saveWriterWaits([...this.writerWaits.keys()]); }
    catch (error) {
      // queue/add already acknowledged. Report a saved, paused queue instead
      // of a failed send (which could make the user resend the same input).
      this.writerWaits.delete(threadId);
      this.pausedQueues.add(threadId);
      this.emit('dispatchError', error);
      return false;
    }
    this._scheduleWriterRetry();
    return true;
  }

  _forgetWriterWait(threadId) {
    if (!this.writerWaits.has(threadId)) return;
    const retryAt = this.writerWaits.get(threadId);
    this.writerWaits.delete(threadId);
    try { this.saveWriterWaits([...this.writerWaits.keys()]); }
    catch (error) { this.writerWaits.set(threadId, retryAt); throw error; }
  }

  _scheduleWriterRetry() {
    if (this.closing || this.writerRetryTimer || ![...this.writerWaits.keys()].some(id => !this.pausedQueues.has(id))) return;
    this.writerRetryTimer = setTimeout(() => {
      this.writerRetryTimer = null;
      this.dispatchWaitingQueues({ writersOnly: true })
        .catch(error => this.emit('dispatchError', error))
        .finally(() => this._scheduleWriterRetry());
    }, this.writerRetryMs);
    this.writerRetryTimer.unref?.();
  }

  async _enqueueInput(threadId, input, clientRequestId, waitingForWriter = false) {
    // A queued send reserves the same single session as an active turn.
    this._assertSessionAvailable(threadId);
    this.ownedThreadId = threadId;
    const clientUserMessageId = asString(clientRequestId) || `codex-mini-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await this.request('thread/queue/add', { threadId, clientUserMessageId, input });
    this.queueThreads.add(threadId);
    if (waitingForWriter) this._rememberWriterWait(threadId);
    return { threadId, queued: true, waitingForWriter: this.writerWaits.has(threadId), queuePaused: this.pausedQueues.has(threadId), queuedSubmission: result.queuedSubmission || null, turn: null };
  }

  async send(options = {}) {
    let threadId = asString(options.threadId);
    const input = this.buildInput(options.text, options.attachments);
    if (!input.length) throw errorWithCode('请输入文字或添加图片。', 'EMPTY_TEXT', 400);
    return this._withSchedulerLock(async () => {
      this._assertSessionAvailable(threadId);
      this._touchSessionActivity();
      if (!threadId) {
        const thread = await this._createThreadUnlocked({ projectPath: asString(options.projectPath), model: options.model, effort: options.effort });
        threadId = thread.id;
      }
      this._clearDesktopHandoff(threadId);
      const queue = await this.listQueue(threadId);
      if (queue.data.length || this.pausedQueues.has(threadId)) return this._enqueueInput(threadId, input, options.clientRequestId);
      let result;
      try {
        await this._ensureThreadLoadedUnlocked(threadId);
        const thread = await this._refreshThreadRuntime(threadId);
        const active = isActiveThread(thread) || this._runtime(threadId).status === 'running';
        if (active || this.activeCount() >= this.maxConcurrency) return this._enqueueInput(threadId, input, options.clientRequestId);
        result = await this.request('turn/start', { threadId, input });
      } catch (error) {
        // A definite writer rejection happened before this input was accepted.
        // Unknown outcomes must never take this path or replay the user's input.
        if (error.code !== 'THREAD_WRITER_BUSY') throw error;
        return this._enqueueInput(threadId, input, options.clientRequestId, true);
      }
      const turn = result.turn || result;
      this._beginTurn(threadId, turn);
      return { threadId, queued: false, queuedSubmission: null, turn };
    });
  }

  async listQueue(threadId, options = {}) {
    const result = await this.request('thread/queue/list', {
      threadId,
      cursor: options.cursor || null,
      limit: Math.max(1, Math.min(Number(options.limit) || 100, 200)),
    }, { mutating: false });
    const data = result.data || [];
    if (data.length) this.queueThreads.add(threadId);
    else {
      this.queueThreads.delete(threadId);
      this._forgetWriterWait(threadId);
    }
    return { data, nextCursor: result.nextCursor || null, paused: this.pausedQueues.has(threadId), waitingForWriter: this.writerWaits.has(threadId) };
  }

  async deleteQueued(threadId, queuedSubmissionId) {
    return this._withSchedulerLock(() => this._deleteQueuedUnlocked(threadId, queuedSubmissionId));
  }

  async _deleteQueuedUnlocked(threadId, queuedSubmissionId) {
    const result = await this.request('thread/queue/delete', { threadId, queuedSubmissionId });
    return Boolean(result.deleted);
  }

  async guideQueueHead(threadId, clientUserMessageId = '') {
    return this._withSchedulerLock(() => this._guideQueueHeadUnlocked(threadId, clientUserMessageId));
  }

  async _guideQueueHeadUnlocked(threadId, clientUserMessageId = '') {
    this._assertSessionAvailable(threadId);
    this._touchSessionActivity();
    if (this.pausedQueues.has(threadId)) {
      throw errorWithCode('队列已暂停；请先刷新确认当前状态，再点击“继续队列”。', 'QUEUE_PAUSED', 409);
    }
    const [thread, queue] = await Promise.all([this.readThread(threadId, true), this.listQueue(threadId)]);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const activeTurn = [...turns].reverse().find(turn => turnStatus(turn) === 'inprogress') || turns[turns.length - 1];
    const head = queue.data[0];
    if (!head) throw errorWithCode('当前没有可引导的队首消息。', 'QUEUE_EMPTY', 409);
    if (!activeTurn?.id || !isActiveThread(thread)) throw errorWithCode('当前线程没有正在运行的回复，无法引导。', 'TURN_NOT_ACTIVE', 409);
    await this.request('turn/steer', {
      threadId,
      expectedTurnId: activeTurn.id,
      input: head.input || [],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
    try {
      await this.request('thread/queue/delete', { threadId, queuedSubmissionId: head.id });
    } catch (error) {
      this.pausedQueues.add(threadId);
      throw errorWithCode('引导已确认，但队首删除结果未确认；队列已暂停，请刷新后检查。', error.code || 'QUEUE_DELETE_UNKNOWN', 409, error.detail || '');
    }
    return head;
  }

  async continueQueue(threadId) {
    return this._withSchedulerLock(() => this._continueQueueUnlocked(threadId, true));
  }

  async _continueQueueUnlocked(threadId, refreshThreads = false) {
    this._assertSessionAvailable(threadId);
    if (refreshThreads) this._touchSessionActivity();
    if (refreshThreads) this._clearDesktopHandoff(threadId);
    else if (this.desktopHandoffs.has(threadId)) throw errorWithCode('会话已归还桌面端，请手动点击“继续队列”后再接管。', 'MINI_SESSION_HANDED_OFF', 409);
    if ([...this.uncertainOperations.values()].some(operation => operation.threadId === threadId)) {
      throw errorWithCode('操作结果仍待确认，暂时不能继续队列。', 'CODEX_APP_SERVER_OUTCOME_UNKNOWN', 409);
    }
    if (refreshThreads) await this._refreshThreadRuntime(threadId);
    if (this._runtime(threadId).status === 'running') {
      throw errorWithCode('这个线程已有回复正在运行。', 'TURN_ALREADY_ACTIVE', 409);
    }
    if (this.activeCount() >= this.maxConcurrency) {
      throw errorWithCode(`当前已有 ${this.maxConcurrency} 个线程在运行，请等待任一线程完成。`, 'GLOBAL_CONCURRENCY_LIMIT', 409);
    }
    let result;
    try {
      await this._ensureThreadLoadedUnlocked(threadId);
      // Persist the removal before dispatch. A crash or timeout after this point
      // must require explicit recovery rather than replaying queue/start.
      this._forgetWriterWait(threadId);
      result = await this.request('thread/queue/start', { threadId });
    } catch (error) {
      if (error.code === 'THREAD_WRITER_BUSY') {
        if (refreshThreads) this.pausedQueues.delete(threadId);
        if (!this._rememberWriterWait(threadId)) throw errorWithCode('消息已保存到队列，但自动继续状态保存失败，请修复后点击“继续队列”。', 'WRITER_WAIT_SAVE_FAILED', 500);
      } else {
        this._forgetWriterWait(threadId);
      }
      throw error;
    }
    this.pausedQueues.delete(threadId);
    const turn = result.turn || result;
    this._beginTurn(threadId, turn);
    return turn;
  }

  async dispatchWaitingQueues(options = {}) {
    if (this.dispatchPromise) return this.dispatchPromise;
    this.dispatchPromise = this._withSchedulerLock(async () => {
      if (!this.queueThreads.size) return;
      if (this.ownedThreadId) await this._refreshThreadRuntime(this.ownedThreadId);
      if (this.activeCount() >= this.maxConcurrency) return;
      for (const threadId of [...this.queueThreads]) {
        if (this.desktopHandoffs.has(threadId) || this.sessionClaimPending || (this.ownedThreadId && this.ownedThreadId !== threadId)) continue;
        if (options.writersOnly && !this.writerWaits.has(threadId)) continue;
        if (this.writerWaits.get(threadId) > Date.now()) continue;
        if (this.pausedQueues.has(threadId)) continue;
        if (threadId !== this.ownedThreadId) await this._refreshThreadRuntime(threadId);
        if (this.activeCount() >= this.maxConcurrency) break;
        if (this._runtime(threadId).status === 'running') continue;
        const queue = await this.listQueue(threadId).catch(() => ({ data: [] }));
        if (!queue.data.length) continue;
        try { await this._continueQueueUnlocked(threadId, false); } catch (error) {
          if (error.code === 'THREAD_WRITER_BUSY') continue;
          this.pausedQueues.add(threadId);
          this.emit('dispatchError', error);
        }
      }
    }).finally(() => { this.dispatchPromise = null; });
    return this.dispatchPromise;
  }

  async stop(threadId, turnId = '') {
    return this._withSchedulerLock(() => this._stopUnlocked(threadId, turnId));
  }

  async _stopUnlocked(threadId, turnId = '') {
    this._assertSessionAvailable(threadId);
    this._touchSessionActivity();
    this.pausedQueues.add(threadId);
    this._forgetWriterWait(threadId);
    let expectedTurnId = turnId;
    if (!expectedTurnId) {
      const thread = await this.readThread(threadId, true);
      const turns = Array.isArray(thread?.turns) ? thread.turns : [];
      const activeTurn = [...turns].reverse().find(turn => turnStatus(turn) === 'inprogress') || turns[turns.length - 1];
      expectedTurnId = asString(activeTurn?.id);
    }
    if (!expectedTurnId) throw errorWithCode('当前线程没有可中断的回复。', 'TURN_NOT_ACTIVE', 409);
    this.pausedQueues.add(threadId);
    await this.request('turn/interrupt', { threadId, turnId: expectedTurnId });
    const runtime = this._runtime(threadId);
    runtime.status = 'interrupted';
    runtime.error = '已中断当前 Codex 回复。';
    return expectedTurnId;
  }

  async threadAction(threadId, action, payload = {}) {
    return this._withSchedulerLock(() => this._threadActionUnlocked(threadId, action, payload));
  }

  async _threadActionUnlocked(threadId, action, payload = {}) {
    if (action === 'archive') return this.request('thread/archive', { threadId });
    if (action === 'unarchive') return this.request('thread/unarchive', { threadId });
    if (action === 'rename') {
      const name = asString(payload.name).trim();
      if (!name) throw errorWithCode('请输入线程名称。', 'EMPTY_THREAD_NAME', 400);
      return this.request('thread/name/set', { threadId, name });
    }
    if (action === 'pin' || action === 'unpin') {
      throw errorWithCode('当前 Codex App Server 版本没有公开的置顶写接口，未执行本地伪置顶。', 'PIN_NOT_SUPPORTED', 501);
    }
    throw errorWithCode('不支持的线程操作。', 'BAD_THREAD_ACTION', 400);
  }

  async updateThreadSettings(threadId, settings = {}) {
    return this._withSchedulerLock(() => this._updateThreadSettingsUnlocked(threadId, settings));
  }

  async permissionMenu(threadId) {
    const thread = await this.readThread(threadId, false);
    const [config, requirements, profiles] = await Promise.all([
      this.request('config/read', { cwd: thread.cwd, includeLayers: false }, { mutating: false }),
      this.request('configRequirements/read', {}, { mutating: false }),
      this.request('permissionProfile/list', {}, { mutating: false }),
    ]);
    if (!Object.hasOwn(requirements, 'requirements') || !Array.isArray(profiles.data)) {
      throw errorWithCode('无法确认权限限制，请稍后再试。', 'PERMISSION_REQUIREMENTS_UNAVAILABLE', 503);
    }
    return { threadId, options: permissionOptions(config.config || {}, requirements.requirements, profiles.data, thread.cwd) };
  }

  async changePermissions(threadId, mode) {
    if (!['ask', 'auto', 'full', 'custom'].includes(mode)) throw errorWithCode('权限选项无效。', 'BAD_PERMISSION_MODE', 400);
    return this._withSchedulerLock(async () => {
      const menu = await this.permissionMenu(threadId);
      const option = menu.options.find(item => item.id === mode);
      if (!option?.allowed) throw errorWithCode(option?.reason || '此权限不可用。', 'PERMISSION_NOT_ALLOWED', 403);
      // Explicit edits may claim a writer; simply opening this menu never does.
      this._touchSessionActivity();
      const previousOwner = this.ownedThreadId;
      try { await this._ensureThreadLoadedUnlocked(threadId); }
      catch (error) {
        if (error.code === 'THREAD_WRITER_BUSY') {
          this.ownedThreadId = previousOwner;
          error.message = '桌面端正在占用这个对话，权限未修改。请在桌面端释放后重试。';
        }
        throw error;
      }
      await this._updateThreadSettingsUnlocked(threadId, option.settings);
      const permissions = { threadId, mode, ...option.settings, source: 'confirmed', updatedAt: new Date().toISOString() };
      this.permissionSnapshots.set(threadId, permissions);
      return permissions;
    });
  }

  async _updateThreadSettingsUnlocked(threadId, settings = {}) {
    this._assertSessionAvailable(threadId);
    this._touchSessionActivity();
    const params = { threadId };
    for (const key of ['model', 'effort', 'approvalPolicy', 'approvalsReviewer', 'permissions', 'sandboxPolicy']) {
      if (settings[key] !== undefined && settings[key] !== '') params[key] = settings[key];
    }
    return this.request('thread/settings/update', params);
  }

  async _disconnectOwnedProcess() {
    if (this.disconnectPromise) return this.disconnectPromise;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.connecting) await this.connecting.catch(() => {});
    const child = this.child;
    if (!child) { this.ownedThreadId = ''; this.sessionClaimPending = false; return; }
    this.connectionStopping = true;
    // EOF lets the native App Server flush and release writers, including when
    // launched through a Windows wrapper. Killing only the wrapper can orphan it.
    this.disconnectPromise = new Promise((resolve, reject) => {
      const onClose = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        child.removeListener('close', onClose);
        reject(errorWithCode('Mini 后台尚未退出，未确认归还成功，请稍后重试。', 'MINI_SESSION_RELEASE_TIMEOUT', 504));
      }, this.shutdownTimeoutMs);
      child.once('close', onClose);
      child.stdin.end();
    });
    try { await this.disconnectPromise; }
    finally { this.disconnectPromise = null; }
  }

  async releaseSession() {
    return this._withSchedulerLock(() => this._releaseSessionUnlocked('manual'));
  }

  async _releaseSessionUnlocked(reason) {
      const threadId = this.ownedThreadId;
      const next = new Set([...this.desktopHandoffs, ...this.queueThreads, ...this.writerWaits.keys(), ...(threadId ? [threadId] : [])]);
      // Persist the handoff before closing. A restart must not retry an old claim.
      this.saveDesktopHandoffs([...next]);
      this.desktopHandoffs = next;
      for (const id of next) this.pausedQueues.add(id);
      if (this.writerRetryTimer) clearTimeout(this.writerRetryTimer);
      this.writerRetryTimer = null;
      this.writerWaits.clear();
      try { this.saveWriterWaits([]); } catch (error) { this.emit('dispatchError', error); }
      await this._disconnectOwnedProcess();
      this.lastReleasedAt = new Date().toISOString();
      this.lastReleaseReason = reason;
      return { threadId, released: true, connection: this.connectionStatus() };
  }

  async close() {
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.writerRetryTimer) clearTimeout(this.writerRetryTimer);
    this.writerRetryTimer = null;
    await this._disconnectOwnedProcess();
  }
}

module.exports = {
  CodexAppServerBackend,
  displayNameForThread,
  historyMessages,
  normalizeThread,
};
