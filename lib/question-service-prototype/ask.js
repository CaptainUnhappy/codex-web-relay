'use strict';

// Small agent-side experiment: create one stable question, await its canonical
// result, return it once. Reading the result never appends a chat message.
async function askQuestion({ baseUrl, token, question, signal = AbortSignal.timeout(120000) }) {
  const url = new URL(baseUrl);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/question-prototype') throw new Error('Only the isolated loopback prototype is supported.');
  async function request(route, body) {
    const response = await fetch(`${baseUrl}/api/${route}`, { method: body ? 'POST' : 'GET', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) throw new Error(data.code || `HTTP ${response.status}`);
    return data;
  }
  await request('questions', question);
  while (!signal.aborted) {
    const { question: current } = await request(`questions/${encodeURIComponent(question.id)}/result`);
    if (current.answer) return { questionId: current.id, ...current.answer };
    await require('node:timers/promises').setTimeout(250, undefined, { signal });
  }
  throw signal.reason;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => askQuestion(JSON.parse(input)).then(answer => console.log(JSON.stringify(answer))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  }));
}
module.exports = { askQuestion };
