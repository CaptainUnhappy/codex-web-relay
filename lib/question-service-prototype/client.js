'use strict';

const base = '/question-prototype';
const client = new URLSearchParams(location.search).get('client') === 'phone' ? 'phone' : 'desktop';
const cards = new Map();
let instance = '', revision = -1, connected = false, refreshBusy = false, timer;
const connection = document.querySelector('#connection'), notice = document.querySelector('#notice');
const reconnect = document.querySelector('#reconnect'), container = document.querySelector('#questions');
const draftKey = id => `question-prototype:${instance}:${id}`;
const readDraft = id => { try { return JSON.parse(sessionStorage.getItem(draftKey(id))) || {}; } catch { return {}; } };
function persist(card) { sessionStorage.setItem(draftKey(card.question.id), JSON.stringify({ value: card.input.value, selected: card.selected, attempt: card.attempt, collapsed: card.root.classList.contains('is-collapsed') })); }

async function api(route, payload) {
  const response = await fetch(`${base}/api/${route}`, { method: payload ? 'POST' : 'GET', cache:'no-store',
    headers: { 'content-type':'application/json' }, body: payload ? JSON.stringify(payload) : undefined, signal:AbortSignal.timeout(6000) });
  const data = await response.json();
  return { response, data };
}
function network(value) {
  connected = value;
  connection.textContent = value ? '已连接' : '连接已中断';
  reconnect.hidden = value;
  cards.forEach(updateControls);
}
function updateControls(card) {
  const locked = card.busy || Boolean(card.attempt) || Boolean(card.question.answer);
  card.input.disabled = locked;
  card.options.forEach((button, index) => {
    button.disabled = locked;
    button.setAttribute('aria-checked', String(card.selected === index));
    button.tabIndex = index === Math.max(0, card.selected) ? 0 : -1;
  });
  card.submit.disabled = !connected || card.busy || Boolean(card.question.answer) || !answerValue(card).trim();
  card.submit.textContent = card.busy ? '确认中…' : card.attempt ? '重试回答' : '发送';
  card.submit.setAttribute('aria-label', card.attempt && !card.busy ? '重试回答' : '发送回答');
}
function answerValue(card) { return card.attempt?.value ?? (card.selected >= 0 ? card.question.options[card.selected].label : card.input.value); }
function collapse(card, collapsed) {
  card.root.classList.toggle('is-collapsed', collapsed);
  card.close.hidden = collapsed; card.reopen.hidden = !collapsed;
  persist(card);
  (collapsed ? card.reopen : card.close).focus({ preventScroll:true });
}
function createCard(question) {
  const root = document.querySelector('#question-template').content.firstElementChild.cloneNode(true);
  root.dataset.questionId = question.id;
  const card = { root, question, input:root.querySelector('textarea'), submit:root.querySelector('.question-submit'),
    help:root.querySelector('.question-help'), close:root.querySelector('.question-close'), reopen:root.querySelector('.question-reopen'), options:[], selected:-1, attempt:null, busy:false };
  const prompt = root.querySelector('.question-prompt');
  prompt.id = `prompt-${question.id}`; prompt.textContent = question.prompt;
  root.setAttribute('aria-labelledby', prompt.id);
  const list = root.querySelector('.question-options'); list.setAttribute('aria-labelledby', prompt.id);
  const select = index => { card.selected = index; card.input.value = ''; persist(card); updateControls(card); };
  question.options.forEach((option, index) => {
    const button = document.createElement('button'), number = document.createElement('span'), copy = document.createElement('span');
    button.type = 'button'; button.className = 'question-option'; button.setAttribute('role','radio');
    number.className = 'question-option-number'; number.textContent = index + 1; number.setAttribute('aria-hidden','true');
    copy.className = 'question-option-copy'; copy.textContent = option.label;
    if (option.description) { const description = document.createElement('span'); description.className = 'question-option-description'; description.textContent = option.description; copy.append(description); }
    button.append(number, copy); button.onclick = () => select(index);
    button.onkeydown = event => {
      if (!['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.key)) return;
      event.preventDefault(); const next = (index + (['ArrowDown','ArrowRight'].includes(event.key) ? 1 : -1) + card.options.length) % card.options.length;
      select(next); card.options[next].focus();
    };
    list.append(button); card.options.push(button);
  });
  const resizeInput = () => { card.input.style.height = 'auto'; card.input.style.height = `${Math.min(160,card.input.scrollHeight)}px`; };
  card.input.oninput = () => { card.selected = -1; resizeInput(); persist(card); updateControls(card); };
  card.input.onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !card.submit.disabled) { event.preventDefault(); card.submit.click(); } };
  card.close.onclick = () => collapse(card,true); card.reopen.onclick = () => collapse(card,false);
  root.querySelector('.question-defer').onclick = () => collapse(card,true);
  root.querySelector('form').onsubmit = event => { event.preventDefault(); submit(card); };
  const saved = readDraft(question.id);
  card.input.value = typeof saved.value === 'string' ? saved.value : '';
  card.selected = Number.isInteger(saved.selected) && saved.selected >= 0 && saved.selected < question.options.length ? saved.selected : -1;
  card.attempt = saved.attempt || null;
  if (card.attempt) card.help.textContent = '上次发送尚未确认，正在核对。';
  root.classList.toggle('is-collapsed', Boolean(saved.collapsed));
  card.close.hidden = Boolean(saved.collapsed); card.reopen.hidden = !saved.collapsed;
  container.append(root); resizeInput(); cards.set(question.id,card);
  return card;
}
function apply(snapshot) {
  if (!snapshot.instance || !Array.isArray(snapshot.questions)) return;
  if (instance && snapshot.instance !== instance) { cards.clear(); container.replaceChildren(); revision = -1; }
  instance = snapshot.instance;
  if (snapshot.revision <= revision) return;
  revision = snapshot.revision;
  snapshot.questions.forEach(question => {
    const card = cards.get(question.id) || createCard(question);
    if (question.answer && !card.question.answer) finish(card, question);
    else if (question.answer && card.root.dataset.state !== 'answered') finish(card, question);
    card.question = question; updateControls(card);
  });
  document.querySelector('#empty').hidden = snapshot.questions.length > 0;
}
function finish(card, question) {
  const draft = answerValue(card), wasFocused = card.root.contains(document.activeElement);
  card.root.dataset.state = 'answered'; card.root.classList.remove('is-collapsed');
  card.root.querySelector('form').hidden = true; card.close.hidden = true; card.reopen.hidden = true;
  card.root.querySelector('.answer-receipt').hidden = false;
  const status = card.root.querySelector('.answer-status');
  status.textContent = `已在${question.answer.client === 'phone' ? '手机端' : '桌面端'}回答`;
  card.root.querySelector('.answer').textContent = question.answer.value;
  if (draft.trim() && draft !== question.answer.value) {
    card.root.querySelector('details').hidden = false;
    card.root.querySelector('.saved-draft').textContent = draft;
  }
  card.attempt = null;
  persist(card);
  if (wasFocused) { status.tabIndex = -1; status.focus({ preventScroll:true }); }
}
async function submit(card) {
  if (card.submit.disabled || card.busy || card.question.answer) return;
  card.attempt ||= { requestId:crypto.randomUUID(), value:answerValue(card), client };
  persist(card); card.busy = true; card.help.textContent = '正在确认回答…'; updateControls(card);
  try {
    const { response, data } = await api(`questions/${card.question.id}/answer`, card.attempt);
    apply(data);
    if (!response.ok && !card.question.answer) throw new Error(data.message || '暂时无法确认回答。');
  } catch {
    if (!card.question.answer) card.help.textContent = '发送结果尚未确认。恢复连接后会核对状态，请勿重复填写。';
  } finally {
    card.busy = false; updateControls(card); refresh();
  }
}
async function refresh() {
  if (refreshBusy) return;
  clearTimeout(timer); refreshBusy = true;
  try {
    const { response, data } = await api('questions');
    if (!response.ok) { notice.textContent = data.message || '无法读取问题。'; throw new Error('read failed'); }
    apply(data); network(true); notice.textContent = '';
    cards.forEach(card => { if (card.attempt && !card.busy && !card.question.answer) card.help.textContent = '已核对：尚未收到回答。可用原提交编号重试。'; });
  } catch { network(false); }
  finally { refreshBusy = false; if (!document.hidden) timer = setTimeout(refresh,1000); }
}
reconnect.onclick = refresh;
window.addEventListener('online',refresh);
window.addEventListener('offline',() => network(false));
document.addEventListener('visibilitychange',() => { if (document.hidden) clearTimeout(timer); else refresh(); });
(async () => {
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  if (key) {
    history.replaceState(null,'',location.pathname + location.search);
    try { const { response, data } = await api('session',{ token:key }); if (!response.ok) throw new Error(data.message); }
    catch (error) { notice.textContent = error.message; network(false); return; }
  }
  refresh();
})();
