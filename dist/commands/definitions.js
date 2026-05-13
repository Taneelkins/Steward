import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { accessPermissionBits } from "../services/access.js";
const communityDefault = accessPermissionBits.community;
const headDefault = accessPermissionBits.head;
const normalDefault = accessPermissionBits.normal;
const juniorDefault = accessPermissionBits.junior;
const registerDefault = accessPermissionBits.register;
const ownerDefault = PermissionFlagsBits.Administrator;
export function buildCommands(options = {}) {
    const pointsEnabled = options.pointsEnabled ?? true;
    const commands = [
        new SlashCommandBuilder()
            .setName("setup")
            .setDescription("Create the moderation ledger roles, category, channels, and config.")
            .addUserOption((option) => option.setName("owner").setDescription("User who receives owner/admin DMs.").setRequired(true))
            .addStringOption((option) => option.setName("category_name").setDescription("Category name to create or reuse. Defaults to Mod Ledger."))
            .addRoleOption((option) => option.setName("staff_role").setDescription("Existing base Staff role to use."))
            .addRoleOption((option) => option.setName("community_manager_role").setDescription("Existing Community Manager role to use."))
            .addRoleOption((option) => option.setName("head_mod_role").setDescription("Existing Head Mod role to use."))
            .addRoleOption((option) => option.setName("senior_mod_role").setDescription("Existing Senior Mod role to use."))
            .addRoleOption((option) => option.setName("normal_mod_role").setDescription("Existing normal Mod role to use."))
            .addRoleOption((option) => option.setName("junior_mod_role").setDescription("Existing Junior Mod role to use."))
            .addChannelOption((option) => textChannelOption(option, "logs_channel", "Existing fallback log channel."))
            .addChannelOption((option) => textChannelOption(option, "mod_alerts_channel", "Existing Mod Alerts channel."))
            .addChannelOption((option) => textChannelOption(option, "quota_channel", "Existing quota alerts/status channel."))
            .addChannelOption((option) => textChannelOption(option, "staff_registration_channel", "Existing staff registration channel."))
            .addChannelOption((option) => textChannelOption(option, "audit_channel", "Existing audit log channel."))
            .addChannelOption((option) => textChannelOption(option, "ticket_transcripts_channel", "Existing Ticket Tool transcript channel."))
            .addChannelOption((option) => textChannelOption(option, "logingame_channel", "Existing ingame log channel."))
            .addChannelOption((option) => textChannelOption(option, "logstrike_channel", "Existing strike log channel."))
            .addChannelOption((option) => textChannelOption(option, "logrestore_channel", "Existing restore log channel."))
            .addChannelOption((option) => textChannelOption(option, "logdiscord_channel", "Existing Discord log channel."))
            .addChannelOption((option) => textChannelOption(option, "logticket_channel", "Existing ticket log channel."))
            .addChannelOption((option) => textChannelOption(option, "logappeal_channel", "Existing appeal log channel."))
            .addRoleOption((option) => option.setName("can_register_role").setDescription("Existing Can register role to use."))
            .setDefaultMemberPermissions(ownerDefault),
        new SlashCommandBuilder()
            .setName("update")
            .setDescription("Repair missing setup items after bot updates.")
            .addStringOption((option) => option.setName("category_name").setDescription("Category name to create or reuse. Defaults to Mod Ledger."))
            .setDefaultMemberPermissions(ownerDefault),
        new SlashCommandBuilder()
            .setName("help")
            .setDescription("Show the commands you can use."),
        new SlashCommandBuilder()
            .setName("register")
            .setDescription("Register yourself as active moderation staff.")
            .setDefaultMemberPermissions(registerDefault),
        logCommand(),
        logEditCommand(),
        configCommand(),
        modshopCommand(),
        actionCommand(pointsEnabled),
        caseCommand(pointsEnabled),
        ...(pointsEnabled ? [pointsCommand(), multiplierCommand()] : []),
        new SlashCommandBuilder()
            .setName("strikes")
            .setDescription("View strike records.")
            .addUserOption((option) => option.setName("target").setDescription("Member.").setRequired(true)),
        new SlashCommandBuilder()
            .setName("warnings")
            .setDescription("View the warning history for a Discord user.")
            .addUserOption((option) => option.setName("target").setDescription("Discord user to look up.").setRequired(true))
            .setDefaultMemberPermissions(normalDefault),
        quotaCommand(pointsEnabled),
        ticketlogCommand(),
        new SlashCommandBuilder()
            .setName("ingameban")
            .setDescription("Ban a player from the configured Roblox experience and create a case log.")
            .addStringOption((option) => option.setName("roblox_user").setDescription("Roblox username to ban.").setRequired(true))
            .addStringOption((option) => option.setName("reason").setDescription("Reason for the ban.").setRequired(true))
            .addStringOption((option) => option.setName("duration").setDescription("Ban duration, e.g. 7 days, 24h, permanent. Defaults to permanent."))
            .addStringOption((option) => option.setName("game").setDescription("Game name as set in /roblox list (required if multiple games configured)."))
            .addBooleanOption((option) => option.setName("exclude_alts").setDescription("Also restrict known alt accounts. Default: false."))
            .setDefaultMemberPermissions(normalDefault),
        new SlashCommandBuilder()
            .setName("ingameunban")
            .setDescription("Unban a player from the configured Roblox experience.")
            .addStringOption((option) => option.setName("roblox_user").setDescription("Roblox username to unban.").setRequired(true))
            .addStringOption((option) => option.setName("game").setDescription("Game name as set in /roblox list (required if multiple games configured)."))
            .setDefaultMemberPermissions(headDefault),
        robloxCommand(),
        autopunishCommand(),
        new SlashCommandBuilder()
            .setName("lookup")
            .setDescription("Search all case logs by target identity.")
            .addStringOption((option) => option.setName("roblox_user").setDescription("Roblox username (partial match)."))
            .addStringOption((option) => option.setName("discord_user").setDescription("Discord username (partial match)."))
            .addStringOption((option) => option.setName("roblox_id").setDescription("Roblox user ID (exact)."))
            .addStringOption((option) => option.setName("discord_id").setDescription("Discord user ID (exact)."))
            .setDefaultMemberPermissions(normalDefault),
        new SlashCommandBuilder()
            .setName("staff")
            .setDescription("View staff profiles.")
            .addUserOption((option) => option.setName("moderator").setDescription("Moderator.").setRequired(true))
            .setDefaultMemberPermissions(juniorDefault),
        new SlashCommandBuilder()
            .setName("audit")
            .setDescription("View audit history.")
            .addIntegerOption((option) => option.setName("limit").setDescription("Number of recent audit events, max 25."))
            .setDefaultMemberPermissions(headDefault),
        new SlashCommandBuilder()
            .setName("bot")
            .setDescription("Bot health and status.")
            .setDefaultMemberPermissions(juniorDefault),
        new SlashCommandBuilder()
            .setName("backup")
            .setDescription("Create a local database backup.")
            .setDefaultMemberPermissions(communityDefault),
        new SlashCommandBuilder()
            .setName("updatebot")
            .setDescription("Pull the latest code from GitHub and restart the bot.")
            .setDefaultMemberPermissions(ownerDefault),
        new SlashCommandBuilder()
            .setName("refresh")
            .setDescription("Clear and re-post all pending CM approval requests in the approval channel.")
            .setDefaultMemberPermissions(communityDefault),
        exportCommand(pointsEnabled)
    ];
    return commands.map((command) => command.toJSON());
}
function configCommand() {
    return new SlashCommandBuilder()
        .setName("config")
        .setDescription("Configure bot roles, channels, and owner settings.")
        .addSubcommand((sub) => sub
        .setName("roles")
        .setDescription("Set staff, permission, and registration roles.")
        .addRoleOption((option) => option.setName("staff_role").setDescription("Base Staff role."))
        .addRoleOption((option) => option.setName("can_register_role").setDescription("Role allowed to use /register."))
        .addRoleOption((option) => option.setName("community_manager_role").setDescription("Community Manager permission role."))
        .addRoleOption((option) => option.setName("head_mod_role").setDescription("Head Mod permission role."))
        .addRoleOption((option) => option.setName("senior_mod_role").setDescription("Senior Mod permission role."))
        .addRoleOption((option) => option.setName("normal_mod_role").setDescription("Normal Mod permission role."))
        .addRoleOption((option) => option.setName("junior_mod_role").setDescription("Junior Mod permission role."))
        .addRoleOption((option) => option.setName("mod_role").setDescription("Legacy mod role field. Prefer staff tier roles."))
        .addRoleOption((option) => option.setName("admin_role").setDescription("Legacy admin role field. Prefer Head Mod/Community Manager."))
        .addRoleOption((option) => option.setName("junior_escalation_role").setDescription("Role to ping when a Junior Mod logs a non-Other ticket."))
        .addRoleOption((option) => option.setName("junior_other_escalation_role").setDescription("Role to ping when a Junior Mod logs an Other ticket (default: none).")))
        .addSubcommand((sub) => sub
        .setName("channels")
        .setDescription("Set general, alert, ticket, and per-action log channels.")
        .addChannelOption((option) => textChannelOption(option, "actions", "Fallback case log channel."))
        .addChannelOption((option) => textChannelOption(option, "strikes", "Strike alert/log channel."))
        .addChannelOption((option) => textChannelOption(option, "alerts", "Mod Alerts channel."))
        .addChannelOption((option) => textChannelOption(option, "audit", "Audit log channel."))
        .addChannelOption((option) => textChannelOption(option, "quota", "Quota status board channel (pinned message only)."))
        .addChannelOption((option) => textChannelOption(option, "quota_alerts", "Quota alert channel (warnings, pings, end-of-period reports)."))
        .addChannelOption((option) => textChannelOption(option, "staff_registration", "Staff registration log channel."))
        .addChannelOption((option) => textChannelOption(option, "ticket_transcripts", "Ticket Tool transcript channel."))
        .addChannelOption((option) => textChannelOption(option, "logingame", "Ingame log channel."))
        .addChannelOption((option) => textChannelOption(option, "logstrike", "Strike log channel."))
        .addChannelOption((option) => textChannelOption(option, "logrestore", "Restore log channel."))
        .addChannelOption((option) => textChannelOption(option, "logdiscord", "Discord log channel."))
        .addChannelOption((option) => textChannelOption(option, "logticket", "Ticket log channel."))
        .addChannelOption((option) => textChannelOption(option, "logappeal", "Appeal log channel."))
        .addChannelOption((option) => textChannelOption(option, "approval_channel", "CM approval channel for quota/points review."))
        .addChannelOption((option) => textChannelOption(option, "junior_help", "Junior Mod review channel (logs posted here for approve/deny before going live)."))
        .addChannelOption((option) => textChannelOption(option, "evidence_archive", "Channel where media evidence attachments are archived."))
        .addChannelOption((option) => textChannelOption(option, "steward_log", "Steward action log channel (auto-posted on every executed punishment)."))
        .addUserOption((option) => option.setName("owner").setDescription("Owner/admin DM target."))
        .addStringOption((option) => option.setName("ticket_tool_bot_id").setDescription("Ticket Tool bot user ID.")))
        .addSubcommand((sub) => sub
        .setName("behavior")
        .setDescription("Configure bot behavior settings.")
        .addBooleanOption((option) => option.setName("interactive_log").setDescription("Enable /log button workflow."))
        .addBooleanOption((option) => option.setName("cm_approval").setDescription("Enable CM approval requirement for non-CM logs (default: on)."))
        .addStringOption((option) => option.setName("linked_server").setDescription("Guild ID of the linked community server for cross-server punishment enforcement."))
        .addStringOption((option) => option.setName("moderation_invite").setDescription("Permanent invite link to include in punishment DMs (e.g. https://discord.gg/...).")))
        .addSubcommand((sub) => sub
        .setName("check")
        .setDescription("Show which configs are set and which are missing."))
        .setDefaultMemberPermissions(communityDefault);
}
function modshopCommand() {
    return new SlashCommandBuilder()
        .setName("modshop")
        .setDescription("Enable or disable the optional point system for this server.")
        .addSubcommand((sub) => sub.setName("enable").setDescription("Enable the point system and redeploy point commands."))
        .addSubcommand((sub) => sub.setName("disable").setDescription("Disable the point system and hide point commands."))
        .addSubcommand((sub) => sub.setName("status").setDescription("Show whether the point system is enabled."))
        .setDefaultMemberPermissions(communityDefault);
}
function actionCommand(pointsEnabled) {
    const command = new SlashCommandBuilder()
        .setName("action")
        .setDescription(pointsEnabled ? "Manage action presets and point values." : "Manage action presets.")
        .addSubcommand((sub) => {
        const upsert = sub
            .setName("upsert")
            .setDescription("Create or update an action preset.")
            .addStringOption((option) => option.setName("name").setDescription("Action name, like warning.").setRequired(true));
        if (pointsEnabled) {
            upsert
                .addNumberOption((option) => option.setName("points").setDescription("Base points.").setRequired(true))
                .addNumberOption((option) => option.setName("no_action_points").setDescription("Reduced points for no-action ticket logs."));
        }
        return upsert
            .addIntegerOption((option) => option.setName("default_strikes").setDescription("Default strike amount.").setRequired(false))
            .addBooleanOption((option) => option.setName("evidence_required").setDescription("Require evidence for this action."))
            .addBooleanOption((option) => option.setName("enabled").setDescription("Enable this action."));
    })
        .addSubcommand((sub) => sub.setName("list").setDescription("List action presets."))
        .addSubcommand((sub) => sub
        .setName("disable")
        .setDescription("Disable an action preset.")
        .addStringOption((option) => option.setName("name").setDescription("Action name.").setRequired(true)));
    if (pointsEnabled) {
        command
            .addSubcommand((sub) => sub
            .setName("points")
            .setDescription("Temporarily override an action's points.")
            .addStringOption((option) => option.setName("name").setDescription("Action name, like ban.").setRequired(true))
            .addNumberOption((option) => option.setName("points").setDescription("Override points, like 5 or 0.5.").setRequired(true))
            .addStringOption((option) => option.setName("reason").setDescription("Why this override is being set.").setRequired(true))
            .addNumberOption((option) => option.setName("no_action_points").setDescription("Optional no-action points override."))
            .addNumberOption((option) => option.setName("duration_hours").setDescription("Optional duration, like 24 for one day.")))
            .addSubcommand((sub) => sub
            .setName("clear-points")
            .setDescription("Clear a temporary action point override.")
            .addStringOption((option) => option.setName("name").setDescription("Action name.").setRequired(true))
            .addStringOption((option) => option.setName("reason").setDescription("Why this override is being cleared.").setRequired(true)));
    }
    return command.setDefaultMemberPermissions(headDefault);
}
function caseCommand(pointsEnabled) {
    return new SlashCommandBuilder()
        .setName("case")
        .setDescription("Log and manage moderation cases.")
        .addSubcommand((sub) => sub
        .setName("log")
        .setDescription("Legacy manual case log. Prefer /log.")
        .addStringOption((option) => option.setName("roblox_user").setDescription("Roblox username."))
        .addUserOption((option) => option.setName("discord_user").setDescription("Discord user, if pingable/selectable."))
        .addStringOption((option) => option.setName("roblox_id").setDescription("Roblox user ID."))
        .addStringOption((option) => option.setName("discord_id").setDescription("Discord user ID for users not in the server."))
        .addStringOption((option) => option.setName("transcript_link").setDescription("Transcript URL."))
        .addStringOption((option) => option.setName("action").setDescription("Action preset name. Defaults to other."))
        .addStringOption((option) => option.setName("reason").setDescription("What happened."))
        .addStringOption((option) => option.setName("evidence").setDescription("Evidence link or text."))
        .addStringOption((option) => option.setName("notes").setDescription("Extra details."))
        .addBooleanOption((option) => option.setName("no_action").setDescription("Ticket required no moderation action."))
        .addStringOption((option) => option.setName("ticket_id").setDescription("Ticket ID, if this came from a ticket."))
        .addStringOption((option) => option.setName("happened_at").setDescription("Optional ISO date/time for late-log flag.")))
        .addSubcommand((sub) => sub
        .setName("edit")
        .setDescription("Edit case text fields.")
        .addIntegerOption((option) => option.setName("case_id").setDescription("Case ID.").setRequired(true))
        .addStringOption((option) => option.setName("admin_reason").setDescription("Why this edit is being made.").setRequired(true))
        .addStringOption((option) => option.setName("reason").setDescription("New case reason."))
        .addStringOption((option) => option.setName("evidence").setDescription("New evidence."))
        .addStringOption((option) => option.setName("notes").setDescription("New notes.")))
        .addSubcommand((sub) => sub
        .setName("void")
        .setDescription(pointsEnabled ? "Void a case and reverse points/strikes." : "Void a case and reverse active strikes.")
        .addIntegerOption((option) => option.setName("case_id").setDescription("Case ID.").setRequired(true))
        .addStringOption((option) => option.setName("reason").setDescription("Why this case is voided.").setRequired(true)))
        .addSubcommand((sub) => sub
        .setName("review")
        .setDescription("Look up a case by its ID and view full details.")
        .addIntegerOption((option) => option.setName("case_id").setDescription("Case ID to look up.").setRequired(true)))
        .addSubcommandGroup((group) => group
        .setName("history")
        .setDescription("View case history.")
        .addSubcommand((sub) => sub
        .setName("user")
        .setDescription("View cases for a target user.")
        .addUserOption((option) => option.setName("target").setDescription("Target user.").setRequired(true)))
        .addSubcommand((sub) => sub
        .setName("mod")
        .setDescription("View cases logged by a moderator.")
        .addUserOption((option) => option.setName("moderator").setDescription("Moderator.").setRequired(true))))
        .setDefaultMemberPermissions(normalDefault);
}
function pointsCommand() {
    return new SlashCommandBuilder()
        .setName("points")
        .setDescription("View or adjust moderator points.")
        .addSubcommand((sub) => sub.setName("me").setDescription("View your points."))
        .addSubcommand((sub) => sub
        .setName("user")
        .setDescription("View a moderator's points.")
        .addUserOption((option) => option.setName("moderator").setDescription("Moderator.").setRequired(true)))
        .addSubcommand((sub) => sub.setName("leaderboard").setDescription("Show point leaderboard."))
        .addSubcommand((sub) => sub
        .setName("adjust")
        .setDescription("Manually add or remove points.")
        .addUserOption((option) => option.setName("moderator").setDescription("Moderator.").setRequired(true))
        .addNumberOption((option) => option.setName("amount").setDescription("Points, positive or negative.").setRequired(true))
        .addStringOption((option) => option.setName("reason").setDescription("Adjustment reason.").setRequired(true)));
}
function multiplierCommand() {
    return new SlashCommandBuilder()
        .setName("multiplier")
        .setDescription("Manage the global point multiplier.")
        .addSubcommand((sub) => sub
        .setName("set")
        .setDescription("Set a timed or permanent point multiplier.")
        .addNumberOption((option) => option.setName("value").setDescription("Multiplier, like 2 or 1.5.").setRequired(true))
        .addStringOption((option) => option.setName("reason").setDescription("Why the multiplier changed.").setRequired(true))
        .addStringOption((option) => option.setName("ends_at").setDescription("Optional ISO date/time when it ends.")))
        .addSubcommand((sub) => sub.setName("clear").setDescription("Reset multiplier to 1x.").addStringOption((option) => option.setName("reason").setDescription("Why it was cleared.").setRequired(true)))
        .addSubcommand((sub) => sub.setName("view").setDescription("View active multiplier."))
        .setDefaultMemberPermissions(headDefault);
}
function quotaCommand(pointsEnabled) {
    return new SlashCommandBuilder()
        .setName("quota")
        .setDescription("Manage quotas and activity reports.")
        .addSubcommand((sub) => sub
        .setName("set")
        .setDescription("Set the default quota.")
        .addIntegerOption((option) => option.setName("required_logs").setDescription("Required logs per period.").setRequired(true))
        .addIntegerOption((option) => option.setName("grace_logs").setDescription("Grace amount for close status.")))
        .addSubcommand((sub) => sub
        .setName("role-set")
        .setDescription("Set a different quota for a role.")
        .addRoleOption((option) => option.setName("role").setDescription("Role.").setRequired(true))
        .addIntegerOption((option) => option.setName("required_logs").setDescription("Required logs.").setRequired(true))
        .addIntegerOption((option) => option.setName("grace_logs").setDescription("Grace amount.")))
        .addSubcommand((sub) => sub
        .setName("role-remove")
        .setDescription("Remove a role-specific quota.")
        .addRoleOption((option) => option.setName("role").setDescription("Role.").setRequired(true)))
        .addSubcommand((sub) => sub
        .setName("schedule")
        .setDescription("Set quota day, time, timezone, and frequency.")
        .addStringOption((option) => option.setName("day").setDescription("Weekday, like Sunday.").setRequired(true))
        .addStringOption((option) => option.setName("time").setDescription("24-hour time, like 21:00.").setRequired(true))
        .addStringOption((option) => option.setName("timezone").setDescription("Timezone, like America/New_York.").setRequired(true))
        .addIntegerOption((option) => option.setName("frequency_days").setDescription("Normally 7.").setRequired(false)))
        .addSubcommand((sub) => sub.setName("end-now").setDescription("Close the current quota period early.").addStringOption((option) => option.setName("reason").setDescription("Why it is ending early.")))
        .addSubcommand((sub) => sub.setName("check-now").setDescription("Check current quota status without closing it."))
        .addSubcommand((sub) => sub.setName("me").setDescription("View your current quota progress."))
        .addSubcommand((sub) => sub.setName("enable").setDescription("Enable quotas."))
        .addSubcommand((sub) => sub.setName("disable").setDescription("Disable quotas."))
        .addSubcommand((sub) => sub.setName("history").setDescription("Show recent quota reports."))
        .addSubcommand((sub) => sub.setName("status").setDescription("Show active quota status."))
        .addSubcommand((sub) => sub.setName("leaderboard").setDescription(pointsEnabled ? "Show quota leaderboard." : "Show quota logs leaderboard."))
        .addSubcommandGroup((group) => group
        .setName("exempt")
        .setDescription("Manage quota exemptions.")
        .addSubcommand((sub) => sub
        .setName("add")
        .setDescription("Exempt a moderator from quota.")
        .addUserOption((option) => option.setName("moderator").setDescription("Moderator.").setRequired(true))
        .addStringOption((option) => option.setName("reason").setDescription("Reason.").setRequired(true))
        .addStringOption((option) => option.setName("expires_at").setDescription("Optional ISO date/time.")))
        .addSubcommand((sub) => sub
        .setName("remove")
        .setDescription("Remove a quota exemption.")
        .addUserOption((option) => option.setName("moderator").setDescription("Moderator.").setRequired(true)))
        .addSubcommand((sub) => sub.setName("list").setDescription("List active quota exemptions.")))
        .setDefaultMemberPermissions(juniorDefault);
}
function ticketlogCommand() {
    return new SlashCommandBuilder()
        .setName("ticketlog")
        .setDescription("Manage pending ticket logs.")
        .addSubcommand((sub) => sub.setName("pending").setDescription("Show pending ticket logs."))
        .addSubcommand((sub) => sub
        .setName("dismiss")
        .setDescription("Dismiss a pending ticket log.")
        .addIntegerOption((option) => option.setName("pending_id").setDescription("Pending ticket log ID.").setRequired(true))
        .addStringOption((option) => option.setName("reason").setDescription("Dismissal reason.").setRequired(true)))
        .addSubcommand((sub) => sub.setName("check-now").setDescription("Run ticket overdue checks now."))
        .addSubcommand((sub) => sub
        .setName("map")
        .setDescription("Map a ticket type to an action preset.")
        .addStringOption((option) => option.setName("ticket_type").setDescription("Ticket type.").setRequired(true))
        .addStringOption((option) => option.setName("action").setDescription("Action preset.").setRequired(true)))
        .setDefaultMemberPermissions(headDefault);
}
function exportCommand(pointsEnabled) {
    const choices = [
        { name: "cases", value: "cases" },
        ...(pointsEnabled ? [{ name: "points", value: "points" }] : []),
        { name: "quotas", value: "quotas" },
        { name: "tickets", value: "tickets" }
    ];
    return new SlashCommandBuilder()
        .setName("export")
        .setDescription("Export bot records as JSON.")
        .addStringOption((option) => option
        .setName("table")
        .setDescription("What to export.")
        .setRequired(true)
        .addChoices(...choices))
        .setDefaultMemberPermissions(communityDefault);
}
function logEditCommand() {
    return new SlashCommandBuilder()
        .setName("logedit")
        .setDescription("Edit a previously submitted log using the interactive logger.")
        .addIntegerOption((option) => option.setName("case_id").setDescription("The case number to edit (shown on the original log embed).").setRequired(true));
}
function logCommand() {
    return new SlashCommandBuilder()
        .setName("log")
        .setDescription("Open the button logger or submit a typed moderation log.")
        .addStringOption((option) => option
        .setName("action")
        .setDescription("Optional typed fallback action.")
        .addChoices({ name: "ingame", value: "ingame" }, { name: "strike", value: "strike" }, { name: "restore", value: "restore" }, { name: "discord", value: "discord" }, { name: "ticket", value: "ticket" }, { name: "other", value: "other" }, { name: "appeal", value: "appeal" }))
        .addStringOption((option) => option.setName("action_type").setDescription("Sub-type for Discord logs: warn, timeout, mute, or ban. Required when action is discord."))
        .addStringOption((option) => option.setName("roblox_user").setDescription("Roblox username."))
        .addUserOption((option) => option.setName("discord_user").setDescription("Discord user, if pingable/selectable."))
        .addStringOption((option) => option.setName("roblox_id").setDescription("Roblox user ID."))
        .addStringOption((option) => option.setName("discord_id").setDescription("Discord user ID for users not in the server."))
        .addStringOption((option) => option.setName("transcript_link").setDescription("Transcript URL."))
        .addStringOption((option) => option.setName("reason").setDescription("What happened."))
        .addStringOption((option) => option.setName("evidence").setDescription("Evidence link or text."))
        .addStringOption((option) => option.setName("notes").setDescription("Extra details."))
        .addBooleanOption((option) => option.setName("no_action").setDescription("Ticket required no moderation action."))
        .addStringOption((option) => option.setName("ticket_id").setDescription("Ticket ID, if available."))
        .addStringOption((option) => option.setName("happened_at").setDescription("Optional ISO date/time for late-log flag."))
        .addStringOption((option) => option.setName("appeal_type").setDescription("Appeal type for appeal logs: ban-appeal, timeout-appeal, warn-appeal, mute-appeal, ingame-appeal."))
        .addStringOption((option) => option.setName("appeal_result").setDescription("Result for appeal logs: accepted or denied."))
        .addStringOption((option) => option.setName("punishment_length").setDescription("Punishment length for Discord logs, e.g. 7 days."));
}
function robloxCommand() {
    return new SlashCommandBuilder()
        .setName("roblox")
        .setDescription("Open the Roblox game management panel.")
        .setDefaultMemberPermissions(headDefault);
}
function autopunishCommand() {
    return new SlashCommandBuilder()
        .setName("autopunish")
        .setDescription("View or toggle automatic punishment execution for different log types.")
        .setDefaultMemberPermissions(headDefault);
}
function textChannelOption(option, name, description) {
    return option.setName(name).setDescription(description).addChannelTypes(ChannelType.GuildText);
}
