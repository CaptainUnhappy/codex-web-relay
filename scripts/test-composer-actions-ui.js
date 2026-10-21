async (page, options = {}) => {
  const source = await (await page.request.get(options.sourceUrl || 'http://127.0.0.1:8787/')).text();
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const id = '01a14dcb-3bf7-7c60-9e10-ebb350f80a24';
  const sends = [], stops = [], errors = [];
  let running = true, failSend = false, sendGate = null, stopGate = null, stage = 'initial state';
  const status = () => ({ ok: true, available: true, threadId: id, active: running, status: running ? 'running' : 'complete',
    startedAt: '2026-10-19T00:00:00Z', preview: '测试回复', final: '已完成', approvals: [], queue: [], desktopQuestions: [] });
  try {
    await ctx.addInitScript(id => localStorage.setItem('codexMini.selectedThread', id), id);
    await ctx.route('https://composer-actions.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), name = url.pathname.split('/').pop();
      if (url.pathname === '/codex/') return route.fulfill({ contentType: 'text/html', body: source });
      let data = { ok: true }, code = 200;
      if (name === 'config') data = { ok: true, backend: 'app-server', localOnly: false, relayApiBases: ['https://composer-actions.test/codex'] };
      else if (name === 'relay-status') data = { ok: true, backend: 'app-server', configured: false, deviceId: 'composer-actions-fixture' };
      else if (name === 'threads') data = { ok: true, scope: url.searchParams.get('scope'), threads: url.searchParams.get('scope') === 'projects' ? [] : [{ id, name: '输入栏按钮测试', isProjectThread: false }], nextCursor: null };
      else if (name === 'thread-bootstrap') data = { ok: true, status: status(), history: { ok: true, available: true, messages: [{ id: 'm1', role: 'assistant', text: '输入内容后发送；回复进行中可停止。' }], nextCursor: null } };
      else if (name === 'status') data = status();
      else if (name === 'send') {
        sends.push(req.postDataJSON());
        if (sendGate) { sendGate.started(); await sendGate.wait; }
        if (failSend) { code = 500; data = { ok: false, message: '测试：发送失败' }; }
        else { data = { ok: true, threadId: id, queued: running, watch: { threadId: id, since: '2026-10-19T00:00:00Z' } }; running = true; }
      } else if (name === 'stop') {
        stops.push(req.postDataJSON());
        if (stopGate) await stopGate;
        running = false;
      }
      await route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(data) });
    });
    const phone = await ctx.newPage(); phone.on('pageerror', error => errors.push(error.message));
    await phone.goto('https://composer-actions.test/codex/');
    await phone.waitForFunction(() => clientReady && activeAssistant && !pollStatusBusy);
    const action = async expected => {
      const visible = await phone.locator('#composer > .send-btn:visible').evaluateAll(nodes => nodes.map(node => node.id));
      assert(JSON.stringify(visible) === JSON.stringify([expected]), `only ${expected} is visible: ${JSON.stringify(visible)}`);
    };
    await action('stop');
    assert(await phone.locator('#stop').isEnabled(), 'running empty composer can stop');
    for (const width of [320, 390, 1280]) {
      await phone.setViewportSize({ width, height: 844 });
      await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const padding = await phone.locator('.composer-shell').evaluate(el => ({ value: getComputedStyle(el).paddingBottom, keyboard: document.body.classList.contains('keyboard-open') }));
      assert(padding.value === '8px', `bottom spacing stays 8px in either keyboard state: ${JSON.stringify({ width, ...padding })}`);
      await phone.locator('#text').fill('准备发送的消息'); await action('send');
      assert(await phone.locator('#send').isEnabled(), 'text enables sending');
      if (width === 390) await phone.locator('#composer').screenshot({ path: 'output/playwright/composer-send-only.png' });
      await phone.locator('#text').fill(''); await action('stop');
      if (width === 390) await phone.locator('#composer').screenshot({ path: 'output/playwright/composer-stop-only.png' });
      assert(await phone.locator('#composer').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length === 3), 'composer reserves only one action column');
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    stage = 'whitespace and image input';
    await phone.locator('#text').fill(' \n '); await action('stop');
    await phone.locator('#text').fill('');
    await phone.locator('#file-input').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9N8AAAAASUVORK5CYII=', 'base64') });
    await phone.waitForFunction(() => pendingAttachments.length === 1); await action('send');
    assert(await phone.locator('#send').isEnabled(), 'an image enables sending without text');
    await phone.locator('.attachment-chip button').click(); await action('stop');
    stage = 'touch send does not trigger stop';
    await phone.locator('#text').fill('触摸发送一次');
    await phone.locator('#send').tap();
    await phone.waitForFunction(() => !sendRequestBusy);
    await action('stop');
    assert(sends.length === 1 && sends[0].text === '触摸发送一次' && stops.length === 0, 'touch sends once and never hits the replacement stop button');
    stage = 'failed send restores the send action';
    failSend = true;
    await phone.locator('#text').fill('失败后保留草稿'); await phone.locator('#send').tap();
    await phone.waitForFunction(() => !sendRequestBusy);
    await action('send');
    assert(await phone.locator('#send').isEnabled(), 'failed send unlocks the restored draft');
    assert(await phone.locator('#text').inputValue() === '失败后保留草稿', 'failed draft remains sendable');
    failSend = false;
    stage = 'pending send remains locked while typing';
    let releaseSend, markSendStarted;
    const sendStarted = new Promise(resolve => { markSendStarted = resolve; });
    sendGate = { started: markSendStarted, wait: new Promise(resolve => { releaseSend = resolve; }) };
    await phone.locator('#text').fill('等待发送完成'); await phone.locator('#send').tap();
    await sendStarted;
    await phone.waitForFunction(() => sendRequestBusy);
    await phone.locator('#text').fill('下一条草稿'); await action('send');
    assert(!await phone.locator('#send').isEnabled(), 'typing cannot unlock an in-flight send');
    const sentBeforeDuplicate = sends.length;
    await phone.locator('#text').press('Enter');
    await phone.evaluate(() => sendText());
    assert(sends.length === sentBeforeDuplicate, 'keyboard and direct submission cannot duplicate an in-flight send');
    releaseSend(); sendGate = null;
    await phone.waitForFunction(() => !sendRequestBusy);
    assert(await phone.locator('#send').isEnabled() && await phone.locator('#text').inputValue() === '下一条草稿', 'finishing a send preserves and enables the next draft');
    await phone.locator('#text').fill('');
    stage = 'idle empty composer';
    running = false; await phone.evaluate(() => pollStatus(activeWatch));
    for (const width of [320, 390, 1280]) {
      await phone.setViewportSize({ width, height: 844 });
      await action('send'); assert(!await phone.locator('#send').isEnabled(), 'idle empty composer shows a disabled send arrow');
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.locator('.composer-shell').screenshot({ path: 'output/playwright/composer-idle-send-2026-10-20.png' });
    await phone.locator('#text').fill('开始新回复'); await action('send');
    await phone.locator('#send').tap();
    await phone.waitForFunction(() => !sendRequestBusy && activeAssistant);
    await action('stop'); assert(await phone.locator('#stop').isEnabled(), 'new reply restores the stop action');
    stage = 'stop in flight remains locked';
    let releaseStop; stopGate = new Promise(resolve => { releaseStop = resolve; });
    await phone.locator('#stop').tap();
    await phone.waitForFunction(() => stopRequestBusy);
    await phone.locator('#text').fill('停止过程中输入'); await action('send');
    await phone.locator('#text').fill(''); await action('stop');
    assert(!await phone.locator('#stop').isEnabled(), 'typing and clearing cannot unlock a pending stop');
    await phone.evaluate(() => stopCodexResponse());
    assert(stops.length === 1, 'stop is submitted once');
    releaseStop();
    await phone.waitForFunction(() => !stopRequestBusy && !activeAssistant && !pollTimer);
    await action('send'); assert(!await phone.locator('#send').isEnabled(), 'completed stop returns to the disabled send arrow');
    stage = 'idle new conversation is available';
    await phone.locator('#thread-button').click();
    await phone.getByRole('button', { name: '新建对话', exact: true }).click();
    await phone.waitForFunction(() => pendingNewThread && !selectedThreadId);
    await action('send'); assert(!await phone.locator('#send').isEnabled(), 'empty new conversation stays disabled');
    const keyboardPadding = await phone.evaluate(() => {
      document.body.classList.add('keyboard-open');
      const padding = getComputedStyle(document.querySelector('.composer-shell')).paddingBottom;
      document.body.classList.remove('keyboard-open');
      return padding;
    });
    assert(keyboardPadding === '8px', 'keyboard-open spacing uses the same 8px');
    assert(errors.length === 0, errors.join('\n'));
    return { oneVisibleAction: [320, 390, 1280], textAndWhitespace: true, imageAndRemoval: true, touchSendOnce: true, failedDraftRestored: true, idleSendDisabled: true, pendingSendLocked: true, pendingStopLocked: true, idleNewConversation: true, bottomPadding: { normal: 8, keyboard: 8 }, sends: sends.length, stops: stops.length };
  } catch (error) { throw new Error(`${stage}: ${error.message}; page errors: ${errors.join('; ')}`); }
  finally { await ctx.close(); }
}
