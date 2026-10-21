async (page, options = {}) => {
  const source = await (await page.request.get(options.sourceUrl || 'http://127.0.0.1:8787/')).text();
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' });
  const id = '01a14dcb-3bf7-7c60-9e10-ebb350f80a24';
  const samples = [], errors = [], writes = [];
  const status = { ok: true, available: true, threadId: id, active: false, status: 'complete', final: '已完成', approvals: [], queue: [], desktopQuestions: [] };
  try {
    await ctx.addInitScript(id => {
      localStorage.setItem('codexMini.selectedThread', id);
      // Emulate the visual viewport reported by a mobile keyboard, while real
      // DOM layout, focus/blur handlers, RAFs and CSS transforms remain active.
      const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    }, id);
    await ctx.route('https://composer-viewport.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), name = url.pathname.split('/').pop();
      if (req.method() !== 'GET' && req.method() !== 'HEAD') writes.push(name);
      if (url.pathname === '/codex/') return route.fulfill({ contentType: 'text/html', body: source });
      let data = { ok: true };
      if (name === 'config') data = { ok: true, backend: 'app-server', localOnly: false, relayApiBases: ['https://composer-viewport.test/codex'] };
      else if (name === 'relay-status') data = { ok: true, backend: 'app-server', configured: false, deviceId: 'composer-viewport-fixture' };
      else if (name === 'threads') data = { ok: true, scope: url.searchParams.get('scope'), threads: url.searchParams.get('scope') === 'projects' ? [] : [{ id, name: '键盘布局测试', isProjectThread: false }], nextCursor: null };
      else if (name === 'thread-bootstrap') data = { ok: true, status, history: { ok: true, available: true, messages: [{ id: 'm1', role: 'assistant', text: '输入框在键盘打开和收起时保持可见。' }], nextCursor: null } };
      else if (name === 'status') data = status;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    const phone = await ctx.newPage();
    phone.on('pageerror', error => errors.push(error.message));
    await phone.goto('https://composer-viewport.test/codex/');
    await phone.waitForFunction(() => clientReady);
    const settle = () => phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const viewport = async (height, offsetTop = 0) => {
      await phone.evaluate(({ height, offsetTop }) => {
        Object.assign(window.visualViewport, { height, offsetTop, pageTop: offsetTop });
        window.visualViewport.dispatchEvent(new Event('resize'));
        window.visualViewport.dispatchEvent(new Event('scroll'));
      }, { height, offsetTop });
      await settle();
    };
    const record = async name => {
      await settle();
      const sample = await phone.locator('#composer').evaluate(el => {
        const rect = el.getBoundingClientRect(), viewport = window.visualViewport;
        const shell = el.parentElement;
        return { top: rect.top, bottom: rect.bottom, visibleTop: viewport.offsetTop, visibleBottom: viewport.offsetTop + viewport.height,
          padding: parseFloat(getComputedStyle(shell).paddingBottom), focused: document.activeElement === document.getElementById('text') };
      });
      samples.push({ name, ...sample });
      return sample;
    };
    await phone.locator('#text').fill('保留这段草稿');
    await phone.waitForTimeout(1400); // Let the existing focus alignment retries finish.
    await record('before keyboard');
    await viewport(500); await record('keyboard open');
    await phone.screenshot({ path: 'output/playwright/composer-keyboard-open-2026-10-20.png', clip: { x: 0, y: 0, width: 390, height: 500 } });
    await viewport(560, 40); await record('keyboard height and pan');
    await viewport(500);
    await phone.locator('#text').blur();
    await record('blur before keyboard finishes closing');
    await viewport(844); await record('keyboard closed');
    await phone.locator('#text').focus();
    await phone.waitForTimeout(1400);
    await viewport(800); await record('small visible viewport change while focused');
    await viewport(844); await record('small change recovered');
    await phone.setViewportSize({ width: 390, height: 500 });
    await viewport(500); await record('layout viewport also shrinks');
    await phone.setViewportSize({ width: 390, height: 844 });
    await viewport(844); await record('layout viewport recovered');
    await phone.evaluate(() => {
      window.visualViewport.height = 500;
      window.visualViewport.dispatchEvent(new Event('resize'));
      window.visualViewport.height = 480; // Final keyboard geometry settles after the event.
    });
    await record('geometry settles before the next frame');
    await viewport(844);
    for (let i = 0; i < 10; i++) {
      await phone.locator('#text').tap();
      await viewport(500 + i * 5);
      await phone.locator('#text').blur();
      await viewport(844);
    }
    await phone.waitForTimeout(1400);
    await record('rapid open and close timers settled');
    await phone.locator('.composer-shell').screenshot({ path: 'output/playwright/composer-viewport-8px-2026-10-20.png' });
    if (await phone.locator('#text').inputValue() !== '保留这段草稿') throw new Error('keyboard changes lost the draft');
    const offscreen = samples.filter(x => x.top < x.visibleTop - 1 || x.bottom > x.visibleBottom + 1);
    const misaligned = samples.filter(x => x.padding !== 8 || Math.abs(x.visibleBottom - x.bottom - x.padding) > 1);
    if (errors.length || writes.length || offscreen.length || misaligned.length) throw new Error(JSON.stringify({ offscreen, misaligned, errors, writes, samples }));
    return { samples, rapidCycles: 10, draftPreserved: true, writes: writes.length, errors };
  } finally { await ctx.close(); }
}
