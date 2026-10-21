async (page, options = {}) => {
  const ctx = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const base = options.relayUrl || 'http://127.0.0.1:19088/codex/', control = options.controlUrl || 'http://127.0.0.1:19089';
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const state = async () => (await page.request.get(`${control}/state`)).json();
  let phone; const errors = [];
  const ready = (tab, device) => tab.waitForFunction(device => typeof clientReady !== 'undefined' && clientReady && activeDeviceId === device, device, { timeout: 10000 });
  const switchTo = async (tab, key, device) => {
    await tab.evaluate(key => { location.hash = `k=${key}`; }, key);
    await ready(tab, device);
  };
  try {
    await page.request.get(`${control}/reset`);
    // Reproduce the old authenticated A + incoming B fragment path.
    await ctx.request.post(`${base}login`, { data: { passphrase: 'fixture-key-a' } });
    phone = await ctx.newPage(); phone.on('pageerror', error => errors.push(error.message));
    await phone.goto(base); await ready(phone, 'fixture-a');
    const ids = (await state()).ids;
    await phone.evaluate(id => {
      localStorage.setItem('codexMini.selectedThread', id);
      localStorage.removeItem(SELECTED_THREAD_STORAGE_KEY);
    }, ids.a[1]);
    await page.request.get(`${control}/reset`);
    await phone.goto(`${base}#k=fixture-key-b`);
    await ready(phone, 'fixture-b');
    assert((await phone.locator('#thread-button').innerText()).startsWith('B conversation'), 'incoming B key must replace an existing A login before loading its thread');
    assert(!new URL(phone.url()).hash, 'successful pairing removes the key fragment');
    assert((await state()).requests.filter(r => r.threadId).every(r => r.device === 'b'), 'the incoming key must be processed before any A history request');
    await switchTo(phone, 'fixture-key-a', 'fixture-a');
    await phone.locator('#thread-button').click();
    await phone.getByRole('button', { name: /^A conversation 2 / }).click();
    await phone.waitForFunction(id => selectedThreadId === id, ids.a[1]);
    const aKeys = await phone.evaluate(() => [SELECTED_THREAD_STORAGE_KEY, STORAGE_PREFIX, ROUTE_STORAGE_KEY, GROUPS_STORAGE_KEY, PROJECT_THREAD_EXPANDED_STORAGE_KEY, THREAD_NOTICE_STORAGE_KEY, REASONING_OVERRIDE_STORAGE_KEY, MODEL_OVERRIDE_STORAGE_KEY]);
    await switchTo(phone, 'fixture-key-b', 'fixture-b');
    const bKeys = await phone.evaluate(() => [SELECTED_THREAD_STORAGE_KEY, STORAGE_PREFIX, ROUTE_STORAGE_KEY, GROUPS_STORAGE_KEY, PROJECT_THREAD_EXPANDED_STORAGE_KEY, THREAD_NOTICE_STORAGE_KEY, REASONING_OVERRIDE_STORAGE_KEY, MODEL_OVERRIDE_STORAGE_KEY]);
    assert(aKeys.every((key, i) => key !== bKeys[i] && key.includes('fixture-a') && bKeys[i].includes('fixture-b')), 'every persisted device state key is isolated');
    await switchTo(phone, 'fixture-key-a', 'fixture-a');
    assert(await phone.evaluate(() => selectedThreadId) === ids.a[1], 'returning to A restores A\'s selected conversation');
    const observer = await ctx.newPage(); await observer.goto(base); await ready(observer, 'fixture-a');
    await page.request.get(`${control}/delay-a`);
    await observer.evaluate(() => { void loadThreadHistory(selectedThreadId); });
    await phone.waitForTimeout(200);
    await switchTo(phone, 'fixture-key-b', 'fixture-b');
    // A new frontend must not loop if an older relay ignores ?pair=1.
    let legacyPairPages = 0;
    await phone.route('**/codex/?pair=1*', async route => {
      legacyPairPages++;
      if (legacyPairPages > 1) throw new Error('legacy pairing redirect loop');
      const source = await page.request.get(options.sourceUrl || 'http://127.0.0.1:8787/');
      await route.fulfill({ contentType: 'text/html', body: await source.text() });
    });
    await phone.goto(`${base}#k=fixture-key-b`);
    await ready(phone, 'fixture-b');
    assert(legacyPairPages === 1 && !new URL(phone.url()).hash, 'older relay fallback logs out once then accepts the new key');
    await phone.unroute('**/codex/?pair=1*');
    await ctx.clearCookies();
    await phone.goto(`${base}#k=fixture-key-b`); await ready(phone, 'fixture-b');
    await ready(observer, 'fixture-b');
    await page.request.get(`${control}/release`);
    assert((await observer.locator('#thread').innerText()).includes('Device B reply') && !(await observer.locator('#thread').innerText()).includes('Device A reply'), 'late A history cannot overwrite B after a cross-tab switch');
    // Change the shared cookie without a storage event to exercise relay protection.
    await ctx.request.post(`${base}login`, { data: { passphrase: 'fixture-key-a' } });
    const wrongDevice = await ctx.request.post(`${base}send`, { headers: { 'x-codex-mini-device-id': 'fixture-b' }, data: { threadId: ids.b[0], text: 'must not reach either desktop' } });
    assert(wrongDevice.status() === 409 && (await wrongDevice.json()).code === 'DEVICE_SESSION_CHANGED', 'a stale tab must not send through another device cookie');
    await phone.evaluate(() => refreshCurrentThreadIfChanged());
    await ready(phone, 'fixture-a');
    await observer.close();
    await page.request.get(`${control}/offline-a`);
    await phone.reload();
    await phone.getByRole('heading', { name: '设备离线', exact: true }).waitFor();
    await switchTo(phone, 'fixture-key-b', 'fixture-b');
    await phone.goto(`${base}#k=invalid-fixture-key`);
    await phone.getByText('设备密钥不正确。', { exact: true }).waitFor();
    assert(await phone.locator('#thread').count() === 0, 'invalid keys stay on pairing UI and cannot expose the previous device');
    await switchTo(phone, 'fixture-key-b', 'fixture-b');
    const snapshot = await state();
    assert(!snapshot.requests.some(r => r.threadId && !snapshot.ids[r.device].includes(r.threadId)), 'neither device may receive foreign session ids');
    assert(!snapshot.requests.some(r => r.method === 'POST'), 'no business mutation should reach the synthetic desktops');
    assert(errors.length === 0, errors.join('; '));
    await phone.screenshot({ path: 'output/playwright/device-switch-b-2026-10-21.png' });
    return { newKeySwitchesDevice: true, hashChange: true, restoredASelection: true, legacyIdRejectedOnB: true,
      crossTabAndLateResponse: true, staleWriteRejected: true, offlineSwitch: true, invalidKeyIsolated: true, legacyRelayFallback: true,
      firstLoginFromLink: true, scopedStateKeys: aKeys.length, foreignThreadRequests: 0, businessWrites: 0 };
  } catch (error) { throw new Error(`${error.message}; errors=${JSON.stringify(errors)}; UI=${await phone?.locator('body').innerText()}`); }
  finally { await page.request.get(`${control}/release`); await page.request.get(`${control}/online-a`); await ctx.close(); }
}
