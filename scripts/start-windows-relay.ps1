$ErrorActionPreference = 'Stop'

$ProjectDir = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location -LiteralPath $ProjectDir

$LogDir = Join-Path $ProjectDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$script:LogPath = Join-Path $LogDir ("{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$script:TranscriptStarted = $false
$script:ManagedCodexProcess = $null

function Add-CodexMiniLogLine([string] $Text) {
  if ([string]::IsNullOrWhiteSpace($script:LogPath)) { return }
  try {
    Add-Content -LiteralPath $script:LogPath -Value $Text -Encoding UTF8
  } catch {
  }
}

function Write-Host {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [AllowNull()]
    [object[]] $Object
  )
  $text = if ($null -eq $Object -or $Object.Count -eq 0) { '' } else { ($Object | ForEach-Object { if ($null -eq $_) { '' } else { [string]$_ } }) -join ' ' }
  $text = $text -replace "`r?`n", "`r`n"
  Add-CodexMiniLogLine $text
  [Console]::Out.Write("`r$text`r`n")
}

function Start-DesktopLog {
  $script:TranscriptStarted = $true
  Add-CodexMiniLogLine '**********************'
  Add-CodexMiniLogLine 'Codex Relay Windows relay log start'
  Add-CodexMiniLogLine ("Start time: {0}" -f (Get-Date -Format 'yyyyMMddHHmmss'))
  Add-CodexMiniLogLine ("Username: {0}\{1}" -f $env:USERDOMAIN, $env:USERNAME)
  Add-CodexMiniLogLine ("Machine: {0} ({1})" -f $env:COMPUTERNAME, [Environment]::OSVersion.VersionString)
  Add-CodexMiniLogLine ("Host application: powershell.exe -NoProfile -ExecutionPolicy Bypass -File {0}" -f $PSCommandPath)
  Add-CodexMiniLogLine ("Process ID: {0}" -f $PID)
  Add-CodexMiniLogLine ("PSVersion: {0}" -f $PSVersionTable.PSVersion)
  Add-CodexMiniLogLine '**********************'
  Write-Host "Log file: $script:LogPath"
}

function Stop-DesktopLog {
  if (!$script:TranscriptStarted) { return }
  Add-CodexMiniLogLine '**********************'
  Add-CodexMiniLogLine ("Codex Relay Windows relay log end: {0}" -f (Get-Date -Format 'yyyyMMddHHmmss'))
  Add-CodexMiniLogLine '**********************'
  $script:TranscriptStarted = $false
}

Start-DesktopLog

trap {
  Write-Host ''
  Write-Host "Fatal error: $($_.Exception.Message)"
  Stop-DesktopLog
  throw
}

$DefaultPublicBase = ''
$LocalEnvPath = Join-Path $ProjectDir 'desktop-env.local.ps1'
if (Test-Path -LiteralPath $LocalEnvPath) {
  . $LocalEnvPath
}
$RegistrationKeyPlaceholder = '__CODEX_MINI_RELAY_REGISTRATION_KEY__'
$DefaultRegistrationKey = '__CODEX_MINI_RELAY_REGISTRATION_KEY__'
$PublicBase = if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_RELAY_PUBLIC_BASE)) { $DefaultPublicBase } else { $env:CODEX_MINI_RELAY_PUBLIC_BASE }
$PublicBase = $PublicBase.TrimEnd('/')
if ([string]::IsNullOrWhiteSpace($PublicBase)) {
  throw 'Set CODEX_MINI_RELAY_PUBLIC_BASE in desktop-env.local.ps1; see desktop-env.example.ps1.'
}
$RegistrationKey = if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_RELAY_REGISTRATION_KEY)) { $DefaultRegistrationKey } else { $env:CODEX_MINI_RELAY_REGISTRATION_KEY }
if ($RegistrationKey -eq $RegistrationKeyPlaceholder) {
  throw 'Set CODEX_MINI_RELAY_REGISTRATION_KEY in desktop-env.local.ps1; see desktop-env.example.ps1.'
}
$RelayUrl = if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_RELAY_URL)) {
  ($PublicBase -replace '^https:', 'wss:' -replace '^http:', 'ws:') + '/tunnel'
} else {
  $env:CODEX_MINI_RELAY_URL
}

$StateRoot = if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
  Join-Path $ProjectDir '.codex-mini-state'
} else {
  Join-Path $env:APPDATA 'CodexMini'
}
$DeviceConfigPath = Join-Path $StateRoot 'relay-device.json'
$RuntimeRoot = Join-Path $ProjectDir '.runtime'
$NodeRoot = Join-Path $RuntimeRoot 'node'
$CodexCliInstallHome = Join-Path $RuntimeRoot 'codex-cli-home'
$CodexCliInstallBin = Join-Path $RuntimeRoot 'codex-cli-bin'
$script:NodeExe = ''
$script:NpmCmd = ''
$script:CodexCliExe = ''

