# restart-bot.ps1 [UpdateNotes]
# Kills any running bot and watcher, then launches a fresh detached watcher.
# Runs going-down.js first to post a "restarting" embed and capture message IDs,
# then edits it to "back online" once the bot comes back up.
#
# Optional: pass a brief changelog as the first argument.
# Example: .\restart-bot.ps1 "Fixed double uploading, fixed autopunish display"

param(
    [string]$UpdateNotes = ""
)

$botDir     = "C:\Users\Taru\Documents\Bot"
$node       = "C:\Program Files\nodejs\node.exe"
$dataDir    = "$botDir\data"
$signalFile = "$dataDir\restart-signal.json"
$pm2BotPidFile = "$env:USERPROFILE\.pm2\pids\steward-bot-0.pid"

# ── Kill existing bot process ─────────────────────────────────────────────────
$botProcs = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*dist/index*" -and $_.Name -eq "node.exe" }
foreach ($p in $botProcs) {
    Write-Output "Stopping bot PID $($p.ProcessId)..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# ── Kill existing watcher process ─────────────────────────────────────────────
$watcherProcs = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*bot-watcher*" -and $_.Name -eq "powershell.exe" }
foreach ($p in $watcherProcs) {
    Write-Output "Stopping watcher PID $($p.ProcessId)..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

if (Test-Path $pm2BotPidFile) {
    $pm2BotPid = (Get-Content $pm2BotPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($pm2BotPid -and (Get-Process -Id $pm2BotPid -ErrorAction SilentlyContinue)) {
        Write-Output "PM2 steward-bot is already running on PID $pm2BotPid. Not launching a duplicate watcher bot."
        Write-Output "Stop PM2 steward-bot first if you want restart-bot.ps1 to take over."
        exit 0
    }
}

Start-Sleep -Seconds 2

# ── Write update notes to a file so going-down.js can read them intact ────────
$pendingNotesFile = "$dataDir\pending-update-notes.txt"
if ($UpdateNotes -ne "") {
    Set-Content -Path $pendingNotesFile -Value $UpdateNotes -Encoding utf8
} elseif (Test-Path $pendingNotesFile) {
    Remove-Item $pendingNotesFile -Force -ErrorAction SilentlyContinue
}

# ── Post "going down" embed via Node.js (writes restart-signal.json) ──────────
Write-Output "Posting going-down announcement..."
$goingDownProc = Start-Process `
    -FilePath $node `
    -ArgumentList @("dist/going-down.js") `
    -WorkingDirectory $botDir `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
if ($goingDownProc.ExitCode -ne 0) {
    Write-Output "WARNING: going-down.js exited with code $($goingDownProc.ExitCode) - announcement may not have posted."
} else {
    Write-Output "Going-down announcement done."
}

# ── Deploy slash commands ─────────────────────────────────────────────────────
Write-Output "Deploying slash commands..."
$deployProc = Start-Process `
    -FilePath $node `
    -ArgumentList "dist/deploy-commands.js" `
    -WorkingDirectory $botDir `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
if ($deployProc.ExitCode -ne 0) {
    Write-Output "WARNING: deploy-commands exited with code $($deployProc.ExitCode) - commands may not be updated."
} else {
    Write-Output "Slash commands deployed successfully."
}

# ── Launch watcher ────────────────────────────────────────────────────────────
Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", "`"$botDir\bot-watcher.ps1`"" `
    -WorkingDirectory $botDir `
    -WindowStyle Hidden

Start-Sleep -Seconds 5

# ── Confirm bot came up ───────────────────────────────────────────────────────
$botUp     = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*dist/index*" -and $_.Name -eq "node.exe" }
$watcherUp = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*bot-watcher*" -and $_.Name -eq "powershell.exe" }

if ($botUp) {
    $watcherPid = if ($watcherUp) { $watcherUp.ProcessId } else { "unknown" }
    Write-Output "Bot running on PID $($botUp.ProcessId). Watcher running on PID $watcherPid."
} else {
    Write-Output "ERROR: Bot did not start. Check logs\watcher.log for details."
    exit 1
}
