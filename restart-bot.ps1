# restart-bot.ps1
# Kills existing bot, starts a background watcher loop.
# Exit 0 = clean shutdown. Exit 75 = /updatebot signal (restart). Anything else = crash restart.

$botDir = "C:\Users\Taru\Documents\Bot"
$node   = "C:\Program Files\nodejs\node.exe"

# Kill existing bot process
$existing = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*dist/index*" -and $_.Name -eq "node.exe" }
foreach ($p in $existing) {
    Write-Output "Stopping PID $($p.ProcessId)..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# Remove any old watcher job
Get-Job -Name "BotWatcher" -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

# Watcher loop in a background job
$job = Start-Job -Name "BotWatcher" -ScriptBlock {
    param($node, $botDir)
    while ($true) {
        $proc = Start-Process -FilePath $node -ArgumentList "dist/index.js" -WorkingDirectory $botDir -WindowStyle Hidden -PassThru
        $proc.WaitForExit()
        $code = $proc.ExitCode
        if ($code -eq 0) {
            Write-Output "Bot stopped cleanly."
            break
        }
        if ($code -eq 75) {
            Write-Output "Restarting after /updatebot..."
        } else {
            Write-Output "Bot crashed (exit $code). Restarting in 2s..."
            Start-Sleep -Seconds 2
        }
    }
} -ArgumentList $node, $botDir

Start-Sleep -Seconds 5

$botUp = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*dist/index*" -and $_.Name -eq "node.exe" }

if ($botUp) {
    Write-Output "Bot running on PID $($botUp.ProcessId), watcher job $($job.Id) active."
} else {
    Write-Output "ERROR: Bot did not start. Check logs/pm2-error.log"
    exit 1
}