function ConvertTo-Base64Url([byte[]] $Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomToken([int] $Bytes) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return ConvertTo-Base64Url $buffer
}

function Get-Sha256Hex([string] $Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $hash = $sha.ComputeHash($bytes)
    return -join ($hash | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
}

function Get-MachineSeed {
  $machineGuid = ''
  try {
    $machineGuid = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
  } catch {
    $machineGuid = ''
  }
  return @(
    $env:COMPUTERNAME,
    $env:USERDOMAIN,
    $env:USERNAME,
    $machineGuid
  ) -join '|'
}

function Get-SafeName([string] $Value, [string] $Fallback) {
  $safe = ($Value -replace '[^a-zA-Z0-9._-]+', '-').Trim('-')
  if ([string]::IsNullOrWhiteSpace($safe)) { return $Fallback }
  if ($safe.Length -gt 40) { return $safe.Substring(0, 40).Trim('-') }
  return $safe
}

function New-DeviceConfig {
  $installId = New-RandomToken 16
  $machineHash = (Get-Sha256Hex ((Get-MachineSeed) + '|' + $installId)).Substring(0, 12)
  $hostPart = Get-SafeName $env:COMPUTERNAME 'windows'
  return [ordered]@{
    publicBase = $PublicBase
    relayUrl = $RelayUrl
    deviceId = "codex-$hostPart-$machineHash".ToLowerInvariant()
    name = "Codex $hostPart"
    relaySecret = New-RandomToken 32
    passphrase = New-RandomToken 18
    fingerprint = $machineHash
    installId = $installId
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
  }
}

function Register-Device($Config) {
  Write-Host ''
  Write-Host 'First start on this computer. A new relay device approval request will be sent.'
  Write-Host "Relay: $PublicBase"
  Write-Host "Device: $($Config.deviceId)"
  Write-Host ''

  $body = @{
    registrationKey = $RegistrationKey
    deviceId = $Config.deviceId
    name = $Config.name
    relaySecret = $Config.relaySecret
    passphrase = $Config.passphrase
    fingerprint = $Config.fingerprint
  } | ConvertTo-Json -Depth 4

  $registerUrl = "$PublicBase/device/register"
  Invoke-RestMethod -Method Post -Uri $registerUrl -ContentType 'application/json' -Body $body -TimeoutSec 30 | Out-Null
  $Config.registeredAt = (Get-Date).ToUniversalTime().ToString('o')
  $Config.approvedAtFirstStart = $false
  Write-Host 'Device request submitted. Waiting for relay authorization.'
}

function Load-Or-CreateDeviceConfig {
  if (Test-Path -LiteralPath $DeviceConfigPath) {
    return Get-Content -LiteralPath $DeviceConfigPath -Raw | ConvertFrom-Json
  }

  New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
  $config = New-DeviceConfig
  Register-Device $config
  $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $DeviceConfigPath -Encoding UTF8
  return Get-Content -LiteralPath $DeviceConfigPath -Raw | ConvertFrom-Json
}

function Save-DeviceConfig($Config) {
  New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
  $Config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $DeviceConfigPath -Encoding UTF8
}

function Ensure-DeviceRuntimeFields($Config) {
  if ([string]::IsNullOrWhiteSpace([string]$Config.localToken)) {
    $Config | Add-Member -NotePropertyName localToken -NotePropertyValue (New-RandomToken 18) -Force
    Save-DeviceConfig $Config
  }
  return $Config
}

function Resolve-NpmCmd([string] $NpmPath) {
  if ([string]::IsNullOrWhiteSpace($NpmPath)) {
    throw 'npm command is not configured.'
  }

  if ([IO.Path]::GetExtension($NpmPath) -ieq '.cmd') {
    return $NpmPath
  }

  $npmDir = Split-Path -Parent $NpmPath
  if (![string]::IsNullOrWhiteSpace($npmDir)) {
    $adjacentCmd = Join-Path $npmDir 'npm.cmd'
    if (Test-Path -LiteralPath $adjacentCmd) {
      return $adjacentCmd
    }
  }

  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npmCmd) {
    return $npmCmd.Source
  }

  throw 'npm.cmd was not found. Install Node.js for Windows or allow the script to install portable Node.js.'
}

function Set-NodeCommands([string] $NodePath, [string] $NpmPath) {
  $script:NodeExe = $NodePath
  $script:NpmCmd = Resolve-NpmCmd $NpmPath
  $nodeDir = Split-Path -Parent $NodePath
  if ($env:Path -notlike "*$nodeDir*") {
    $env:Path = "$nodeDir;$env:Path"
  }
}

