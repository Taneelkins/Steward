# Self-Hosted Discord Moderation Ledger Bot

This is a local Discord bot for moderation logging, moderator points, strikes, quotas, Ticket Tool transcript checks, backups, and exports.

It does **not** ban, kick, mute, timeout, or punish users. It only records and alerts.

## What Runs On Your PC

- Discord bot process
- Local SQLite database file
- Local backups
- Local exports

No Postgres, Redis, Vercel, cloud server, website, port forwarding, or extra hosted services are required.

## Requirements

- Node.js 24 or newer
- A Discord bot token
- A Discord application client ID
- Your PC must stay awake and connected for the bot to stay online

In the Discord Developer Portal, enable these bot intents:

- Server Members Intent
- Message Content Intent

The bot should have these server permissions:

- View Channels
- Send Messages
- Embed Links
- Attach Files
- Read Message History
- Use Slash Commands
- Manage Channels, Manage Roles, and Manage Messages are needed for `/setup` provisioning
- Administrator is easiest for first setup; after setup, you can reduce the bot role if it can still manage its created roles/channels

## Setup

1. Install packages:

```bash
npm install
```

If npm complains about your home-folder cache, use:

```bash
npm_config_cache=.npm-cache npm install
```

2. Copy `.env.example` to `.env`.

3. Fill in:

```env
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-client-id
```

You do not need a server/guild ID in `.env`. The bot detects the server from each Discord interaction and stores each server's setup separately by guild ID.

4. Register slash commands:

```bash
npm run deploy
```

Deploy clears old global commands and registers one per-server copy for every server the bot is already in. This prevents duplicate global + server commands from showing in Discord.

5. Build and start:

```bash
npm run build
npm start
```

For development, you can run:

```bash
npm run dev
```

## First Server Commands

Run these in Discord:

```text
/setup owner:@you
/update
/log
/quota set
/quota schedule
/action list
/modshop status
/help
```

Only the Discord server owner can run `/setup` and `/update`.

`/setup` can use premade roles/channels if you provide them as options. Anything not provided is created or reused automatically.

`/setup` creates, reuses, or saves:

- Category: `Mod Ledger`
- Roles: `Staff`, `Junior Mod`, `Mod`, `Senior Mod`, `Head Mod`, `Community manager`
- Log channels: `logban`, `logstrike`, `logrestore`, `log-discord`, `logticket`
- Support channels: `case-logs`, `quota-alerts`, `audit-log`, `mod-alerts`, `staff-registration`, `ticket-transcripts`

`/setup` also creates or reuses a `Can register` role. Only users with that role can see and use `/register`.

`/update` is safe to run after bot updates. It checks saved roles/channels, repairs missing or deleted setup items, creates newly required items, and re-applies channel permissions without deleting existing setup.

Command visibility is role-based after `/setup` or `/update` repairs the server:

- Non-staff users see `/help`, `/strikes`, and `/log`. They also see `/points` only in servers where the point system is enabled.
- Users with `Can register` also see `/register`.
- `Junior Mod`, `Mod`, `Senior Mod`, `Head Mod`, and `Community manager` each get their configured command tier.
- `Head Mod` also sees lower staff tiers. `Community manager` sees Community Manager-level commands plus public commands.
- The bot still checks permissions at runtime even if Discord shows a command because of another existing role permission.

Then configure Ticket Tool support if your real Ticket Tool transcript channel is different from the one `/setup` created:

```text
/config channels
/ticketlog map
```

Ticket Tool parsing no longer uses a claim system. It detects transcript details, creates pending ticket logs, and lets staff/admins review or log them without checking who claimed the ticket.

## Important Features

