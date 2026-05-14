import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { canUseAccess } from "../utils/discord.js";
import { truncate } from "../utils/format.js";
const levels = [
    { id: "junior", label: "Junior Moderator", description: "Public tools, basic staff tools, and logging." },
    { id: "moderator", label: "Moderator", description: "Moderator tools plus case history." },
    { id: "senior", label: "Senior Moderator", description: "Moderator tools plus senior review expectations." },
    { id: "admin", label: "Admin", description: "Head Mod, Community Manager, and owner setup tools." }
];
const helpCommands = [
    {
        id: "log",
        label: "/log",
        access: "public",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Starts the moderation log workflow or submits a typed fallback log.",
        who: "Visible to everyone based on your server rules.",
        usage: ["`/log` opens the button flow.", "`/log action:ban ...` submits with typed fields as a fallback."],
        subcommands: [
            "Button flow: choose log type -> Next -> fill fields -> Submit.",
            "Fields: Target, Evidence, Info, Details, Attach Media. Discord logs also require Action Type.",
            "Typed fields: action, action_type, roblox_user, discord_user, roblox_id, discord_id, reason, evidence, notes, no_action, ticket_id, transcript_link."
        ],
        examples: ["`/log`", "`/log action:discord action_type:timeout discord_id:123 reason:Rule break evidence:Clip`"],
        notes: [
            "First screen only shows log type buttons. After choosing a type, use Next to open fields or Cancel to stop.",
            "Red field buttons are required and still missing. Green means submit/success/completed required fields. Blue opens an editing action. Grey is optional navigation/details/back. Red Cancel stops the draft.",
            "Back returns to the log type picker. Submit creates the case. Inactive drafts expire after 5 minutes, and starting another command cancels the old draft.",
            "Attach Media turns on evidence capture; send image/video/file evidence in the same channel before Submit. Attachments are archived immediately as you upload them — you will see Archiving N/N progress in the preview.",
            "Non Ticket Action toggle appears on Discord logs. Enable it if the action didn't come from a ticket so a transcript link isn't required.",
            "Discord Warn logs show a Warning History field with how many prior warnings that target has on record. Use Execute Punishment to deliver the warning — the bot DMs them their warning number and reason.",
            "Ingame flow: choose Exploiter (straight to proof → ban log) or Rule Break → Approved/Denied → Ban result → logs with colour.",
            "Junior Mod logs go to the junior help channel for review instead of the log channel directly. A mod must approve or deny. On deny, the junior mod is DM'd with the reason and can run /log to edit and resubmit."
        ]
    },
    {
        id: "logedit",
        label: "/logedit",
        access: "public",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Edit a previously submitted case log using the interactive logger without affecting quota or points.",
        who: "All staff. Mods can only edit their own cases; admins can edit any case.",
        usage: ["`/logedit case_id:42`"],
        examples: ["`/logedit case_id:42`"],
        notes: [
            "Opens the interactive logger pre-filled with all existing case details — edit what you need, then Submit.",
            "Editing does not create a new quota entry or change points. It updates the existing case in-place.",
            "Target info (Discord ID, Roblox username, etc.) is fully rewritten on save, so Execute Punishment will use the corrected person.",
            "If the case has a Discord Execute Punishment button, it reappears after editing with the updated target.",
            "Admins can edit any case. Mods can only edit their own."
        ]
    },
    {
        id: "points",
        label: "/points",
        access: "public",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Shows personal points, another user's points, leaderboards, or admin adjustments.",
        who: "Public for viewing. `/points adjust` is Head Mod-level.",
        usage: ["`/points me`", "`/points user moderator:@user`", "`/points leaderboard`", "`/points adjust moderator:@user amount:1 reason:...`"],
        examples: ["`/points me`", "`/points adjust moderator:@Mod amount:-0.5 reason:Correction`"],
        notes: ["Point amounts support decimals.", "Fast point gain warnings are sent to admin/mod alerts."],
        requiresPoints: true
    },
    {
        id: "strikes",
        label: "/strikes",
        access: "public",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Shows active strike records for a Discord user.",
        who: "Public command.",
        usage: ["`/strikes target:@user`"],
        examples: ["`/strikes target:@User`"],
        notes: ["Roblox-only strike history is stored in case logs; this lookup uses a Discord target."]
    },
    {
        id: "register",
        label: "/register",
        access: "register",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Registers a staff member and gives them the configured Staff role.",
        who: "Only users with the Can register role.",
        usage: ["`/register`"],
        examples: ["`/register`"],
        notes: ["Registration is server-specific."]
    },
    {
        id: "bot",
        label: "/bot",
        access: "junior",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Shows bot health, database path, point-system state, quota state, and ticket watcher state.",
        who: "Junior Moderator and above.",
        usage: ["`/bot`"],
        examples: ["`/bot`"],
        notes: ["Useful after setup, updates, and restarts."]
    },
    {
        id: "staff",
        label: "/staff",
        access: "junior",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Shows a staff profile with logged actions and review flags.",
        who: "Junior Moderator and above.",
        usage: ["`/staff moderator:@user`"],
        examples: ["`/staff moderator:@Mod`"],
        notes: ["Staff data is server-specific."]
    },
    {
        id: "multiplier-view",
        label: "/multiplier view",
        access: "junior",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Shows the active point multiplier.",
        who: "Junior Moderator and above.",
        usage: ["`/multiplier view`"],
        examples: ["`/multiplier view`"],
        notes: ["Weekend multiplier is automatic when active."],
        requiresPoints: true
    },
    {
        id: "ingameban",
        label: "/ingameban",
        access: "normal",
        levels: ["moderator", "senior", "admin"],
        what: "Bans a player from the configured Roblox experience via the Open Cloud API and creates a case log automatically.",
        who: "Moderator and above.",
        usage: ["`/ingameban roblox_user:<username> reason:<reason>`", "`/ingameban roblox_user:<username> reason:<reason> duration:7 days game:MyGame`"],
        examples: ["`/ingameban roblox_user:PlayerXYZ reason:Exploiting`", "`/ingameban roblox_user:Player reason:Harassing others duration:3 days`"],
        notes: [
            "Duration defaults to permanent if omitted. Accepts natural language: `7 days`, `24h`, `permanent`.",
            "If only one game is configured, `game` is optional. If multiple games are set up, you must specify which one.",
            "The ban is executed immediately via the Roblox Open Cloud API — the player cannot join until the ban expires or is removed with `/ingameunban`.",
            "A case log is created automatically in the ingame log channel. No need to run /log separately.",
            "`exclude_alts:true` also restricts known Roblox alt accounts.",
            "An admin must first run `/roblox add` to configure the game before bans will work.",
            "**Auto-ban from `/log`:** Logging an Ingame action via `/log` will also auto-execute the Roblox ban if the target's Roblox username/ID is filled in. Normal/head mods ban immediately; junior mod bans execute after senior review approval.",
            "**Auto-unban from `/log`:** Logging an accepted Ingame Ban appeal via `/log` will auto-unban the player in-game."
        ]
    },
    {
        id: "ingameunban",
        label: "/ingameunban",
        access: "head",
        levels: ["admin"],
        what: "Manually removes an active Roblox ban for a player in the configured experience.",
        who: "Head Mod and above.",
        usage: ["`/ingameunban roblox_user:<username>`"],
        examples: ["`/ingameunban roblox_user:PlayerXYZ`"],
        notes: [
            "Unbans via this command are not automatically logged as cases — check audit for the action.",
            "For appeal-based unbans, log the appeal via `/log` with result: Accepted and type: Ingame Ban — the unban executes automatically."
        ]
    },
    {
        id: "roblox",
        label: "/roblox",
        access: "head",
        levels: ["admin"],
        what: "Opens the Roblox game management panel. Add, remove, or set a default game for in-game ban enforcement — all through buttons and a form, no typed commands needed.",
        who: "Head Mod and above.",
        usage: ["`/roblox`"],
        subcommands: ["Panel buttons: ➕ Add Game (form popup), 🗑️ Remove, ⭐ Set Default"],
        examples: ["`/roblox`"],
        notes: [
            "Click **➕ Add Game** to fill in Universe ID, API Key, and a friendly name in a popup form.",
            "Each game shows **🗑️ Remove** and (if multiple games) **Set Default** buttons — click to act instantly, panel refreshes.",
            "Universe ID: open your experience on create.roblox.com — the number in the URL is the ID.",
            "API Key: create at create.roblox.com/settings/credentials. Select **User API key**. Enable **User Restrictions → Write** and **Messaging Service → Publish**, scoped to your universe.",
            "If only one game is configured it is used automatically. If multiple, use Set Default to pick which one is used for auto-execution from `/log`.",
            "API keys are stored locally in the bot database — treat it as sensitive.",
            "To update a key, add the same Universe ID again — it overwrites."
        ]
    },
    {
        id: "autopunish",
        label: "/autopunish",
        access: "head",
        levels: ["admin"],
        what: "Opens a panel to view and toggle automatic punishment execution for different log types.",
        who: "Head Mod and above.",
        usage: ["`/autopunish`"],
        subcommands: ["Panel buttons: Enable/Disable Ingame Bans, Ingame Unbans, Discord Actions"],
        examples: ["`/autopunish`"],
        notes: [
            "**Ingame Bans** — controls whether ingame ban logs auto-execute the Roblox ban. Disable if you want to manage bans manually.",
            "**Ingame Unbans** — controls whether accepted ingame ban appeal logs auto-execute the in-game unban.",
            "**Discord Actions** — controls whether the ⚡ Execute Punishment button appears on discord action / appeal logs.",
            "All three are enabled by default. Toggling is instant and reflected immediately in the panel.",
            "Useful if you want to pause all auto-enforcement temporarily (e.g. during a bot API key rotation) without losing case log data."
        ]
    },
    {
        id: "lookup",
        label: "/lookup",
        access: "normal",
        levels: ["moderator", "senior", "admin"],
        what: "Searches all case logs for a specific target by Roblox username, Discord username, Roblox ID, or Discord ID.",
        who: "Moderator and above.",
        usage: ["`/lookup roblox_user:TestUser`", "`/lookup discord_id:123456789`", "`/lookup roblox_id:456789 discord_user:TestUser`"],
        examples: ["`/lookup roblox_user:TestUser`", "`/lookup discord_id:123456789012345678`"],
        notes: [
            "Username fields use partial matching. ID fields are exact.",
            "Returns up to 20 most recent matching cases.",
            "Shows all case statuses including voided and pending cases."
        ]
    },
    {
        id: "case",
        label: "/case",
        access: "normal",
        levels: ["moderator", "senior", "admin"],
        what: "Legacy/manual case tools, case lookup by ID, and case history.",
        who: "Moderator and above for history and review. Edit/void is Head Mod-level.",
        usage: ["`/case review case_id:42`", "`/case history user target:@user`", "`/case history mod moderator:@user`", "`/case edit ...`", "`/case void ...`"],
        subcommands: ["log, edit, void, review, history user, history mod"],
        examples: ["`/case review case_id:42`", "`/case history mod moderator:@Mod`", "`/case void case_id:12 reason:Duplicate`"],
        notes: [
            "Prefer `/log` for new logs. Edits and voids preserve audit history.",
            "`/case review` shows the full case embed — action, target, reason, evidence, status, and any void/approval/review flags.",
            "Case IDs appear on every log embed footer (Case #N)."
        ]
    },
    {
        id: "warnings",
        label: "/warnings",
        access: "normal",
        levels: ["moderator", "senior", "admin"],
        what: "Shows the full warning history for a Discord user — warning number, reason, issuing moderator, and timestamp.",
        who: "Moderator and above.",
        usage: ["`/warnings target:@user`"],
        examples: ["`/warnings target:@User`"],
        notes: [
            "Warnings are recorded when Execute Punishment is clicked on a Discord Warn log.",
            "Shows the 10 most recent warnings with sequential numbering. Total count is shown in the title.",
            "Use `/lookup` to find cases by Roblox username or other identifiers."
        ]
    },
    {
        id: "action",
        label: "/action",
        access: "head",
        levels: ["admin"],
        what: "Manages action presets, evidence requirements, default strikes, whether actions are enabled, and point values when points are enabled.",
        who: "Head Mod-level.",
        usage: ["`/action list`", "`/action upsert ...`", "`/action disable name:...`", "`/action points ...` when points are enabled"],
        subcommands: ["list, upsert, disable", "points and clear-points appear only when `/modshop` point tracking is enabled"],
        examples: ["`/action upsert name:warning default_strikes:1 evidence_required:true`", "`/action points name:ban points:5 duration_hours:24 reason:Event`"],
        notes: ["Permanent action defaults use `/action upsert`.", "Point-only options are hidden when `/modshop disable` is active."]
    },
    {
        id: "multiplier",
        label: "/multiplier",
        access: "head",
        levels: ["admin"],
        what: "Sets, clears, or views the global point multiplier.",
        who: "View is Junior Moderator and above. Set/clear is Head Mod-level.",
        usage: ["`/multiplier set value:1.5 reason:... ends_at:...`", "`/multiplier clear reason:...`", "`/multiplier view`"],
        examples: ["`/multiplier set value:2 reason:Weekend event ends_at:2026-05-10T23:59:00-04:00`"],
        notes: ["Expired multipliers are cleaned up on startup/recovery."],
        requiresPoints: true
    },
    {
        id: "modshop",
        label: "/modshop",
        access: "community",
        levels: ["admin"],
        what: "Enables or disables the point system for this server.",
        who: "Community Manager-level.",
        usage: ["`/modshop status`", "`/modshop disable`", "`/modshop enable`"],
        subcommands: ["status, enable, disable"],
        examples: ["`/modshop disable`"],
        notes: ["When disabled, point commands are removed from this server and new logs do not award points."]
    },
    {
        id: "quota",
        label: "/quota",
        access: "head",
        levels: ["admin"],
        what: "Manages quota requirements, schedules, reports, exemptions, and leaderboards.",
        who: "Head Mod-level for management. Personal/status views follow configured access.",
        usage: ["`/quota set required_logs:5`", "`/quota schedule day:Sunday time:21:00 timezone:America/New_York`", "`/quota status`"],
        subcommands: ["set, role-set, role-remove, schedule, end-now, check-now, me, enable, disable, history, status, leaderboard, exempt add/remove/list"],
        examples: ["`/quota exempt add moderator:@Mod reason:LOA expires_at:2026-06-01`", "`/quota leaderboard`"],
        notes: ["Quota period-end pings only the Community Manager role. Warning pings go to individuals who are below quota.", "Reports stay server-specific."]
    },
    {
        id: "ticketlog",
        label: "/ticketlog",
        access: "head",
        levels: ["admin"],
        what: "Reviews pending Ticket Tool transcript logs and ticket mappings.",
        who: "Head Mod-level.",
        usage: ["`/ticketlog pending`", "`/ticketlog dismiss pending_id:1 reason:...`", "`/ticketlog map ticket_type:support action:ticket`"],
        subcommands: ["pending, dismiss, check-now, map"],
        examples: ["`/ticketlog pending`", "`/ticketlog dismiss pending_id:3 reason:Already logged`"],
        notes: ["There is no ticket claim system. The bot no longer checks who claimed a ticket."]
    },
    {
        id: "audit",
        label: "/audit",
        access: "head",
        levels: ["admin"],
        what: "Shows recent bot audit events.",
        who: "Head Mod-level.",
        usage: ["`/audit limit:10`"],
        examples: ["`/audit limit:25`"],
        notes: ["Audit records are local and server-specific."]
    },
    {
        id: "edit",
        label: "/edit",
        access: "community",
        levels: ["admin"],
        what: "Directly edit a player's in-game datastore stat in real-time via MessagingService.",
        who: "Community Manager only.",
        usage: ["`/edit roblox_user:<username> stat:<path> value:<value>`"],
        examples: [
            "`/edit roblox_user:PlayerXYZ stat:Stats.Elo value:500`",
            "`/edit roblox_user:PlayerXYZ stat:Player.Clan value:Warriors`",
            "`/edit roblox_user:PlayerXYZ stat:Stats.StrikingPower value:100`"
        ],
        notes: [
            "**The player must be online in the game** — the edit is sent via MessagingService which only reaches active servers. It has no effect if the player is offline.",
            "Use dot-notation for the stat path matching the DataManager template, e.g. `Stats.Elo`, `Player.Clan`, `Stats.Stamina`.",
            "Values are auto-typed: numbers stay numbers, `true`/`false` become booleans, everything else is a string.",
            "The action is logged to the audit channel.",
            "Available stat paths (from the data template): `Stats.Elo`, `Stats.Stamina`, `Stats.Durability`, `Stats.RunningSpeed`, `Stats.Height`, `Stats.Fat`, `Stats.StrikingPower`, `Stats.StrikingSpeed`, `Stats.LowerBodyMuscle`, `Stats.UpperBodyMuscle`, `Player.Clan`, `Player.FirstName`, `Player.Gender`, `Player.Title`, `LastHealth`, `LastStamina`, `LastStomach`."
        ]
    },
    {
        id: "loa",
        label: "/loa",
        access: "junior",
        levels: ["junior", "moderator", "senior", "admin"],
        what: "Submit a Leave of Absence request for Head Mod review.",
        who: "Junior Moderator and above.",
        usage: ["`/loa request reason:<reason> duration:<duration>`"],
        examples: [
            "`/loa request reason:Personal trip duration:1 week`",
            "`/loa request reason:Burnout duration:2 weeks`",
            "`/loa request reason:Vacation duration:permanent`"
        ],
        notes: [
            "The request is posted to the configured LOA approval channel with Approve and Deny buttons for Head Mods.",
            "Duration accepts natural language: `3 days`, `1 week`, `2 weeks`, `permanent`, `indefinite`, etc.",
            "If approved, you are automatically exempt from quota requirements for the duration and receive a DM confirmation.",
            "If denied, you receive a DM letting you know. Contact a Head Mod if you have questions.",
            "A Head Mod or above must approve the request — it is not instant.",
            "The approval channel must be configured by an admin via `/config channels loa_channel:#channel`.",
            "LOA approvals are also posted to a separate log channel if configured via `/config channels loa_log_channel:#channel`."
        ]
    },
    {
        id: "config",
        label: "/config",
        access: "community",
        levels: ["admin"],
        what: "Manually updates saved roles, channels, and behavior settings.",
        who: "Community Manager-level.",
        usage: ["`/config roles ...`", "`/config channels ...`", "`/config behavior interactive_log:true`"],
        subcommands: [
            "roles: staff_role, can_register_role, community_manager_role, head_mod_role, senior_mod_role, normal_mod_role, junior_mod_role, junior_escalation_role, junior_other_escalation_role",
            "channels: actions (fallback), alerts, audit, quota, quota_alerts, staff_registration, ticket_transcripts, approval_channel, junior_help, steward_log, logingame, logstrike, logrestore, logdiscord, logticket, logappeal, evidence_archive",
            "behavior: interactive_log, cm_approval, points_enabled, quota_enabled"
        ],
        examples: ["`/config channels logingame:#log-ingame logdiscord:#log-discord alerts:#mod-alerts junior_help:#junior-review`", "`/config roles staff_role:@Staff community_manager_role:@CM junior_mod_role:@Junior`", "`/config behavior interactive_log:true cm_approval:true`"],
        notes: [
            "Use `/config` to point the bot at premade roles/channels without rerunning setup.",
            "Use `/update` for safe repair after bot updates.",
            "Use `/config check` to see the full status of every configured channel, role, and setting.",
            "steward_log is optional — sets the channel where Steward bot action logs are posted.",
            "cm_approval behavior toggle enables or disables the CM approval flow for cases that require it.",
            "interactive_log behavior toggle enables or disables the button-based interactive logger (fallback to typed /log fields when off).",
            "Warn system is automatic — warnings are tracked per Discord user. No extra config needed. Use /log (discord action, warn type) and Execute Punishment to issue and record warnings.",
            "**Roblox game config is NOT done here.** Run `/roblox` and click ➕ Add Game to link this server's game. Once saved it shows under **Roblox Game** in `/config check`. All in-game bans from `/log` and `/ingameban` route to it automatically."
        ]
    },
    {
        id: "refresh",
        label: "/refresh",
        access: "head",
        levels: ["admin"],
        what: "Clears and reposts all pending CM approval cases in the approval channel.",
        who: "Head Mod-level.",
        usage: ["`/refresh`"],
        examples: ["`/refresh`"],
        notes: ["Run this if the approval channel gets out of sync or messages were deleted."]
    },
    {
        id: "updatebot",
        label: "/updatebot",
        access: "owner",
        levels: ["admin"],
        what: "Pulls the latest code from GitHub, rebuilds, deploys slash commands, and restarts the bot.",
        who: "Server owner only.",
        usage: ["`/updatebot`"],
        examples: ["`/updatebot`"],
        notes: ["PM2 automatically brings the bot back online after restart.", "The bot will be offline for a few seconds during restart."]
    },
    {
        id: "roblox-server-setup",
        label: "Roblox Game Setup (per server)",
        access: "head",
        levels: ["admin"],
        what: "Each server that uses this bot links its own Roblox game once via /roblox. After that, all in-game bans and unbans from /log and /ingameban go to that server's game automatically.",
        who: "Head Mod and above.",
        usage: ["`/roblox` → click ➕ Add Game"],
        examples: ["`/roblox` then fill in Universe ID, API Key, and name in the popup form"],
        notes: [
            "**One-time setup per server.** Each Discord server has its own game — completely separate from other servers.",
            "Run `/config check` after setup to confirm the game is shown under Roblox Game.",
            "Universe ID: open your experience on create.roblox.com — the number in the URL.",
            "API Key: create.roblox.com/settings/credentials → **User API key** (not group) → enable **User Restrictions → Write** and **Messaging Service → Publish** → scope to your universe.",
            "Once saved: `/ingameban` works, Ingame ban logs via `/log` auto-ban, accepted Ingame Ban appeal logs auto-unban.",
            "Junior mod ingame bans wait for senior review approval before executing.",
            "Normal/head mod ingame bans execute the moment the log is submitted.",
            "If the ban stamp shows ⚠️ Ingame Ban Failed, check the API key permissions and Universe ID via `/roblox`."
        ]
    },
    {
        id: "setup",
        label: "/setup",
        access: "owner",
        levels: ["admin"],
        what: "Creates or connects roles, channels, category, and initial server config.",
        who: "Server owner only.",
        usage: ["`/setup owner:@you`"],
        examples: ["`/setup owner:@Owner category_name:Mod Ledger`"],
        notes: ["Can use existing roles/channels if supplied.", "Does not affect other servers."]
    },
    {
        id: "update",
        label: "/update",
        access: "owner",
        levels: ["admin"],
        what: "Repairs missing setup items after bot updates.",
        who: "Server owner only.",
        usage: ["`/update`"],
        examples: ["`/update category_name:Mod Ledger`"],
        notes: ["Safe to run anytime. It does not overwrite valid setup."]
    },
    {
        id: "backup-export",
        label: "/backup /export",
        access: "community",
        levels: ["admin"],
        what: "Creates local backups and JSON exports.",
        who: "Community Manager-level.",
        usage: ["`/backup`", "`/export table:cases|quotas|tickets`"],
        examples: ["`/export table:cases`"],
        notes: ["Files are stored locally on this computer."]
    }
];
export async function replyHelpMenu(interaction, db, member) {
    await interaction.reply({
        embeds: [homeEmbed()],
        components: homeComponents(interaction.user.id),
        ephemeral: true
    });
}
export async function handleHelpButton(db, interaction) {
    if (!interaction.customId.startsWith("help:"))
        return false;
    if (!interaction.guild || !interaction.member) {
        await interaction.reply({ content: "This help menu only works inside a server.", ephemeral: true });
        return true;
    }
    const [, ownerId, action, value, levelValue] = interaction.customId.split(":");
    if (ownerId !== interaction.user.id) {
        await interaction.reply({ content: "Open your own help menu with `/help`.", ephemeral: true });
        return true;
    }
    const member = interaction.member;
    if (action === "home") {
        await interaction.update({ embeds: [homeEmbed()], components: homeComponents(ownerId) });
        return true;
    }
    if (action === "level") {
        const level = parseLevel(value);
        await interaction.update(levelPayload(db, member, ownerId, level));
        return true;
    }
    if (action === "cmd") {
        const command = helpCommands.find((entry) => entry.id === value);
        const level = parseLevel(levelValue);
        if (!command || !canUseAccess(db, member, command.access) || (command.requiresPoints && !db.getGuildConfig(interaction.guild.id).pointsEnabled)) {
            await interaction.reply({ content: "That command is not available to your current role.", ephemeral: true });
            return true;
        }
        await interaction.update(commandPayload(ownerId, command, level));
        return true;
    }
    return false;
}
function homeEmbed() {
    return new EmbedBuilder()
        .setTitle("Command Help")
        .setColor(0x5865f2)
        .setDescription("Choose a moderation level to see the commands available from that level. Command pages include usage, examples, notes, and permission limits.")
        .addFields(levels.map((level) => ({ name: level.label, value: level.description, inline: false })));
}
function homeComponents(ownerId) {
    return [
        new ActionRowBuilder().addComponents(...levels.map((level) => new ButtonBuilder()
            .setCustomId(`help:${ownerId}:level:${level.id}`)
            .setLabel(level.label)
            .setStyle(level.id === "admin" ? ButtonStyle.Danger : ButtonStyle.Primary)))
    ];
}
function levelPayload(db, member, ownerId, level) {
    const visible = visibleCommandsForLevel(db, member, level);
    const levelInfo = levels.find((entry) => entry.id === level);
    const embed = new EmbedBuilder()
        .setTitle(`${levelInfo.label} Commands`)
        .setColor(0x5865f2)
        .setDescription(visible.length > 0
        ? visible.map((entry) => `**${entry.label}** - ${entry.what}`).join("\n")
        : "No commands in this level are visible to your current role.");
    return {
        embeds: [embed],
        components: levelComponents(ownerId, level, visible)
    };
}
function visibleCommandsForLevel(db, member, level) {
    const pointsEnabled = db.getGuildConfig(member.guild.id).pointsEnabled;
    return helpCommands.filter((entry) => entry.levels.includes(level) && canUseAccess(db, member, entry.access) && (!entry.requiresPoints || pointsEnabled));
}
function levelComponents(ownerId, level, commands) {
    const rows = [];
    for (let index = 0; index < commands.length && index < 20; index += 5) {
        rows.push(new ActionRowBuilder().addComponents(...commands.slice(index, index + 5).map((command) => new ButtonBuilder()
            .setCustomId(`help:${ownerId}:cmd:${command.id}:${level}`)
            .setLabel(command.label.slice(0, 80))
            .setStyle(ButtonStyle.Secondary))));
    }
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`help:${ownerId}:home`).setLabel("Levels").setStyle(ButtonStyle.Primary)));
    return rows;
}
function commandPayload(ownerId, command, level) {
    const embed = new EmbedBuilder()
        .setTitle(command.label)
        .setColor(0x2f8f83)
        .addFields({ name: "What It Does", value: truncate(command.what, 1000), inline: false }, { name: "Who Can Use It", value: truncate(command.who, 1000), inline: false }, { name: "How To Use It", value: truncate(command.usage.join("\n"), 1000), inline: false }, { name: "Subcommands / Fields", value: truncate(command.subcommands?.join("\n") ?? "None", 1000), inline: false }, { name: "Examples", value: truncate(command.examples.join("\n"), 1000), inline: false }, { name: "Important Notes", value: truncate(command.notes.join("\n"), 1000), inline: false });
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`help:${ownerId}:level:${level}`).setLabel("Back").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`help:${ownerId}:home`).setLabel("Levels").setStyle(ButtonStyle.Primary))
        ]
    };
}
function parseLevel(value) {
    return value === "moderator" || value === "senior" || value === "admin" ? value : "junior";
}
