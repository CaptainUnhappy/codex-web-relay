async (page, options = {}) => {
  const source = await (await page.request.get(options.sourceUrl || 'http://127.0.0.1:8787/')).text();
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const a = '01a14dcb-3bf7-7c60-9e10-ebb350f80a24', b = '01a14dcb-3bf7-7c60-9e10-ebb350f80a25';
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  let remaining = 92, quotaUnavailable = false, delayedStatus = null, delayedHistory = null;
  let permissionFailure = false, permissionMode = 'auto', modelPhase = 'model-only', modelLabel = 'GPT Test';
  let resetAt = Math.floor(Date.now() / 1000) + 5 * 86400 + 13 * 3600 + 120;
  const writes = [], errors = [];
  let stage = 'initial load';
  const contexts = { [a]: { available: true, percent: 80, usedTokens: 80000, windowTokens: 100000 }, [b]: null };
  const stamp = () => new Date().toISOString();
  const quota = () => ({ source: 'account', available: !quotaUnavailable, remainingPercent: quotaUnavailable ? null : remaining, resetsAt: resetAt, windowMinutes: 10080, updatedAt: stamp() });
  const permission = () => ({ mode: permissionMode, updatedAt: stamp() });
  try {
    await ctx.addInitScript(id => {
      localStorage.setItem('codexMini.selectedThread', id);
      localStorage.setItem('codexMini.contextDisplayMode.v1', '0');
      localStorage.setItem('codexMini.contextDisplayOrder.v1', '[0,1,2]');
    }, a);
    await ctx.route('https://metadata-fixture.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), id = url.searchParams.get('thread') || a;
      if (url.pathname === '/codex/') return route.fulfill({ contentType: 'text/html', body: source });
      const status = { ok: true, available: true, active: false, status: 'idle', threadId: id,
        model: modelPhase === 'effort-only' ? null : { id: 'gpt-test', displayName: modelLabel },
        reasoningMode: modelPhase === 'model-only' ? null : { key: 'high', displayName: 'High' },
        context: contexts[id] ? { ...contexts[id], threadId: id } : null, permissions: permission(), codexQuota: quota(), queue: [], approvals: [], desktopQuestions: [] };
      let data = { ok: true }, http = 200;
      if (url.pathname.endsWith('/config')) data = { ok: true, backend: 'app-server', relayApiBases: ['https://metadata-fixture.test/codex'], localOnly: false,
        defaultModel: 'gpt-test', modelOptions: [{ id: 'gpt-test', displayName: modelLabel, supportedReasoningEfforts: ['low', 'high'] }] };
      else if (url.pathname.endsWith('/relay-status')) data = { ok: true, backend: 'app-server', configured: false, deviceId: 'metadata-fixture' };
      else if (url.pathname.endsWith('/threads')) data = { ok: true, scope: url.searchParams.get('scope'), threads: url.searchParams.get('scope') === 'projects' ? [] : [{ id: a, name: '对话 A', isProjectThread: false }, { id: b, name: '对话 B', isProjectThread: false }], nextCursor: null };
      else if (url.pathname.endsWith('/thread-bootstrap')) {
        data = { ok: true, threadId: id, status, history: { ok: true, available: true, messages: [{ id: 'm', role: 'assistant', text: id === a ? '对话 A' : '对话 B' }], nextCursor: null } };
        if (delayedHistory) { const d = delayedHistory; delayedHistory = null; d.started(); await d.gate; }
      } else if (url.pathname.endsWith('/status')) {
        data = status;
        if (delayedStatus) { const d = delayedStatus; delayedStatus = null; d.started(); await d.gate; }
      } else if (url.pathname.endsWith('/account-usage')) data = { ok: true, codexQuota: quota() };
      else if (url.pathname.endsWith('/permissions')) {
        if (req.method() === 'POST') {
          writes.push(req.postDataJSON());
          if (permissionFailure) { http = 409; data = { ok: false, message: '测试：桌面端正在占用，修改未保存。' }; }
          else { permissionMode = req.postDataJSON().mode; data = { ok: true, permissions: permission(), message: '权限已更新，对下一次回复生效。' }; }
        } else data = { ok: true, permissions: permission(), options: [
          { id: 'ask', label: '请求批准', description: '需要时向你请求批准', allowed: true },
          { id: 'auto', label: '帮我批准', description: '自动审核操作风险', allowed: true },
          { id: 'full', label: '完全访问权限', description: '访问文件和网络', allowed: true },
          { id: 'custom', label: '自定义（config.toml）', description: '使用配置权限', allowed: true },
        ] };
      }
      await route.fulfill({ status: http, contentType: 'application/json', body: JSON.stringify(data) });
    });
    const phone = await ctx.newPage();
    phone.on('pageerror', e => errors.push(e.message));
    await phone.goto('https://metadata-fixture.test/codex/');
    await phone.waitForFunction(() => clientReady, null, { timeout: 5000 });
    const ring = phone.locator('#top-status'), badge = phone.locator('#codex-quota-text');
    assert((await ring.getAttribute('aria-label')).includes('80%'), 'initial context must be A');
    assert(await badge.innerText() === '92%', 'account quota must load');
    assert(await phone.locator('#conversation-usage-badge').count() === 0, 'no duplicate context tokens');
    const model = phone.locator('#model-badge'), quotaPill = phone.locator('#codex-quota-badge');
    const refreshStatus = async () => { await phone.waitForFunction(() => !autoRefreshBusy); await phone.evaluate(() => refreshCurrentThreadIfChanged()); };
    stage = 'combined model loading';
    assert(await model.isVisible() && await model.innerText() === '' && !await model.isEnabled(), 'loading keeps an empty, disabled model shell');
    modelPhase = 'effort-only'; await refreshStatus();
    assert(await model.isVisible() && await model.innerText() === '', 'effort alone must not be shown in the shell');
    modelPhase = 'complete'; await refreshStatus();
    assert(await model.isVisible(), 'complete model and effort must appear together');
    assert((await model.innerText()).includes('GPT Test') && (await model.innerText()).includes('High'), 'combined model label');
    stage = 'countdown boundaries';
    const countdowns = await phone.evaluate(() => {
      const now = 1800000000000, reset = seconds => quotaResetCountdown(now / 1000 + seconds, now);
      return [reset(5 * 86400 + 13 * 3600), reset(3 * 3600 + 42 * 60), reset(23 * 3600 + 59 * 60), reset(86400), reset(3600), reset(3599), reset(42 * 60), reset(59), reset(-1), quotaResetCountdown(null, now)];
    });
    assert(JSON.stringify(countdowns) === JSON.stringify(['5d', '3h', '23h', '1d', '1h', '59m', '42m', '0m', '0m', '--']), 'countdown uses a single unit across day, hour and minute boundaries');
    const measure = () => ring.evaluate(el => {
      const box = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      const circle = el.querySelector('.context-ring'), text = el.querySelector('.context-text');
      const quota = document.getElementById('codex-quota-badge');
      return { box: box(el), circle: box(circle), text: box(text), next: box(document.getElementById('model-badge')),
        quota: box(quota), quotaCircle: box(quota.querySelector('.quota-ring')), quotaText: box(quota.querySelector('.usage-value')),
        radius: getComputedStyle(el).borderRadius, textVisible: getComputedStyle(text).display !== 'none' };
    });
    stage = 'compact fixed geometry';
    for (const width of [320, 390, 1280]) {
      await phone.setViewportSize({ width, height: 844 });
      await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const before = await measure();
      assert(before.box[2] === 60 && before.quota[2] === 60 && before.box[3] === 32 && before.quota[3] === 32, 'quota and context share the same compact fixed dimensions');
      assert(before.textVisible && before.circle[0] < before.text[0], 'context always shows circle on left and value on right');
      assert(before.quotaCircle[0] < before.quotaText[0], 'quota also has circle on left and value on right');
      assert(await ring.locator('.context-percent').innerText() === '80%', 'legacy ring-only preference migrates to percent');
      for (const expected of ['80k', '80%', '80k', '80%']) {
        await ring.click();
        assert(await ring.locator('.context-percent').innerText() === expected, 'only percent and token count are cycled');
        assert(JSON.stringify(await measure()) === JSON.stringify(before), 'toggling must not change control or neighbour geometry');
      }
      await quotaPill.click();
      assert(await badge.innerText() === '5d', 'click quota shows reset countdown');
      assert(JSON.stringify(await measure()) === JSON.stringify(before), 'quota countdown must not move either control or neighbours');
      assert(await badge.evaluate(el => el.scrollWidth <= el.clientWidth), 'countdown must fit without clipping');
      await quotaPill.click();
      assert(await badge.innerText() === '92%', 'second click restores remaining percent');
      assert(JSON.stringify(await measure()) === JSON.stringify(before), 'quota percent must preserve geometry');
      const modelLayout = await model.evaluate(el => {
        const r = el.getBoundingClientRect(), arrow = el.querySelector('.model-control-chevron').getBoundingClientRect();
        const label = el.querySelector('#model-text').getBoundingClientRect(), effort = el.querySelector('#reasoning-text').getBoundingClientRect();
        return { display: getComputedStyle(el).display, centerOffset: arrow.y + arrow.height / 2 - r.y - r.height / 2,
          labelOffset: label.y + label.height / 2 - effort.y - effort.height / 2, gap: arrow.x - effort.right, inset: r.right - arrow.right };
      });
      assert(['flex', 'inline-flex'].includes(modelLayout.display) && Math.abs(modelLayout.centerOffset) < 0.5
        && Math.abs(modelLayout.labelOffset) < 0.5 && modelLayout.gap >= 0 && modelLayout.inset >= 0,
        `model, effort and arrow must stay inline with centered arrow: ${JSON.stringify(modelLayout)}`);
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    stage = 'sub-day countdown';
    resetAt = Math.floor(Date.now() / 1000) + 23 * 3600 + 59 * 60 + 50;
    await phone.waitForFunction(() => !quotaReadBusy);
    await phone.evaluate(() => refreshCodexQuota(true));
    await phone.waitForFunction(expected => latestCodexQuota?.resetsAt === expected, resetAt);
    await quotaPill.click();
    await phone.waitForFunction(() => document.getElementById('codex-quota-text').textContent === '23h');
    assert(await badge.innerText() === '23h', 'sub-day countdown uses hours only');
    assert(await badge.evaluate(el => el.scrollWidth <= el.clientWidth), 'longest sub-day label fits');
    await phone.locator('#composer-meta').screenshot({ path: 'output/playwright/context-pill-mobile.png' });
    await quotaPill.click();
    const switchTo = async id => { await phone.locator('#thread-button').click(); await phone.locator(`[data-focus-key="thread:${id}"]`).click(); };
    let releaseHistory, historyStarted;
    const historySeen = new Promise(resolve => { historyStarted = resolve; });
    delayedHistory = { started: historyStarted, gate: new Promise(resolve => { releaseHistory = resolve; }) };
    stage = 'delayed history switch';
    await switchTo(b); await historySeen;
    assert((await ring.getAttribute('aria-label')).includes('暂未读到'), 'clear A immediately while B is loading');
    releaseHistory();
    await phone.waitForFunction(() => !historyLoadPromise);
    assert((await ring.getAttribute('aria-label')).includes('暂未读到'), 'B has no context and must stay unknown');
    stage = 'live context refresh';
    contexts[b] = { available: true, percent: 12, usedTokens: 24000, windowTokens: 200000 };
    await phone.waitForFunction(() => document.getElementById('top-status').getAttribute('aria-label').includes('12%'), null, { timeout: 10000 });
    assert((await ring.getAttribute('aria-label')).includes('12%'), 'live status updates B');
    let releaseStatus, statusStarted;
    const statusSeen = new Promise(resolve => { statusStarted = resolve; });
    delayedStatus = { started: statusStarted, gate: new Promise(resolve => { releaseStatus = resolve; }) };
    stage = 'late status switch';
    await phone.evaluate(() => { void refreshCurrentThreadIfChanged(); }); await statusSeen;
    await switchTo(a);
    await phone.waitForFunction(() => !historyLoadPromise);
    releaseStatus();
    await phone.waitForFunction(() => !autoRefreshBusy);
    assert((await ring.getAttribute('aria-label')).includes('80%'), 'late B response must not overwrite A');
    let releaseOldA, oldAStarted;
    const oldASeen = new Promise(resolve => { oldAStarted = resolve; });
    delayedStatus = { started: oldAStarted, gate: new Promise(resolve => { releaseOldA = resolve; }) };
    await phone.evaluate(() => { void refreshCurrentThreadIfChanged(); }); await oldASeen;
    await switchTo(b); await phone.waitForFunction(() => !historyLoadPromise);
    contexts[a] = { available: true, percent: 30, usedTokens: 30000, windowTokens: 100000 };
    await switchTo(a); await phone.waitForFunction(() => !historyLoadPromise);
    releaseOldA(); await phone.waitForFunction(() => !autoRefreshBusy);
    assert((await ring.getAttribute('aria-label')).includes('30%'), 'A-B-A switch must reject the first A request');
    stage = 'one percent quota';
    remaining = 1; await phone.evaluate(() => refreshCodexQuota(true));
    await phone.waitForFunction(() => document.getElementById('codex-quota-text').textContent === '1%');
    stage = 'unavailable quota';
    quotaUnavailable = true; await phone.evaluate(() => refreshCodexQuota(true));
    await phone.waitForFunction(() => document.getElementById('codex-quota-text').textContent === '--');
    stage = 'quota reconnect';
    quotaUnavailable = false; remaining = 90; await phone.evaluate(() => refreshCodexQuota(true));
    await phone.waitForFunction(() => document.getElementById('codex-quota-text').textContent === '90%');
    stage = 'permission success';
    await phone.locator('#permission-badge').click();
    await phone.locator('.permission-option[data-mode="ask"]').waitFor();
    await phone.locator('.permission-option[data-mode="ask"]').click();
    await phone.waitForFunction(() => !permissionBusy);
    assert(writes.length === 1 && writes[0].threadId === a && writes[0].mode === 'ask', 'one scoped permission write');
    assert((await phone.locator('#permission-badge').getAttribute('title')).includes('请求批准'), 'only confirmed permission is displayed');
    permissionFailure = true;
    await phone.locator('#permission-badge').click();
    await phone.locator('.permission-option[data-mode="auto"]').click();
    await phone.waitForFunction(() => !permissionBusy);
    assert((await phone.locator('#permission-menu-card').innerText()).includes('修改未保存'), 'writer conflict is visible');
    assert((await phone.locator('#permission-badge').getAttribute('title')).includes('请求批准'), 'failed write does not fake a change');
    assert(writes.length === 2, 'failed write is not retried');
    await phone.screenshot({ path: 'output/playwright/session-permissions-mobile.png' });
    await phone.locator('body').press('Escape');
    await phone.setViewportSize({ width: 1280, height: 800 });
    await phone.locator('#permission-badge').click();
    await phone.locator('.permission-option[data-mode="custom"]').waitFor();
    assert(await phone.locator('.permission-option').count() === 4, 'desktop has the same four choices');
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await phone.screenshot({ path: 'output/playwright/session-permissions-desktop.png' });
    await phone.locator('body').press('Escape');
    stage = 'responsive label priority';
    modelLabel = 'GPT-6.1-Sol';
    await phone.evaluate(() => loadApiConfig()); await refreshStatus();
    const adaptiveLabels = [];
    for (const width of [1280, 430, 390, 375, 360, 340, 320, 1280]) {
      await phone.setViewportSize({ width, height: 844 });
      await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const labels = { width, permission: await phone.locator('#permission-badge').innerText(), model: await phone.locator('#model-text').innerText() };
      adaptiveLabels.push(labels);
      assert(labels.model.startsWith('GPT') || labels.permission === '权限', 'permission must shorten before removing the model prefix');
      assert((await model.getAttribute('aria-label')).includes(modelLabel), 'accessible model name remains complete');
      if (width === 1280) assert(labels.permission === '更改权限' && labels.model === modelLabel, 'wide layouts always restore full labels');
      if (width === 390 || width === 375 || width === 360) await phone.locator('#composer-meta').screenshot({ path: `output/playwright/adaptive-labels-${width}.png` });
    }
    assert(adaptiveLabels.some(x => x.permission === '权限' && x.model === modelLabel), `permission-only shortening has priority: ${JSON.stringify(adaptiveLabels)}`);
    assert(adaptiveLabels.some(x => x.permission === '权限' && x.model === '6.1-Sol'), 'model prefix is a fallback at narrower widths');
    await phone.setViewportSize({ width: 320, height: 844 });
    await model.click(); await phone.locator('.model-picker-trigger').click();
    assert((await phone.locator('.model-menu-item[data-target="gpt-test"]').innerText()).includes(modelLabel), 'model picker keeps full names on narrow screens');
    assert(await phone.evaluate(() => currentModelInfo.id) === 'gpt-test', 'responsive labels do not change the model selection');
    await phone.locator('body').press('Escape');
    modelLabel = 'gpt-6-astra'; await refreshStatus();
    await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await phone.locator('#model-text').innerText() === '6-astra', 'lowercase gpt prefix also shortens');
    assert(errors.length === 0, errors.join('\n'));
    return { quotaRefresh: true, onePercent: true, unknownAndReconnect: true, immediateThreadReset: true,
      lateResponseIsolation: true, ringCycle: true, fixedContextGeometry: [320, 390, 1280], contextModes: ['percent', 'tokens'], quotaCountdown: countdowns,
      compactPills: { context: 60, quota: 60, height: 32 }, combinedModelLoading: true, centeredChevron: true,
      permissionWrite: true, permissionFailure: true, desktopAndMobile: true, adaptiveLabels, writes: writes.length };
  } catch (error) { const body = await ctx.pages().at(-1)?.locator('body').innerText().catch(() => ''); throw new Error(`${stage}: ${error.message}; page errors: ${errors.join('; ')}; UI: ${body}`); }
  finally { await ctx.close(); }
}
