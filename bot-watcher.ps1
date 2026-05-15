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
$pm2BotPidFile = "$env:USERPROFILE\.pm2\pids\steward-bot-0.pid"

function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
    Write-Output $line
}

Log "=== Watcher started (PID $PID) ==="

if (Test-Path $pm2BotPidFile) {
    $pm2BotPid = (Get-Content $pm2BotPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($pm2BotPid -and (Get-Process -Id $pm2BotPid -ErrorAction SilentlyContinue)) {
        Log "PM2 steward-bot is already running on PID $pm2BotPid. Watcher will not start a duplicate bot."
        Log "=== Watcher stopped ==="
        exit 0
    }
}

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

    # Write a signal file so the bot knows why it restarted and how long it was down.
    # If a signal already exists with updateNotes pre-written (e.g. by Claude before a manual
    # restart), preserve that content and just add/update exitTime rather than overwriting.
    if ($code -eq 75) {
        Log "/updatebot signal. Restarting immediately with new build..."
        $existing = $null
        if (Test-Path $signalFile) {
            try { $existing = Get-Content $signalFile -Raw | ConvertFrom-Json } catch {}
        }
        if ($existing -and $existing.updateNotes) {
            # Preserve pre-written signal — just stamp the exit time
            $existing | Add-Member -Force -NotePropertyName "exitTime" -NotePropertyValue $exitTime
            $existing | Add-Member -Force -NotePropertyName "reason" -NotePropertyValue "update"
            $existing | ConvertTo-Json | Out-File -FilePath $signalFile -Encoding utf8 -Force
        } else {
            @{ reason = "update"; exitTime = $exitTime } | ConvertTo-Json | Out-File -FilePath $signalFile -Encoding utf8 -Force
        }
    } else {
        Log "Crash or unexpected exit. Restarting in 3s..."
        Start-Sleep -Seconds 3
        # If a signal with updateNotes was pre-written before this restart, honour it
        # (treat as an update restart, not a crash — Claude pre-wrote the notes and
        # then triggered the restart by killing the process directly).
        $existing = $null
        if (Test-Path $signalFile) {
            try { $existing = Get-Content $signalFile -Raw | ConvertFrom-Json } catch {}
        }
        if ($existing -and $existing.updateNotes) {
            $existing | Add-Member -Force -NotePropertyName "exitTime" -NotePropertyValue $exitTime
            $existing | Add-Member -Force -NotePropertyName "reason" -NotePropertyValue "update"
            $existing | ConvertTo-Json | Out-File -FilePath $signalFile -Encoding utf8 -Force
        } else {
            @{ reason = "crash"; exitTime = $exitTime } | ConvertTo-Json | Out-File -FilePath $signalFile -Encoding utf8 -Force
        }
    }
}

Log "=== Watcher stopped ==="
