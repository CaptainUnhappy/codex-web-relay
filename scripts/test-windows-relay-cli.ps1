$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'start-windows-relay.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'Cannot test an invalid relay startup script.' }

# Import functions without running registration, installation, or the supervisor.
foreach ($name in @(
  'Get-CodexCliTestSessionIdPath', 'Read-CodexCliTestSessionId',
  'Get-CodexCliThreadIdFromText', 'Save-CodexCliTestSessionId',
  'Remove-OldCodexCliTestSessions', 'Invoke-CodexCliExecutionTest',
  'ConvertTo-WindowsCommandLineArgument', 'Invoke-CodexCliCapture'
)) {
  $definition = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  if (!$definition) { throw "Missing startup function: $name" }
  . ([scriptblock]::Create($definition.Extent.Text))
}

function Assert-RelayTest([bool] $Condition, [string] $Message) {
  if (!$Condition) { throw $Message }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-mini-relay-test-' + [guid]::NewGuid().ToString('N'))
$previousUserProfile = $env:USERPROFILE
$previousCleanup = $env:CODEX_MINI_CLEAN_OLD_CLI_TEST_SESSIONS
$failures = @()
try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  $env:USERPROFILE = Join-Path $testRoot 'profile'
  $env:CODEX_MINI_CLEAN_OLD_CLI_TEST_SESSIONS = '1'
  $checkDir = Join-Path $testRoot 'codex-mini-cli'
  $sessionsDir = Join-Path $env:USERPROFILE '.codex\sessions\2026\09\16'
  New-Item -ItemType Directory -Path $checkDir, $sessionsDir -Force | Out-Null
  $oldId = '00000000-0000-4000-8000-000000000001'
  $keepId = '00000000-0000-4000-8000-000000000002'
  $otherId = '00000000-0000-4000-8000-000000000003'
  $oldPath = Join-Path $sessionsDir "rollout-2026-09-15T10-00-00-$oldId.jsonl"
  $keepPath = Join-Path $sessionsDir "rollout-2026-09-16T10-00-00-$keepId.jsonl"
  $otherPath = Join-Path $sessionsDir "rollout-2026-09-16T11-00-00-$otherId.jsonl"
  $unknownPath = Join-Path $sessionsDir 'rollout-without-session-id.jsonl'
  foreach ($fixture in @(
    @{ Path = $oldPath; Id = $oldId; Cwd = $checkDir },
    @{ Path = $keepPath; Id = $keepId; Cwd = $checkDir },
    @{ Path = $otherPath; Id = $otherId; Cwd = "$checkDir-other" },
    @{ Path = $unknownPath; Id = ''; Cwd = $checkDir }
  )) {
    @{ type = 'session_meta'; payload = @{ id = $fixture.Id; cwd = $fixture.Cwd } } |
      ConvertTo-Json -Compress | Set-Content -LiteralPath $fixture.Path -Encoding UTF8
  }

  try {
    Remove-OldCodexCliTestSessions $checkDir $keepId
    Assert-RelayTest (Test-Path -LiteralPath $keepPath) 'Cleanup deleted the current rollout instead of preserving its session_meta ID.'
    Assert-RelayTest (!(Test-Path -LiteralPath $oldPath)) 'Cleanup did not remove the older test rollout.'
    Assert-RelayTest (Test-Path -LiteralPath $otherPath) 'Cleanup deleted a rollout from another working directory.'
    Assert-RelayTest (Test-Path -LiteralPath $unknownPath) 'Cleanup deleted a rollout with an unknown session identity.'
    Write-Output 'PASS: cleanup preserves the current and unrelated sessions.'
  } catch { $failures += $_.Exception.Message }

  try {
    $script:CodexCliExe = (Get-Command powershell.exe -ErrorAction Stop).Source
    $capture = Invoke-CodexCliCapture -Arguments @('-NoProfile', '-Command', '[Console]::Error.WriteLine(''relay-test-error''); exit 23') -WorkingDirectory $testRoot
    Assert-RelayTest ($capture.ExitCode -eq 23) "CLI capture lost the nonzero process exit code: $($capture.ExitCode)."
    Assert-RelayTest ($capture.Stderr -match 'relay-test-error') 'CLI capture lost stderr.'
    Write-Output 'PASS: native command exit code and stderr are preserved.'
  } catch { $failures += $_.Exception.Message }

  try {
    $batchDir = Join-Path $testRoot 'batch with spaces'
    $batchScriptsDir = Join-Path $batchDir 'scripts'
    New-Item -ItemType Directory -Path $batchScriptsDir -Force | Out-Null
    $batchPath = Join-Path $batchDir 'start-codex-mini-relay.bat'
    Copy-Item -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'start-codex-mini-relay.bat') -Destination $batchPath
    foreach ($expectedExitCode in @(0, 17)) {
      Set-Content -LiteralPath (Join-Path $batchScriptsDir 'start-windows-relay.ps1') -Value "exit $expectedExitCode" -Encoding ASCII
      $batchProcess = Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /s /c ""{0}" <nul"' -f $batchPath) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'batch.stdout') -RedirectStandardError (Join-Path $testRoot 'batch.stderr')
      $null = $batchProcess.Handle
      if (!$batchProcess.WaitForExit(10000)) {
        $batchProcess.Kill()
        throw 'The isolated BAT launcher did not exit.'
      }
      Assert-RelayTest ($batchProcess.ExitCode -eq $expectedExitCode) "BAT did not preserve the startup exit code $expectedExitCode (actual: $($batchProcess.ExitCode))."
    }
    Write-Output 'PASS: BAT runs from a path with spaces and preserves success/failure exit codes.'
  } catch { $failures += $_.Exception.Message }

  # Replay the observed CLI error, without contacting Codex or spending a model turn.
  function Invoke-CodexCliCapture([string[]] $Arguments, [string] $WorkingDirectory) {
    $script:testCalls.Add($Arguments)
    if ($Arguments -contains 'resume') {
      return [pscustomobject]@{ ExitCode = $script:resumeExitCode; Stdout = $script:resumeStdout; Stderr = $script:resumeError }
    }
    return [pscustomobject]@{ ExitCode = 0; Stdout = ('{"type":"thread.started","thread_id":"' + $keepId + '"}' + "`n" + '{"type":"item.completed","item":{"type":"agent_message","text":"codex-mini-cli-ok"}}'); Stderr = '' }
  }
  $env:CODEX_MINI_CLEAN_OLD_CLI_TEST_SESSIONS = '0'
  $script:resumeStdout = ''
  foreach ($exitCode in @(0, 1)) {
    try {
      Save-CodexCliTestSessionId $checkDir $oldId
      $script:testCalls = New-Object 'System.Collections.Generic.List[object]'
      $script:resumeExitCode = $exitCode
      $script:resumeError = "Error: thread/resume: thread/resume failed: no rollout found for thread id $oldId (code -32600)"
      $result = Invoke-CodexCliExecutionTest 'codex-mini-cli-ok' $checkDir
      Assert-RelayTest ($script:testCalls.Count -eq 2) "Missing rollout was not replaced exactly once (resume exit code $exitCode)."
      Assert-RelayTest ($script:testCalls[0] -contains 'resume') 'The saved test session was not resumed first.'
      Assert-RelayTest (!($script:testCalls[1] -contains 'resume')) 'Recovery tried to resume the missing session again.'
      Assert-RelayTest ((Read-CodexCliTestSessionId $checkDir) -eq $keepId) 'Recovery did not persist the replacement session ID.'
      Assert-RelayTest ($result.ExitCode -eq 0) 'Recovery did not return the successful replacement result.'
      Write-Output "PASS: missing rollout recovers once (resume exit code $exitCode)."
    } catch { $failures += $_.Exception.Message }
  }

  try {
    $script:testCalls = New-Object 'System.Collections.Generic.List[object]'
    $script:resumeExitCode = 0
    $script:resumeError = ''
    $script:resumeStdout = '{"type":"item.completed","item":{"type":"agent_message","text":"codex-mini-cli-ok"}}'
    $result = Invoke-CodexCliExecutionTest 'codex-mini-cli-ok' $checkDir
    Assert-RelayTest ($script:testCalls.Count -eq 1 -and $script:testCalls[0] -contains 'resume') 'A valid saved session must be reused without creating another one.'
    Assert-RelayTest ((Read-CodexCliTestSessionId $checkDir) -eq $keepId) 'A successful resume replaced the saved session ID.'
    Write-Output 'PASS: the next startup reuses the recovered session.'
  } catch { $failures += $_.Exception.Message }

  try {
    Save-CodexCliTestSessionId $checkDir $oldId
    $script:testCalls = New-Object 'System.Collections.Generic.List[object]'
    $script:resumeExitCode = 1
    $script:resumeStdout = ''
    $script:resumeError = 'Error: unauthorized, please log in'
    $result = Invoke-CodexCliExecutionTest 'codex-mini-cli-ok' $checkDir
    Assert-RelayTest ($script:testCalls.Count -eq 1) 'Authentication failure must not create another session.'
    Assert-RelayTest ($result.ExitCode -eq 1) 'Authentication failure was hidden.'
    Assert-RelayTest ((Read-CodexCliTestSessionId $checkDir) -eq $oldId) 'Authentication failure erased the saved session ID.'
    Write-Output 'PASS: authentication failure remains fatal without creating a session.'
  } catch { $failures += $_.Exception.Message }
} finally {
  $env:USERPROFILE = $previousUserProfile
  $env:CODEX_MINI_CLEAN_OLD_CLI_TEST_SESSIONS = $previousCleanup
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (!$resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedTestRoot) -notmatch '^codex-mini-relay-test-[0-9a-f]{32}$') {
    throw 'Refusing to remove an unexpected test directory.'
  }
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}

if ($failures.Count -gt 0) { throw ($failures -join "`n") }
