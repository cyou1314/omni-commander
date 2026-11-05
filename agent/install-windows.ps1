# Can agent installer for Windows.
# Run from the folder that contains agent.js:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
# It installs the agent into %USERPROFILE%\can-agent, creates the work
# folder %USERPROFILE%\can-work, asks for the agent key once, and registers
# a logon scheduled task that keeps the agent running.
param(
  [string]$Gateway = "https://unpaid-reiterate-sacred.ngrok-free.dev",
  [string]$CuaPath = "cua-driver"
)

$ErrorActionPreference = "Stop"
$AgentDir = Join-Path $env:USERPROFILE "can-agent"
$WorkDir  = Join-Path $env:USERPROFILE "can-work"

# 1) Node.js is required.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js was not found on PATH. Install the LTS build from https://nodejs.org and run this script again." -ForegroundColor Red
  exit 1
}
Write-Host "Node: $(node -v)"

# 2) Folders and agent code.
New-Item -ItemType Directory -Force -Path $AgentDir, $WorkDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot "agent.js") -Destination $AgentDir -Force
Write-Host "Agent installed to $AgentDir ; work folder $WorkDir"

# 3) Config (only when missing, so re-running the installer keeps settings).
$CfgPath = Join-Path $AgentDir "config.json"
if (-not (Test-Path $CfgPath)) {
  $key = Read-Host "Paste the Can agent key (same key the gateway uses)"
  $cfg = [ordered]@{
    gateway  = $Gateway
    agentKey = $key
    agentId  = "win-1"
    name     = "Can agent (Windows)"
    workRoot = $WorkDir
    cuaPath  = $CuaPath
    fence    = @{ confirmRun = $false; confirmEgo = $false; confirmDesktop = $false; dialogTimeoutS = 60; trustWindowMin = 0 }
  }
  ($cfg | ConvertTo-Json -Depth 4) | Set-Content -Path $CfgPath -Encoding UTF8
  Write-Host "Wrote $CfgPath"
} else {
  Write-Host "Keeping existing $CfgPath"
}

# 4) Logon scheduled task with restart-on-failure.
$action  = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$AgentDir\agent.js`"" -WorkingDirectory $AgentDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Can Agent" -Action $action -Trigger $trigger -Settings $settings -Description "Can agent (omni-commander): connects this PC to the Can gateway." -Force | Out-Null
Start-ScheduledTask -TaskName "Can Agent"
Start-Sleep -Seconds 5

# 5) Report.
$status = Join-Path $AgentDir "status.json"
if (Test-Path $status) {
  Write-Host "status.json:"; Get-Content $status
} else {
  Write-Host "status.json not written yet - check $AgentDir\agent.log" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Install Cua Driver for Windows and make sure 'cua-driver' is on PATH"
Write-Host "     (or set cuaPath in config.json to its full path), then restart the task:"
Write-Host "     Stop-ScheduledTask -TaskName 'Can Agent'; Start-ScheduledTask -TaskName 'Can Agent'"
Write-Host "  2. The desktop layer needs the Cua accessibility/screen permissions granted."
Write-Host "  3. Only ONE agent (Mac or Windows) should be connected to the gateway at a time."
