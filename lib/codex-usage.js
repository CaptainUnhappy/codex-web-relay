'use strict';

function finite(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}

function contextFromTokenUsage(tokenUsage, updatedAt = '') {
  const windowTokens = finite(tokenUsage?.modelContextWindow);
  const total = finite(tokenUsage?.last?.totalTokens);
  if (!(windowTokens > 0) || total === null || total < 0) return { available: false, updatedAt };
  // Same calculation as Codex App: the last request, clamped to its effective window.
  const usedTokens = Math.min(total, windowTokens);
  return { available: true, usedTokens, windowTokens, remainingTokens: windowTokens - usedTokens,
    percent: usedTokens / windowTokens * 100, updatedAt };
}

function quotaFromAccount(result, updatedAt = new Date().toISOString()) {
  const limits = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  const window = value => {
    const used = finite(value?.usedPercent);
    if (used === null) return null;
    const usedPercent = Math.max(0, Math.min(100, used));
    return { usedPercent, remainingPercent: 100 - usedPercent,
      windowMinutes: finite(value.windowDurationMins), resetsAt: finite(value.resetsAt) };
  };
  const primary = window(limits?.primary), secondary = window(limits?.secondary);
  return { available: Boolean(primary || secondary), source: 'account', ...(primary || secondary),
    primary, secondary, planType: limits?.planType || '', updatedAt };
}

function usageFromEvents(items) {
  let tokenUsage = null, updatedAt = '';
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info) continue;
    const info = payload.info;
    // A missing usage/window must stay unknown; do not pair a new turn's window with old usage.
    tokenUsage = { last: { totalTokens: info.last_token_usage?.total_tokens ?? info.current_token_usage?.total_tokens },
      modelContextWindow: info.model_context_window };
    updatedAt = item.timestamp || '';
  }
  return contextFromTokenUsage(tokenUsage, updatedAt);
}

module.exports = { contextFromTokenUsage, quotaFromAccount, usageFromEvents };
