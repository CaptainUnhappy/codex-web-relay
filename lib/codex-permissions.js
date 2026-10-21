'use strict';

function permissionMode(settings) {
  const sandbox = settings?.sandboxPolicy?.type || settings?.sandboxMode || settings?.permissions;
  if (settings?.approvalPolicy === 'never' && ['dangerFullAccess', 'danger-full-access', ':danger-full-access'].includes(sandbox)) return 'full';
  if (settings?.approvalPolicy === 'on-request' && ['workspaceWrite', 'workspace-write', ':workspace'].includes(sandbox)) {
    if (['auto_review', 'guardian_subagent'].includes(settings.approvalsReviewer)) return 'auto';
    if (settings.approvalsReviewer === 'user') return 'ask';
  }
  return 'custom';
}

function permissionOptions(config, requirements, profiles, cwd) {
  const mode = config.sandbox_mode;
  const workspace = config.sandbox_workspace_write || {};
  const sandboxPolicy = mode === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : mode === 'read-only' ? { type: 'readOnly' }
    : mode === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [...new Set([cwd, ...(workspace.writable_roots || [])].filter(Boolean))],
      networkAccess: workspace.network_access === true, excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var === true,
      excludeSlashTmp: workspace.exclude_slash_tmp === true } : null;
  const custom = { approvalPolicy: config.approval_policy, approvalsReviewer: config.approvals_reviewer || 'user',
    ...(config.default_permissions ? { permissions: config.default_permissions } : { sandboxPolicy }) };
  const options = [
    { id: 'ask', label: '请求批准', description: '编辑项目文件；联网或越界操作时请求批准', settings: { approvalPolicy: 'on-request', approvalsReviewer: 'user', permissions: ':workspace' } },
    { id: 'auto', label: '帮我批准', description: '自动审核操作风险，必要时请求你批准', settings: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', permissions: ':workspace' } },
    { id: 'full', label: '完全访问权限', description: '可访问电脑上的文件和网络，无需逐次批准', settings: { approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access' } },
    { id: 'custom', label: '自定义（config.toml）', description: '使用当前项目的配置权限', settings: custom },
  ];
  const includes = (list, value) => !Array.isArray(list) || list.some(item => JSON.stringify(item) === JSON.stringify(value));
  return options.map(option => {
    const s = option.settings;
    const sandboxMode = s.permissions === ':workspace' ? 'workspace-write' : s.permissions === ':danger-full-access' ? 'danger-full-access' : mode;
    const profile = profiles.find(p => p.id === s.permissions);
    const allowed = Boolean(s.approvalPolicy && (s.permissions || s.sandboxPolicy))
      && includes(requirements?.allowedApprovalPolicies, s.approvalPolicy)
      && includes(requirements?.allowedApprovalsReviewers, s.approvalsReviewer)
      && includes(requirements?.allowedSandboxModes, sandboxMode)
      && (!s.permissions || (profile?.allowed === true && includes(requirements?.allowedPermissionProfiles, s.permissions)));
    return { ...option, allowed, reason: allowed ? '' : '当前配置或管理策略不允许此选项' };
  });
}

function permissionsFromEvents(items, threadId) {
  let snapshot = null;
  for (const item of items) {
    const payload = item.payload || {};
    const applied = item.type === 'event_msg' && payload.type === 'thread_settings_applied';
    if (item.type !== 'turn_context' && !applied) continue;
    if (applied && payload.thread_id && payload.thread_id !== threadId) continue;
    const p = applied ? payload.thread_settings || {} : payload;
    if (!p.approval_policy) continue;
    const type = { 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess', 'read-only': 'readOnly' }[p.sandbox_policy?.type] || p.sandbox_policy?.type;
    snapshot = { threadId, approvalPolicy: p.approval_policy, approvalsReviewer: p.approvals_reviewer || 'user',
      sandboxPolicy: { ...p.sandbox_policy, type }, permissions: p.active_permission_profile?.id || '',
      source: applied ? 'settings' : 'turn', updatedAt: item.timestamp || '' };
    snapshot.mode = permissionMode(snapshot);
  }
  return snapshot;
}

module.exports = { permissionMode, permissionOptions, permissionsFromEvents };
