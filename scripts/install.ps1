# Claude Anywhere bootstrap installer for Windows (PowerShell 5.1 or 7+).
#
#   irm https://raw.githubusercontent.com/patel-deepanshu/claude-anywhere/main/scripts/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/patel-deepanshu/claude-anywhere/main/scripts/install.ps1))) --hotkey --electron
#
# Installs into $env:USERPROFILE\.claude-anywhere\app (git clone, or the GitHub zip when git is
# missing), runs `node app\bin\anywhere.js install <args>`, and adds app\bin to the user PATH so
# `anywhere` works in new terminals.
#
# Environment: ANYWHERE_HOME, ANYWHERE_REPO, ANYWHERE_BRANCH, ANYWHERE_NO_PATH=1.

param([Parameter(ValueFromRemainingArguments = $true)][string[]]$InstallArgs)

function Install-ClaudeAnywhere {
  param([string[]]$Arguments)

  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version 2.0
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  $repo = if ($env:ANYWHERE_REPO) { $env:ANYWHERE_REPO } else { 'https://github.com/patel-deepanshu/claude-anywhere' }
  $branch = if ($env:ANYWHERE_BRANCH) { $env:ANYWHERE_BRANCH } else { 'main' }
  $stateDir = if ($env:ANYWHERE_HOME) { $env:ANYWHERE_HOME } else { Join-Path $env:USERPROFILE '.claude-anywhere' }
  $appDir = Join-Path $stateDir 'app'
  if (-not $Arguments) { $Arguments = @() }

  function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

  # The user Path with $Dir appended, or $null when it is already there. @() keeps a one-entry
  # Path an array (a lone string would be concatenated with $Dir and no ';').
  function Get-PathWithEntry {
    param([AllowNull()][AllowEmptyString()][string]$Current, [string]$Dir)
    $parts = @()
    if ($Current) { $parts = @($Current.Split(';') | Where-Object { $_ }) }
    $want = $Dir.TrimEnd('\')
    foreach ($p in $parts) {
      if ($p.TrimEnd('\') -ieq $want -or [Environment]::ExpandEnvironmentVariables($p).TrimEnd('\') -ieq $want) { return $null }
    }
    return ((@($parts) + $Dir) -join ';')
  }

  # Append $Dir to HKCU\Environment\Path without expanding it: entries such as %JAVA_HOME%\bin
  # stay live (REG_EXPAND_SZ). Returns $true when the Path changed.
  function Add-UserPathEntry {
    param([string]$Dir)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
      $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
      $new = Get-PathWithEntry -Current $raw -Dir $Dir
      if ($null -eq $new) { return $false }
      if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -or $new.Contains('%')) { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue('Path', $new, $kind)
    }
    finally { $key.Close() }
    # SetEnvironmentVariable broadcasts WM_SETTINGCHANGE, so Explorer and new terminals see the change.
    try { [Environment]::SetEnvironmentVariable('CLAUDE_ANYWHERE_PATH_REFRESH', $null, 'User') } catch { }
    return $true
  }

  # Node.js 18.17+
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host 'Node.js 18.17 or newer is required, but node.exe was not found. Install it:' -ForegroundColor Red
    Write-Host '  winget install OpenJS.NodeJS.LTS     (or the LTS installer from https://nodejs.org)'
    Write-Host 'Then open a new PowerShell window and run this installer again.'
    throw 'Node.js is missing'
  }
  & node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)"
  if ($LASTEXITCODE -ne 0) {
    $found = (& node --version)
    Write-Host "Node.js 18.17 or newer is required (found $found). Upgrade it: winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor Red
    throw 'Node.js is too old'
  }

  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git -and (Test-Path -LiteralPath (Join-Path $appDir '.git'))) {
    Write-Step "Updating $appDir"
    & git -C $appDir pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not update $appDir (local changes?). Fix it or delete the folder, then retry." }
  }
  elseif ($git) {
    if ((Test-Path -LiteralPath $appDir) -and (Get-ChildItem -LiteralPath $appDir -Force | Select-Object -First 1)) {
      Write-Step "Replacing the previous download in $appDir"
      Remove-Item -LiteralPath $appDir -Recurse -Force
    }
    Write-Step "Downloading Claude Anywhere into $appDir"
    & git clone --quiet --depth 1 --branch $branch $repo $appDir
    if ($LASTEXITCODE -ne 0) { throw "git clone of $repo failed." }
  }
  else {
    Write-Step 'git was not found; downloading the source zip instead'
    $zip = Join-Path ([IO.Path]::GetTempPath()) ("claude-anywhere-" + [Guid]::NewGuid().ToString('N') + '.zip')
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("claude-anywhere-" + [Guid]::NewGuid().ToString('N'))
    try {
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -UseBasicParsing -Uri "$repo/archive/refs/heads/$branch.zip" -OutFile $zip
      Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
      $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
      if (-not $inner) { throw 'The downloaded archive is empty.' }
      if (Test-Path -LiteralPath $appDir) { Remove-Item -LiteralPath $appDir -Recurse -Force }
      Move-Item -LiteralPath $inner.FullName -Destination $appDir
    }
    finally {
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  Write-Step 'Installing the /anywhere skill and MCP tools'
  $cli = Join-Path $appDir 'bin\anywhere.js'
  # The PATH step below makes 'anywhere' available, so the installer does not point at it.
  $prevNoLink = $env:ANYWHERE_NO_LINK
  if ($env:ANYWHERE_NO_PATH -ne '1') { $env:ANYWHERE_NO_LINK = '1' }
  try { & node $cli install @Arguments }
  finally { $env:ANYWHERE_NO_LINK = $prevNoLink }
  if ($LASTEXITCODE -ne 0) { throw "anywhere install failed (exit code $LASTEXITCODE). Run: node `"$cli`" doctor" }

  if ($env:ANYWHERE_NO_PATH -ne '1') {
    $binDir = Join-Path $appDir 'bin'
    try {
      if (Add-UserPathEntry -Dir $binDir) { Write-Host "Added $binDir to your user PATH (open a new terminal to use 'anywhere')." }
    }
    catch {
      Write-Host "Could not add $binDir to your user PATH ($($_.Exception.Message)). Add it in Settings > System > About > Advanced system settings > Environment Variables." -ForegroundColor Yellow
    }
    if (-not (@($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') })) { $env:Path = "$env:Path;$binDir" }
  }

  Write-Host ''
  Write-Host 'Done. Restart Claude Code, then type /anywhere in any project.' -ForegroundColor Green
}

Install-ClaudeAnywhere -Arguments $InstallArgs