function Invoke-Npm {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
  )

  $npmCmd = $script:NpmCmd
  if ([string]::IsNullOrWhiteSpace($npmCmd)) {
    throw 'npm command is not configured.'
  }
  if ([IO.Path]::GetExtension($npmCmd) -ieq '.ps1') {
    throw 'npm.ps1 cannot be used here because it mis-parses variable-based calls. npm.cmd is required.'
  }
  & $npmCmd @Arguments
}

function Get-PortableNodeArch {
  $arch = "$env:PROCESSOR_ARCHITEW6432 $env:PROCESSOR_ARCHITECTURE"
  if ($arch -match 'ARM64') { return 'win-arm64' }
  return 'win-x64'
}

function Install-PortableNode {
  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  $arch = Get-PortableNodeArch
  $baseUrl = 'https://nodejs.org/dist/latest-v24.x'
  $sumsUrl = "$baseUrl/SHASUMS256.txt"

  Write-Host ''
  Write-Host 'Node.js was not found. Downloading portable Node.js into this folder...'
  Write-Host "Architecture: $arch"

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl -TimeoutSec 60).Content
  $zipName = $null
  $expectedHash = $null
  foreach ($line in ($sums -split "`n")) {
    if ($line -match "^([a-fA-F0-9]{64})\s+(node-v[0-9]+\.[0-9]+\.[0-9]+-$arch\.zip)") {
      $expectedHash = $Matches[1].ToLowerInvariant()
      $zipName = $Matches[2]
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($zipName)) {
    throw "Could not find a Node.js Windows zip for $arch."
  }

  $zipUrl = "$baseUrl/$zipName"
  $zipPath = Join-Path $RuntimeRoot $zipName
  $expandedName = [IO.Path]::GetFileNameWithoutExtension($zipName)
  $expandedPath = Join-Path $RuntimeRoot $expandedName

  Write-Host "Downloading $zipName..."
  Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $zipPath -TimeoutSec 180
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    Remove-Item -LiteralPath $zipPath -Force
    throw 'Downloaded Node.js zip failed SHA256 verification.'
  }

  if (Test-Path -LiteralPath $expandedPath) {
    Remove-Item -LiteralPath $expandedPath -Recurse -Force
  }
  if (Test-Path -LiteralPath $NodeRoot) {
    Remove-Item -LiteralPath $NodeRoot -Recurse -Force
  }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $RuntimeRoot -Force
  Move-Item -LiteralPath $expandedPath -Destination $NodeRoot

  $nodePath = Join-Path $NodeRoot 'node.exe'
  $npmPath = Join-Path $NodeRoot 'npm.cmd'
  if (!(Test-Path -LiteralPath $nodePath) -or !(Test-Path -LiteralPath $npmPath)) {
    throw 'Portable Node.js download did not contain node.exe and npm.cmd.'
  }
  Set-NodeCommands $nodePath $npmPath
}

function Ensure-NodeRuntime {
  $portableNode = Join-Path $NodeRoot 'node.exe'
  $portableNpm = Join-Path $NodeRoot 'npm.cmd'
  if ((Test-Path -LiteralPath $portableNode) -and (Test-Path -LiteralPath $portableNpm)) {
    Set-NodeCommands $portableNode $portableNpm
    return
  }

  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  $systemNpm = Get-Command npm -ErrorAction SilentlyContinue
  if ($systemNode -and $systemNpm) {
    Set-NodeCommands $systemNode.Source $systemNpm.Source
    return
  }

  Install-PortableNode
}

function Ensure-NodeDependencies {
  $missing = @()
  foreach ($module in @('node_modules\ws', 'node_modules\qrcode', 'node_modules\qrcode-terminal')) {
    if (!(Test-Path -LiteralPath (Join-Path $ProjectDir $module))) {
      $missing += $module
    }
  }
  if ($missing.Count -eq 0) { return }
  Write-Host ''
  Write-Host 'Installing Node dependencies...'
  Invoke-Npm install --omit=dev
  if ($LASTEXITCODE -ne 0) {
    throw 'npm install failed.'
  }
}

function Set-CodexCliCommand([string] $CodexPath) {
  $script:CodexCliExe = (Resolve-Path -LiteralPath $CodexPath).Path
  $env:CODEX_MINI_CODEX_CLI = $script:CodexCliExe
  $codexDir = Split-Path -Parent $CodexPath
  if (![string]::IsNullOrWhiteSpace($codexDir) -and $env:Path -notlike "*$codexDir*") {
    $env:Path = "$codexDir;$env:Path"
  }
}

