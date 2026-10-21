async (page, options = {}) => {
  // Production HTML, isolated fixture API, actual browser touch input.
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const source = await (await page.request.get(options.sourceUrl || 'http://127.0.0.1:8787/')).text();
  const imageResponse = await page.request.get(new URL('icons/icon-512.png', options.sourceUrl || 'http://127.0.0.1:8787/').href);
  assert(imageResponse.ok(), 'image fixture must load');
  const png = await imageResponse.body();
  const threadId = '01a14dcb-3bf7-7c60-9e10-ebb350f80a24';
  const otherId = '01a14dcb-3bf7-7c60-9e10-ebb350f80a25';
  const initial = { threadId, objective: '检查图片预览与目标同步，完整显示一个较长的目标内容。'.repeat(3), status: 'active', createdAt: 1, updatedAt: 2, timeUsedSeconds: 210, tokenBudget: null, tokensUsed: 1200 };
  let goal = { ...initial }, failNext = false, loseNextResponse = false;
  const imageId = 'm'.repeat(43), missingId = 'z'.repeat(43);
  const markdownImage = `![按钮预览](codex-image:${imageId})`;
  let streamImages = false, streamComplete = false;
  const writes = [], errors = [];
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await ctx.addInitScript(id => localStorage.setItem('codexMini.selectedThread', id), threadId);
    await ctx.route('https://media-goal-fixture.test/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === '/codex/') return route.fulfill({ status: 200, contentType: 'text/html', body: source });
      if (url.pathname.endsWith('/codex/image')) return url.searchParams.get('id') === missingId
        ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' })
        : route.fulfill({ status: 200, contentType: 'image/png', body: png });
      let data = { ok: true }, statusCode = 200;
      const requestedThread = url.searchParams.get('thread') || threadId;
      const liveImage = `![实时图片](codex-image:${imageId})`;
      const status = { ok: true, available: true, threadId: requestedThread, status: streamImages ? streamComplete ? 'complete' : 'running' : 'idle', active: streamImages && !streamComplete,
        preview: streamImages ? liveImage : '', final: streamComplete ? liveImage : '', steps: streamImages ? [{ kind: 'assistant', text: liveImage }] : [],
        queue: [], approvals: [], goal: requestedThread === threadId ? goal : null };
      if (url.pathname.endsWith('/codex/config')) data = { ...data, backend: 'app-server', localOnly: false, relayApiBases: ['https://media-goal-fixture.test/codex'], capabilities: { releaseSession: true, autoReleaseSession: true }, connection: { idleReleaseSeconds: 60 } };
      else if (url.pathname.endsWith('/codex/relay-status')) data = { ...data, deviceId: 'fixture-device', backend: 'app-server', appServer: { idleReleaseSeconds: 60 }, configured: false };
      else if (url.pathname.endsWith('/codex/threads')) data = { ...data, scope: url.searchParams.get('scope'), threads: url.searchParams.get('scope') === 'conversations' ? [{ id: threadId, name: '图片与目标测试', isProjectThread: false }, { id: otherId, name: '另一个对话', isProjectThread: false }] : [], nextCursor: null };
      else if (url.pathname.endsWith('/codex/thread-bootstrap')) data = { ...data, threadId: requestedThread, history: { ok: true, threadId: requestedThread, available: true, messages: [
        { id: 'image-msg', role: 'user', text: '查看这张图片', attachments: [{ name: 'history-image.png', previewId: 'fixture-image' }] },
        { id: 'markdown-image', role: 'assistant', text: `${markdownImage}\n\n\`${markdownImage}\`\n\n\`\`\`markdown\n${markdownImage}\n\`\`\`\n\n[普通链接](https://example.test/)` },
      ], nextCursor: null }, status };
      else if (url.pathname.endsWith('/codex/status')) data = status;
      else if (url.pathname.endsWith('/codex/goal')) {
        if (req.method() === 'POST') {
          const body = req.postDataJSON(); writes.push(body);
          if (failNext) { failNext = false; statusCode = 409; data = { ok: false, message: '测试：目标已在其他设备更新，请重试。' }; }
          else {
            if (body.action === 'clear') goal = null;
            else if (body.action === 'update') goal = { ...goal, objective: body.objective };
            else goal = { ...goal, status: body.action === 'pause' ? 'paused' : 'active' };
            data = { ok: true, goal };
            if (loseNextResponse) { loseNextResponse = false; return route.fulfill({ status: 502, contentType: 'text/html', body: 'Lost response after write' }); }
          }
        } else data = { ok: true, goal };
      }
      await route.fulfill({ status: statusCode, contentType: 'application/json', body: JSON.stringify(data) });
    });
    const phone = await ctx.newPage(); phone.on('pageerror', error => errors.push(error.message));
    await phone.goto('https://media-goal-fixture.test/codex/');
    await phone.locator('#goal-strip:not([hidden])').waitFor();
    const markdownThumb = phone.locator('.markdown-image');
    assert(await markdownThumb.count() === 1, 'only the actual Markdown image renders; inline and fenced code stay literal');
    await markdownThumb.scrollIntoViewIfNeeded();
    await phone.waitForFunction(() => document.querySelector('.markdown-image').naturalWidth > 0);
    assert(await phone.locator('.message.assistant code').count() === 2, 'code examples remain code');
    assert(await phone.locator('.message.assistant a[href="https://example.test/"]').count() === 1, 'ordinary links still render');
    await markdownThumb.click();
    await phone.waitForFunction(() => document.getElementById('image-viewer').open && document.getElementById('image-viewer-image').naturalWidth > 0);
    await phone.locator('#image-viewer-close').click();
    const initialBounds = await phone.evaluate(() => {
      const goal = document.getElementById('goal-strip').getBoundingClientRect();
      const title = document.getElementById('thread-button').getBoundingClientRect();
      return { goal: { x: goal.x, y: goal.y, right: goal.right, height: goal.height }, titleBottom: title.bottom, width: innerWidth };
    });
    assert(initialBounds.goal.y >= initialBounds.titleBottom - 1, 'Goal belongs below title');
    assert(initialBounds.goal.right <= initialBounds.width && initialBounds.goal.height <= 48, 'Goal stays compact on phone');
    await phone.locator('#goal-edit').click();
    assert(await phone.locator('#goal-objective-input').inputValue() === initial.objective, 'detail dialog shows the whole objective');
    await phone.locator('#goal-objective-input').fill('修改目标第一行 <beta>\n第二行');
    failNext = true;
    await phone.locator('#goal-save').click();
    await phone.waitForFunction(() => !goalBusy && document.getElementById('goal-error').textContent);
    assert((await phone.locator('#goal-objective-input').inputValue()).includes('\n第二行'), 'failed writes retain the draft');
    await phone.locator('#goal-save').click();
    await phone.waitForFunction(() => !document.getElementById('goal-dialog').open);
    assert(goal.objective === '修改目标第一行 <beta>\n第二行', 'native request preserves text and line breaks');
    await phone.locator('#goal-pause').click();
    await phone.getByRole('button', { name: '继续目标', exact: true }).waitFor();
    assert(goal.status === 'paused', 'pause persists through API');
    await phone.reload();
    await phone.getByRole('button', { name: '继续目标', exact: true }).waitFor();
    await phone.locator('#goal-pause').click();
    await phone.getByRole('button', { name: '暂停目标', exact: true }).waitFor();
    assert(goal.status === 'active', 'resume persists through API');
    await phone.locator('#goal-edit').click();
    await phone.locator('#goal-objective-input').fill('丢失回执后仍能确认保存');
    loseNextResponse = true;
    const beforeLost = writes.length;
    await phone.locator('#goal-save').click();
    await phone.waitForFunction(() => !goalBusy && !document.getElementById('goal-dialog').open);
    assert(writes.length === beforeLost + 1, 'lost response must be reconciled by read, never duplicate POST');
    assert((await phone.locator('#notice').textContent()).includes('已确认'), 'readback success must not leave a false failure notice');
    await phone.evaluate(() => {
      const staleEpoch = goalEpoch - 1;
      updateContextFromStatus({ threadId: selectedThreadId, goal: null }, staleEpoch);
      if (!currentGoal) throw Error('stale status overwrote the Goal');
    });

    const img = phone.locator('.message-attachments img').first();
    if (!(await img.count())) throw new Error(`Missing thumbnail: ${await phone.locator('#thread').innerHTML()}`);
    await img.waitFor(); await img.click();
    await phone.waitForFunction(() => document.getElementById('image-viewer').open && document.getElementById('image-viewer-image').naturalWidth > 0);
    const cdp = await ctx.newCDPSession(phone);
    const stage = await phone.locator('#image-viewer-stage').boundingBox();
    const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
    const touch = (id, x, y) => ({ id, x, y, radiusX: 3, radiusY: 3, force: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(1, cx - 40, cy), touch(2, cx + 40, cy)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(1, cx - 100, cy), touch(2, cx + 100, cy)] });
    await phone.waitForFunction(() => imageScale > 2);
    const zoomed = await phone.evaluate(() => imageScale);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(1, cx - 50, cy), touch(2, cx + 50, cy)] });
    await phone.waitForFunction(() => imageScale < 2);
    const reduced = await phone.evaluate(() => imageScale);
    assert(zoomed > reduced && reduced > 1, 'two-finger pinch zooms in and out');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await phone.locator('#image-zoom-in').click();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(1, cx, cy)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(1, cx + 50, cy)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert(Math.abs(await phone.evaluate(() => imageX)) > 10, 'one finger pans a zoomed image');
    await phone.screenshot({ path: 'output/playwright/image-pinch-mobile.png' });
    await phone.locator('#image-viewer-close').click();
    assert(!(await phone.locator('#image-viewer').isVisible()), 'close hides the viewer');
    await img.focus(); await img.press('Enter');
    await phone.locator('#image-viewer').press('Escape');
    assert(!(await phone.locator('#image-viewer').isVisible()), 'keyboard Escape closes viewer');
    assert(await img.evaluate(el => el === document.activeElement), 'focus returns to the image');
    await phone.locator('#text').fill('预览图片后仍保留的草稿');
    await phone.locator('#file-input').setInputFiles({ name: 'pending.png', mimeType: 'image/png', buffer: png });
    await phone.locator('.attachment-chip img').click();
    await phone.locator('#image-viewer-close').click();
    assert(await phone.locator('#text').inputValue() === '预览图片后仍保留的草稿', 'preview must preserve composer draft');
    assert(await phone.locator('.attachment-chip').count() === 1, 'preview must preserve pending uploads');
    await phone.setViewportSize({ width: 844, height: 390 });
    await img.click();
    assert(await phone.locator('#image-viewer-close').isVisible(), 'landscape close remains visible');
    await phone.locator('#image-zoom-reset').click();
    await phone.locator('#image-viewer-close').click();
    await phone.setViewportSize({ width: 390, height: 844 });

    await phone.locator('#thread-button').click();
    assert(!(await phone.locator('#goal-strip').isVisible()), 'thread picker has the available height');
    await phone.locator(`[data-focus-key="thread:${otherId}"]`).click();
    await phone.waitForFunction(id => selectedThreadId === id && !currentGoal, otherId);
    await phone.locator('#thread-button').click();
    await phone.locator(`[data-focus-key="thread:${threadId}"]`).click();
    await phone.locator('#goal-strip:not([hidden])').waitFor();
    await phone.locator('#thread-name').evaluate(el => { el.textContent = '检查 Web UI 与仓库更新 · 很长的对话标题'; });
    const singleRow = await phone.evaluate(() => {
      const a = document.getElementById('thread-button').getBoundingClientRect(), b = document.querySelector('.top-actions').getBoundingClientRect();
      return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 20;
    });
    assert(singleRow, 'long title must not push top actions onto a second row');
    await phone.screenshot({ path: 'output/playwright/goal-strip-mobile.png' });
    await phone.setViewportSize({ width: 1280, height: 900 });
    await phone.screenshot({ path: 'output/playwright/goal-strip-desktop.png' });
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'desktop has no horizontal overflow');
    phone.once('dialog', dialog => dialog.dismiss());
    await phone.locator('#goal-clear').click(); assert(goal, 'cancel leaves goal unchanged');
    phone.once('dialog', dialog => dialog.accept());
    await phone.locator('#goal-clear').click();
    await phone.waitForFunction(() => !currentGoal && !goalBusy);
    assert(!goal && !(await phone.locator('#goal-strip').isVisible()), 'confirmed clear removes Goal');
    await phone.setViewportSize({ width: 390, height: 844 });
    if (await phone.locator('#jump-to-latest').isVisible()) await phone.locator('#jump-to-latest').click();
    streamImages = true;
    await phone.waitForFunction(() => !autoRefreshBusy && !historyLoadPromise);
    await phone.evaluate(() => refreshCurrentThreadIfChanged());
    const liveThumb = phone.locator('.message.pending .markdown-image');
    await liveThumb.waitFor(); await liveThumb.scrollIntoViewIfNeeded();
    await phone.waitForFunction(() => document.querySelector('.message.pending .markdown-image')?.naturalWidth > 0);
    await liveThumb.click();
    await phone.waitForFunction(() => document.getElementById('image-viewer').open && document.getElementById('image-viewer-image').naturalWidth > 0);
    await phone.locator('#image-viewer-close').click();
    streamComplete = true;
    await phone.evaluate(() => pollStatus(activeWatch));
    await phone.waitForFunction(() => !activeAssistant && !pollTimer);
    assert(await phone.locator('.message img[alt="实时图片"]').count() === 1, 'final answer keeps the live image');
    const cached = await phone.evaluate(() => {
      serializeMessages(); const saved = localStorage.getItem(chatStorageKey());
      clearThreadMessages(); restoreMessages(); return saved;
    });
    assert(cached.includes('data-preview-id') && !cached.includes('/codex/image?'), 'cached Markdown images retain opaque IDs without authenticated URLs');
    const restored = phone.locator('.message img[alt="实时图片"]');
    await restored.scrollIntoViewIfNeeded();
    await phone.waitForFunction(() => document.querySelector('.message img[alt="实时图片"]')?.naturalWidth > 0);
    const escapedAlt = await phone.evaluate(id => {
      const msg = messageEl('assistant', `![\" onerror=\"alert(1)](codex-image:${id})`);
      const img = msg.bubble.querySelector('img'); return { count: msg.bubble.querySelectorAll('img').length, handler: img?.getAttribute('onerror') };
    }, imageId);
    assert(escapedAlt.count === 1 && escapedAlt.handler === null, 'image alt text cannot inject HTML attributes');
    await phone.evaluate(id => messageEl('assistant', `![缺失图](codex-image:${id})`), missingId);
    await phone.waitForFunction(() => [...document.querySelectorAll('.attachment-note')].some(el => el.textContent.includes('图片无法加载')));
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
    return { passed: true, markdownHistory: true, markdownCodeLiteral: true, markdownLiveAndFinal: true, markdownCacheRestore: true, escapedAlt: true, missingImage: true,
      pinch: { zoomed, reduced }, actions: writes.map(row => row.action), initialBounds, errors };
  } finally { await ctx.close(); }
}
