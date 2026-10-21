$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'start-windows-relay.ps1'
$text = Get-Content -LiteralPath $scriptPath -Raw
$serverPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'server.js'
$serverText = Get-Content -LiteralPath $serverPath -Raw
$macPath = Join-Path $PSScriptRoot 'start-macos-relay.sh'
$macText = Get-Content -LiteralPath $macPath -Raw
$htmlPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'public/index.html'
$htmlText = Get-Content -LiteralPath $htmlPath -Raw

if ($text -match '&\s+\$script:NpmCmd\b') {
  throw 'start-windows-relay.ps1 must call npm through Invoke-Npm, not directly through $script:NpmCmd.'
}

if ($text -notmatch 'function Resolve-NpmCmd') {
  throw 'start-windows-relay.ps1 must normalize npm to npm.cmd before invoking it.'
}

if ($text -notmatch 'Get-Command npm\.cmd') {
  throw 'start-windows-relay.ps1 must resolve npm.cmd instead of relying on the npm PowerShell shim.'
}

if ($text -notmatch 'npm\.ps1 cannot be used here') {
  throw 'start-windows-relay.ps1 must reject npm.ps1 so npm does not mis-parse variable-based calls.'
}

if ($text -notmatch 'desktop-env\.local\.ps1') {
  throw 'start-windows-relay.ps1 must load desktop-env.local.ps1 for local, uncommitted configuration.'
}

if ($text -notmatch 'function Write-Host' -or $text -notmatch '\[Console\]::Out\.Write\("`r\$text`r`n"\)') {
  throw 'start-windows-relay.ps1 must force CRLF line output so terminal logs do not drift right.'
}

if ($text -notmatch 'function Add-CodexMiniLogLine' -or $text -notmatch 'Add-Content -LiteralPath \$script:LogPath' -or $text -notmatch 'Add-CodexMiniLogLine \$text') {
  throw 'start-windows-relay.ps1 must append every console Write-Host line to the current log file.'
}

if ($text -match 'Start-Transcript') {
  throw 'start-windows-relay.ps1 must not use Start-Transcript because it locks the same log file and drops console tee output.'
}

if ($text -notmatch 'CODEX_MINI_DESKTOP_LOG_PATH') {
  throw 'start-windows-relay.ps1 must pass the current log path to node so server output is written into the same log.'
}

if ($serverText -notmatch 'CODEX_MINI_DESKTOP_LOG_PATH' -or $serverText -notmatch 'function appendDesktopLogLine' -or $serverText -notmatch 'function installDesktopConsoleLogTee') {
  throw 'server.js must tee node console output into CODEX_MINI_DESKTOP_LOG_PATH.'
}

$wrapperTemplate = [regex]::Match($serverText, '(?s)const script = `(.*?)`;')
if ($wrapperTemplate.Success -and $wrapperTemplate.Groups[1].Value -match 'function getCodexAppServerBackend\(\)') {
  throw 'getCodexAppServerBackend must be executable JavaScript, not text inside the Windows PowerShell wrapper template.'
}

if ($text -notmatch 'function Watch-CodexMiniRelay') {
  throw 'start-windows-relay.ps1 must run as a supervisor instead of a one-shot npm start wrapper.'
}

if ($text -notmatch 'localFailureCount' -or $text -notmatch 'localFailureSince' -or $text -notmatch 'localFailureSeconds' -or $text -notmatch '\$localFailureCount -lt 3' -or $text -notmatch '\$localFailureSeconds -lt 15') {
  throw 'start-windows-relay.ps1 must debounce transient local relay-status failures before printing local-unreachable.'
}

if ($text -notmatch '/codex/relay-status') {
  throw 'start-windows-relay.ps1 must monitor the local /codex/relay-status endpoint.'
}

if ($text -notmatch 'function Start-CodexMiniProcess') {
  throw 'start-windows-relay.ps1 must start node server.js under supervisor control.'
}