function Find-CodexCli {
  if (![string]::IsNullOrWhiteSpace($env:CODEX_MINI_CODEX_CLI)) {
    if (!(Test-Path -LiteralPath $env:CODEX_MINI_CODEX_CLI -PathType Leaf)) {
      throw "Configured Codex CLI does not exist: $env:CODEX_MINI_CODEX_CLI"
    }
    Set-CodexCliCommand $env:CODEX_MINI_CODEX_CLI
    return $true
  }

  foreach ($candidate in @(
    (Join-Path $CodexCliInstallBin 'node_modules\.bin\codex.cmd'),
    (Join-Path $CodexCliInstallBin 'codex.exe')
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      Set-CodexCliCommand $candidate
      return $true
    }
  }

  foreach ($name in @('codex.exe', 'codex.cmd', 'codex')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      Set-CodexCliCommand $command.Source
      return $true
    }
  }

  $candidates = @(
    (Join-Path $CodexCliInstallBin 'codex.exe'),
    (Join-Path $env:APPDATA 'npm\codex.cmd'),
    (Join-Path $env:APPDATA 'npm\codex.exe'),
    (Join-Path $env:USERPROFILE '.codex\bin\codex.exe'),
    (Join-Path $env:USERPROFILE '.local\bin\codex.exe')
  )
  foreach ($candidate in $candidates) {
    if (![string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
      Set-CodexCliCommand $candidate
      return $true
    }
  }
  return $false
}

function Install-CodexCli {
  Write-Host ''
  Write-Host 'Codex CLI was not found. Installing official Codex CLI...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $previousCodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
  $previousCodexInstallDir = [Environment]::GetEnvironmentVariable('CODEX_INSTALL_DIR', 'Process')
  $previousCodexNonInteractive = [Environment]::GetEnvironmentVariable('CODEX_NON_INTERACTIVE', 'Process')
  $previousProcessPath = $env:Path
  $previousUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  try {
    $env:CODEX_HOME = $CodexCliInstallHome
    $env:CODEX_INSTALL_DIR = $CodexCliInstallBin
    $env:CODEX_NON_INTERACTIVE = '1'
    Invoke-Expression ((Invoke-RestMethod -Uri 'https://chatgpt.com/codex/install.ps1' -TimeoutSec 120) | Out-String)
  } catch {
    throw "Codex CLI install failed in the portable runtime '$RuntimeRoot'. Check that the extracted Codex Relay folder is writable. $($_.Exception.Message)"
  } finally {
    if ($null -eq $previousCodexHome) {
      Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    } else {
      $env:CODEX_HOME = $previousCodexHome
    }
    if ($null -eq $previousCodexInstallDir) {
      Remove-Item Env:CODEX_INSTALL_DIR -ErrorAction SilentlyContinue
    } else {
      $env:CODEX_INSTALL_DIR = $previousCodexInstallDir
    }
    if ($null -eq $previousCodexNonInteractive) {
      Remove-Item Env:CODEX_NON_INTERACTIVE -ErrorAction SilentlyContinue
    } else {
      $env:CODEX_NON_INTERACTIVE = $previousCodexNonInteractive
    }
    $env:Path = $previousProcessPath
    [Environment]::SetEnvironmentVariable('Path', $previousUserPath, 'User')
  }
}

function Get-CodexCliCheckDir {
  $root = if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_CODEX_TEST_ROOT)) {
    Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Codex'
  } else {
    $env:CODEX_MINI_CODEX_TEST_ROOT
  }
  $dir = Join-Path $root 'codex-mini-cli'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Get-CodexCliTestSessionIdPath([string] $CheckDir) {
  return (Join-Path $CheckDir '.codex-mini-cli-session-id')
}

function Read-CodexCliTestSessionId([string] $CheckDir) {
  $path = Get-CodexCliTestSessionIdPath $CheckDir
  if (!(Test-Path -LiteralPath $path)) { return '' }
  $value = (Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue).Trim()
  if ($value -match '(?i)^([0-9a-f]{8}-[0-9a-f-]{27,}|thr_[a-z0-9_-]{3,})$') { return $value }
  return ''
}

function Get-CodexCliThreadIdFromText([string] $Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
  if ($Text -match '(?i)(?:thread_id|threadId|session_id|sessionId)["'':=\s]+([0-9a-f]{8}-[0-9a-f-]{27,}|thr_[a-z0-9_-]{3,})') {
    return $matches[1]
  }
  if ($Text -match '(?i)\b(thr_[a-z0-9_-]{3,})\b') {
    return $matches[1]
  }
  if ($Text -match '(?i)\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b') {
    return $matches[1]
  }
  return ''
}

function Save-CodexCliTestSessionId([string] $CheckDir, [string] $ThreadId) {
  if ([string]::IsNullOrWhiteSpace($ThreadId)) { return }
  Set-Content -LiteralPath (Get-CodexCliTestSessionIdPath $CheckDir) -Value $ThreadId -Encoding UTF8
}

