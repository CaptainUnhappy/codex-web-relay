$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'start-windows-relay.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$null)
foreach ($name in @('Set-CodexCliCommand', 'Find-CodexCli', 'Ensure-CodexCli', 'Invoke-CodexCliCapture', 'ConvertTo-WindowsCommandLineArgument')) {
  $definition = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  . ([scriptblock]::Create($definition.Extent.Text))
}
function Assert-Startup([bool] $Condition, [string] $Message) { if (!$Condition) { throw $Message } }
$previous = @{}
foreach ($key in @('CODEX_MINI_CODEX_CLI','CODEX_MINI_REQUIRE_CODEX_CLI','CODEX_MINI_SKIP_CODEX_CLI_TEST','CODEX_MINI_FULL_CODEX_CLI_CHECK','Path')) {
  $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-mini-startup-test-' + [guid]::NewGuid().ToString('N'))
$failures = @()
try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $CodexCliInstallBin = Join-Path $tempRoot 'codex-cli-bin'
  $portableDir = Join-Path $CodexCliInstallBin 'node_modules\.bin'
  New-Item -ItemType Directory -Path $portableDir -Force | Out-Null
  $portableCli = Join-Path $portableDir 'codex.cmd'
  Set-Content -LiteralPath $portableCli -Value '@exit /b 0' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $CodexCliInstallBin 'codex.exe') -Value 'old standalone installation' -Encoding ASCII
  try {
    $env:CODEX_MINI_CODEX_CLI = ''
    Assert-Startup (Find-CodexCli) 'The project CLI was not found.'
    Assert-Startup ($script:CodexCliExe -eq $portableCli) 'The project CLI upgrade must win over an older PATH installation.'
    Assert-Startup ($env:CODEX_MINI_CODEX_CLI -eq $portableCli) 'The launcher did not pass its selected CLI to the Node service.'
    $env:CODEX_MINI_CODEX_CLI = Join-Path $tempRoot 'missing.exe'
    $rejected = $false
    try { Find-CodexCli | Out-Null } catch { $rejected = $true }
    Assert-Startup $rejected 'An explicit missing CLI must not silently fall back.'
    Write-Output 'PASS: startup selects and exports the project CLI, rejecting invalid overrides.'
  } catch { $failures += $_.Exception.Message }

  try {
    $script:CodexCliExe = (Get-Command powershell.exe).Source
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-CodexCliCapture -Arguments @('-NoProfile','-Command','Start-Sleep -Seconds 3') -WorkingDirectory $tempRoot -TimeoutMs 200
    Assert-Startup ($result.ExitCode -eq 124 -and $watch.ElapsedMilliseconds -lt 2500) 'CLI quick-check timeout was not enforced.'
    Write-Output 'PASS: a hung quick check fails within its time budget.'
  } catch { $failures += $_.Exception.Message }

  function Find-CodexCli { $script:CodexCliExe = $portableCli; return $true }
  function Install-CodexCli { throw 'Unexpected installation in a configured startup.' }
  function Repair-CodexCliConfig { throw 'Startup must not edit the global Codex configuration.' }
  function Get-CodexCliCheckDir { return $tempRoot }
  function Invoke-CodexCliExecutionTest {
    $script:fullChecks += 1
    return [pscustomobject]@{ ExitCode=$script:fullExitCode; Stdout=$script:fullOutput; Stderr='' }
  }
  function Invoke-CodexCliCapture([string[]] $Arguments, [string] $WorkingDirectory, [int] $TimeoutMs = 120000) {
    $script:quickCalls.Add([pscustomobject]@{ Arguments=$Arguments; TimeoutMs=$TimeoutMs })
    $exitCode = if ($Arguments[0] -eq $script:failedCommand) { 1 } else { 0 }
    return [pscustomobject]@{ ExitCode=$exitCode; Stdout='codex-cli 0.159.0'; Stderr='' }
  }
  $env:CODEX_MINI_REQUIRE_CODEX_CLI = ''
  $env:CODEX_MINI_SKIP_CODEX_CLI_TEST = ''
  $env:CODEX_MINI_FULL_CODEX_CLI_CHECK = ''
  $script:quickCalls = New-Object 'System.Collections.Generic.List[object]'
  $script:fullChecks = 0
  $script:fullExitCode = 0
  $script:fullOutput = 'codex-mini-cli-ok'
  $script:failedCommand = ''
  try {
    Ensure-CodexCli
    Assert-Startup ($script:fullChecks -eq 0) 'Default startup must not invoke a model or scan sessions.'
    Assert-Startup ($script:quickCalls.Count -eq 2) 'Default startup should only check version and app-server capability.'
    foreach ($call in $script:quickCalls) { Assert-Startup ($call.TimeoutMs -le 10000) 'A quick check can still block for two minutes.' }
    Write-Output 'PASS: default startup performs bounded checks without a model request.'
  } catch { $failures += $_.Exception.Message }
  try {
    $env:CODEX_MINI_FULL_CODEX_CLI_CHECK = '1'
    Ensure-CodexCli
    Assert-Startup ($script:fullChecks -eq 1) 'Explicit full diagnostics must run the model check once.'
    $env:CODEX_MINI_SKIP_CODEX_CLI_TEST = '1'
    Ensure-CodexCli
    Assert-Startup ($script:fullChecks -eq 1) 'The existing skip flag must override full diagnostics.'
    Write-Output 'PASS: full diagnostics remain opt-in and respect the skip flag.'
  } catch { $failures += $_.Exception.Message }
  $env:CODEX_MINI_FULL_CODEX_CLI_CHECK = ''
  $env:CODEX_MINI_SKIP_CODEX_CLI_TEST = ''
  foreach ($command in @('--version','app-server')) {
    try {
      $script:failedCommand = $command
      $rejected = $false
      try { Ensure-CodexCli } catch { $rejected = $true }
      Assert-Startup $rejected "A failed $command check was accepted."
      Write-Output "PASS: a failed $command check blocks startup."
    } catch { $failures += $_.Exception.Message }
  }
  $script:failedCommand = ''
  $env:CODEX_MINI_FULL_CODEX_CLI_CHECK = '1'
  foreach ($message in @('requires a newer version of Codex', 'unauthorized: please log in')) {
    try {
      $script:fullExitCode = 1
      $script:fullOutput = $message
      $rejected = $false
      try { Ensure-CodexCli } catch { $rejected = $true }
      Assert-Startup $rejected 'A failed full diagnostic was treated as a usable App Server.'
    } catch { $failures += $_.Exception.Message }
  }
  Write-Output 'PASS: full diagnostics reject version incompatibility and authentication failures.'
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  $resolved = [IO.Path]::GetFullPath($tempRoot)
  $allowedRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (!$resolved.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^codex-mini-startup-test-[0-9a-f]{32}$') { throw 'Unexpected test directory.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
if ($failures.Count) { throw ($failures -join "`n") }
