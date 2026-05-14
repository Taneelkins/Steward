# bot-watcher.ps1
# Runs as a detached background process. Restarts the bot on crash or /updatebot signal.
# Exit codes:
#   0  = clean shutdown (do NOT restart)
#   75 = /updatebot signal (restart immediately with new build)
#   *  = crash (restart after brief delay)

$botDir  = "C:\Users\Taru\Documents\Bot"
$node    = "C:\Program Files\nodejs\node.exe"
$logFile = "$botDir\logs\watcher.log"

function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
    Write-Output $line
}

Log "=== Watcher started (PID $PID) ==="

while ($true) {
    Log "Starting bot..."

    $proc = Start-Process `
        -FilePath $node `
        -ArgumentList "dist/index.js" `
        -WorkingDirectory $botDir `
        -WindowStyle Hidden `
        -PassThru

    if (-not $proc) {
        Log "ERROR: Failed to start node process. Retrying in 5s..."
        Start-Sleep -Seconds 5
        continue
    }

    Log "Bot started on PID $($proc.Id)"
    $proc.WaitForExit()
    $code = $proc.ExitCode

    Log "Bot exited with code $code"

    if ($code -eq 0) {
        Log "Clean shutdown. Watcher stopping."
        break
    }

    if ($code -eq 75) {
        Log "/updatebot signal. Restarting immediately with new build..."
    } else {
        Log "Crash or unexpected exit. Restarting in 3s..."
        Start-Sleep -Seconds 3
    }
}

Log "=== Watcher stopped ==="