function Remove-OldCodexCliTestSessions([string] $CheckDir, [string] $KeepThreadId) {
  if ($env:CODEX_MINI_CLEAN_OLD_CLI_TEST_SESSIONS -eq '0') { return }
  if ([string]::IsNullOrWhiteSpace($CheckDir) -or [string]::IsNullOrWhiteSpace($KeepThreadId)) { return }
  $sessionsRoot = Join-Path $env:USERPROFILE '.codex\sessions'
  if (!(Test-Path -LiteralPath $sessionsRoot)) { return }
  $expected = [System.IO.Path]::GetFullPath($CheckDir).TrimEnd('\')
  Get-ChildItem -LiteralPath $sessionsRoot -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $isTestSession = $false
      foreach ($line in (Get-Content -LiteralPath $_.FullName -TotalCount 80 -ErrorAction Stop)) {
        try {
          $item = $line | ConvertFrom-Json -ErrorAction Stop
          if ($item.type -eq 'session_meta' -and $item.payload.cwd) {
            $threadId = [string]$item.payload.id
            $cwd = [System.IO.Path]::GetFullPath([string]$item.payload.cwd).TrimEnd('\')
            if ($cwd -eq $expected -and ![string]::IsNullOrWhiteSpace($threadId) -and $threadId -ne $KeepThreadId) {
              $isTestSession = $true
            }
            break
          }
        } catch {}
      }
      if ($isTestSession) {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
      }
    } catch {}
  }
}

function Invoke-CodexCliExecutionTest([string] $Expected, [string] $CheckDir) {
  $existingThreadId = Read-CodexCliTestSessionId $CheckDir
  if (![string]::IsNullOrWhiteSpace($existingThreadId)) {
    $resume = Invoke-CodexCliCapture @('--ask-for-approval', 'never', 'exec', 'resume', '--json', '--skip-git-repo-check', $existingThreadId, "Reply with exactly: $Expected")
    $resumeText = (($resume.Stdout + "`n" + $resume.Stderr) | Out-String)
    if ($resume.ExitCode -eq 0 -and $resumeText -like "*$Expected*") {
      $threadId = Get-CodexCliThreadIdFromText $resumeText
      if ([string]::IsNullOrWhiteSpace($threadId)) { $threadId = $existingThreadId }
      Save-CodexCliTestSessionId $CheckDir $threadId
      Remove-OldCodexCliTestSessions $CheckDir $threadId
      return $resume
    }
    if ($resumeText -notmatch '(?i)no rollout found|not found|missing|conversation state|session') {
      return $resume
    }
    Remove-Item -LiteralPath (Get-CodexCliTestSessionIdPath $CheckDir) -Force -ErrorAction SilentlyContinue
  }

  $created = Invoke-CodexCliCapture @('--ask-for-approval', 'never', 'exec', '--json', '--skip-git-repo-check', '--cd', $CheckDir, "Reply with exactly: $Expected")
  $createdText = (($created.Stdout + "`n" + $created.Stderr) | Out-String)
  if ($created.ExitCode -eq 0 -and $createdText -like "*$Expected*") {
    $threadId = Get-CodexCliThreadIdFromText $createdText
    Save-CodexCliTestSessionId $CheckDir $threadId
    Remove-OldCodexCliTestSessions $CheckDir $threadId
  }
  return $created
}