if ($text -notmatch 'function Ensure-CodexCli') {
  throw 'start-windows-relay.ps1 must check Codex CLI during startup.'
}

if ($text -match 'function Repair-CodexCliConfig') {
  throw 'start-windows-relay.ps1 must not rewrite the global Codex configuration during startup.'
}

if ($text -notmatch 'https://chatgpt.com/codex/install\.ps1') {
  throw 'start-windows-relay.ps1 must install the official Windows Codex CLI when missing.'
}

if ($text -notmatch '\$CodexCliInstallHome = Join-Path \$RuntimeRoot' -or $text -notmatch '\$CodexCliInstallBin = Join-Path \$RuntimeRoot' -or $text -notmatch '\$env:CODEX_HOME = \$CodexCliInstallHome' -or $text -notmatch '\$env:CODEX_INSTALL_DIR = \$CodexCliInstallBin') {
  throw 'start-windows-relay.ps1 must install Codex CLI under the portable runtime instead of the user .codex package directory.'
}

if ($text -notmatch 'Join-Path \$CodexCliInstallBin ''codex\.exe''') {
  throw 'start-windows-relay.ps1 must discover the Codex CLI installed under the portable runtime.'
}

if ($text -notmatch 'finally\s*\{' -or $text -notmatch 'Remove-Item Env:CODEX_HOME' -or $text -notmatch 'Remove-Item Env:CODEX_INSTALL_DIR' -or $text -notmatch 'GetEnvironmentVariable\(''Path'', ''User''\)') {
  throw 'start-windows-relay.ps1 must restore temporary Codex installer environment and user PATH state.'
}

if ($text -notmatch 'codex-mini-cli-ok' -or $text -notmatch 'CODEX_MINI_FULL_CODEX_CLI_CHECK') {
  throw 'start-windows-relay.ps1 must retain an opt-in Codex CLI execution diagnostic.'
}

if ($text -notmatch 'function Invoke-CodexCliCapture' -or $text -notmatch 'RedirectStandardError' -or $text -notmatch 'Start-Process' -or $text -match '2>&1') {
  throw 'start-windows-relay.ps1 must capture Codex CLI stdout/stderr without letting stderr trigger the global PowerShell trap.'
}

if ($text -notmatch '\$env:ComSpec' -or $text -notmatch 'cmd\|bat') {
  throw 'start-windows-relay.ps1 must invoke codex.cmd through cmd.exe for Windows startup compatibility.'
}

if ($text -match 'Continuing because Codex App Server is available') {
  throw 'A failed full model diagnostic must not be reported as a usable App Server.'
}

if ($text -notmatch 'app-server --help' -or $text -notmatch 'Codex App Server check passed') {
  throw 'start-windows-relay.ps1 must verify Codex App Server support during startup.'
}

if ($text -notmatch 'codex-mini-cli') {
  throw 'start-windows-relay.ps1 must run the Codex CLI test under the codex-mini-cli work folder.'
}

if ($text -notmatch '--skip-git-repo-check') {
  throw 'start-windows-relay.ps1 must skip the git repo check for the Codex CLI startup test.'
}

if ($text -notmatch 'Invoke-CodexCliExecutionTest' -or $text -notmatch "exec', 'resume" -or $text -notmatch '\.codex-mini-cli-session-id') {
  throw 'start-windows-relay.ps1 must reuse one Codex CLI test session for the codex-mini-cli project.'
}

if ($text -notmatch 'MOBILE_TYPER_TOKEN') {
  throw 'start-windows-relay.ps1 must set MOBILE_TYPER_TOKEN so relay-status checks can authenticate.'
}

if ($text -notmatch 'ManagedCodexProcess') {
  throw 'start-windows-relay.ps1 must clean up the supervised node process on script exit.'
}

