# restart-bot.ps1
# Kills any running bot and watcher, then launches a fresh detached watcher.
# The watcher runs as a standalone powershell.exe process - it survives this
# session exiting and automatically restarts the bot on crash or /updatebot.

$botDir = "C:\Users\Taru\Documents\Bot"

# Kill existing bot process
$botProcs = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*dist/index*" -and $_.Name -eq "node.exe" }
foreach ($p in $botProcs) {
    Write-Output "Stopping bot PID $($p.ProcessId)..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# Kill existing watcher process
$watcherProcs = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*bot-watcher*" -and $_.Name -eq "powershell.exe" }
foreach ($p in $watcherProcs) {
    Write-Output "Stopping watcher PID $($p.ProcessId)..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# Launch watcher as a fully detached powershell process.
# -NoProfile -NonInteractive keeps it lean; -WindowStyle Hidden keeps it invisible.
# This process outlives the current session - it is NOT a background job.
Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", "`"$botDir\bot-watcher.ps1`"" `
    -WorkingDirectory $botDir `
    -WindowStyle Hidden

Start-Sleep -Seconds 5

# Confirm the bot came up
$botUp = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*dist/index*" -and $_.Name -eq "node.exe" }
$watcherUp = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*bot-watcher*" -and $_.Name -eq "powershell.exe" }

if ($botUp) {
    $watcherPid = if ($watcherUp) { $watcherUp.ProcessId } else { "unknown" }
    Write-Output "Bot running on PID $($botUp.ProcessId). Watcher running on PID $watcherPid."
} else {
    Write-Output "ERROR: Bot did not start. Check logs\watcher.log for details."
    exit 1
}