function ConvertTo-WindowsCommandLineArgument([string] $Argument) {
  if ($null -eq $Argument) { return '""' }
  if ($Argument.Length -eq 0) { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }
  $result = '"'
  $backslashes = 0
  foreach ($char in $Argument.ToCharArray()) {
    if ($char -eq '\') {
      $backslashes += 1
      continue
    }
    if ($char -eq '"') {
      $result += ('\' * (($backslashes * 2) + 1))
      $result += '"'
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      $result += ('\' * $backslashes)
      $backslashes = 0
    }
    $result += $char
  }
  if ($backslashes -gt 0) {
    $result += ('\' * ($backslashes * 2))
  }
  return $result + '"'
}

function Invoke-CodexCliCapture([string[]] $Arguments, [string] $WorkingDirectory = $ProjectDir, [int] $TimeoutMs = 120000) {
  $stdoutPath = Join-Path $env:TEMP ("codex-mini-cli-stdout-{0}-{1}.log" -f $PID, ([guid]::NewGuid().ToString('N')))
  $stderrPath = Join-Path $env:TEMP ("codex-mini-cli-stderr-{0}-{1}.log" -f $PID, ([guid]::NewGuid().ToString('N')))
  $filePath = $script:CodexCliExe
  $argumentText = (($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) }) -join ' ')
  if ($script:CodexCliExe -match '(?i)\.(cmd|bat)$') {
    $commandLine = (ConvertTo-WindowsCommandLineArgument $script:CodexCliExe)
    if (![string]::IsNullOrWhiteSpace($argumentText)) {
      $commandLine = "$commandLine $argumentText"
    }
    $filePath = if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { Join-Path $env:SystemRoot 'System32\cmd.exe' } else { $env:ComSpec }
    $argumentText = "/d /s /c $(ConvertTo-WindowsCommandLineArgument $commandLine)"
  }
  try {
    $process = Start-Process -FilePath $filePath -ArgumentList $argumentText -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
    # Windows PowerShell needs a retained process handle to read ExitCode after exit.
    $null = $process.Handle
    if (!$process.WaitForExit($timeoutMs)) {
      try { $process.Kill() } catch {}
      $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue } else { '' }
      $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue } else { '' }
      return [pscustomobject]@{
        ExitCode = 124
        Stdout = $stdout
        Stderr = (($stderr + "`nCodex CLI command timed out after $timeoutMs ms").Trim())
      }
    }
    $process.WaitForExit()
    $process.Refresh()
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue } else { '' }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue } else { '' }
    if ($null -eq $process.ExitCode) { throw 'Codex CLI exited without an available exit code.' }
    $exitCode = [int]$process.ExitCode
    return [pscustomobject]@{
      ExitCode = $exitCode
      Stdout = $stdout
      Stderr = $stderr
    }
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-CodexCli {
  if ($env:CODEX_MINI_REQUIRE_CODEX_CLI -eq '0') {
    Write-Host ''
    Write-Host 'Skipping Codex CLI check because CODEX_MINI_REQUIRE_CODEX_CLI=0.'
    return
  }

  if (!(Find-CodexCli)) {
    Install-CodexCli
    if (!(Find-CodexCli)) {
      throw 'Codex CLI install finished, but the codex command was not found. Restart this PowerShell window or set CODEX_MINI_CODEX_CLI to the full codex path.'
    }
  }

  $checkTimer = [Diagnostics.Stopwatch]::StartNew()
  Write-Host ''
  Write-Host 'Checking Codex CLI...'
  Write-Host "Codex CLI path: $script:CodexCliExe"
  Write-Host 'Running Codex CLI version check...'
  $versionCheck = Invoke-CodexCliCapture -Arguments @('--version') -TimeoutMs 8000
  $versionText = (($versionCheck.Stdout + $versionCheck.Stderr).Trim())
  if ($versionText) { Write-Host $versionText }
  if ($versionCheck.ExitCode -ne 0 -or $versionText -notmatch 'codex-cli\s+\d') {
    throw 'Codex CLI version check failed.'
  }
  # Startup capability check: codex app-server --help
  Write-Host 'Running Codex App Server capability check...'
  $appServerCheck = Invoke-CodexCliCapture -Arguments @('app-server', '--help') -TimeoutMs 8000
  if ($appServerCheck.ExitCode -ne 0) {
    $appServerText = (($appServerCheck.Stdout + "`n" + $appServerCheck.Stderr).Trim())
    if ($appServerText) { Write-Host $appServerText }
    throw 'Codex App Server check failed. Please update Codex CLI and start Codex Relay again.'
  }
  Write-Host 'Codex App Server check passed.'
  Write-Host ("Quick checks completed in {0:N2}s." -f $checkTimer.Elapsed.TotalSeconds)

  if ($env:CODEX_MINI_SKIP_CODEX_CLI_TEST -eq '1') {
    Write-Host 'Skipping Codex CLI execution test because CODEX_MINI_SKIP_CODEX_CLI_TEST=1.'
    return
  }
  if ($env:CODEX_MINI_FULL_CODEX_CLI_CHECK -ne '1') {
    Write-Host 'Model execution check is opt-in. Set CODEX_MINI_FULL_CODEX_CLI_CHECK=1 for full diagnostics.'
    return
  }

  $expected = 'codex-mini-cli-ok'
  $checkDir = Get-CodexCliCheckDir
  $check = Invoke-CodexCliExecutionTest $expected $checkDir
  $text = (($check.Stdout + "`n" + $check.Stderr) | Out-String)
  if ($check.ExitCode -ne 0) {
    Write-Host $text
    if ($text -like '*service_tier*default*') {
      throw 'Codex CLI config is incompatible with the selected CLI. Check .codex\config.toml or update Codex CLI.'
    }
    if ($text -match '(?i)auth|login|sign in|api key|unauthorized') {
      throw 'Codex CLI execution test failed. If the output mentions authentication, unlock this computer and run codex login, then start Codex Relay again.'
    }
    throw 'Codex CLI execution test failed. If the output mentions authentication, unlock this computer and run codex login, then start Codex Relay again.'
  }
  if ($text -notlike "*$expected*") {
    Write-Host $text
    throw 'Codex CLI execution test did not return the expected response.'
  }
  Write-Host 'Codex CLI execution test passed.'
}