- `/case log` posts a `LOGGED {ACTION_TYPE}` embed.
- Use `/log` for moderation logging. With no fields, it opens a two-step button workflow: choose a log type first, then press `Next` to fill fields or `Cancel` to stop.
- The field screen includes `Target`, `Evidence`, `Info`, `Details`, `Attach Media`, `Submit`, `Back`, and `Cancel`. Discord logs also show `Action Type` because the embed title uses that value.
- Button colors in `/log` are intentional: red field buttons are required and missing, green means submit/success/completed required field, blue opens an editing/media action, grey is optional navigation/details/back, and red `Cancel` stops the draft.
- `Back` returns to the log type picker. Starting another command cancels the old pending log, and inactive drafts expire after 5 minutes.
- The older separate quick-log aliases are intentionally consolidated into `/log` so the Discord command picker stays smaller.
- `/help` opens an embed-and-button guide by moderation level, then command-specific pages with usage, examples, subcommands, and permission notes.
- Logging commands support Discord and Roblox targets with `roblox_user`, `discord_user`, `roblox_id`, and `discord_id`; a pingable Discord user is no longer required.
- For Discord logs, use `/log action:discord action_type:ban` or the `Action Type` button. Whatever you enter there is used in the log embed title, such as `LOGGED BAN`, `LOGGED WARN`, `LOGGED MUTE`, or `LOGGED TIMEOUT`.
- Logging commands support `transcript_link`, which is shown as a `Transcript` button so the long URL is not visible in embeds.
- In the `/log` button workflow, press `Attach Media`, then send image/video/file evidence in the same channel before submitting. The final case log adds clickable buttons like `Image 1` or `Video 1` that open the original Discord message.
- Use `/config channels` to update saved channels without rerunning setup. It supports general channels plus per-action log channels: `logban`, `logstrike`, `logrestore`, `logdiscord`, and `logticket`.
- Use `/config roles` to update Staff, Can register, Community Manager, Head Mod, Senior Mod, Mod, and Junior Mod roles without resetting server setup.
- The point system is enabled by default. Use `/modshop disable` in servers that should only log cases, strikes, and quotas without points. Use `/modshop enable` to bring point commands and point displays back for that server.
- When the point system is disabled, new logs do not award points, log embeds hide point/multiplier fields, point commands are removed from that server, and help pages stop showing point-only commands.
- Action points are configurable with decimals while the point system is enabled:
  - Permanent defaults: `/action upsert name:ban points:5`
  - Temporary override: `/action points name:ban points:5 duration_hours:24 reason:event`
  - Decimal example: `/action points name:ban points:0.5 duration_hours:24 reason:slow day`
  - Clear override: `/action clear-points name:ban reason:done`
- Logs immediately award points when enabled and apply configured strikes.
- If point tracking is enabled and a moderator gains 10 or more points in 15 minutes, the bot posts a Fast Points Review warning in Mod Alerts.
- If a Junior Moderator logs a ban, the ban log pings Senior Moderator and marks that review/completion is required.
- Ban, strike, restore, Discord, and ticket logs route to their matching log channels.
- The default multiplier is automatically at least `1.5x` on Saturdays and Sundays in the configured timezone.
- `/case void` reverses active strikes and any existing ledger entry without deleting history.
- `/quota` snapshots the mod roster each period.
- Below-quota mods can be pinged before quota ends.
- Quota-end pings are sent only in the Mod Alerts channel. Quota reports can still appear in the quota channel without role pings.
- One persistent quota embed is edited with the next Discord timestamp.
- Ticket transcripts create pending ticket logs without claim checks.
- No-action ticket logs count for quota and award reduced points only when point tracking is enabled.
- Overdue ticket logs alert after 12 hours.
- `/backup` writes a local SQLite backup.
- `/export table:cases`, `/export table:quotas`, and `/export table:tickets` create local JSON exports. `points` export is available while point tracking is enabled.

## Local Files

- Database: `data/mod-ledger.sqlite`
- Backups: `backups/`
- Exports: `exports/`

These stay on your PC.

## If The PC Was Offline

When the bot starts again, it catches up on:

- Missed quota checks
- Expired multipliers
- Expired LOA/quota exemptions
- Overdue ticket logs
- Recent Ticket Tool transcript messages since the last saved transcript message

## Checks

```bash
npm run build
npm test
```

Node currently prints an experimental SQLite warning during tests. That warning comes from Node's built-in SQLite module and does not prevent the bot from running.
