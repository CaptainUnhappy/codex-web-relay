async (page, options = {}) => {
  const source = await (await page.request.get(options.sourceUrl || 'http://127.0.0.1:8787/')).text();
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const id = '01a14dcb-3bf7-7c60-9e10-ebb350f80a24';
  let version = 1, running = true, stage = 'load', configGate = null, bootstrapGate = null;
  const errors = [], reads = {}, writes = [];
  const models = [{ id: 'gpt-test', displayName: 'GPT Test', supportedReasoningEfforts: ['low', 'high', 'max'], isDefault: true },
    { id: 'gpt-other', displayName: 'GPT Other', supportedReasoningEfforts: ['low', 'high'] }];
  let modelId = 'gpt-test', effort = 'high', permissionMode = 'auto', denyPermission = false;
  const permissionOptions = ['ask', 'auto', 'full', 'custom'].map((id, i) => ({ id, label: ['请求批准', '帮我批准', '完全访问权限', '自定义'][i], description: '权限选项', allowed: true }));
  const status = () => ({ ok: true, available: true, threadId: id, active: running, observing: true, status: running ? 'running' : 'complete',
    startedAt: '2026-10-19T00:00:00Z', updatedAt: `2026-10-19T00:00:${String(version).padStart(2, '0')}Z`, progressVersion: version,
    preview: `实时内容 ${version}\n${'持续更新的回复。'.repeat(version)}`, final: `已完成 ${version}`, queue: [], approvals: [], desktopQuestions: [],
    model: { ...models.find(x => x.id === modelId), source: 'official' }, reasoningMode: { key: effort, label: effort, displayName: effort },
    permissions: { mode: permissionMode, updatedAt: new Date().toISOString() } });
  try {
    await ctx.addInitScript(id => localStorage.setItem('codexMini.selectedThread', id), id);
    await ctx.route('https://composer-fixture.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), name = url.pathname.split('/').pop();
      if (url.pathname === '/codex/') return route.fulfill({ contentType: 'text/html', body: source });
      reads[name] = (reads[name] || 0) + 1;
      let data = { ok: true }, code = 200;
      if (name === 'config') data = { ok: true, backend: 'app-server', localOnly: false, relayApiBases: ['https://composer-fixture.test/codex'], modelOptions: models, defaultModel: modelId, defaultReasoningEffort: 'high' };
      else if (name === 'relay-status') data = { ok: true, backend: 'app-server', deviceId: 'composer-fixture', configured: false };
      else if (name === 'threads') data = { ok: true, scope: url.searchParams.get('scope'), threads: url.searchParams.get('scope') === 'projects' ? [] : [{ id, name: '阅读与菜单测试', isProjectThread: false }], nextCursor: null };
      else if (name === 'status') data = status();
      else if (name === 'thread-bootstrap') data = { ok: true, status: status(), history: { ok: true, available: true,
        messages: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `历史 ${i + 1}\n${'可回看的历史内容。'.repeat(12)}` })), nextCursor: null } };
      else if (name === 'permissions') {
        if (req.method() === 'POST') {
          writes.push(req.postDataJSON());
          if (denyPermission) { code = 403; data = { ok: false, message: '当前策略不允许此权限。' }; }
          else { permissionMode = req.postDataJSON().mode; data = { ok: true, permissions: { mode: permissionMode, updatedAt: new Date().toISOString() } }; }
        } else data = { ok: true, options: permissionOptions, permissions: { mode: permissionMode, updatedAt: new Date().toISOString() } };
      } else if (name === 'reasoning-mode') {
        const body = req.postDataJSON(); writes.push(body); effort = body.target;
        data = { ok: true, targetReasoningMode: { key: effort, label: effort, displayName: effort, updatedAt: new Date().toISOString() } };
      } else if (name === 'model-switch') {
        const body = req.postDataJSON(); writes.push(body); modelId = body.target;
        data = { ok: true, targetModel: { ...models.find(x => x.id === modelId), updatedAt: new Date().toISOString() } };
      }
      if (name === 'config' && configGate) { const gate = configGate; configGate = null; gate.started(); await gate.wait; }
      if (name === 'thread-bootstrap' && bootstrapGate) { const gate = bootstrapGate; bootstrapGate = null; gate.started(); await gate.wait; }
      await route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(data) });
    });
    const phone = await ctx.newPage(); phone.on('pageerror', e => errors.push(e.message));
    const scrollBack = async (amount = 1000) => {
      const box = await phone.locator('#thread').boundingBox();
      await phone.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await phone.mouse.wheel(0, -amount);
      await phone.waitForFunction(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop > 48);
    };
    await phone.goto('https://composer-fixture.test/codex/');
    await phone.waitForFunction(() => clientReady && activeAssistant && !pollStatusBusy);
    const position = () => phone.locator('#thread').evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
    await phone.waitForFunction(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop < 5);
    stage = 'reading while streaming';
    await scrollBack();
    await phone.waitForFunction(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop > 900);
    const before = await position();
    version++;
    await phone.evaluate(() => pollStatus(activeWatch));
    await phone.waitForFunction(() => document.querySelector('.message.pending').textContent.includes('实时内容 2'));
    await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(Math.abs((await position()).top - before.top) < 3, 'stream updates must preserve the reader position');
    stage = 'keyboard layout while reading';
    await phone.locator('#text').fill('尚未发送的草稿');
    await phone.evaluate(() => { alignComposerForKeyboard(); restoreLayoutAfterKeyboard(); });
    await phone.evaluate(() => new Promise(resolve => setTimeout(resolve, 1400)));
    assert(Math.abs((await position()).top - before.top) < 3, 'keyboard layout must preserve the reader position');
    assert(await phone.locator('#jump-to-latest').isVisible(), 'return to latest button is visible while reading');
    stage = 'return to latest';
    await phone.locator('#jump-to-latest').click();
    await phone.waitForFunction(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop < 5);
    assert(await phone.locator('#jump-to-latest').isHidden(), 'return button hides at latest');
    version++; await phone.evaluate(() => pollStatus(activeWatch));
    await phone.waitForFunction(() => thread.scrollHeight - thread.clientHeight - thread.scrollTop < 5);
    stage = 'completion and idle updates while reading';
    await scrollBack();
    await phone.waitForFunction(() => !followLatest);
    const reading = await position(), historyReads = reads['thread-bootstrap'];
    running = false; version++; await phone.evaluate(() => pollStatus(activeWatch));
    assert(Math.abs((await position()).top - reading.top) < 3, 'completion must not jump to the final answer');
    version++; await phone.evaluate(() => refreshCurrentThreadIfChanged());
    assert(reads['thread-bootstrap'] === historyReads, 'idle updates defer history replacement while reading');
    await phone.locator('#text').fill('多行草稿\n第二行\n第三行\n第四行');
    await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(Math.abs((await position()).top - reading.top) < 3, 'growing composer preserves reading');
    await phone.locator('#jump-to-latest').click();
    await phone.waitForFunction(() => !historyLoadPromise && thread.scrollHeight - thread.clientHeight - thread.scrollTop < 5);
    assert(reads['thread-bootstrap'] === historyReads + 1, 'returning to latest loads deferred history once');
    stage = 'in-flight history update';
    let releaseBootstrap, bootstrapStarted;
    const bootstrapSeen = new Promise(resolve => { bootstrapStarted = resolve; });
    bootstrapGate = { started: bootstrapStarted, wait: new Promise(resolve => { releaseBootstrap = resolve; }) };
    version++; await phone.evaluate(() => { void refreshCurrentThreadIfChanged(); }); await bootstrapSeen;
    await scrollBack();
    await phone.waitForFunction(() => !followLatest);
    const delayedPosition = await position(); releaseBootstrap();
    await phone.waitForFunction(() => !historyLoadPromise && !autoRefreshBusy);
    assert(Math.abs((await position()).top - delayedPosition.top) < 3, 'late history responses cannot reset a newly scrolled reader');
    stage = 'return during an in-flight history request';
    await phone.locator('#jump-to-latest').click();
    await phone.waitForFunction(() => !historyLoadPromise);
    const returnHistorySeen = new Promise(resolve => { bootstrapStarted = resolve; });
    bootstrapGate = { started: bootstrapStarted, wait: new Promise(resolve => { releaseBootstrap = resolve; }) };
    version++; await phone.evaluate(() => { void refreshCurrentThreadIfChanged(); }); await returnHistorySeen;
    await scrollBack(); await phone.locator('#jump-to-latest').click(); releaseBootstrap();
    await phone.waitForFunction(() => !historyLoadPromise && !autoRefreshBusy && !historyRefreshPending && thread.scrollHeight - thread.clientHeight - thread.scrollTop < 5);
    for (const width of [320, 390, 1280]) {
      await phone.setViewportSize({ width, height: 844 });
      await scrollBack(600);
      await phone.waitForFunction(() => !followLatest);
      assert(await phone.locator('#jump-to-latest').evaluate(el => {
        const r = el.getBoundingClientRect(), footer = document.querySelector('.composer-shell').getBoundingClientRect();
        return Math.abs(r.x + r.width / 2 - footer.x - footer.width / 2) < 1 && r.bottom <= footer.top && r.x >= 0 && r.right <= innerWidth;
      }), 'return button is centered above the composer within each viewport');
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.screenshot({ path: 'output/playwright/read-history-return-mobile.png' });
    stage = 'model two-level menu';
    await phone.locator('#model-badge').click();
    assert(await phone.locator('#model-menu-card input[type=range]').isVisible(), 'first view edits reasoning strength');
    assert(await phone.locator('#model-menu-card .model-menu-item').count() === 0, 'model list is a separate view');
    await phone.locator('#model-menu-card').screenshot({ path: 'output/playwright/model-strength-menu-mobile.png' });
    await phone.locator('.model-picker-trigger').click();
    assert(await phone.locator('.model-menu-item').count() === 2, 'second view lists models');
    await phone.locator('#model-menu-card').screenshot({ path: 'output/playwright/model-list-menu-mobile.png' });
    await phone.locator('.model-menu-item[data-target="gpt-other"]').click();
    await phone.waitForFunction(() => !switchingModel);
    assert(writes.filter(x => x.target === 'gpt-other').length === 1, 'model choice submits once');
    await phone.locator('#model-badge').click();
    await phone.locator('#model-menu-card input[type=range]').press('Home');
    await phone.waitForFunction(() => !switchingReasoningMode);
    assert(writes.filter(x => x.target === 'low').length === 1, 'strength choice submits once');
    stage = 'permission option cache';
    await phone.locator('#permission-badge').click();
    await phone.locator('.permission-option[data-mode=ask]').waitFor();
    const permissionReads = reads.permissions;
    await phone.locator('body').press('Escape');
    await phone.locator('#permission-badge').click();
    assert(await phone.locator('.permission-option').count() === 4 && reads.permissions === permissionReads, 'reopening uses cached permissions');
    denyPermission = true;
    await phone.locator('.permission-option[data-mode=ask]').click();
    await phone.waitForFunction(() => !permissionBusy);
    assert((await phone.locator('#permission-menu-card').innerText()).includes('不允许'), 'changed server policy rejects cached option');
    assert(permissionMode === 'auto', 'rejected permission cannot change current selection');
    await phone.locator('body').press('Escape');
    await phone.locator('#permission-badge').click();
    await phone.waitForFunction(() => document.querySelectorAll('.permission-option').length === 4);
    assert(reads.permissions > permissionReads + 1, 'failed write invalidates cached options');
    await phone.locator('body').press('Escape');
    stage = 'cache survives reload without stale selected values';
    let releaseConfig, configStarted;
    const configSeen = new Promise(resolve => { configStarted = resolve; });
    configGate = { started: configStarted, wait: new Promise(resolve => { releaseConfig = resolve; }) };
    const beforeReloadReads = reads.permissions;
    await phone.evaluate(() => { localStorage.removeItem(MODEL_OVERRIDE_STORAGE_KEY); localStorage.removeItem(REASONING_OVERRIDE_STORAGE_KEY); });
    await phone.reload(); await configSeen;
    await phone.waitForFunction(() => modelMenuOptions.length === 2 && optionCacheKey);
    assert(await phone.locator('#model-badge').isVisible(), 'empty shell is visible before status is ready');
    assert(await phone.locator('#model-badge').innerText() === '', 'cached options never masquerade as current selected values');
    releaseConfig();
    await phone.waitForFunction(() => clientReady);
    await phone.locator('#permission-badge').click();
    assert(await phone.locator('.permission-option').count() === 4 && reads.permissions === beforeReloadReads, 'device-scoped permission cache survives reload');
    await phone.locator('body').press('Escape');
    await phone.evaluate(() => { permissionOptionCache.get(selectedThreadId).at = Date.now() - OPTION_CACHE_MS - 1; });
    await phone.locator('#permission-badge').click();
    await phone.locator('.permission-option[data-mode=ask]').waitFor();
    assert(reads.permissions === beforeReloadReads + 1, 'expired permission options are revalidated');
    assert(errors.length === 0, errors.join('\n'));
    return { streamingPreservesReading: true, keyboardPreservesReading: true, completionPreservesReading: true, deferredHistory: true, lateHistoryGuard: true,
      returnToLatest: [320, 390, 1280], modelTwoLevel: true, permissionCache: true, rejectedCachedPermission: true, cacheSurvivesReload: true, cacheExpiry: true, reads, writes: writes.length };
  } catch (error) {
    const debug = await ctx.pages().at(-1)?.evaluate(() => ({ followLatest, pending: historyRefreshPending, historyLoading: Boolean(historyLoadPromise), autoRefreshBusy, gap: thread.scrollHeight - thread.clientHeight - thread.scrollTop })).catch(() => ({}));
    throw new Error(`${stage}: ${error.message}; page errors: ${errors.join('; ')}; state: ${JSON.stringify(debug)}`);
  }
  finally { await ctx.close(); }
}