function Test-TcpPort([string] $HostName, [int] $PortNumber) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $result = $client.BeginConnect($HostName, $PortNumber, $null, $null)
    if (!$result.AsyncWaitHandle.WaitOne(800, $false)) { return $false }
    $client.EndConnect($result)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-RelayStatus([string] $BaseUrl, [string] $Token, [switch] $Quiet) {
  try {
    return Invoke-RestMethod -Method Get -Uri "$BaseUrl/codex/relay-status" -Headers @{ 'x-mobile-typer-token' = $Token } -TimeoutSec 5
  } catch {
    if (!$Quiet) {
      Write-Host "Relay status check failed: $($_.Exception.Message)"
    }
    return $null
  }
}

function Start-CodexMiniProcess {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $script:NodeExe
  $info.Arguments = 'server.js'
  $info.WorkingDirectory = [string]$ProjectDir
  $info.UseShellExecute = $false
  $info.EnvironmentVariables['CODEX_MINI_DESKTOP_LOG_PATH'] = [string]$script:LogPath
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  if (!$process.Start()) {
    throw 'Failed to start Codex Relay node process.'
  }
  return $process
}

function Stop-CodexMiniKeepAwakeHelpers {
  try {
    $helpers = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
      Where-Object { $_.CommandLine -like '*CodexMiniPower*SetThreadExecutionState*' }
    foreach ($helper in $helpers) {
      try { Stop-Process -Id $helper.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
  } catch {
  }
}

function Stop-CodexMiniProcess($Process) {
  if (!$Process -or $Process.HasExited) { return }
  try {
    $Process.CloseMainWindow() | Out-Null
    Start-Sleep -Milliseconds 800
  } catch {
  }
  if (!$Process.HasExited) {
    try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  Stop-CodexMiniKeepAwakeHelpers
  if ($script:ManagedCodexProcess -and $script:ManagedCodexProcess.Id -eq $Process.Id) {
    $script:ManagedCodexProcess = $null
  }
}

function Wait-ForRelayStatus([string] $BaseUrl, [string] $Token, [int] $TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $status = Get-RelayStatus $BaseUrl $Token -Quiet
    if ($status) { return $status }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Watch-CodexMiniRelay([string] $BaseUrl, [string] $Token, [string] $ExpectedDeviceId) {
  $process = $null
  $restartDelayMs = 1000
  $offlineSince = $null
  $lastState = ''
  $managedProcess = $true
  $localFailureCount = 0
  $localFailureSince = $null
  $localPort = 8787
  if (![string]::IsNullOrWhiteSpace($env:PORT)) {
    $localPort = [int]$env:PORT
  }

  $existing = Get-RelayStatus $BaseUrl $Token -Quiet
  if ($existing -and $existing.deviceId -eq $ExpectedDeviceId) {
    Write-Host ''
    Write-Host "Existing Codex Relay service is already running on $BaseUrl."
    Write-Host 'Monitoring existing service. Restart this script if that old service stops responding.'
    $managedProcess = $false
  } elseif (Test-TcpPort '127.0.0.1' $localPort) {
    throw "Port $localPort is already in use, but it did not expose this device's relay status. Close the old Codex Relay window and run this script again."
  }

  while ($true) {
    if ($managedProcess -and (!$process -or $process.HasExited)) {
      if ($process -and $process.HasExited) {
        Write-Host "Codex Relay node process exited with code $($process.ExitCode). Restarting..."
        Start-Sleep -Milliseconds $restartDelayMs
        $restartDelayMs = [Math]::Min($restartDelayMs * 2, 30000)
      }
      $process = Start-CodexMiniProcess
      $script:ManagedCodexProcess = $process
      Write-Host "Supervisor started Codex Relay node process PID $($process.Id)."
      Wait-ForRelayStatus $BaseUrl $Token 20 | Out-Null
      $offlineSince = $null
      $localFailureCount = 0
      $localFailureSince = $null
    }

    $status = Get-RelayStatus $BaseUrl $Token -Quiet
    $now = Get-Date
    if ($status -and $status.connected -eq $true) {
      $offlineSince = $null
      $localFailureCount = 0
      $localFailureSince = $null
      $restartDelayMs = 1000
      if ($lastState -ne 'connected') {
        Write-Host "Relay status: connected as $($status.deviceId)."
        $lastState = 'connected'
      }
      Start-Sleep -Seconds 5
      continue
    }

    if ($status) {
      $localFailureCount = 0
      $localFailureSince = $null
    } else {
      $localFailureCount += 1
      if (!$localFailureSince) { $localFailureSince = $now }
      $localFailureSeconds = ($now - $localFailureSince).TotalSeconds
      if ($localFailureCount -lt 3 -or $localFailureSeconds -lt 15) {
        Start-Sleep -Seconds 5
        continue
      }
    }

    $state = if ($status) { [string]$status.state } else { 'local-unreachable' }
    if ($state -eq 'codex-stopped' -or $state -eq 'codex-checking') {
      $offlineSince = $null
      if ($lastState -ne $state) {
        if ($state -eq 'codex-stopped') {
          Write-Host 'Relay access is paused because Codex is not running. Waiting for Codex to start...'
        } else {
          Write-Host 'Checking Codex desktop before opening relay access...'
        }
        $lastState = $state
      }
      Start-Sleep -Seconds 5
      continue
    }

    if (!$offlineSince) {
      $offlineSince = if (!$status -and $localFailureSince) { $localFailureSince } else { $now }
      Write-Host "Relay status: $state. Waiting for automatic recovery..."
      $lastState = $state
    } elseif ($lastState -ne $state) {
      Write-Host "Relay status: $state."
      $lastState = $state
    }

    $offlineSeconds = ($now - $offlineSince).TotalSeconds
    if ($offlineSeconds -ge 60) {
      if ($managedProcess) {
        Write-Host "Relay has been unavailable for $([int]$offlineSeconds) seconds. Restarting Codex Relay node process..."
        Stop-CodexMiniProcess $process
        $process = $null
        $offlineSince = $null
      } else {
        Write-Host 'Existing Codex Relay service is unhealthy and was not started by this supervisor. Close the old Codex Relay window, then run this script again.'
        Start-Sleep -Seconds 10
      }
    } else {
      Write-Host "Relay reconnecting... $([int]$offlineSeconds)s elapsed."
      Start-Sleep -Seconds 5
    }
  }
}

$device = Ensure-DeviceRuntimeFields (Load-Or-CreateDeviceConfig)

$env:CODEX_MINI_RELAY_URL = [string]$device.relayUrl
$env:CODEX_MINI_RELAY_PUBLIC_BASE = [string]$device.publicBase
$env:CODEX_MINI_RELAY_DEVICE_ID = [string]$device.deviceId
$env:CODEX_MINI_RELAY_SECRET = [string]$device.relaySecret
$env:CODEX_MINI_RELAY_PASSPHRASE = [string]$device.passphrase
$env:MOBILE_TYPER_TOKEN = [string]$device.localToken
$env:CODEX_MINI_QR_DIR = [string]$ProjectDir
if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_RELAY_REQUIRE_CODEX_DESKTOP)) { $env:CODEX_MINI_RELAY_REQUIRE_CODEX_DESKTOP = '0' }
if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_AUTO_KEEP_AWAKE)) { $env:CODEX_MINI_AUTO_KEEP_AWAKE = '1' }
if ([string]::IsNullOrWhiteSpace($env:PORT)) { $env:PORT = '8787' }

