async (page, options = {}) => {
  // Load through Playwright browser_run_code_unsafe's filename parameter.
  // Uses the production HTML in an isolated context; sends go only to fixture routes.
  const assert = (condition, message = 'Question UI assertion failed') => { if (!condition) throw new Error(message); };
  assert.strictEqual = (actual, expected, message) => assert(actual === expected, message || `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  const source = await (await page.request.get(options.sourceUrl || 'http://127.0.0.1:8787/')).text();
  const threadId = '01a14dcb-3bf7-7c60-9e10-ebb350f80a24';
  const otherThreadId = '01a14dcb-3bf7-7c60-9e10-ebb350f80a25';
  const questionFixture = (id, questions, method = 'item/tool/requestUserInput') => ({
    id, method, clientRequestId: `question-${id}`, params: { threadId, questions },
  });
  let question = questionFixture('choices', [{ id: 'choice', question: '请选择颜色。\n```text\nalpha <beta>\n第二行\n```',
    options: [{ label: '橙色', description: '暖色方案' }, { label: '蓝色', description: '冷色方案' }], isOther: true }]);
  const modelFixture = {
    key: 'gpt-6-astra', id: 'gpt-6-astra', label: 'GPT-6 Astra', displayName: 'GPT-6 Astra', source: 'official',
    isDefault: true, defaultReasoningEffort: 'max', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  };
  let queue = [], failNext = false, delayedApproval = null;
  let versionHeader = '', documentLoads = 0, updateOnReload = false;
  const requests = [];
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await ctx.addInitScript(id => localStorage.setItem('codexMini.selectedThread', id), threadId);
    await ctx.route('https://question-fixture.test/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === '/codex/') {
        if (req.method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'x-codex-mini-client-version': versionHeader }, body: '' });
        documentLoads++;
        if (updateOnReload) versionHeader = '';
        return route.fulfill({ status: 200, contentType: 'text/html', body: source });
      }
      let data = { ok: true }, http = 200;
      const requestedThread = url.searchParams.get('thread') || threadId;
      const appHistory = question && (question.method === 'desktop/requestUserInput' || question.responseOwner === 'codex-app');
      const status = { ok: true, available: true, threadId: requestedThread, status: 'idle', active: false,
        queue: requestedThread === threadId ? queue : [], approvals: requestedThread === threadId && question && !appHistory ? [question] : [],
        desktopQuestions: requestedThread === threadId && appHistory ? [question] : [], model: modelFixture,
        reasoningMode: { key: 'max', value: 'max', label: 'Max', displayName: 'Max', updatedAt: '2026-10-19T00:00:00Z' },
        codexQuota: { source: 'account', available: true, remainingPercent: 11 },
        context: { available: true, percent: 99.1, usedTokens: 99100, windowTokens: 100000 } };
      if (url.pathname.endsWith('/codex/config')) data = { ...data, backend: 'app-server', localOnly: false, defaultModel: 'gpt-6-astra', defaultReasoningEffort: 'max', modelOptions: [modelFixture], effectiveApprovalPolicy: 'on-request', effectiveApprovalsReviewer: 'auto_review', relayApiBases: ['https://question-fixture.test/codex'], capabilities: { releaseSession: true, autoReleaseSession: true }, connection: { idleReleaseSeconds: 60 } };
      else if (url.pathname.endsWith('/codex/relay-status')) data = { ...data, deviceId: 'fixture-device', backend: 'app-server', appServer: { idleReleaseSeconds: 60 }, configured: false };
      else if (url.pathname.endsWith('/codex/threads')) data = { ...data, scope: url.searchParams.get('scope'), threads: url.searchParams.get('scope') === 'conversations' ? [{ id: threadId, name: '提问测试', isProjectThread: false }, { id: otherThreadId, name: '其他测试对话', isProjectThread: false }] : [], nextCursor: null };
      else if (url.pathname.endsWith('/codex/thread-bootstrap')) data = { ...data, threadId: requestedThread, history: { ok: true, available: true, messages: [{ id: 'initial', role: 'assistant', text: requestedThread === threadId ? '请回答下方问题。' : '其他对话' }], nextCursor: null }, status };
      else if (url.pathname.endsWith('/codex/status')) data = status;
      else if (url.pathname.endsWith('/codex/account-usage')) data = { ok: true, codexQuota: status.codexQuota };
      else if (url.pathname.endsWith('/codex/permissions')) data = { ok: true, threadId: requestedThread, permissions: { mode: 'auto' }, options: [{ id: 'ask', label: '请求批准', description: '按需批准', allowed: true }] };
      else if (url.pathname.endsWith('/codex/queue')) data = { ...data, queue, waitingForWriter: Boolean(queue.length), paused: false };
      else if (url.pathname.endsWith('/codex/approvals')) {
        if (req.method() === 'POST') {
          requests.push({ kind: 'native', body: req.postDataJSON() });
          if (failNext) { failNext = false; http = 400; data = { ok: false, message: '测试：发送失败，请重试。' }; }
          else question = { ...question, submittedAt: '2026-10-18T09:00:00Z' };
        }
        if (http === 200) data = { ok: true, approvals: requestedThread === threadId && question && !appHistory ? [question] : [], desktopQuestions: requestedThread === threadId && appHistory ? [question] : [] };
        if (req.method() === 'GET' && delayedApproval) {
          const delay = delayedApproval; delayedApproval = null;
          delay.started(); await delay.gate;
        }
      } else if (url.pathname.endsWith('/send')) {
        const body = req.postDataJSON();
        requests.push({ kind: 'desktop', body });
        http = 409; data = { ok: false, code: 'DESKTOP_QUESTION_REQUIRES_APP' };
      }
      await route.fulfill({ status: http, contentType: 'application/json', body: JSON.stringify(data) });
    });
    let phone = await ctx.newPage();
    let panel = phone.locator('#approval-panel');
    await phone.goto('https://question-fixture.test/codex/');
    await phone.waitForFunction(() => clientReady);
    assert.strictEqual(await phone.locator('.top-actions > *').count(), 1, 'top bar keeps only the exit control');
    assert.strictEqual(await phone.locator('.top-actions #logout-session').count(), 1);
    assert(await phone.locator('#logout-session').isVisible(), 'the exit control remains visible');
    assert.strictEqual(await phone.locator('.topbar #top-status').count(), 0, 'context status moved above the composer');
    assert.strictEqual(await phone.locator('.composer-meta #top-status').count(), 1);
    assert.strictEqual(await phone.locator('.composer-meta #model-badge').count(), 1);
    const composerControlIds = await phone.locator('.composer-meta-controls > *').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => node.id));
    assert.strictEqual(JSON.stringify(composerControlIds), JSON.stringify(['codex-quota-badge', 'permission-badge', 'top-status', 'model-badge']), `composer controls follow the requested order: ${JSON.stringify(composerControlIds)}`);
    assert.strictEqual(await phone.locator('#codex-quota-text').innerText(), '11%');
    assert.strictEqual(await phone.locator('#conversation-usage-badge').count(), 0, 'keep just one context control');
    assert.strictEqual(await phone.locator('#model-text').innerText(), 'GPT-6 Astra');
    assert.strictEqual(await phone.locator('#reasoning-text').innerText(), 'Max');
    assert((await phone.locator('#model-badge').innerText()).includes('GPT-6 Astra'));
    assert((await phone.locator('#model-badge').innerText()).includes('Max'));
    await phone.locator('#permission-badge').click();
    await phone.locator('.permission-option').waitFor();
    assert((await phone.locator('#permission-menu-card').innerText()).includes('按需批准'));
    await phone.locator('body').press('Escape');
    await phone.locator('#model-badge').click();
    const slider = phone.locator('#model-menu-card .reasoning-slider');
    assert.strictEqual(await slider.count(), 1, 'model menu exposes the real reasoning slider');
    assert.strictEqual(await slider.getAttribute('max'), '4', 'slider follows the model supported efforts');
    assert((await phone.locator('#model-menu-card .model-picker-effort').innerText()).includes('Max'));
    await phone.locator('#model-menu-card .model-picker-trigger').click();
    await phone.locator('#model-menu-card .model-menu-item').first().waitFor();
    await phone.locator('body').press('Escape');
    await phone.setViewportSize({ width: 1024, height: 844 });
    await phone.locator('#model-badge').click();
    assert.strictEqual(await phone.locator('#model-menu-card .reasoning-slider').count(), 1, 'desktop uses the same model and reasoning entry');
    await phone.locator('body').press('Escape');
    await phone.setViewportSize({ width: 390, height: 844 });
    assert.strictEqual(await panel.locator('select').count(), 0);
    assert.strictEqual(await panel.getByRole('radio').count(), 2);
    assert.strictEqual(await panel.locator('pre code').textContent(), 'alpha <beta>\n第二行');
    assert(await panel.getByRole('button', { name: '发送回答', exact: true }).isDisabled(), 'empty questions cannot be submitted');
    assert(await panel.locator('textarea').isVisible(), 'custom response is directly visible');
    const assertPending = async () => {
      await panel.getByRole('radio', { name: '蓝色 冷色方案' }).waitFor();
      assert.strictEqual(await phone.evaluate(() => currentApproval?.id), 'choices');
      assert.strictEqual(await panel.locator('[aria-checked="true"]').count(), 0);
      assert(await panel.getByRole('button', { name: '发送回答', exact: true }).isDisabled());
      assert.strictEqual(requests.length, 0, 'reading a question must never submit an answer');
    };
    await phone.reload({ waitUntil: 'domcontentloaded' });
    await assertPending();
    await phone.locator('#thread-button').click();
    await phone.locator(`[data-focus-key="thread:${otherThreadId}"]`).click();
    await phone.waitForFunction(id => selectedThreadId === id && !currentApproval, otherThreadId);
    assert(!(await panel.isVisible()), 'pending questions must not leak into another thread');
    await phone.locator('#thread-button').click();
    await phone.locator(`[data-focus-key="thread:${threadId}"]`).click();
    await assertPending();
    await phone.close();
    phone = await ctx.newPage();
    panel = phone.locator('#approval-panel');
    await phone.goto('https://question-fixture.test/codex/');
    await assertPending();
    await panel.getByRole('radio', { name: '蓝色 冷色方案' }).click();
    await phone.evaluate(item => renderApproval(item), question);
    assert.strictEqual(await panel.locator('[aria-checked="true"]').innerText(), '2\n蓝色\n冷色方案');
    await panel.getByRole('button', { name: '稍后回答', exact: true }).click();
    assert(!(await panel.getByRole('radio').first().isVisible()));
    await panel.getByRole('button', { name: '继续回答', exact: true }).click();
    assert.strictEqual(await panel.locator('[aria-checked="true"]').count(), 1);
    await panel.locator('[aria-checked="true"]').press('ArrowUp');
    assert((await panel.locator('[aria-checked="true"]').innerText()).includes('橙色'));
    await panel.getByRole('radio', { name: '蓝色 冷色方案' }).click();
    const screenshotDir = 'output/playwright';
    await phone.screenshot({ path: `${screenshotDir}/question-options-mobile.png` });
    await panel.getByRole('button', { name: '发送回答', exact: true }).click();
    await phone.waitForFunction(() => !approvalActionBusy);
    assert.strictEqual(requests[0].body.response.answers.choice.answers[0], '蓝色');

    const present = async item => {
      question = item; queue = [];
      await phone.evaluate(item => { stopPolling(); activeAssistant = null; clearQueuedSends(); if (typeof renderDesktopQuestionHistory === 'function') renderDesktopQuestionHistory([]); renderApproval(item); }, item);
    };
    await present(questionFixture('custom', [{ id: 'custom', question: '选择或自行填写。', options: [{ label: '默认值' }] }]));
    await panel.getByRole('radio', { name: '默认值' }).click();
    const custom = panel.locator('textarea');
    const answer = '第一行 <beta>\n第二行：保留换行';
    await custom.fill(answer);
    assert.strictEqual(await panel.locator('[aria-checked="true"]').count(), 0);
    await phone.evaluate(item => renderApproval(item), question);
    assert.strictEqual(await custom.inputValue(), answer);
    failNext = true;
    await panel.getByRole('button', { name: '发送回答', exact: true }).click();
    await phone.waitForFunction(() => !approvalActionBusy);
    assert.strictEqual(await custom.inputValue(), answer, 'failure must retain the draft');
    assert(await panel.getByRole('button', { name: '发送回答', exact: true }).isEnabled());
    await panel.getByRole('button', { name: '发送回答', exact: true }).click();
    await phone.waitForFunction(() => !approvalActionBusy);
    assert.strictEqual(requests[2].body.response.answers.custom.answers[0], answer);

    await present(questionFixture('native', [{ id: 'free', question: '请填写说明。' }], 'item/tool/requestUserInput'));
    await panel.locator('textarea').fill('原生回答');
    await panel.getByRole('button', { name: '发送回答', exact: true }).click();
    await phone.waitForFunction(() => !approvalActionBusy);
    assert.strictEqual(requests[3].body.response.answers.free.answers[0], '原生回答');
    assert.strictEqual(await panel.getByRole('button', { name: '发送回答', exact: true }).count(), 0);

    const desktop = questionFixture('desktop-owned', [{ id: 'desktop', question: '请在 App 回答。', options: [{ label: '选项一' }, { label: '选项二' }] }], 'desktop/requestUserInput');
    await present(desktop);
    let history = phone.locator('#desktop-question-history');
    assert(!(await panel.isVisible()), 'historical App questions must not be displayed as current approvals');
    assert(await history.isVisible());
    assert((await history.locator('summary').innerText()).includes('状态未确认'));
    assert.strictEqual(await history.locator('details').evaluate(el => el.open), false);
    await history.locator('summary').press('Enter');
    assert.strictEqual(await history.locator('details').evaluate(el => el.open), true);
    assert.strictEqual(await panel.locator('textarea, input, select, button').count(), 0, 'Desktop async questions have no second submission entry');
    assert.strictEqual(await history.locator('.question-app-options li').count(), 2);
    assert.strictEqual(await history.locator('textarea, input, select, button:not(.question-history-close)').count(), 0);
    assert.strictEqual(await history.getByRole('button', { name: '关闭历史提问卡片', exact: true }).count(), 1, 'history needs a real close action, not only a disclosure toggle');
    await phone.evaluate(() => loadApprovals());
    assert.strictEqual(await history.locator('details').evaluate(el => el.open), true, 'polling must preserve the expanded history');
    assert.strictEqual(await phone.evaluate(() => currentApproval), null, 'historical questions are not currentApproval');
    const liveAlongsideHistory = questionFixture('native-with-history', [{ id: 'live', question: '当前需要回答的问题', options: [{ label: '继续' }] }]);
    await phone.evaluate(({ historical, live }) => applyApprovalSnapshot({ approvals: [historical, live], desktopQuestions: [historical] }, ++approvalReadSequence), { historical: desktop, live: liveAlongsideHistory });
    assert.strictEqual(await phone.evaluate(() => currentApproval?.id), 'native-with-history', 'legacy mixed responses must not hide a real native request');
    assert.strictEqual(await history.locator('.question-field').count(), 1, 'a historical item appearing in both channels is shown only once');
    await panel.locator('textarea').fill('保留当前回答草稿');
    await phone.evaluate(({ historical, live }) => applyApprovalSnapshot({ approvals: [live], desktopQuestions: [historical] }, ++approvalReadSequence), { historical: desktop, live: liveAlongsideHistory });
    assert.strictEqual(await panel.locator('textarea').inputValue(), '保留当前回答草稿');
    for (const width of [320, 390, 1024]) {
      await phone.setViewportSize({ width, height: 844 });
      const bounds = await phone.locator('.composer-shell').boundingBox();
      assert(bounds.y >= 0 && bounds.y + bounds.height <= 845, 'native request and expanded history must fit on screen');
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.locator('#text').fill('保留普通消息草稿');
    await history.getByRole('button', { name: '关闭历史提问卡片', exact: true }).click();
    assert(!(await history.isVisible()));
    assert.strictEqual(await phone.evaluate(() => currentApproval?.id), 'native-with-history');
    assert.strictEqual(await panel.locator('textarea').inputValue(), '保留当前回答草稿');
    assert.strictEqual(await phone.locator('#text').inputValue(), '保留普通消息草稿');
    await phone.evaluate(() => openThreadActionCard(selectedThreadId));
    await phone.getByRole('button', { name: '重新显示历史提问', exact: true }).click();
    assert(await history.isVisible());
    assert.strictEqual(await panel.locator('textarea').inputValue(), '保留当前回答草稿');
    await phone.locator('#text').fill('');
    await phone.evaluate(() => loadApprovals());
    assert(!(await panel.isVisible()));
    const beforeDesktop = requests.length;
    await phone.evaluate(item => submitApproval(item, { answers: { desktop: { answers: ['选项一'] } } }), desktop);
    assert.strictEqual(requests.length, beforeDesktop, 'stale Desktop callbacks cannot call /send or approvals');
    await phone.reload({ waitUntil: 'domcontentloaded' });
    await history.locator('summary').waitFor();
    assert.strictEqual(await history.locator('details').evaluate(el => el.open), false, 'history is collapsed on reopening');
    assert.strictEqual(await panel.locator('textarea, input, select, button').count(), 0);
    await phone.screenshot({ path: `${screenshotDir}/question-app-owned-mobile.png` });
    const sibling = await ctx.newPage();
    try {
      await sibling.goto('https://question-fixture.test/codex/');
      await sibling.waitForFunction(() => clientReady);
      await history.getByRole('button', { name: '关闭历史提问卡片', exact: true }).click();
      await sibling.waitForFunction(() => !desktopQuestionHistory.classList.contains('is-visible'));
      await phone.evaluate(() => loadApprovals());
      assert(!(await history.isVisible()), 'polling must not reopen dismissed history');
      await phone.reload({ waitUntil: 'domcontentloaded' });
      await phone.waitForFunction(() => clientReady);
      assert(!(await history.isVisible()), 'dismissal must survive reload');
      await phone.evaluate(id => selectThread(id), otherThreadId);
      await phone.evaluate(() => openThreadActionCard(selectedThreadId));
      assert(await phone.getByRole('button', { name: '重新显示历史提问', exact: true }).isHidden(), 'dismissal is scoped to one thread');
      await phone.evaluate(() => closeThreadActionCard());
      await phone.evaluate(id => selectThread(id), threadId);
      assert(!(await history.isVisible()), 'switching back must retain dismissal');
      await present({ ...desktop, id: 'new-desktop-question' });
      assert(await history.isVisible(), 'a newly issued question must not inherit an old dismissal');
      await present(desktop);
      assert(!(await history.isVisible()));
      await phone.evaluate(() => openThreadActionCard(selectedThreadId));
      await phone.getByRole('button', { name: '重新显示历史提问', exact: true }).click();
      assert(await history.isVisible());
      await sibling.waitForFunction(() => desktopQuestionHistory.classList.contains('is-visible'));
      assert.strictEqual(requests.length, beforeDesktop, 'closing and restoring history must never send an answer');
    } finally { await sibling.close(); }
    question = null;
    await phone.evaluate(() => loadApprovals());
    assert(!(await panel.isVisible()));
    assert(!(await history.isVisible()), 'history is removed when the source no longer returns it');

    await present(desktop);
    await history.locator('summary').click();
    await phone.evaluate(id => selectThread(id), otherThreadId);
    assert(!(await history.isVisible()), 'history must not leak into a different thread');
    await phone.evaluate(id => selectThread(id), threadId);
    await history.locator('summary').waitFor();
    assert.strictEqual(await history.locator('details').evaluate(el => el.open), false);

    await present(questionFixture('delayed', [{ id: 'delayed', question: '旧快照中的问题' }]));
    let releaseOld;
    const gate = new Promise(resolve => { releaseOld = resolve; });
    const started = new Promise(resolve => { delayedApproval = { gate, started: resolve }; });
    await phone.evaluate(() => { window.oldApprovalRead = loadApprovals(); });
    await started;
    question = null;
    await phone.evaluate(() => loadApprovals());
    assert(!(await panel.isVisible()));
    releaseOld();
    await phone.evaluate(() => window.oldApprovalRead);
    assert(!(await panel.isVisible()), 'a late old snapshot must not reopen a cleared card');

    const owned = questionFixture('ownership-change', [{ id: 'owned', question: '回答权限以服务端为准', options: [{ label: '确认' }] }]);
    await present(owned);
    await panel.getByRole('radio', { name: '确认', exact: true }).click();
    await present({ ...owned, canSubmit: false, responseOwner: 'codex-app' });
    assert.strictEqual(await panel.locator('textarea, input, select, button').count(), 0, 'ownership changes invalidate the form even when the question ID and method stay the same');
    assert(await history.isVisible());
    const beforeStale = requests.length;
    await phone.evaluate(item => submitApproval(item, { answers: { owned: { answers: ['确认'] } } }), owned);
    assert.strictEqual(requests.length, beforeStale, 'a stale callback must use the current permissions');

    const queuedReplies = [{ questionItemId: 'desktop', question: '**题目**', answer }];
    const legacyQueue = [{ id: 'older-queued-answer', input: [{ type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify(queuedReplies)}\n</send_user_message_question_reply>` }] }];
    await phone.evaluate(items => { queuedSends = items; renderQueuedSends(); }, legacyQueue);
    assert.strictEqual(await phone.locator('#queued-send .question-reply-answer').textContent(), answer);
    assert.strictEqual(await phone.locator('#queued-send beta').count(), 0);
    assert(!(await phone.locator('#queued-send').innerText()).includes('**Codex 提问**'));
    assert(!(await phone.locator('#queued-send').innerText()).includes('questionItemId'));

    await present(questionFixture('long', Array.from({ length: 3 }, (_, i) => ({ id: `long-${i}`, question: '较长的问题说明'.repeat(12), options: [{ label: '保留'.repeat(30) }, { label: '修改' }], isOther: false }))));
    assert.strictEqual(await panel.locator('textarea').count(), 0);
    for (const width of [320, 390, 1024]) {
      await phone.setViewportSize({ width, height: 844 });
      assert.strictEqual(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no horizontal overflow at ${width}`);
      assert(await panel.getByRole('button', { name: '发送回答', exact: true }).isVisible());
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    assert(await panel.locator('.approval-detail').evaluate(el => el.scrollHeight > el.clientHeight));
    const replies = [{ questionItemId: 'safe', question: '**题目**\n```text\n说明\n```', answer }];
    await phone.evaluate(rows => messageEl('user', '', { questionReplies: rows }), replies);
    assert.strictEqual(await phone.locator('.message.user').last().locator('.question-reply-answer').textContent(), answer);

    versionHeader = await phone.evaluate(() => loadedClientVersion);
    const beforeUpdate = documentLoads;
    await phone.evaluate(() => checkClientVersion({ force: true }));
    assert.strictEqual(documentLoads, beforeUpdate, 'matching client code must not reload');
    versionHeader = 'f'.repeat(64);
    await phone.locator('#text').fill('不要丢失消息草稿');
    await phone.evaluate(() => checkClientVersion({ force: true }));
    assert.strictEqual(documentLoads, beforeUpdate);
    assert.strictEqual(await phone.locator('#text').inputValue(), '不要丢失消息草稿');
    await phone.locator('#text').fill('');
    await present(questionFixture('update-draft', [{ id: 'draft', question: '保留回答草稿' }]));
    await panel.locator('textarea').fill('不要丢失回答草稿');
    await phone.evaluate(() => checkClientVersion({ force: true }));
    assert.strictEqual(documentLoads, beforeUpdate);
    assert.strictEqual(await panel.locator('textarea').inputValue(), '不要丢失回答草稿');
    await panel.locator('textarea').fill('');
    await phone.evaluate(() => { threadRenameInput.value = '已保存的标题'; threadActionCard.classList.remove('is-renaming'); });
    updateOnReload = true;
    await Promise.all([phone.waitForEvent('domcontentloaded'), phone.evaluate(() => checkClientVersion({ force: true }))]);
    await phone.waitForFunction(() => clientReady);
    assert.strictEqual(documentLoads, beforeUpdate + 1, 'an idle outdated page refreshes once');
    return { pendingAfterReload: true, pendingAfterThreadSwitch: true, pendingAfterReopen: true,
      expandedOptions: true, customInput: true, draftAndSelectionPreserved: true, keyboard: true, failureRetry: true,
      desktopAppOnly: true, desktopAnswerRequests: requests.filter(row => row.kind === 'desktop').length,
      queuedAnswer: true, multilineHistory: true, nativeAnswer: true, lateSnapshotIgnored: true, ownershipChange: true,
      historySeparateFromApprovals: true, historyCollapsedByDefault: true, historyExpansionPreserved: true,
      historyDismissalPersists: true, historyRestore: true, historyDismissalSyncedAcrossTabs: true, dismissalPreservesDrafts: true,
      updatePreservesDrafts: true, idleUpdateReloads: true,
      responsiveWidths: [320, 390, 1024], requests: requests.length };
  } finally { await ctx.close(); }
}