if ($text -notmatch 'CODEX_MINI_RELAY_REQUIRE_CODEX_DESKTOP') {
  throw 'start-windows-relay.ps1 must disable the Codex desktop relay gate by default so CLI fallback can work while locked.'
}

if ($text -notmatch "CODEX_MINI_RELAY_REQUIRE_CODEX_DESKTOP\s*=\s*'0'") {
  throw 'start-windows-relay.ps1 must default CODEX_MINI_RELAY_REQUIRE_CODEX_DESKTOP to 0.'
}

if ($text -notmatch "CODEX_MINI_AUTO_KEEP_AWAKE\s*=\s*'1'") {
  throw 'start-windows-relay.ps1 must default CODEX_MINI_AUTO_KEEP_AWAKE to 1.'
}

if ($text -notmatch 'Keep-awake: Codex Relay will prevent idle sleep') {
  throw 'start-windows-relay.ps1 must print the keep-awake boundary during startup.'
}

if ($text -notmatch 'function Stop-CodexMiniKeepAwakeHelpers') {
  throw 'start-windows-relay.ps1 must clean up keep-awake helpers when the supervisor stops node.'
}

if ($text -notmatch 'codex-stopped') {
  throw 'start-windows-relay.ps1 must treat codex-stopped as a paused relay state instead of restarting the local service.'
}

if ($macText -notmatch 'watch_codex_mini_relay\(\)' -or $macText -notmatch 'start_codex_mini_process\(\)' -or $macText -notmatch 'stop_codex_mini_process\(\)' -or $macText -notmatch '/codex/relay-status') {
  throw 'start-macos-relay.sh must run node server.js under supervisor control and monitor relay-status.'
}

if ($macText -notmatch 'local_failure_count' -or $macText -notmatch 'local_failure_since' -or $macText -notmatch 'local_failure_seconds' -or $macText -notmatch '\$local_failure_count" -lt 3' -or $macText -notmatch '\$local_failure_seconds" -lt 15') {
  throw 'start-macos-relay.sh must debounce transient local relay-status failures before printing local-unreachable.'
}

if ($macText -notmatch 'ensure_device_runtime_fields\(\)' -or $macText -notmatch 'localToken' -or $macText -notmatch 'MOBILE_TYPER_TOKEN') {
  throw 'start-macos-relay.sh must persist a local token for authenticated relay-status checks.'
}

if ($macText -notmatch 'if \[\[ "\$managed_process" -eq 1 \]\] && tcp_port_open 127\.0\.0\.1 "\$local_port"; then') {
  throw 'start-macos-relay.sh must reject a local relay port owned by another device before starting a second process.'
}

if ($macText -match '(?m)^\s*"\$NPM_CMD"\s+start\s*$') {
  throw 'start-macos-relay.sh must not end as a one-shot npm start wrapper.'
}

if ($serverText -notmatch 'function isDesktopLockedAutomationError' -or $serverText -notmatch 'startLockedCodexAppServerSend' -or $serverText -notmatch 'isDesktopLockedAutomationError\(error\)') {
  throw 'server.js must route late Windows lock-screen automation failures into Codex App Server fallback.'
}

if ($serverText -notmatch 'function runCodexCliWithTimeout' -or $serverText -notmatch 'function spawnCodexCliProcess' -or $serverText -notmatch 'npm'', ''codex\.cmd') {
  throw 'server.js must run Windows Codex CLI/App Server through the PowerShell wrapper and check the AppData npm codex.cmd path.'
}

if ($serverText -notmatch 'ConvertFrom-Json' -or $serverText -notmatch 'codex-mini-cli-\$\{process\.pid\}-\$\{Date\.now\(\)\}-\$\{crypto\.randomBytes\(4\)\.toString\(''hex''\)\}\.json' -or $serverText -match 'powerShellArrayLiteral\(args\)') {
  throw 'server.js must pass Windows Codex CLI arguments through a UTF-8 JSON sidecar instead of embedding prompt text in a .ps1 string.'
}

