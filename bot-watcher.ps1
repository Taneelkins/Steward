# bot-watcher.ps1
# Runs as a detached background process. Restarts the bot on crash or /updatebot signal.
# Exit codes:
#   0  = clean shutdown (do NOT restart)
#   75 = /updatebot signal (restart immediately with new build)
#   *  = crash (restart after brief delay)

$botDir    = "C:\Users\Taru\Documents\Bot"
$node      = "C:\Program Files\nodejs\node.exe"
$logFile   = "$botDir\logs\watcher.log"
$botLog    = "$botDir\logs\bot.log"
$signalFile = "$botDir\data\restart-signal.json"

function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
    Write-Output $line
}

Log "=== Watcher started (PID $PID) ==="

while ($true) {
    Log "Starting bot..."

    # Redirect bot stdout+stderr to bot.log so we can diagnose crashes
    $proc = Start-Process `
        -FilePath $node `
        -ArgumentList "dist/index.js" `
        -WorkingDirectory $botDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput "$botLog" `
        -RedirectStandardError "$botLog.err" `
        -PassThru

    if (-not $proc) {
        Log "ERROR: Failed to start node process. Retrying in 5s..."
        Start-Sleep -Seconds 5
        continue
    }

    Log "Bot started on PID $($proc.Id)"
    $botStartTime = Get-Date
    $proc.WaitForExit()
    $code = $proc.ExitCode
    $exitTime = Get-Date -Format "o"

    # Merge stderr into bot.log for easy reading
    if (Test-Path "$botLog.err") {
        $errContent = Get-Content "$botLog.err" -Raw -ErrorAction SilentlyContinue
        if ($errContent) {
            Add-Content -Path $botLog -Value "`n--- STDERR ---`n$errContent" -ErrorAction SilentlyContinue
        }
        Remove-Item "$botLog.err" -Force -ErrorAction SilentlyContinue
    }

    Log "Bot exited with code $code"

    if ($code -eq 0) {
        Log "Clean shutdown. Watcher stopping."
        break
    }

    # Write a signal file so the bot knows why it restarted and how long it was down
    if ($code -eq 75) {
        Log "/updatebot signal. Restarting immediately with new build..."
        @{ reason = "update"; exitTime = $exitTime } | ConvertTo-Json | Out-File -FilePath $signalFile -Encoding utf8 -Force
    } else {
        Log "Crash or unexpected exit. Restarting in 3s..."
        Start-Sleep -Seconds 3
        @{ reason = "crash"; exitTime = $exitTime } | ConvertTo-Json | Out-File -FilePath $signalFile -Encoding utf8 -Force
    }
}

Log "=== Watcher stopped ==="
