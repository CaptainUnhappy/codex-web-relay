'use strict';
const { spawnSync } = require('child_process');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of ['server.js', 'lib/codex-app-server-backend.js', 'relay-server/server.js',
  'relay-server/create-device.js', 'relay-server/lib/crypto.js']) run(process.execPath, ['--check', file]);

for (const name of ['app-server-backend', 'codex-cli-selection', 'ui-contract', 'user-input',
  'thread-images', 'codex-usage', 'web-request-scheduling', 'thread-browser-cache', 'keyboard-layout',
  'touch-scroll', 'thread-search', 'thread-menu-interactions', 'web-delivery', 'atomic-state']) {
  run(process.execPath, [`scripts/test-${name}.js`]);
}
if (['win32', 'darwin'].includes(process.platform)) run(process.execPath, ['scripts/test-desktop-sync-e2e.js']);
if (process.platform === 'win32') {
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/check-windows-relay-script.ps1']);
} else {
  for (const file of ['start-codex-relay.command', 'start-codex-mini-relay.command', 'scripts/start-macos-relay.sh',
    'relay-server/install-full.sh', 'relay-server/install-systemd.sh']) run('bash', ['-n', file]);
}
run(process.env.PYTHON || 'python', ['scripts/test-package-release.py']);