if ($serverText -notmatch 'startCodexAppServerRun' -or $serverText -notmatch 'thread/start' -or $serverText -notmatch 'thread/resume' -or $serverText -notmatch 'turn/start' -or $serverText -notmatch 'turn/interrupt') {
  throw 'server.js must use Codex App Server thread and turn APIs for locked sends.'
}

if ($serverText -notmatch 'recordPendingDesktopThreadSync\(run\.threadId' -or $serverText -notmatch "source: 'codex-app-server-locked'") {
  throw 'server.js must queue locked Codex App Server conversations for desktop sync after unlock.'
}

if ($serverText -notmatch 'promptCodexDesktopRestartSync' -or $serverText -notmatch 'promptAndMaybeRestartCodexDesktopSync' -or $serverText -notmatch 'restart_required') {
  throw 'server.js must prompt on the unlocked desktop before restarting Codex App to sync locked messages.'
}

if ($serverText -notmatch 'desktopRestartPromptInFlight' -or $serverText -notmatch '已有同步提示窗口等待确认' -or $serverText -notmatch "refreshDesktopStateAndSyncPendingThreads\('relay-status'\)\.catch") {
  throw 'server.js must keep desktop restart prompts singleton and must not block relay-status while waiting for the desktop prompt.'
}

if ($serverText -notmatch "target\.source === 'codex-app-server-locked'" -or $serverText -notmatch 'App UI 可能仍使用旧缓存') {
  throw 'server.js must not mark locked Codex App Server conversations synced merely because the Codex App thread opened.'
}

if ($serverText -notmatch 'CODEX_MINI_DESKTOP_THREAD_SYNC_INTERVAL_MS \|\| 1500' -or $serverText -notmatch "item\.source === 'codex-app-server-locked'\) return true") {
  throw 'server.js must prompt locked Codex App Server syncs quickly after unlock instead of waiting for the normal throttle.'
}

if ($htmlText -match 'confirmRestartDesktopSync' -or $htmlText -match 'window\.confirm\(`未同步消息') {
  throw 'public/index.html must not ask for Codex App restart confirmation from the phone web UI.'
}

if ($htmlText -match 'directPasteWithoutClick:\s*isPendingNewThreadFirstSend' -or $serverText -notmatch 'const directPasteWithoutClick = false;') {
  throw 'new projectless first sends must focus the Codex composer instead of direct-pasting into an uncertain target.'
}

if ($serverText -notmatch 'collapseCodexMiniCliTestThreads' -or $serverText -notmatch 'isCodexMiniCliTestThread') {
  throw 'server.js must collapse codex-mini-cli startup test sessions to the latest one in the web thread list.'
}

if ($htmlText -notmatch 'selectedThreadPlaceholder' -or $htmlText -notmatch 'preserveSelectedMissing: true') {
  throw 'public/index.html must preserve the selected projectless thread while the official session list catches up.'
}

if ($serverText -notmatch "sandbox: 'workspace-write'" -or $serverText -notmatch "type: 'workspaceWrite'") {
  throw 'server.js must use the Codex App Server sandbox variants accepted by current Codex CLI: thread/start workspace-write and turn/start workspaceWrite.'
}

if ($serverText -notmatch 'LockScreenBackstopFrame\|Windows\\\.UI\\\.Core\\\.CoreWindow\|锁屏\|lock screen\|secure desktop') {
  throw 'server.js must detect Windows secure desktop even when the lock-screen title is mojibake.'
}

$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $tokens, [ref] $parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) {
  $messages = $parseErrors | ForEach-Object { "$($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber) $($_.Message)" }
  throw "PowerShell parse failed: $($messages -join '; ')"
}

& (Join-Path $PSScriptRoot 'test-windows-relay-cli.ps1')
& (Join-Path $PSScriptRoot 'test-windows-relay-startup.ps1')
