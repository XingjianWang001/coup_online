param(
  [string]$Revision,
  [switch]$Check,
  [switch]$AccessOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$remoteScript = Join-Path $PSScriptRoot 'deploy-private-remote.sh'
$configPath = Join-Path $repoRoot '.deploy-private.local.json'
$archive = $null
$keyCopy = $null
$tunnel = $null

function Assert-ExitCode([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit code $LASTEXITCODE)." }
}

function Read-DeployConfig {
  if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  } else {
    $hostName = Read-Host 'Server IP or DNS name'
    $userName = Read-Host 'SSH user (press Enter for ubuntu)'
    if (-not $userName) { $userName = 'ubuntu' }
    $keyPath = (Read-Host 'Full path to your PEM file').Trim('"')
    $config = [pscustomobject]@{ Host = $hostName; User = $userName; KeyPath = $keyPath }
  }

  if ($config.Host -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*$') { throw 'Invalid server host in deploy config.' }
  if ($config.User -notmatch '^[A-Za-z_][A-Za-z0-9_-]*$') { throw 'Invalid SSH user in deploy config.' }
  # 可选 Domain：设置后以 Caddy 公网 HTTPS 发布，不再开 SSH 隧道；多个域名用逗号分隔，同一个 app 同时用这些域名提供
  $domain = if ($config.PSObject.Properties['Domain']) { ([string]$config.Domain).ToLowerInvariant().Trim() -replace '\s*,\s*', ',' } else { '' }
  if ($domain -and $domain -notmatch '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(,([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})*$') { throw 'Invalid Domain in deploy config.' }
  $config | Add-Member -NotePropertyName Domain -NotePropertyValue $domain -Force
  $key = Get-Item -LiteralPath $config.KeyPath -ErrorAction Stop
  if ($key.PSIsContainer) { throw 'The PEM path must be a file.' }
  $config.KeyPath = $key.FullName

  if (-not (Test-Path -LiteralPath $configPath)) {
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
    Write-Host "Saved server settings in $configPath (the PEM itself stays on this computer)."
  }
  return $config
}

try {
  Set-Location $repoRoot
  foreach ($command in @('git', 'ssh', 'scp')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is required." }
  }
  if ($AccessOnly -and ($Revision -or $Check)) { throw '-AccessOnly cannot be combined with -Revision or -Check.' }

  if (-not $AccessOnly) {
  if ($Revision) {
    if ($Revision -notmatch '^[0-9a-fA-F]{40}$') { throw '-Revision needs a full 40-character Git commit SHA.' }
    $commit = (& git rev-parse --verify "${Revision}^{commit}").Trim()
    Assert-ExitCode 'Looking up the requested revision'
  } else {
    & git fetch --no-tags origin refs/heads/dev
    Assert-ExitCode 'Fetching origin/dev'
    $commit = (& git rev-parse --verify 'FETCH_HEAD^{commit}').Trim()
    Assert-ExitCode 'Resolving origin/dev'
  }

  $trackedFiles = @(& git ls-tree -r --name-only $commit)
  Assert-ExitCode 'Reading the release file list'
  foreach ($required in @('compose.yaml', 'Dockerfile', 'packages/server/src/index.ts')) {
    if ($trackedFiles -cnotcontains $required) { throw "$commit lacks $required. Merge the deployment files into dev first." }
  }
  foreach ($path in $trackedFiles) {
    if ($path -match '\.(pem|p12|pfx|key)$' -or
        ($path -match '(^|/)\.env($|\.)' -and $path -notmatch '(^|/)\.env\.example$')) {
      throw "Refusing to upload a possible secret: $path"
    }
  }

  $archive = Join-Path ([IO.Path]::GetTempPath()) "coup-online-$commit-$([guid]::NewGuid()).tar"
  & git archive --format=tar "--output=$archive" $commit
  Assert-ExitCode 'Creating the release archive'
  Write-Host "Prepared dev release $commit. Uncommitted files are excluded."
  if ($Check) { return }
  }

  $config = Read-DeployConfig
  $target = "$($config.User)@$($config.Host)"
  $keyCopy = Join-Path ([IO.Path]::GetTempPath()) "coup-online-$([guid]::NewGuid()).pem"
  Copy-Item -LiteralPath $config.KeyPath -Destination $keyCopy
  # Windows PowerShell 5.1 没有 $IsWindows，StrictMode 下不能直接引用
  if ($env:OS -eq 'Windows_NT') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $keyCopy /inheritance:r /grant:r "${identity}:F" | Out-Null
  } else {
    & chmod 600 $keyCopy
  }
  Assert-ExitCode 'Restricting the temporary PEM copy'

  if (-not $AccessOnly) {
  $sshOptions = @('-o', 'ConnectTimeout=20', '-o', 'ConnectionAttempts=3',
    '-o', 'PasswordAuthentication=no', '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3')
  Write-Host "Connecting to $target..."
  & ssh @sshOptions -i $keyCopy $target "mkdir -p .coup-online/uploads/$commit .coup-online/releases/$commit"
  Assert-ExitCode 'Preparing the server release directory'
  Write-Host 'Uploading the release...'
  & scp @sshOptions -C -i $keyCopy $archive $remoteScript "${target}:.coup-online/uploads/$commit/"
  Assert-ExitCode 'Uploading the release archive'
  Write-Host 'Building and starting the server app...'
  $archiveName = Split-Path -Leaf $archive
  & ssh @sshOptions -tt -i $keyCopy $target "cd && bash .coup-online/uploads/$commit/deploy-private-remote.sh $commit $archiveName $($config.Domain)"
  Assert-ExitCode 'Deploying and checking the server'
  }

  if ($config.Domain -and -not $AccessOnly) {
    # Windows PowerShell 5.1 可能默认不启用 TLS 1.2
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    foreach ($name in $config.Domain -split ',') {
    $publicUrl = "https://$name"
    $healthy = $false
    $lastError = 'no response'
    # Caddy 首次签发证书需要一些时间
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      try {
        $response = Invoke-WebRequest -Uri "$publicUrl/healthz" -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200 -and $response.Content.Trim() -eq 'ok') {
          $healthy = $true
          break
        }
        $lastError = "HTTP $($response.StatusCode)"
      } catch { $lastError = $_.Exception.Message }
      Start-Sleep -Seconds 2
    }
    if (-not $healthy) { throw "$publicUrl/healthz did not answer ok ($lastError). Check DNS, firewall ports 80/443 and 'docker compose -p coup-online logs caddy'." }
    Write-Host "Public access verified: $publicUrl"
    }
    Write-Host 'Deployment verified on every domain.'
    return
  }

  $sshPath = (Get-Command ssh).Source
  $tunnelArgs = @('-N', '-i', ('"' + $keyCopy + '"'), '-o', 'ConnectTimeout=20',
    '-o', 'ConnectionAttempts=3',
    '-o', 'PasswordAuthentication=no', '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes',
    '-L', '127.0.0.1:18887:127.0.0.1:8787', $target)
  $tunnel = Start-Process -FilePath $sshPath -ArgumentList $tunnelArgs -NoNewWindow -PassThru
  $healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($tunnel.HasExited) { throw "SSH tunnel exited with code $($tunnel.ExitCode)." }
    try {
      $response = Invoke-WebRequest -Uri 'http://127.0.0.1:18887/healthz' -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200 -and $response.Content.Trim() -eq 'ok') {
        $healthy = $true
        break
      }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) { throw 'The SSH tunnel did not reach the app health endpoint.' }
  if ($AccessOnly) {
    Write-Host 'Local access verified: http://127.0.0.1:18887'
  } else {
    Write-Host 'Deployment and local access verified: http://127.0.0.1:18887'
  }
  Write-Host 'Leave this window open to use the private site. Press Ctrl+C to close the tunnel.'
  while (-not $tunnel.HasExited) { Start-Sleep -Seconds 1 }
  throw "SSH tunnel exited with code $($tunnel.ExitCode)."
} catch {
  [Console]::Error.WriteLine("Deployment failed: $($_.Exception.Message)")
  exit 1
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
  if ($keyCopy -and (Test-Path -LiteralPath $keyCopy)) { Remove-Item -LiteralPath $keyCopy -Force }
  if ($archive -and (Test-Path -LiteralPath $archive)) { Remove-Item -LiteralPath $archive -Force }
}