Ensure-NodeRuntime
Ensure-NodeDependencies
Ensure-CodexCli

Write-Host ''
Write-Host 'Starting Codex Relay desktop relay...'
Write-Host "Device ID: $($device.deviceId)"
Write-Host "Device config: $DeviceConfigPath"
Write-Host 'Phone URL:'
Write-Host "  $($device.publicBase)/#k=$([uri]::EscapeDataString($device.passphrase))"
Write-Host ''
Write-Host 'Keep this window open while using the phone client.'
Write-Host 'Supervisor will restart the local relay automatically if it becomes unhealthy.'
if ($env:CODEX_MINI_CODEX_BACKEND -eq 'legacy_gui') {
  Write-Host 'Backend: legacy desktop automation (explicit override).'
} else {
  Write-Host 'Backend: Codex App Server for both locked and unlocked desktops.'
}
if ($env:CODEX_MINI_AUTO_KEEP_AWAKE -ne '0') {
  Write-Host 'Keep-awake: Codex Relay will prevent idle sleep while this relay is running.'
  Write-Host 'Lid boundary: if lid-close still sleeps, set Windows lid action to "Do nothing".'
} else {
  Write-Host 'Keep-awake: disabled by CODEX_MINI_AUTO_KEEP_AWAKE=0.'
}
Write-Host ''

try {
  Watch-CodexMiniRelay "http://127.0.0.1:$env:PORT" ([string]$device.localToken) ([string]$device.deviceId)
} finally {
  Stop-CodexMiniProcess $script:ManagedCodexProcess
  Stop-DesktopLog
}
