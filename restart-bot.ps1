# restart-bot.ps1
# Kills any running bot and watcher, then launches a fresh detached watcher.
# Posts a "going down" embed to each shouts channel via the Discord API,
# then edits it to "back online" once the bot restarts.

$botDir    = "C:\Users\Taru\Documents\Bot"
$node      = "C:\Program Files\nodejs\node.exe"
$dataDir   = "$botDir\data"
$signalFile = "$dataDir\restart-signal.json"
$shoutsFile = "$dataDir\shouts-channels.json"

# ── Read bot token from .env ──────────────────────────────────────────────────
$botToken = $null
if (Test-Path "$botDir\.env") {
    $envLines = Get-Content "$botDir\.env" -ErrorAction SilentlyContinue
    foreach ($line in $envLines) {
        if ($line -match "^DISCORD_TOKEN=(.+)$") {
            $botToken = $Matches[1].Trim()
            break
        }
    }
}

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

# ── Post "going down" embed and build signal file ─────────────────────────────
$exitTime = (Get-Date).ToUniversalTime().ToString("o")
$postedMessages = @()

if ($botToken -and (Test-Path $shoutsFile)) {
    $shoutsChannels = @()
    try {
        $shoutsChannels = Get-Content $shoutsFile -Raw | ConvertFrom-Json
    } catch {
        Write-Output "WARNING: Could not read shouts-channels.json — skipping going-down message."
    }

    foreach ($entry in $shoutsChannels) {
        $channelId = $entry.channelId
        if (-not $channelId) { continue }

        $embedBody = @{
            embeds = @(
                @{
                    title       = "🔄 Steward Restarting"
                    description = "Going down for an update. Back online shortly."
                    color       = 10181046
                    timestamp   = $exitTime
                }
            )
        } | ConvertTo-Json -Depth 6 -Compress

        try {
            $response = Invoke-RestMethod `
                -Uri "https://discord.com/api/v10/channels/$channelId/messages" `
                -Method POST `
                -Headers @{ "Authorization" = "Bot $botToken"; "Content-Type" = "application/json" } `
                -Body $embedBody `
                -ErrorAction Stop
            $postedMessages += @{ channelId = $channelId; messageId = $response.id }
            Write-Output "Posted going-down message to channel $channelId (msg $($response.id))"
        } catch {
            Write-Output "WARNING: Could not post going-down message to channel $channelId`: $_"
        }
    }
} else {
    if (-not $botToken)            { Write-Output "WARNING: DISCORD_TOKEN not found in .env — skipping going-down message." }
    if (-not (Test-Path $shoutsFile)) { Write-Output "WARNING: shouts-channels.json not found — skipping going-down message." }
}

# Write signal file (with message IDs if we posted anything)
$signal = @{ reason = "update"; exitTime = $exitTime }
if ($postedMessages.Count -gt 0) {
    $signal.messages = $postedMessages
}
$signal | ConvertTo-Json -Depth 5 | Out-File -FilePath $signalFile -Encoding utf8 -Force
Write-Output "Restart signal written."

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
