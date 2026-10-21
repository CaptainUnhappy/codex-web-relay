async (page) => {
  // Run via browser_run_code_unsafe filename. All normal requests hit the real
  // isolated service. Routes below only inject explicitly named network faults.
  const assert = (value,message) => { if (!value) throw new Error(message); };
  const base = 'http://127.0.0.1:18791/question-prototype';
  const key = 'isolated-question-e2e-key-v1';
  const browser = page.context().browser();
  const phoneContext = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const desktopContext = await browser.newContext({viewport:{width:1280,height:900}});
  const phone = await phoneContext.newPage(), desktop = await desktopContext.newPage();
  const errors = [], checks = [], requests = [];
  for (const target of [phone,desktop]) {
    target.on('pageerror',error=>errors.push(error.message));
    target.on('request',request=>{ if(request.method()==='POST' && request.url().endsWith('/answer')) requests.push({url:request.url(),body:request.postDataJSON()}); });
  }
  const card = (target,id) => target.locator(`[data-question-id="${id}"]`);
  const waitPending = async id => { for(const target of [phone,desktop]) await target.locator(`[data-question-id="${id}"][data-state="pending"]`).waitFor(); };
  const waitAnswered = async id => { for(const target of [phone,desktop]) { await target.locator(`[data-question-id="${id}"][data-state="answered"]`).waitFor(); assert(!await card(target,id).locator('form').isVisible(),`${id}: answered form must close`); } };
  const snapshot = async () => (await desktop.request.get(`${base}/api/questions`)).json();
  const create = async id => {
    const response = await desktop.request.post(`${base}/api/questions`,{data:{id,threadId:'browser-e2e',prompt:`${id}：请选择或自行填写回复。`,options:[{label:'确认一次',description:'采用当前方案。'},{label:'保留原值',description:'暂时保持现状。'}]}});
    assert(response.status()===201,`create ${id}: ${response.status()}`); await waitPending(id);
  };
  const bothText = async (id,value) => { for(const target of [phone,desktop]) assert(await card(target,id).locator('.answer').textContent()===value,`${id}: both clients must show canonical answer`); };
  try {
    await Promise.all([phone.goto(`${base}/?client=phone#key=${key}`),desktop.goto(`${base}/?client=desktop#key=${key}`)]);
    await waitPending('consumer');
    assert(await card(phone,'consumer').getByRole('radio').count()===2,'expanded choices, no select');
    assert(await phone.locator('select').count()===0,'no select dropdown');
    await phone.setViewportSize({width:320,height:700});
    assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px must not overflow');
    await phone.setViewportSize({width:390,height:844});
    await phone.screenshot({path:'C:/Projects/Codex-Mini/output/playwright/question-prototype-phone-pending.png',fullPage:true});
    await desktop.screenshot({path:'C:/Projects/Codex-Mini/output/playwright/question-prototype-desktop-pending.png',fullPage:true});
    await card(desktop,'consumer').getByRole('textbox').fill('桌面尚未发送的补充\n保留这行');
    await card(phone,'consumer').getByRole('radio',{name:'确认一次 采用当前方案。'}).tap();
    await card(phone,'consumer').getByRole('textbox').fill('手机自定义第一行 <beta>\n第二行：保留换行');
    await card(phone,'consumer').getByRole('button',{name:'发送回答',exact:true}).tap();
    await waitAnswered('consumer'); await bothText('consumer','手机自定义第一行 <beta>\n第二行：保留换行');
    assert(await card(desktop,'consumer').locator('.saved-draft').textContent()==='桌面尚未发送的补充\n保留这行','preserve losing draft');
    await desktop.reload(); await desktop.locator('[data-question-id="consumer"][data-state="answered"]').waitFor();
    assert(await card(desktop,'consumer').locator('.saved-draft').textContent()==='桌面尚未发送的补充\n保留这行','draft survives reload');
    checks.push('phone-answer-closes-both-forms','custom-answer-newlines-and-literal-html','unsent-desktop-draft-preserved','320px-layout');

    await create('desktop-answer');
    await card(desktop,'desktop-answer').getByRole('radio').first().focus();
    await card(desktop,'desktop-answer').getByRole('radio').first().press('ArrowDown');
    assert(await card(desktop,'desktop-answer').getByRole('radio').last().getAttribute('aria-checked')==='true','keyboard choice');
    await card(desktop,'desktop-answer').getByRole('button',{name:'发送回答',exact:true}).click();
    await waitAnswered('desktop-answer'); await bothText('desktop-answer','保留原值');
    checks.push('desktop-answer-closes-both-forms','keyboard-radio-selection');

    await create('simultaneous');
    await card(phone,'simultaneous').getByRole('radio').first().tap();
    await card(desktop,'simultaneous').getByRole('radio').last().click();
    const held = [];
    const barrier = async route => { held.push(route); if(held.length===2) await Promise.all(held.map(item=>item.continue())); };
    await phone.route('**/questions/simultaneous/answer',barrier);
    await desktop.route('**/questions/simultaneous/answer',barrier);
    const responses = Promise.all([phone.waitForResponse(r=>r.url().endsWith('/simultaneous/answer')),desktop.waitForResponse(r=>r.url().endsWith('/simultaneous/answer'))]);
    await Promise.all([card(phone,'simultaneous').getByRole('button',{name:'发送回答',exact:true}).tap(),card(desktop,'simultaneous').getByRole('button',{name:'发送回答',exact:true}).click()]);
    const outcomes = await responses;
    assert(outcomes.map(r=>r.status()).sort().join(',')==='200,409','race must have one winner and one conflict');
    await waitAnswered('simultaneous');
    const afterRace = await snapshot(), winner = afterRace.questions.find(q=>q.id==='simultaneous').answer;
    await bothText('simultaneous',winner.value);
    const replay = await desktop.request.post(`${base}/api/questions/simultaneous/answer`,{data:{requestId:winner.requestId,value:winner.value,client:winner.client}});
    assert(replay.status()===200 && (await replay.json()).duplicate,'same request is idempotent');
    const changed = await desktop.request.post(`${base}/api/questions/simultaneous/answer`,{data:{requestId:winner.requestId,value:'改动回答',client:winner.client}});
    assert(changed.status()===409,'changed replay rejected');
    assert((await snapshot()).revision===afterRace.revision,'replays add no events');
    checks.push('simultaneous-http-race-one-winner','retry-same-id-no-new-answer','changed-retry-rejected');

    await create('double-click');
    await card(desktop,'double-click').getByRole('radio').first().click();
    await card(desktop,'double-click').getByRole('button',{name:'发送回答',exact:true}).dblclick();
    await waitAnswered('double-click');
    assert(requests.filter(r=>r.url.endsWith('/double-click/answer')).length===1,'double click sends once');
    checks.push('double-click-one-post');

    await create('offline');
    await card(phone,'offline').getByRole('textbox').fill('离线时的草稿');
    await phoneContext.setOffline(true);
    await phone.getByText('连接已中断',{exact:true}).waitFor();
    assert(await card(phone,'offline').getByRole('button',{name:'发送回答',exact:true}).isDisabled(),'offline send disabled');
    await card(desktop,'offline').getByRole('radio').last().click();
    await card(desktop,'offline').getByRole('button',{name:'发送回答',exact:true}).click();
    await desktop.locator('[data-question-id="offline"][data-state="answered"]').waitFor();
    assert(await card(phone,'offline').getAttribute('data-state')==='pending','disconnected client is initially stale');
    await phoneContext.setOffline(false);
    await waitAnswered('offline'); await bothText('offline','保留原值');
    assert(await card(phone,'offline').locator('.saved-draft').textContent()==='离线时的草稿','offline draft kept');
    assert(requests.filter(r=>r.url.endsWith('/offline/answer')).length===1,'reconnect never replays answer');
    checks.push('offline-stale-card-reconciles','reconnect-no-auto-submit');

    await create('before-commit');
    let dropBefore = true;
    await phone.route('**/questions/before-commit/answer',route=>{ if(dropBefore){dropBefore=false; return route.abort('failed');} return route.continue(); });
    await card(phone,'before-commit').getByRole('textbox').fill('原编号重试');
    await card(phone,'before-commit').getByRole('button',{name:'发送回答',exact:true}).tap();
    await card(phone,'before-commit').getByRole('button',{name:'重试回答',exact:true}).waitFor();
    assert((await snapshot()).questions.find(q=>q.id==='before-commit').answer===null,'aborted before service must remain pending');
    await phone.reload();
    const retry = card(phone,'before-commit').getByRole('button',{name:'重试回答',exact:true});
    await retry.waitFor(); await retry.tap();
    await waitAnswered('before-commit');
    const attempts = requests.filter(r=>r.url.endsWith('/before-commit/answer'));
    assert(attempts.length===2 && attempts[0].body.requestId===attempts[1].body.requestId,'reload retry keeps original submission id');
    checks.push('failure-before-commit-pending','reload-and-retry-reuses-id');

    await create('lost-response');
    let committed;
    await phone.route('**/questions/lost-response/answer',async route=>{ const response=await route.fetch(); committed=await response.json(); await route.abort('failed'); });
    await card(phone,'lost-response').getByRole('textbox').fill('服务已保存但响应丢失');
    await card(phone,'lost-response').getByRole('button',{name:'发送回答',exact:true}).tap();
    await waitAnswered('lost-response');
    assert(committed.accepted,'server really committed before network response was dropped');
    await phone.reload(); await phone.locator('[data-question-id="lost-response"][data-state="answered"]').waitFor();
    assert(requests.filter(r=>r.url.endsWith('/lost-response/answer')).length===1,'lost response recovered by readback, no second POST');
    checks.push('lost-success-response-readback-no-replay');

    await create('late-snapshot');
    let releaseOld, captured;
    const capturedPromise = new Promise(resolve=>{captured=resolve;});
    let holdOld = true;
    await desktop.route('**/api/questions',async route=>{
      if(route.request().method()!=='GET' || !holdOld) return route.continue();
      holdOld=false; const response=await route.fetch();
      await new Promise(resolve=>{releaseOld=resolve; captured();});
      await route.fulfill({response});
    });
    await capturedPromise;
    await card(desktop,'late-snapshot').getByRole('radio').first().click();
    await card(desktop,'late-snapshot').getByRole('button',{name:'发送回答',exact:true}).click();
    await desktop.locator('[data-question-id="late-snapshot"][data-state="answered"]').waitFor();
    await desktop.evaluate(()=>{
      window.regressedQuestion=false;
      new MutationObserver(()=>{if(document.querySelector('[data-question-id="late-snapshot"]').dataset.state!=='answered')window.regressedQuestion=true;}).observe(document.querySelector('[data-question-id="late-snapshot"]'),{attributes:true,subtree:true});
    });
    const deliveredOld = desktop.waitForResponse(r=>r.url().endsWith('/api/questions') && r.request().method()==='GET');
    releaseOld(); await deliveredOld;
    await waitAnswered('late-snapshot');
    assert(!await desktop.evaluate(()=>window.regressedQuestion),'late snapshot cannot reopen answered card');
    checks.push('late-stale-snapshot-cannot-reopen');

    await create('draft-return');
    await card(phone,'draft-return').getByRole('textbox').fill('返回后继续填写\n第二行 <img src=x onerror=alert(1)>');
    await card(phone,'draft-return').getByRole('button',{name:'稍后回答',exact:true}).tap();
    await phone.reload();
    await card(phone,'draft-return').getByRole('button',{name:'继续回答',exact:true}).tap();
    assert(await card(phone,'draft-return').getByRole('textbox').inputValue()==='返回后继续填写\n第二行 <img src=x onerror=alert(1)>','return preserves pending draft');
    await card(phone,'draft-return').getByRole('button',{name:'发送回答',exact:true}).tap();
    await waitAnswered('draft-return');
    assert(await card(phone,'draft-return').locator('.answer img').count()===0,'answer is literal text');
    assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'long answer wraps');
    checks.push('collapse-return-draft','untrusted-answer-is-text','long-answer-wraps');

    const final = await snapshot();
    assert(final.questions.length===9 && final.questions.every(q=>q.answer),'all nine questions answered');
    assert(new Set(final.questions.map(q=>q.answer.receiptId)).size===9,'one distinct canonical receipt per question');
    assert(final.revision===18,'exactly one created and one answered event per question');
    assert(errors.length===0,`browser errors: ${errors.join(';')}`);
    await phone.screenshot({path:'C:/Projects/Codex-Mini/output/playwright/question-prototype-phone-answered.png',fullPage:true});
    await desktop.screenshot({path:'C:/Projects/Codex-Mini/output/playwright/question-prototype-desktop-answered.png',fullPage:true});
    return {passed:true,checks,questions:9,canonicalAnswers:9,revision:final.revision,browserErrors:errors,realHttpService:true,physicalPhone:false,nativeAppCard:false,contextsLeftOpenForRestartCheck:true};
  } catch(error) {
    await phone.screenshot({path:'C:/Projects/Codex-Mini/output/playwright/question-prototype-failure.png',fullPage:true}).catch(()=>{});
    await phoneContext.close(); await desktopContext.close(); throw error;
  }
}
