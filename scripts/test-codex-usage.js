'use strict';
const assert = require('node:assert/strict');
const { contextFromTokenUsage, quotaFromAccount, usageFromEvents } = require('../lib/codex-usage');
const usage = (totalTokens, modelContextWindow = 1000) => ({ last: { totalTokens }, modelContextWindow });
assert.equal(contextFromTokenUsage(usage(450)).percent, 45);
assert.equal(contextFromTokenUsage(usage(2000)).usedTokens, 1000);
assert.equal(contextFromTokenUsage(usage(0)).percent, 0);
for (const value of [null, undefined, -1]) assert.equal(contextFromTokenUsage(usage(value)).available, false);
assert.equal(contextFromTokenUsage(usage(20, null)).available, false);
const event = (tokens, window, timestamp) => ({ type: 'event_msg', timestamp, payload: { type: 'token_count',
  info: { last_token_usage: { total_tokens: tokens }, model_context_window: window }, rate_limits: { primary: { used_percent: 100 } } } });
assert.equal(usageFromEvents([event(900, 1000, 'a'), event(200, 2000, 'b')]).percent, 10);
assert.equal(usageFromEvents([event(900, 1000, 'a'), event(200, null, 'b')]).available, false);
assert.equal(usageFromEvents([]).available, false);
assert.equal(usageFromEvents([event(900, 1000)]).codexQuota, undefined, 'thread history must not supply account quota');
assert.equal(quotaFromAccount({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 8 } } } }).remainingPercent, 92);
assert.equal(quotaFromAccount({ rateLimits: { primary: { usedPercent: 1 } } }).remainingPercent, 99);
assert.equal(quotaFromAccount({ rateLimits: { primary: { usedPercent: null } } }).available, false);
assert.equal(quotaFromAccount({}).available, false);
const { permissionsFromEvents } = require('../lib/codex-permissions');
const settingsEvent = { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: 'a', thread_settings: {
  approval_policy: 'on-request', approvals_reviewer: 'auto_review', active_permission_profile: { id: ':workspace' } } } };
assert.equal(permissionsFromEvents([settingsEvent], 'a').mode, 'auto');
assert.equal(permissionsFromEvents([settingsEvent], 'b'), null, 'settings are thread-scoped');
console.log('Codex usage: App formula, unknown/zero values, compaction and account isolation passed.');
