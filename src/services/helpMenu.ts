import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember
} from "discord.js";
import type { AppDatabase } from "../db.js";
import type { CommandAccess } from "./access.js";
import { canUseAccess } from "../utils/discord.js";
import { truncate } from "../utils/format.js";

type HelpLevel = "junior" | "moderator" | "senior" | "admin";

type HelpCommand = {
  id: string;
  label: string;
  access: CommandAccess;
  levels: HelpLevel[];
  what: string;
  who: string;
  usage: string[];
  subcommands?: string[];
  examples: string[];
  notes: string[];
  requiresPoints?: boolean;
};

const levels: Array<{ id: HelpLevel; label: string; description: string }> = [
  { id: "junior", label: "Junior Moderator", description: "Public tools, basic staff tools, and logging." },
  { id: "moderator", label: "Moderator", description: "Moderator tools plus case history." },
  { id: "senior", label: "Senior Moderator", description: "Moderator tools plus senior review expectations." },
  { id: "admin", label: "Admin", description: "Head Mod, Community Manager, and owner setup tools." }
];

const helpCommands: HelpCommand[] = [
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
      "Attach Media turns on evidence capture; send image/video/file evidence in the same channel before Submit. Final logs show media as clickable buttons.",
      "Junior Mod logs go to the junior help channel for review instead of the log channel directly. A mod must approve or deny. On deny, the junior mod is DM'd with the reason and can run /log to edit and resubmit."
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
    id: "case",
    label: "/case",
    access: "normal",
    levels: ["moderator", "senior", "admin"],
    what: "Legacy/manual case tools and case history.",
    who: "Moderator and above for history. Edit/void is Head Mod-level.",
    usage: ["`/case history user target:@user`", "`/case history mod moderator:@user`", "`/case edit ...`", "`/case void ...`"],
    subcommands: ["log, edit, void, history user, history mod"],
    examples: ["`/case history mod moderator:@Mod`", "`/case void case_id:12 reason:Duplicate`"],
    notes: ["Prefer `/log` for new logs. Edits and voids preserve audit history."]
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
    id: "config",
    label: "/config",
    access: "community",
    levels: ["admin"],
    what: "Manually updates saved roles, channels, and behavior settings.",
    who: "Community Manager-level.",
    usage: ["`/config roles ...`", "`/config channels ...`", "`/config behavior interactive_log:true`"],
    subcommands: [
      "roles: staff_role, can_register_role, community_manager_role, head_mod_role, senior_mod_role, normal_mod_role, junior_mod_role, junior_escalation_role, junior_other_escalation_role",
      "channels: actions (fallback), alerts, audit, quota, quota_alerts, staff_registration, ticket_transcripts, approval_channel, junior_help, logingame, logstrike, logrestore, logdiscord, logticket, logappeal, evidence_archive",
      "behavior: interactive_log, points_enabled, quota_enabled"
    ],
    examples: ["`/config channels logingame:#log-ingame logdiscord:#log-discord alerts:#mod-alerts junior_help:#junior-review`", "`/config roles staff_role:@Staff community_manager_role:@CM junior_mod_role:@Junior`"],
    notes: ["Use `/config` to point the bot at premade roles/channels without rerunning setup.", "Use `/update` for safe repair after bot updates.", "Use `/config check` to see the full status of every configured channel, role, and setting."]
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

export async function replyHelpMenu(interaction: ChatInputCommandInteraction, db: AppDatabase, member: GuildMember) {
  await interaction.reply({
    embeds: [homeEmbed()],
    components: homeComponents(interaction.user.id),
    ephemeral: true
  });
}

export async function handleHelpButton(db: AppDatabase, interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith("help:")) return false;
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "This help menu only works inside a server.", ephemeral: true });
    return true;
  }

  const [, ownerId, action, value, levelValue] = interaction.customId.split(":");
  if (ownerId !== interaction.user.id) {
    await interaction.reply({ content: "Open your own help menu with `/help`.", ephemeral: true });
    return true;
  }

  const member = interaction.member as GuildMember;
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

function homeComponents(ownerId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...levels.map((level) =>
        new ButtonBuilder()
          .setCustomId(`help:${ownerId}:level:${level.id}`)
          .setLabel(level.label)
          .setStyle(level.id === "admin" ? ButtonStyle.Danger : ButtonStyle.Primary)
      )
    )
  ];
}

function levelPayload(db: AppDatabase, member: GuildMember, ownerId: string, level: HelpLevel) {
  const visible = visibleCommandsForLevel(db, member, level);
  const levelInfo = levels.find((entry) => entry.id === level)!;
  const embed = new EmbedBuilder()
    .setTitle(`${levelInfo.label} Commands`)
    .setColor(0x5865f2)
    .setDescription(
      visible.length > 0
        ? visible.map((entry) => `**${entry.label}** - ${entry.what}`).join("\n")
        : "No commands in this level are visible to your current role."
    );

  return {
    embeds: [embed],
    components: levelComponents(ownerId, level, visible)
  };
}

function visibleCommandsForLevel(db: AppDatabase, member: GuildMember, level: HelpLevel) {
  const pointsEnabled = db.getGuildConfig(member.guild.id).pointsEnabled;
  return helpCommands.filter((entry) => entry.levels.includes(level) && canUseAccess(db, member, entry.access) && (!entry.requiresPoints || pointsEnabled));
}

function levelComponents(ownerId: string, level: HelpLevel, commands: HelpCommand[]) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < commands.length && index < 20; index += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...commands.slice(index, index + 5).map((command) =>
          new ButtonBuilder()
            .setCustomId(`help:${ownerId}:cmd:${command.id}:${level}`)
            .setLabel(command.label.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
        )
      )
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`help:${ownerId}:home`).setLabel("Levels").setStyle(ButtonStyle.Primary)
    )
  );
  return rows;
}

function commandPayload(ownerId: string, command: HelpCommand, level: HelpLevel) {
  const embed = new EmbedBuilder()
    .setTitle(command.label)
    .setColor(0x2f8f83)
    .addFields(
      { name: "What It Does", value: truncate(command.what, 1000), inline: false },
      { name: "Who Can Use It", value: truncate(command.who, 1000), inline: false },
      { name: "How To Use It", value: truncate(command.usage.join("\n"), 1000), inline: false },
      { name: "Subcommands / Fields", value: truncate(command.subcommands?.join("\n") ?? "None", 1000), inline: false },
      { name: "Examples", value: truncate(command.examples.join("\n"), 1000), inline: false },
      { name: "Important Notes", value: truncate(command.notes.join("\n"), 1000), inline: false }
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`help:${ownerId}:level:${level}`).setLabel("Back").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`help:${ownerId}:home`).setLabel("Levels").setStyle(ButtonStyle.Primary)
      )
    ]
  };
}

function parseLevel(value: string | undefined): HelpLevel {
  return value === "moderator" || value === "senior" || value === "admin" ? value : "junior";
}
