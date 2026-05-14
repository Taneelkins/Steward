# restart-bot.ps1
# Kills any running bot and watcher, then launches a fresh detached watcher.
# Runs going-down.js first to post a "restarting" embed and capture message IDs,
# then edits it to "back online" once the bot comes back up.

$botDir     = "C:\Users\Taru\Documents\Bot"
$node       = "C:\Program Files\nodejs\node.exe"
$dataDir    = "$botDir\data"
$signalFile = "$dataDir\restart-signal.json"

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

Start-Sleep -Seconds 2

# ── Post "going down" embed via Node.js (writes restart-signal.json) ──────────
Write-Output "Posting going-down announcement..."
$goingDownProc = Start-Process `
    -FilePath $node `
    -ArgumentList "dist/going-down.js" `
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
