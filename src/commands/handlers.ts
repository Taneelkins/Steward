import { execSync } from "node:child_process";
import path from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  GuildMember,
  InteractionReplyOptions,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  Role,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  User
} from "discord.js";
import type { AppDatabase } from "../db.js";
import type { AppEnv } from "../env.js";
import { formatMultiplier, formatPoints, listOrNone, pointsToMilli, truncate } from "../utils/format.js";
import { canUseAccess, caseLinkComponents, commandDeniedMessage, configSummaryEmbed, getTextChannel, hasCanRegisterRole, isAdminMember, isModMember, postToConfiguredChannel, requireAdmin, requireMod } from "../utils/discord.js";
import { dayName, discordTimestamp, nowIso, parseDateInput, parseTime, parseWeekday } from "../utils/time.js";
import { writeAuditAndPost } from "../services/audit.js";
import { commandAccess } from "../services/access.js";
import {
  activeMultiplier,
  adjustPoints,
  buildCaseLogEmbed,
  buildExecutePunishmentButton,
  type CaseTarget,
  createCase,
  editCase,
  effectiveActionPoints,
  getPointTotal,
  getStrikeTotal,
  isWeekendMultiplierActive,
  parsePunishmentLength,
  voidCase
} from "../services/cases.js";
import { createBackup, exportTable } from "../services/files.js";
import { assignStaffRole, provisionModerationServer, staffRoleSpecs, type ProvisionedServer, type SetupChannelKey, type StaffRoleKey } from "../services/provisioning.js";
import {
  buildLeaderboardEmbed,
  buildQuotaReport,
  buildQuotaReportEmbed,
  closeQuotaPeriod,
  ensureQuotaPeriod,
  quotaHistory,
  quotaLeaderboard,
  setQuotaSchedule,
  snapshotRoster,
  upsertQuotaStatusMessage
} from "../services/quota.js";
import { cancelPendingLogForUser, resolveLogAction, startEditLog, startInteractiveLog } from "../services/logWorkflow.js";
import { replyHelpMenu } from "../services/helpMenu.js";
import { normalizeTicketType, processOverdueTickets } from "../services/tickets.js";
import { refreshApprovalChannel } from "../services/cases.js";
import { deployCommandsForGuild } from "../deploy-commands.js";
import { banRobloxPlayer, formatRobloxDuration, kickActivePlayer, lookupRobloxUser, parseRobloxDuration, readProfileStoreEntry, sendDataEdit, setNestedValue, unbanRobloxPlayer, writeProfileStoreEntry } from "../services/roblox.js";
import { buildLoaApprovalButtons, buildLoaRequestEmbed } from "../services/loa.js";
import { buildSetupPanel } from "../services/setupPanel.js";
import { postGoingDown } from "../services/startupAnnouncement.js";

export type CommandContext = {
  db: AppDatabase;
  env: AppEnv;
};

/** Commands available in secondary (community) servers. Everything else is blocked. */
const SECONDARY_ALLOWED_COMMANDS = new Set([
  "setupsecondary",
  "promote",
  "demote",
  "fire",
  "assignroblox",
]);

export async function handleChatInputCommand(interaction: ChatInputCommandInteraction, context: CommandContext) {
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "This bot only works inside a server.", ephemeral: true });
    return;
  }

  context.db.ensureGuild(interaction.guild.id);

  // Secondary server guard — only staff-management commands are available
  const guildConfig = context.db.getGuildConfig(interaction.guild.id);
  if (guildConfig.isSecondary && !SECONDARY_ALLOWED_COMMANDS.has(interaction.commandName)) {
    await interaction.reply({ content: "This command is not available in a secondary server.", ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;
  const access = commandAccess[interaction.commandName] ?? "public";
  if (!canUseAccess(context.db, member, access)) {
    await interaction.reply({ content: commandDeniedMessage(access), ephemeral: true });
    return;
  }
  if (interaction.commandName !== "log") {
    await cancelPendingLogForUser(interaction.guild.id, interaction.user.id, "Previous pending log cancelled because you used another command.");
  }

  try {
    switch (interaction.commandName) {
      case "setup":
        await handleSetup(interaction, context, member);
        break;
      case "update":
        await handleUpdate(interaction, context, member);
        break;
      case "help":
        await handleHelp(interaction, context, member);
        break;
      case "register":
        await handleRegister(interaction, context, member);
        break;
      case "log":
        await handleLog(interaction, context, member);
        break;
      case "logedit":
        await handleLogEdit(interaction, context, member);
        break;
      case "logban":
        await handleQuickLog(interaction, context, member, "ban");
        break;
      case "logstrike":
        await handleQuickLog(interaction, context, member, "strike");
        break;
      case "logrestore":
        await handleQuickLog(interaction, context, member, "restore");
        break;
      case "logdiscord":
        await handleQuickLog(interaction, context, member, "discord", interaction.options.getString("action_type", true));
        break;
      case "logticket":
        await handleQuickLog(interaction, context, member, "ticket");
        break;
      case "addpoints":
        await handlePointAlias(interaction, context, member, 1);
        break;
      case "removepoints":
        await handlePointAlias(interaction, context, member, -1);
        break;
      case "checkpoints":
        await handleCheckpoints(interaction, context, member);
        break;
      case "multi":
        await handleMultiplierView(interaction, context, member);
        break;
      case "config":
        await handleConfig(interaction, context, member);
        break;
      case "modshop":
        await handleModshop(interaction, context, member);
        break;
      case "action":
        await handleAction(interaction, context, member);
        break;
      case "case":
        await handleCase(interaction, context, member);
        break;
      case "points":
        await handlePoints(interaction, context, member);
        break;
      case "strikes":
        await handleStrikes(interaction, context, member);
        break;
      case "warnings":
        await handleWarnings(interaction, context, member);
        break;
      case "ingameban":
        await handleIngameBan(interaction, context, member);
        break;
      case "ingameunban":
        await handleIngameUnban(interaction, context, member);
        break;
      case "roblox":
        await handleRoblox(interaction, context, member);
        break;
      case "autopunish":
        await handleAutoPunish(interaction, context, member);
        break;
      case "edit":
        await handleEdit(interaction, context, member);
        break;
      case "loa":
        await handleLoa(interaction, context, member);
        break;
      case "multiplier":
        await handleMultiplier(interaction, context, member);
        break;
      case "quota":
        await handleQuota(interaction, context, member);
        break;
      case "ticketlog":
        await handleTicketlog(interaction, context, member);
        break;
      case "lookup":
        await handleLookup(interaction, context, member);
        break;
      case "staff":
        await handleStaff(interaction, context, member);
        break;
      case "audit":
        await handleAudit(interaction, context, member);
        break;
      case "bot":
        await handleBot(interaction, context);
        break;
      case "backup":
        await handleBackup(interaction, context, member);
        break;
      case "updatebot":
        await handleUpdateBot(interaction, context, member);
        break;
      case "refresh":
        await handleRefresh(interaction, context, member);
        break;
      case "export":
        await handleExport(interaction, context, member);
        break;
      case "setupsecondary":
        await handleSetupSecondary(interaction, context, member);
        break;
      case "ingameban":
        await handleIngameBan(interaction, context, member);
        break;
      case "ingameunban":
        await handleIngameUnban(interaction, context, member);
        break;
      case "roblox":
        await handleRoblox(interaction, context, member);
        break;
      case "autopunish":
        await handleAutoPunish(interaction, context, member);
        break;
      case "edit":
        await handleEdit(interaction, context, member);
        break;
      case "loa":
        await handleLoa(interaction, context, member);
        break;
      case "promote":
        await handlePromoteOrDemote(interaction, context, member, "promote");
        break;
      case "demote":
        await handlePromoteOrDemote(interaction, context, member, "demote");
        break;
      case "fire":
        await handleFire(interaction, context, member);
        break;
      case "assignroblox":
        await handleAssignRoblox(interaction, context, member);
        break;
      default:
        await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  } catch (error) {
    console.error(`[${interaction.commandName}] command error:`, error);
    await replyError(interaction, error);
  }
}

function execError(error: unknown): string {
  if (error instanceof Error) {
    const stdout = (error as any).stdout ?? "";
    const stderr = (error as any).stderr ?? "";
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    return detail || error.message;
  }
  return String(error);
}

async function handleSetup(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  requireServerOwner(member);
  const guild = interaction.guild!;

  if (db.isLinkedCommunityServer(guild.id)) {
    await interaction.reply({
      content: "This server is registered as a linked community server. No channels or roles will be created here — the bot only needs its permissions to execute punishments. Use `/config behavior linked_server` in your log server to manage the link.",
      ephemeral: true
    });
    return;
  }

  const owner = interaction.options.getUser("owner", true);
  const categoryName = interaction.options.getString("category_name")?.trim() || "Mod Ledger";

  await interaction.deferReply({ ephemeral: true });
  const provisioned = await provisionModerationServer(guild, {
    categoryName,
    roleOverrides: readSetupRoleOverrides(interaction),
    canRegisterRoleOverride: readCanRegisterRoleOverride(interaction),
    channelOverrides: readSetupChannelOverrides(interaction),
    savedRoleIds: savedRoleIdsFromDb(db, guild.id),
    savedCanRegisterRoleId: db.getGuildConfig(guild.id).registrationRoleId,
    savedChannelIds: savedChannelIdsFromConfig(db, guild.id)
  });
  const ownerWarnings = [...provisioned.warnings];
  await assignStaffRole(guild, owner.id, provisioned.roles.communityManager, "Moderation ledger setup owner role").catch(() => {
    ownerWarnings.push("Could not assign Community manager to the setup owner; move the bot role above it if needed.");
  });
  await assignStaffRole(guild, owner.id, provisioned.roles.staff, "Moderation ledger setup owner staff role").catch(() => {
    ownerWarnings.push("Could not assign Staff to the setup owner; move the bot role above it if needed.");
  });

  saveProvisionedConfig(db, guild.id, provisioned, owner.id);
  db.registerStaffMember(guild.id, owner.id, interaction.user.id);
  await ensureQuotaPeriod(db, guild);
  await writeAuditAndPost(db, guild, interaction.user.id, "setup.completed", {
    categoryId: provisioned.category.id,
    staffRoleIds: Object.fromEntries(staffRoleSpecs.map((spec) => [spec.key, provisioned.roles[spec.key].id])),
    ownerUserId: owner.id
  });
  const warningLine = ownerWarnings.length > 0 ? `\n⚠️ ${ownerWarnings.join(" ")}` : "";
  const summaryLine = `Setup complete. Category **${provisioned.category.name}** provisioned.${warningLine}\n\nUse the buttons below to configure channels, roles, and behavior.`;
  await interaction.editReply({ content: summaryLine, ...buildSetupPanel(db, guild.id, interaction.user.id) });
}

async function handleUpdate(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  requireServerOwner(member);
  const guild = interaction.guild!;

  if (db.isLinkedCommunityServer(guild.id)) {
    await interaction.reply({
      content: "This server is a linked community server — nothing to update here.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const config = db.getGuildConfig(guild.id);
  const provisioned = await provisionModerationServer(guild, {
    categoryName: interaction.options.getString("category_name")?.trim() || "Mod Ledger",
    savedRoleIds: savedRoleIdsFromDb(db, guild.id),
    savedCanRegisterRoleId: config.registrationRoleId,
    savedChannelIds: savedChannelIdsFromConfig(db, guild.id)
  });
  saveProvisionedConfig(db, guild.id, provisioned, config.ownerUserId ?? interaction.user.id);
  await ensureQuotaPeriod(db, guild);
  await writeAuditAndPost(db, guild, interaction.user.id, "setup.repaired", {
    categoryId: provisioned.category.id,
    warnings: provisioned.warnings
  });
  const warningLine = provisioned.warnings.length > 0 ? `\n⚠️ ${provisioned.warnings.join(" ")}` : "";
  const summaryLine = `Update complete. Category **${provisioned.category.name}** checked.${warningLine || " No missing items."}\n\nUse the buttons below to configure channels, roles, and behavior.`;
  await interaction.editReply({ content: summaryLine, ...buildSetupPanel(db, guild.id, interaction.user.id) });
}

async function handleHelp(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await replyHelpMenu(interaction, db, member);
}

async function handleRegister(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  if (!hasCanRegisterRole(db, member)) {
    throw new Error("Only members with the Can register role can register.");
  }
  const guild = interaction.guild!;
  const provisioned = await ensureProvisionedForStaffRole(db, guild);
  await assignStaffRole(guild, member.id, provisioned.roles.staff).catch(() => null);
  db.registerStaffMember(guild.id, member.id, interaction.user.id);
  await writeAuditAndPost(db, guild, interaction.user.id, "staff.registered", { userId: member.id });
  const config = db.getGuildConfig(guild.id);
  await postToConfiguredChannel(guild, config.staffRegistrationChannelId, {
    embeds: [
      new EmbedBuilder()
        .setTitle("Staff Registered")
        .setColor(0x2ecc71)
        .addFields(
          { name: "Staff Member", value: `<@${member.id}>`, inline: true },
          { name: "Staff Role", value: `<@&${provisioned.roles.staff.id}>`, inline: true }
        )
        .setTimestamp()
    ],
    allowedMentions: { parse: [] }
  });
  await interaction.reply({ content: `Registered <@${member.id}> as active staff and assigned <@&${provisioned.roles.staff.id}>.`, ephemeral: true });
}

async function handleLog(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  const selected = resolveLogAction(interaction.options.getString("action"));
  if (!selected) {
    await startInteractiveLog(interaction, db, member);
    return;
  }

  await cancelPendingLogForUser(interaction.guild!.id, member.id, "Previous pending log cancelled because you started a new log.");
  const actionType = interaction.options.getString("action_type");
  if (selected.actionName === "discord" && !actionType) {
    throw new Error("Set action_type for Discord logs, like ban, warn, mute, or timeout.");
  }
  await submitTypedLog(interaction, db, member, selected.actionName, actionType ?? selected.displayName);
}

async function handleLogEdit(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  const caseId = interaction.options.getInteger("case_id", true);
  await startEditLog(interaction, db, member, caseId);
}

async function handleQuickLog(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember, actionName: string, actionDisplayName?: string | null) {
  await submitTypedLog(interaction, db, member, actionName, actionDisplayName);
}

const TRANSCRIPT_REQUIRED_ACTIONS = new Set(["ticket", "discord", "discord-ban", "ban"]);

async function submitTypedLog(interaction: ChatInputCommandInteraction, db: AppDatabase, member: GuildMember, actionName: string, actionDisplayName?: string | null) {
  const guild = interaction.guild!;
  const transcriptLink = interaction.options.getString("transcript_link");
  if (TRANSCRIPT_REQUIRED_ACTIONS.has(actionName) && !transcriptLink) {
    await interaction.reply({ content: `A transcript link is required for ${actionDisplayName ?? actionName} logs.`, ephemeral: true });
    return;
  }
  const evidence = interaction.options.getString("evidence") ?? (transcriptLink ? "See transcript." : null);
  const appealType = interaction.options.getString("appeal_type");
  const rawResult = interaction.options.getString("appeal_result")?.toLowerCase();
  const appealResult = rawResult === "accepted" || rawResult === "denied" ? rawResult : null;
  const punishmentLength = interaction.options.getString("punishment_length");
  const record = await createCase(db, {
    guild,
    targetInfo: readCaseTarget(interaction),
    moderator: member,
    actionName,
    actionDisplayName,
    reason: interaction.options.getString("reason") ?? "No reason provided.",
    evidence,
    notes: interaction.options.getString("notes"),
    noAction: interaction.options.getBoolean("no_action") ?? false,
    transcriptUrl: transcriptLink,
    appealType,
    appealResult,
    punishmentLength
  });
  const config = db.getGuildConfig(guild.id);
  const executeRow = buildExecutePunishmentButton(record, config);
  const linkRows = caseLinkComponents(record.transcriptUrl, record.mediaLinks, record.id);
  await interaction.reply({
    content: caseReplyText(`Logged ${record.actionDisplayName ?? record.actionName}`, record.id, record.awardedPointsMilli, config.pointsEnabled),
    embeds: [buildCaseLogEmbed(record, { showPoints: config.pointsEnabled })],
    components: [...(executeRow ? [executeRow] : []), ...linkRows],
    ephemeral: true
  });
}

async function handlePointAlias(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember, sign: 1 | -1) {
  assertPointsEnabled(db, interaction.guild!.id);
  await requireAdmin(db, member);
  const guild = interaction.guild!;
  const moderator = interaction.options.getUser("moderator", true);
  const amount = Math.abs(pointsToMilli(interaction.options.getNumber("amount", true))) * sign;
  const reason = interaction.options.getString("reason", true);
  await adjustPoints(db, guild, interaction.user.id, moderator.id, amount, reason);
  await interaction.reply({ content: `${sign > 0 ? "Added" : "Removed"} ${formatPoints(Math.abs(amount))} points ${sign > 0 ? "to" : "from"} <@${moderator.id}>.`, ephemeral: true });
}

async function handleCheckpoints(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  assertPointsEnabled(db, interaction.guild!.id);
  await requireMod(db, member);
  const guild = interaction.guild!;
  db.registerStaffMember(guild.id, member.id, interaction.user.id);
  const total = getPointTotal(db, guild.id, member.id);
  const registered = db.listRegisteredStaff(guild.id);
  const lines = registered.map((staff, index) => `${index + 1}. <@${staff.userId}> - ${formatPoints(getPointTotal(db, guild.id, staff.userId))}`);
  const embed = new EmbedBuilder()
    .setTitle("Moderator Points")
    .setColor(0x5865f2)
    .addFields(
      { name: "Your Points", value: formatPoints(total), inline: true },
      { name: "Active Registered Staff", value: truncate(listOrNone(lines), 1000), inline: false }
    )
    .setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleMultiplierView(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  assertPointsEnabled(db, interaction.guild!.id);
  await requireMod(db, member);
  const config = db.getGuildConfig(interaction.guild!.id);
  const active = activeMultiplier(config);
  const weekendNote = isWeekendMultiplierActive(config) && active === 1500 ? " Weekend auto-multiplier is active." : "";
  await interaction.reply({
    content: `Current multiplier is ${formatMultiplier(active)}.${weekendNote}`,
    ephemeral: true
  });
}

async function handleConfig(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireAdmin(db, member);
  const guild = interaction.guild!;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "check") {
    await handleConfigCheck(interaction, db, guild.id);
    return;
  }

  if (subcommand === "roles") {
    const roleUpdates = readConfigRoleUpdates(interaction);
    for (const update of roleUpdates.staffRoles) {
      upsertStaffRole(db, guild.id, update.key, update.role);
    }
    const juniorEscalationRole = interaction.options.getRole("junior_escalation_role") as Role | null;
    const juniorOtherEscalationRole = interaction.options.getRole("junior_other_escalation_role") as Role | null;
    db.updateGuildConfig(guild.id, {
      registration_role_id: roleUpdates.canRegisterRole?.id,
      mod_role_id: roleUpdates.legacyModRole?.id,
      admin_role_id: roleUpdates.legacyAdminRole?.id,
      junior_escalation_role_ids_json: juniorEscalationRole ? JSON.stringify([juniorEscalationRole.id]) : undefined,
      junior_other_escalation_role_ids_json: juniorOtherEscalationRole ? JSON.stringify([juniorOtherEscalationRole.id]) : undefined
    });
    await writeAuditAndPost(db, guild, interaction.user.id, "config.roles.updated", {
      staffRoles: roleUpdates.staffRoles.map((update) => ({ key: update.key, roleId: update.role.id })),
      canRegisterRoleId: roleUpdates.canRegisterRole?.id,
      legacyModRoleId: roleUpdates.legacyModRole?.id,
      legacyAdminRoleId: roleUpdates.legacyAdminRole?.id
    });
    await interaction.reply({ embeds: [configEmbed(db, guild.id)], ephemeral: true });
    return;
  }

  if (subcommand === "behavior") {
    const interactiveLog = interaction.options.getBoolean("interactive_log");
    const cmApproval = interaction.options.getBoolean("cm_approval");
    const linkedServer = interaction.options.getString("linked_server");
    const moderationInvite = interaction.options.getString("moderation_invite");
    const juniorApprovalPoints = interaction.options.getNumber("junior_approval_points");
    const promoteDemoteRole = interaction.options.getRole("promote_demote_role") as Role | null;

    let promoteDemoteRoleIdsJson: string | undefined;
    if (promoteDemoteRole) {
      const currentConfig = db.getGuildConfig(guild.id);
      const existing = currentConfig.promoteDemoteRoleIds;
      if (!existing.includes(promoteDemoteRole.id)) {
        promoteDemoteRoleIdsJson = JSON.stringify([...existing, promoteDemoteRole.id]);
      }
    }

    db.updateGuildConfig(guild.id, {
      interactive_log_enabled: interactiveLog === null ? undefined : interactiveLog ? 1 : 0,
      approval_enabled: cmApproval === null ? undefined : cmApproval ? 1 : 0,
      ...(linkedServer !== null ? { linked_guild_id: linkedServer || null } : {}),
      ...(moderationInvite !== null ? { moderation_invite: moderationInvite || null } : {}),
      ...(juniorApprovalPoints !== null ? { junior_approval_points_milli: Math.round(juniorApprovalPoints * 1000) } : {}),
      ...(promoteDemoteRoleIdsJson !== undefined ? { promote_demote_role_ids_json: promoteDemoteRoleIdsJson } : {})
    });
    await writeAuditAndPost(db, guild, interaction.user.id, "config.behavior.updated", { interactiveLog, linkedServer, moderationInvite, juniorApprovalPoints, promoteDemoteRoleId: promoteDemoteRole?.id });
    await interaction.reply({ embeds: [configEmbed(db, guild.id)], ephemeral: true });
    return;
  }

  const actionLogUpdates = readConfigActionLogChannelUpdates(interaction);
  for (const update of actionLogUpdates) {
    upsertActionLogChannel(db, guild.id, update.actionName, update.channel.id);
  }
  const values = {
    action_log_channel_id: getTextChannelOption(interaction, "actions")?.id,
    strike_log_channel_id: getTextChannelOption(interaction, "strikes")?.id ?? actionLogUpdates.find((update) => update.actionName === "strike")?.channel.id,
    alert_channel_id: getTextChannelOption(interaction, "alerts")?.id,
    audit_channel_id: getTextChannelOption(interaction, "audit")?.id,
    quota_channel_id: getTextChannelOption(interaction, "quota")?.id,
    quota_alert_channel_id: getTextChannelOption(interaction, "quota_alerts")?.id,
    staff_registration_channel_id: getTextChannelOption(interaction, "staff_registration")?.id,
    ticket_transcript_channel_id: getTextChannelOption(interaction, "ticket_transcripts")?.id,
    appeal_log_channel_id: getTextChannelOption(interaction, "logappeal")?.id ?? actionLogUpdates.find((update) => update.actionName === "appeal")?.channel.id,
    approval_channel_id: getTextChannelOption(interaction, "approval_channel")?.id,
    junior_help_channel_id: getTextChannelOption(interaction, "junior_help")?.id,
    evidence_archive_channel_id: getTextChannelOption(interaction, "evidence_archive")?.id,
    steward_log_channel_id: getTextChannelOption(interaction, "steward_log")?.id,
    owner_user_id: interaction.options.getUser("owner")?.id,
    ticket_tool_bot_id: interaction.options.getString("ticket_tool_bot_id") ?? undefined,
    loa_channel_id: getTextChannelOption(interaction, "loa_channel")?.id,
    loa_log_channel_id: getTextChannelOption(interaction, "loa_log_channel")?.id,
    shouts_channel_id: getTextChannelOption(interaction, "shouts_channel")?.id
  };
  db.updateGuildConfig(guild.id, values);
  await upsertQuotaStatusMessage(db, guild);
  await writeAuditAndPost(db, guild, interaction.user.id, "config.channels.updated", {
    ...values,
    actionLogs: actionLogUpdates.map((update) => ({ actionName: update.actionName, channelId: update.channel.id }))
  });
  await interaction.reply({ embeds: [configEmbed(db, guild.id)], ephemeral: true });
}

async function handleModshop(interaction: ChatInputCommandInteraction, { db, env }: CommandContext, member: GuildMember) {
  await requireAdmin(db, member);
  const guild = interaction.guild!;
  const subcommand = interaction.options.getSubcommand();
  const current = db.getGuildConfig(guild.id).pointsEnabled;

  if (subcommand === "status") {
    await interaction.reply({ content: `Point system is currently ${current ? "enabled" : "disabled"} for this server.`, ephemeral: true });
    return;
  }

  const enabled = subcommand === "enable";
  await interaction.deferReply({ ephemeral: true });
  db.updateGuildConfig(guild.id, { points_enabled: enabled ? 1 : 0 });
  await writeAuditAndPost(db, guild, interaction.user.id, `modshop.${enabled ? "enabled" : "disabled"}`, {});
  await deployCommandsForGuild(env.discordToken, env.discordClientId, guild.id, { pointsEnabled: enabled });
  await interaction.editReply(
    enabled
      ? "Point system enabled. Point commands and point fields have been redeployed for this server."
      : "Point system disabled. New logs will not award points, point fields are hidden, and point commands have been removed from this server."
  );
}

async function handleAction(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireAdmin(db, member);
  const guild = interaction.guild!;
  const subcommand = interaction.options.getSubcommand();
  const timestamp = nowIso();
  const pointsEnabled = db.getGuildConfig(guild.id).pointsEnabled;

  if (subcommand === "upsert") {
    const rawName = interaction.options.getString("name", true);
    const name = normalizeActionName(rawName);
    const existing = db.getAction(guild.id, name);
    const rawPoints = interaction.options.getNumber("points");
    if (pointsEnabled && rawPoints === null && !existing) throw new Error("Set points when creating a new action preset.");
    const points = rawPoints === null ? existing?.basePointsMilli ?? 0 : pointsToMilli(rawPoints);
    const noActionPoints = interaction.options.getNumber("no_action_points");
    const strikes = interaction.options.getInteger("default_strikes") ?? existing?.defaultStrikes ?? 0;
    const evidenceRequired = interaction.options.getBoolean("evidence_required") ?? existing?.evidenceRequired ?? false;
    const enabled = interaction.options.getBoolean("enabled") ?? existing?.enabled ?? true;

    db.run(
      `INSERT INTO action_presets (
        guild_id, name, display_name, base_points_milli, no_action_points_milli,
        default_strikes, evidence_required, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, name) DO UPDATE SET
        display_name = excluded.display_name,
        base_points_milli = excluded.base_points_milli,
        no_action_points_milli = excluded.no_action_points_milli,
        default_strikes = excluded.default_strikes,
        evidence_required = excluded.evidence_required,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
      guild.id,
      name,
      rawName,
      points,
      noActionPoints === null ? existing?.noActionPointsMilli ?? 0 : pointsToMilli(noActionPoints),
      strikes,
      evidenceRequired ? 1 : 0,
      enabled ? 1 : 0,
      existing?.createdAt ?? timestamp,
      timestamp
    );
    await writeAuditAndPost(db, guild, interaction.user.id, "action.upserted", { name, points });
    await interaction.reply({
      content: pointsEnabled ? `Saved action preset \`${name}\` worth ${formatPoints(points)} points.` : `Saved action preset \`${name}\`.`,
      ephemeral: true
    });
    return;
  }

  if (subcommand === "disable") {
    const name = normalizeActionName(interaction.options.getString("name", true));
    db.run("UPDATE action_presets SET enabled = 0, updated_at = ? WHERE guild_id = ? AND name = ?", timestamp, guild.id, name);
    await writeAuditAndPost(db, guild, interaction.user.id, "action.disabled", { name });
    await interaction.reply({ content: `Disabled action preset \`${name}\`.`, ephemeral: true });
    return;
  }

  if (subcommand === "points") {
    assertPointsEnabled(db, guild.id);
    const name = normalizeActionName(interaction.options.getString("name", true));
    const action = db.getAction(guild.id, name);
    if (!action) throw new Error(`Action preset "${name}" does not exist.`);
    const points = pointsToMilli(interaction.options.getNumber("points", true));
    const noActionPoints = interaction.options.getNumber("no_action_points");
    const durationHours = interaction.options.getNumber("duration_hours");
    if (durationHours !== null && durationHours <= 0) throw new Error("duration_hours must be greater than 0.");
    const endsAt = durationHours === null ? null : new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
    const reason = interaction.options.getString("reason", true);
    db.run(
      `UPDATE action_presets
       SET override_base_points_milli = ?, override_no_action_points_milli = ?, override_ends_at = ?,
           override_reason = ?, override_created_by = ?, updated_at = ?
       WHERE guild_id = ? AND name = ?`,
      points,
      noActionPoints === null ? null : pointsToMilli(noActionPoints),
      endsAt,
      reason,
      interaction.user.id,
      timestamp,
      guild.id,
      name
    );
    await writeAuditAndPost(db, guild, interaction.user.id, "action.points.override.set", { name, points, noActionPoints, endsAt, reason });
    await interaction.reply({
      content: `Set \`${name}\` to ${formatPoints(points)} points${endsAt ? ` until ${discordTimestamp(endsAt, "F")}` : " until cleared"}.`,
      ephemeral: true
    });
    return;
  }

  if (subcommand === "clear-points") {
    assertPointsEnabled(db, guild.id);
    const name = normalizeActionName(interaction.options.getString("name", true));
    const reason = interaction.options.getString("reason", true);
    db.run(
      `UPDATE action_presets
       SET override_base_points_milli = NULL, override_no_action_points_milli = NULL, override_ends_at = NULL,
           override_reason = NULL, override_created_by = NULL, updated_at = ?
       WHERE guild_id = ? AND name = ?`,
      timestamp,
      guild.id,
      name
    );
    await writeAuditAndPost(db, guild, interaction.user.id, "action.points.override.cleared", { name, reason });
    await interaction.reply({ content: `Cleared temporary points for \`${name}\`.`, ephemeral: true });
    return;
  }

  const actions = db.listActions(guild.id);
  const lines = actions.map(
    (action) => {
      if (!pointsEnabled) {
        return `\`${action.name}\` - strikes ${action.defaultStrikes}, evidence ${action.evidenceRequired ? "required" : "optional"}, ${action.enabled ? "enabled" : "disabled"}`;
      }
      const effective = effectiveActionPoints(action);
      const override = effective.overrideActive ? `, override ${formatPoints(effective.basePointsMilli)}${effective.overrideEndsAt ? ` until ${discordTimestamp(effective.overrideEndsAt, "R")}` : " until cleared"}` : "";
      return `\`${action.name}\` - ${formatPoints(action.basePointsMilli)} pts, no-action ${formatPoints(action.noActionPointsMilli)}, strikes ${action.defaultStrikes}, ${action.enabled ? "enabled" : "disabled"}${override}`;
    }
  );
  await interaction.reply({ content: truncate(listOrNone(lines), 1900), ephemeral: true });
}

async function handleCase(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  const guild = interaction.guild!;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "log") {
    await requireMod(db, member);
    const transcriptLink = interaction.options.getString("transcript_link");
    const evidence = interaction.options.getString("evidence") ?? (transcriptLink ? "See transcript." : null);
    const record = await createCase(db, {
      guild,
      targetInfo: readCaseTarget(interaction),
      moderator: member,
      actionName: normalizeActionName(interaction.options.getString("action") ?? "other"),
      reason: interaction.options.getString("reason") ?? "No reason provided.",
      evidence,
      notes: interaction.options.getString("notes"),
      noAction: interaction.options.getBoolean("no_action") ?? false,
      transcriptUrl: transcriptLink,
      happenedAt: interaction.options.getString("happened_at")
    });
    const pointsEnabled = db.getGuildConfig(guild.id).pointsEnabled;
    await interaction.reply({
      content: caseReplyText("Logged", record.id, record.awardedPointsMilli, pointsEnabled),
      embeds: [buildCaseLogEmbed(record, { showPoints: pointsEnabled })],
      components: caseLinkComponents(record.transcriptUrl, record.mediaLinks, record.id),
      ephemeral: true
    });
    return;
  }

  if (subcommand === "edit") {
    await requireAdmin(db, member);
    await editCase(db, guild, interaction.user.id, interaction.options.getInteger("case_id", true), {
      adminReason: interaction.options.getString("admin_reason", true),
      reason: interaction.options.getString("reason"),
      evidence: interaction.options.getString("evidence"),
      notes: interaction.options.getString("notes")
    });
    await interaction.reply({ content: "Case updated and audited.", ephemeral: true });
    return;
  }

  if (subcommand === "void") {
    await requireAdmin(db, member);
    await voidCase(db, guild, interaction.user.id, interaction.options.getInteger("case_id", true), interaction.options.getString("reason", true));
    await interaction.reply({ content: "Case voided and audited. Any active strikes were reversed.", ephemeral: true });
    return;
  }

  if (group === "history") {
    await requireMod(db, member);
    const target = subcommand === "user" ? interaction.options.getUser("target", true) : interaction.options.getUser("moderator", true);
    const column = subcommand === "user" ? "target_user_id" : "moderator_user_id";
    const rows = db.all<{
      id: number;
      action_name: string;
      reason: string;
      created_at: string;
      status: string;
    }>(
      `SELECT id, action_name, reason, created_at, status FROM moderation_cases WHERE guild_id = ? AND ${column} = ? ORDER BY id DESC LIMIT 10`,
      guild.id,
      target.id
    );
    const lines = rows.map((row) => `#${row.id} \`${row.action_name}\` ${row.status} - ${truncate(row.reason, 80)} - ${discordTimestamp(row.created_at, "R")}`);
    await interaction.reply({ content: truncate(listOrNone(lines), 1900), ephemeral: true });
    return;
  }

  if (subcommand === "review") {
    await requireMod(db, member);
    const caseId = interaction.options.getInteger("case_id", true);
    const record = db.getCase(guild.id, caseId);
    if (!record) {
      await interaction.reply({ content: `Case #${caseId} not found.`, ephemeral: true });
      return;
    }
    const config = db.getGuildConfig(guild.id);
    const embed = buildCaseLogEmbed(record, { showPoints: config.pointsEnabled });
    if (record.status === "void") {
      embed.addFields({ name: "⛔ Voided", value: record.voidReason ? `Reason: ${record.voidReason}` : "This case was voided.", inline: false });
    }
    if (record.approvalStatus === "pending") {
      embed.addFields({ name: "⏳ Awaiting CM Approval", value: "This case has not been approved by a Community Manager yet.", inline: false });
    }
    if (record.juniorReviewStatus === "pending") {
      embed.addFields({ name: "⏳ Awaiting Junior Review", value: "This case has not been reviewed by a Senior Moderator yet.", inline: false });
    }
    const linkRows = caseLinkComponents(record.transcriptUrl, record.mediaLinks, record.id);
    await interaction.reply({ embeds: [embed], components: linkRows, ephemeral: true });
    return;
  }
}

async function handlePoints(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  const guild = interaction.guild!;
  assertPointsEnabled(db, guild.id);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "adjust") {
    if (!canUseAccess(db, member, "head")) throw new Error(commandDeniedMessage("head"));
    const moderator = interaction.options.getUser("moderator", true);
    const amount = pointsToMilli(interaction.options.getNumber("amount", true));
    const reason = interaction.options.getString("reason", true);
    await adjustPoints(db, guild, interaction.user.id, moderator.id, amount, reason);
    await interaction.reply({ content: `Adjusted <@${moderator.id}> by ${formatPoints(amount)} points.`, ephemeral: true });
    return;
  }

  if (subcommand === "me" || subcommand === "user") {
    const user = subcommand === "me" ? interaction.user : interaction.options.getUser("moderator", true);
    const total = getPointTotal(db, guild.id, user.id);
    await interaction.reply({ content: `<@${user.id}> has ${formatPoints(total)} points.`, ephemeral: true });
    return;
  }

  const rows = db.all<{ moderator_user_id: string; points: number }>(
    "SELECT moderator_user_id, COALESCE(SUM(amount_milli), 0) AS points FROM point_ledger WHERE guild_id = ? GROUP BY moderator_user_id ORDER BY points DESC LIMIT 20",
    guild.id
  );
  const lines = rows.map((row, index) => `${index + 1}. <@${row.moderator_user_id}> - ${formatPoints(row.points)}`);
  await interaction.reply({ content: truncate(listOrNone(lines), 1900), ephemeral: true });
}

async function handleStrikes(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  const target = interaction.options.getUser("target", true);
  const total = getStrikeTotal(db, interaction.guild!.id, target.id);
  const rows = db.all<{ case_id: number; amount: number; created_at: string }>(
    "SELECT case_id, amount, created_at FROM strikes WHERE guild_id = ? AND target_user_id = ? AND active = 1 ORDER BY id DESC LIMIT 10",
    interaction.guild!.id,
    target.id
  );
  const lines = rows.map((row) => `Case #${row.case_id}: +${row.amount} - ${discordTimestamp(row.created_at, "R")}`);
  await interaction.reply({ content: `<@${target.id}> has ${total} active strikes.\n${truncate(listOrNone(lines), 1700)}`, ephemeral: true });
}

async function handleWarnings(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireMod(db, member);
  const guild = interaction.guild!;
  const target = interaction.options.getUser("target", true);

  const count = db.countWarnings(guild.id, target.id);
  if (count === 0) {
    await interaction.reply({ content: `<@${target.id}> has no warnings on record.`, ephemeral: true });
    return;
  }

  const rows = db.all<{ id: number; case_id: number | null; reason: string | null; moderator_user_id: string; created_at: string }>(
    "SELECT id, case_id, reason, moderator_user_id, created_at FROM warnings WHERE guild_id = ? AND discord_target_id = ? ORDER BY id DESC LIMIT 10",
    guild.id,
    target.id
  );

  const lines = rows.map((row, index) => {
    const num = count - index;
    const caseRef = row.case_id ? ` (Case #${row.case_id})` : "";
    const reason = row.reason ? truncate(row.reason, 80) : "No reason recorded";
    return `**Warning #${num}** — ${reason}${caseRef}\n> ${discordTimestamp(row.created_at, "R")} by <@${row.moderator_user_id}>`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Warning History — ${count} warning${count !== 1 ? "s" : ""}`)
    .setColor(0xf39c12)
    .setDescription(truncate(lines.join("\n"), 4000))
    .setFooter({ text: `Discord ID: ${target.id}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

// ── Roblox In-Game Ban/Unban ──────────────────────────────────────────────────

/** Resolve which game to use: auto-selects if only one is configured. */
function resolveRobloxGame(db: AppDatabase, guildId: string, nameOption: string | null) {
  const games = db.listRobloxGames(guildId);
  if (games.length === 0) {
    throw new Error("No Roblox games configured. Ask an admin to run `/roblox add` first.");
  }
  if (nameOption) {
    const game = db.getRobloxGame(guildId, nameOption);
    if (!game) throw new Error(`No Roblox game found named "${nameOption}". Use \`/roblox list\` to see configured games.`);
    return game;
  }
  if (games.length === 1) return games[0];
  const names = games.map((g) => `\`${g.name}\``).join(", ");
  throw new Error(`Multiple games configured (${names}). Specify which one with the \`game\` option.`);
}

async function handleIngameBan(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireMod(db, member);
  const guild = interaction.guild!;
  const robloxUsername = interaction.options.getString("roblox_user", true).trim();
  const reason = interaction.options.getString("reason", true).trim();
  const durationRaw = interaction.options.getString("duration");
  const gameOption = interaction.options.getString("game");
  const excludeAlts = interaction.options.getBoolean("exclude_alts") ?? false;

  const game = resolveRobloxGame(db, guild.id, gameOption);

  const durationSeconds = parseRobloxDuration(durationRaw);
  if (durationSeconds === null) {
    await interaction.reply({ content: `Could not parse duration \`${durationRaw}\`. Examples: \`7 days\`, \`24h\`, \`permanent\`.`, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Look up the Roblox user ID
  const robloxUser = await lookupRobloxUser(robloxUsername);
  if (!robloxUser) {
    await interaction.editReply(`❌ Roblox user \`${robloxUsername}\` not found. Check the spelling and try again.`);
    return;
  }

  // Execute the ban via Open Cloud API
  const banResult = await banRobloxPlayer({
    universeId: game.universeId,
    apiKey: game.apiKey,
    robloxUserId: robloxUser.id,
    displayReason: reason,
    privateReason: `[Staff: ${member.user.tag}] ${reason}`,
    durationSeconds: durationSeconds ?? undefined,
    excludeAltAccounts: excludeAlts
  });

  if (!banResult.success) {
    await interaction.editReply(`❌ Roblox ban failed: ${banResult.error}\n\nDouble-check the API key permissions and Universe ID in \`/roblox list\`.`);
    return;
  }

  // Best-effort real-time kick — boots the player if they are in any live server right now
  await kickActivePlayer(game.universeId, game.apiKey, robloxUser.id, reason);

  // Create a case log for the ban
  let caseId: number | null = null;
  try {
    const durationLabel = formatRobloxDuration(durationSeconds ?? undefined);
    const record = await createCase(db, {
      guild,
      moderator: member,
      actionName: "ban",
      actionDisplayName: "Ingame Ban",
      targetInfo: { robloxUsername: robloxUser.name, robloxId: String(robloxUser.id) },
      reason,
      punishmentLength: durationRaw ?? "permanent"
    });
    caseId = record.id;
  } catch {
    // Case creation failure doesn't undo the ban; just note it
  }

  const durationLabel = formatRobloxDuration(durationSeconds ?? undefined);
  const caseNote = caseId !== null ? ` Case #${caseId} logged.` : " (Case log failed — ban was still executed.)";
  await interaction.editReply(
    `✅ **${robloxUser.name}** (ID: ${robloxUser.id}) banned from **${game.name}**.\n` +
    `**Duration:** ${durationLabel}\n**Reason:** ${reason}${caseNote}`
  );
}

async function handleIngameUnban(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  if (!canUseAccess(db, member, "head")) throw new Error(commandDeniedMessage("head"));
  const guild = interaction.guild!;
  const robloxUsername = interaction.options.getString("roblox_user", true).trim();
  const gameOption = interaction.options.getString("game");

  const game = resolveRobloxGame(db, guild.id, gameOption);

  await interaction.deferReply({ ephemeral: true });

  const robloxUser = await lookupRobloxUser(robloxUsername);
  if (!robloxUser) {
    await interaction.editReply(`❌ Roblox user \`${robloxUsername}\` not found. Check the spelling and try again.`);
    return;
  }

  const result = await unbanRobloxPlayer({
    universeId: game.universeId,
    apiKey: game.apiKey,
    robloxUserId: robloxUser.id
  });

  if (!result.success) {
    await interaction.editReply(`❌ Roblox unban failed: ${result.error}`);
    return;
  }

  await writeAuditAndPost(db, guild, interaction.user.id, "roblox.unban", {
    robloxUserId: robloxUser.id, robloxUsername: robloxUser.name, universeId: game.universeId, gameName: game.name
  });
  await interaction.editReply(`✅ **${robloxUser.name}** (ID: ${robloxUser.id}) unbanned from **${game.name}**.`);
}

// ── /loa ─────────────────────────────────────────────────────────────────────

async function handleLoa(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  if (!canUseAccess(db, member, "junior")) throw new Error(commandDeniedMessage("junior"));

  const guild = interaction.guild!;
  const config = db.getGuildConfig(guild.id);

  if (!config.loaChannelId) {
    throw new Error("No LOA approval channel is configured. Ask an admin to set one via `/config channels loa_channel:`.");
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "request") return;

  const reason   = interaction.options.getString("reason", true);
  const durText  = interaction.options.getString("duration", true).trim();

  // Parse duration into seconds using the existing roblox duration parser
  const durationSeconds = parseRobloxDuration(durText);
  if (durationSeconds === null) {
    throw new Error(`Could not parse duration \`${durText}\`. Try something like \`2 weeks\`, \`1 month\`, or \`14 days\`.`);
  }

  const expiresAt = durationSeconds !== undefined
    ? new Date(Date.now() + durationSeconds * 1000).toISOString()
    : null;

  const loaId = db.createLoaRequest({
    guildId: guild.id,
    userId: member.id,
    username: member.user.tag,
    reason,
    durationText: durText,
    expiresAt
  });

  const request = db.getLoaRequest(loaId)!;
  const embed   = buildLoaRequestEmbed(request);
  const row     = buildLoaApprovalButtons(loaId);

  const loaChannel = await getTextChannel(guild, config.loaChannelId);
  if (!loaChannel) {
    throw new Error("The configured LOA channel could not be found. Please update it in `/config channels`.");
  }

  const msg = await loaChannel.send({ embeds: [embed], components: [row] });
  db.updateLoaRequest(loaId, {
    approvalMessageId: msg.id,
    approvalChannelId: loaChannel.id
  });

  await interaction.reply({
    content: `Your LOA request has been submitted for review in <#${loaChannel.id}>. You will receive a DM when it is approved or denied.`,
    ephemeral: true
  });
}

// ── /edit ─────────────────────────────────────────────────────────────────────

/**
 * Parse the raw string value from the Discord option into the correct type.
 * Priority: boolean → number → string.
 */
function parseEditValue(raw: string): unknown {
  const lower = raw.trim().toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  const num = Number(raw.trim());
  if (!isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

async function handleEdit(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  if (!canUseAccess(db, member, "community")) throw new Error(commandDeniedMessage("community"));

  await interaction.deferReply({ ephemeral: true });

  const guild      = interaction.guild!;
  const username   = interaction.options.getString("roblox_user", true).trim();
  const statPath   = interaction.options.getString("stat", true).trim();
  const rawValue   = interaction.options.getString("value", true);
  const gameOption = interaction.options.getString("game");
  const game       = resolveRobloxGame(db, guild.id, gameOption);
  const value      = parseEditValue(rawValue);

  const robloxUser = await lookupRobloxUser(username);
  if (!robloxUser) {
    await interaction.editReply(`❌ Roblox user \`${username}\` not found. Check the spelling and try again.`);
    return;
  }

  // ── Step 1: try to read the DataStore entry ──────────────────────────────
  const readResult = await readProfileStoreEntry({
    universeId: game.universeId,
    apiKey: game.apiKey,
    userId: robloxUser.id
  });

  if (!readResult.success) {
    if (readResult.notFound) {
      // No data yet (never joined) — try a live broadcast as a last resort
      await sendDataEdit(game.universeId, game.apiKey, robloxUser.id, statPath, value);
      await interaction.editReply(
        `⚠️ **${robloxUser.name}** has no saved data yet (never joined). Sent a live broadcast instead — ` +
        `this only works if they are currently in-game.`
      );
      return;
    }
    // DataStore permission missing or API error
    await interaction.editReply(
      `❌ Could not read player data: ${readResult.error}\n` +
      `-# Make sure the API key has **Universe Datastore Objects → Read** and **Universe Datastore Objects → Update** permissions in the Roblox Creator Hub, with your universe added under each permission.`
    );
    return;
  }

  // ── Step 2: check ActiveSession — is the player online? ──────────────────
  const entry      = readResult.data as Record<string, unknown>;
  const metaData   = entry.MetaData as Record<string, unknown> | undefined;
  const activeSession = metaData?.ActiveSession; // null/undefined = offline, array = online

  if (activeSession) {
    // Player currently has an active ProfileStore session — editing the DataStore
    // directly would be overwritten when their session saves. Use MessagingService.
    await sendDataEdit(game.universeId, game.apiKey, robloxUser.id, statPath, value);
    await writeAuditAndPost(db, guild, interaction.user.id, "data.edit", {
      robloxUserId: robloxUser.id, robloxUsername: robloxUser.name,
      statPath, value: String(value), method: "live (player online)"
    });
    await interaction.editReply(
      `✅ **${robloxUser.name}** is currently online — edit applied live.\n` +
      `\`${statPath}\` → \`${String(value)}\``
    );
    return;
  }

  // ── Step 3: player is offline — do DataStore read-modify-write ────────────
  const profileData = entry.Data as Record<string, unknown> | undefined;
  if (!profileData || !Array.isArray(profileData.Slots)) {
    await interaction.editReply(`❌ Unexpected DataStore format — could not parse player data.`);
    return;
  }

  // ProfileStore uses Lua 1-based slot indices; JSON arrays are 0-based in JS
  const slotIndex = (typeof profileData.Current_Slot === "number" ? profileData.Current_Slot : 1) - 1;
  const slots     = profileData.Slots as Array<Record<string, unknown>>;
  const slot      = slots[slotIndex];
  if (!slot) {
    await interaction.editReply(`❌ Could not find slot ${slotIndex + 1} in the player's data.`);
    return;
  }

  const ok = setNestedValue(slot, statPath, value);
  if (!ok) {
    await interaction.editReply(
      `❌ Stat path \`${statPath}\` is invalid — an intermediate key doesn't exist.\n` +
      `-# Example paths: \`Stats.Elo\`, \`Player.Clan\`, \`LastHealth\`, \`Stats.StrikingPower\``
    );
    return;
  }

  const writeResult = await writeProfileStoreEntry({
    universeId: game.universeId,
    apiKey: game.apiKey,
    userId: robloxUser.id,
    entry  // we pass back the whole envelope so MetaData/GlobalUpdates are untouched
  });

  if (!writeResult.success) {
    await interaction.editReply(
      `❌ Edit failed when saving: ${writeResult.error}\n` +
      `-# Make sure the API key has **DataStore → Write** permission.`
    );
    return;
  }

  await writeAuditAndPost(db, guild, interaction.user.id, "data.edit", {
    robloxUserId: robloxUser.id, robloxUsername: robloxUser.name,
    statPath, value: String(value), method: "datastore (player offline)"
  });

  await interaction.editReply(
    `✅ **${robloxUser.name}**'s data saved directly to DataStore.\n` +
    `\`${statPath}\` → \`${String(value)}\`\n` +
    `-# Player was offline. Change takes effect the next time they log in.`
  );
}

async function handleRoblox(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  if (!canUseAccess(db, member, "head")) throw new Error(commandDeniedMessage("head"));
  await interaction.reply({ ...buildRobloxPanel(db, interaction.guild!.id), ephemeral: true });
}

// ── Roblox panel helpers ─────────────────────────────────────────────────────

function buildRobloxPanel(db: AppDatabase, guildId: string): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const games = db.listRobloxGames(guildId);

  const embed = new EmbedBuilder()
    .setTitle("🎮 Roblox Game Management")
    .setColor(0xe00000)
    .setTimestamp();

  if (games.length === 0) {
    embed.setDescription("No Roblox game configured yet.\nClick **Add Game** to link this server's game.");
  } else {
    const lines = games.map((g) =>
      `${g.isDefault ? "⭐ " : ""}**${g.name}**\nUniverse: \`${g.universeId}\`\nKey: \`${g.apiKey.slice(0, 6)}…${g.apiKey.slice(-4)}\``
    );
    embed
      .setDescription(lines.join("\n\n"))
      .setFooter({ text: "API key shown truncated for security." });
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Add Game button (always shown)
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("roblox:add")
        .setLabel("➕ Add Game")
        .setStyle(ButtonStyle.Success)
    )
  );

  // Per-game Remove / Set Default buttons (one row per game, max 5 games)
  for (const game of games.slice(0, 4)) {
    const btns = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`roblox:remove:${game.id}`)
        .setLabel(`🗑️ Remove ${game.name}`)
        .setStyle(ButtonStyle.Danger),
      ...(games.length > 1
        ? [new ButtonBuilder()
            .setCustomId(`roblox:setdefault:${game.id}`)
            .setLabel(game.isDefault ? `⭐ Default (${game.name})` : `Set Default: ${game.name}`)
            .setStyle(game.isDefault ? ButtonStyle.Secondary : ButtonStyle.Primary)
            .setDisabled(game.isDefault)]
        : [])
    );
    rows.push(btns);
  }

  return { embeds: [embed], components: rows };
}

// ── Roblox button handler (exported — wired in index.ts) ─────────────────────

export async function handleRobloxButton(db: AppDatabase, interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("roblox:")) return false;
  if (!interaction.guild) return false;

  const member = interaction.member as GuildMember;
  if (!canUseAccess(db, member, "head")) {
    await interaction.reply({ content: "You don't have permission to manage Roblox games.", ephemeral: true });
    return true;
  }

  const parts = interaction.customId.split(":");
  const action = parts[1];

  if (action === "add") {
    const modal = new ModalBuilder()
      .setCustomId("roblox:add_modal")
      .setTitle("Add Roblox Game")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("universe_id")
            .setLabel("Universe ID")
            .setPlaceholder("e.g. 10163900853 — from the Creator Hub URL")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("api_key")
            .setLabel("API Key")
            .setPlaceholder("rblx_xxxx... — from create.roblox.com/settings/credentials")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("name")
            .setLabel("Game Name")
            .setPlaceholder("e.g. My Game")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80)
        )
      );
    await interaction.showModal(modal);
    return true;
  }

  if (action === "remove") {
    const gameId = parseInt(parts[2], 10);
    const games = db.listRobloxGames(interaction.guild.id);
    const game = games.find((g) => g.id === gameId);
    if (!game) {
      await interaction.reply({ content: "Game not found — it may have already been removed.", ephemeral: true });
      return true;
    }
    db.removeRobloxGame(interaction.guild.id, game.universeId);
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "roblox.game.removed", { name: game.name });
    await interaction.update(buildRobloxPanel(db, interaction.guild.id));
    return true;
  }

  if (action === "setdefault") {
    const gameId = parseInt(parts[2], 10);
    const games = db.listRobloxGames(interaction.guild.id);
    const game = games.find((g) => g.id === gameId);
    if (!game) {
      await interaction.reply({ content: "Game not found.", ephemeral: true });
      return true;
    }
    db.setDefaultRobloxGame(interaction.guild.id, game.universeId);
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "roblox.game.default_set", { name: game.name });
    await interaction.update(buildRobloxPanel(db, interaction.guild.id));
    return true;
  }

  return false;
}

// ── Roblox modal handler (exported — wired in index.ts) ──────────────────────

export async function handleRobloxModal(db: AppDatabase, interaction: import("discord.js").ModalSubmitInteraction): Promise<boolean> {
  if (interaction.customId !== "roblox:add_modal") return false;
  if (!interaction.guild) return false;

  const member = interaction.member as GuildMember;
  if (!canUseAccess(db, member, "head")) {
    await interaction.reply({ content: "You don't have permission to manage Roblox games.", ephemeral: true });
    return true;
  }

  const universeId = interaction.fields.getTextInputValue("universe_id").trim();
  const apiKey = interaction.fields.getTextInputValue("api_key").trim();
  const name = interaction.fields.getTextInputValue("name").trim();

  if (!/^\d+$/.test(universeId)) {
    await interaction.reply({ content: "❌ Universe ID must be a number. Find it in the Creator Hub URL for your experience.", ephemeral: true });
    return true;
  }

  db.upsertRobloxGame(interaction.guild.id, universeId, apiKey, name);
  await writeAuditAndPost(db, interaction.guild, interaction.user.id, "roblox.game.added", { universeId, name });

  // Refresh the panel if the original message is still there
  const guildId = interaction.guild!.id;
  await interaction.deferUpdate().catch(() => null);
  await interaction.editReply(buildRobloxPanel(db, guildId)).catch(async () => {
    await interaction.followUp({ ...buildRobloxPanel(db, guildId), ephemeral: true }).catch(() => null);
  });
  return true;
}

// ── AutoPunish panel ─────────────────────────────────────────────────────────

const PUNISH_TYPES: Array<{ key: string; label: string; description: string }> = [
  { key: "ingame",  label: "Ingame Bans",     description: "Auto-ban players in-game when an ingame ban log is created/approved." },
  { key: "appeal",  label: "Ingame Unbans",   description: "Auto-unban players in-game when an accepted ingame appeal log is created/approved." },
  { key: "discord", label: "Discord Actions", description: "Show the ⚡ Execute Punishment button on discord/appeal action logs." },
];

function buildAutoPunishPanel(db: AppDatabase, guildId: string): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const config = db.getGuildConfig(guildId);
  const disabled = config.autoPunishDisabled;

  const lines = PUNISH_TYPES.map((t) => {
    const on = !disabled.includes(t.key);
    return `${on ? "🟢 **ON**" : "🔴 **OFF**"} — **${t.label}**\n${t.description}`;
  });

  const embed = new EmbedBuilder()
    .setTitle("⚡ Auto-Punishment Settings")
    .setColor(0x5865f2)
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: "Green = active  •  Red = disabled  •  Use buttons to toggle" });

  const buttons = PUNISH_TYPES.map((t) => {
    const on = !disabled.includes(t.key);
    return new ButtonBuilder()
      .setCustomId(`autopunish:toggle:${t.key}`)
      .setLabel(on ? `Disable ${t.label}` : `Enable ${t.label}`)
      .setStyle(on ? ButtonStyle.Danger : ButtonStyle.Success);
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  return { embeds: [embed], components: [row] };
}

async function handleAutoPunish(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  if (!canUseAccess(db, member, "head")) throw new Error(commandDeniedMessage("head"));
  await interaction.reply({ ...buildAutoPunishPanel(db, interaction.guild!.id), ephemeral: true });
}

export async function handleAutoPunishButton(db: AppDatabase, interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("autopunish:")) return false;
  if (!interaction.guild) return false;

  const member = interaction.member as GuildMember;
  if (!canUseAccess(db, member, "head")) {
    await interaction.reply({ content: "You need Head Mod or higher to change auto-punishment settings.", ephemeral: true });
    return true;
  }

  const parts = interaction.customId.split(":");
  if (parts[1] !== "toggle") return false;
  const key = parts[2];
  if (!PUNISH_TYPES.some((t) => t.key === key)) return false;

  const config = db.getGuildConfig(interaction.guild.id);
  const disabled = [...config.autoPunishDisabled];
  const idx = disabled.indexOf(key);
  if (idx === -1) {
    disabled.push(key);
  } else {
    disabled.splice(idx, 1);
  }
  db.setAutoPunishDisabled(interaction.guild.id, disabled);
  const panel = buildAutoPunishPanel(db, interaction.guild.id);
  const updated = await interaction.update(panel).then(() => true).catch(() => false);
  if (!updated) {
    await interaction.reply({ ...panel, ephemeral: true }).catch(() => null);
  }
  return true;
}

async function handleMultiplier(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  const guild = interaction.guild!;
  assertPointsEnabled(db, guild.id);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "view") {
    await requireMod(db, member);
    const config = db.getGuildConfig(guild.id);
    const active = activeMultiplier(config);
    await interaction.reply({
      content: `Current multiplier is ${formatMultiplier(active)}${config.multiplierEndsAt ? ` and ends ${discordTimestamp(config.multiplierEndsAt, "R")}` : ""}.`,
      ephemeral: true
    });
    return;
  }

  await requireAdmin(db, member);
  if (subcommand === "clear") {
    const reason = interaction.options.getString("reason", true);
    db.updateGuildConfig(guild.id, { multiplier_milli: 1000, multiplier_ends_at: null });
    await writeAuditAndPost(db, guild, interaction.user.id, "multiplier.cleared", { reason });
    await interaction.reply({ content: "Multiplier reset to 1x.", ephemeral: true });
    return;
  }

  const value = pointsToMilli(interaction.options.getNumber("value", true));
  const endsAtText = interaction.options.getString("ends_at");
  const endsAt = endsAtText ? parseDateInput(endsAtText) : null;
  if (endsAtText && !endsAt) throw new Error("Could not parse ends_at. Use an ISO date/time.");
  const reason = interaction.options.getString("reason", true);
  db.updateGuildConfig(guild.id, { multiplier_milli: value, multiplier_ends_at: endsAt?.toISOString() ?? null });
  await writeAuditAndPost(db, guild, interaction.user.id, "multiplier.set", { value, endsAt: endsAt?.toISOString() ?? null, reason });
  await interaction.reply({ content: `Multiplier set to ${formatMultiplier(value)}${endsAt ? ` until ${discordTimestamp(endsAt, "F")}` : ""}.`, ephemeral: true });
}

async function handleQuota(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  const guild = interaction.guild!;
  const subcommand = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);

  if (group === "exempt") {
    await handleQuotaExempt(interaction, db, member);
    return;
  }

  if (subcommand === "me") {
    await requireMod(db, member);
    await ensureQuotaPeriod(db, guild);
    const config = db.getGuildConfig(guild.id);
    const report = config.quotaPeriodStart && config.quotaPeriodEnd ? buildQuotaReport(db, guild.id, config.quotaPeriodStart, config.quotaPeriodEnd) : null;
    const status = report?.statuses.find((entry) => entry.userId === member.id);
    await interaction.reply({
      content: status
        ? `Your quota: ${status.loggedActions}/${status.requiredLogs} logs (${status.status}). Missing ${status.missing}.`
        : "You are not in the current quota roster yet. Run /register and make sure you have a staff role.",
      ephemeral: true
    });
    return;
  }

  if (subcommand === "status" || subcommand === "leaderboard") {
    await requireMod(db, member);
  } else {
    await requireAdmin(db, member);
  }

  if (subcommand === "set") {
    const required = interaction.options.getInteger("required_logs", true);
    const grace = interaction.options.getInteger("grace_logs") ?? 0;
    const config = db.getGuildConfig(guild.id);
    db.updateGuildConfig(guild.id, { quota_required_logs: required, quota_grace_logs: grace, quota_enabled: required > 0 ? 1 : 0 });
    await ensureQuotaPeriod(db, guild);
    const updated = db.getGuildConfig(guild.id);
    if (updated.quotaPeriodStart && updated.quotaPeriodEnd) {
      await snapshotRoster(db, guild, updated.quotaPeriodStart, updated.quotaPeriodEnd);
    }
    await upsertQuotaStatusMessage(db, guild);
    await writeAuditAndPost(db, guild, interaction.user.id, "quota.set", { required, grace, previousRequired: config.quotaRequiredLogs });
    await interaction.reply({ content: `Quota set to ${required} logs with ${grace} grace logs.`, ephemeral: true });
    return;
  }

  if (subcommand === "role-set") {
    const role = interaction.options.getRole("role", true) as Role;
    const required = interaction.options.getInteger("required_logs", true);
    const grace = interaction.options.getInteger("grace_logs") ?? 0;
    db.run(
      `INSERT INTO role_quotas (guild_id, role_id, required_logs, grace_logs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, role_id) DO UPDATE SET required_logs = excluded.required_logs, grace_logs = excluded.grace_logs, updated_at = excluded.updated_at`,
      guild.id,
      role.id,
      required,
      grace,
      nowIso(),
      nowIso()
    );
    const config = db.getGuildConfig(guild.id);
    if (config.quotaPeriodStart && config.quotaPeriodEnd) await snapshotRoster(db, guild, config.quotaPeriodStart, config.quotaPeriodEnd);
    await writeAuditAndPost(db, guild, interaction.user.id, "quota.role.set", { roleId: role.id, required, grace });
    await interaction.reply({ content: `Set quota for <@&${role.id}> to ${required} logs.`, ephemeral: true });
    return;
  }

  if (subcommand === "role-remove") {
    const role = interaction.options.getRole("role", true);
    db.run("DELETE FROM role_quotas WHERE guild_id = ? AND role_id = ?", guild.id, role.id);
    await writeAuditAndPost(db, guild, interaction.user.id, "quota.role.removed", { roleId: role.id });
    await interaction.reply({ content: `Removed role quota for <@&${role.id}>.`, ephemeral: true });
    return;
  }

  if (subcommand === "schedule") {
    const day = parseWeekday(interaction.options.getString("day", true));
    const { hour, minute } = parseTime(interaction.options.getString("time", true));
    const timezone = interaction.options.getString("timezone", true);
    const frequencyDays = interaction.options.getInteger("frequency_days") ?? 7;
    await setQuotaSchedule(db, guild, interaction.user.id, { checkDay: day, checkHour: hour, checkMinute: minute, timezone, frequencyDays });
    await interaction.reply({ content: `Quota schedule set to ${dayName(day)} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${timezone}.`, ephemeral: true });
    return;
  }

  if (subcommand === "end-now") {
    const report = await closeQuotaPeriod(db, guild, interaction.user.id, interaction.options.getString("reason") ?? "Ended manually");
    await interaction.reply({ content: report ? "Quota period ended and next quota started." : "Quota is not configured yet.", ephemeral: true });
    return;
  }

  if (subcommand === "check-now" || subcommand === "status") {
    await ensureQuotaPeriod(db, guild);
    const config = db.getGuildConfig(guild.id);
    const report = config.quotaPeriodStart && config.quotaPeriodEnd ? buildQuotaReport(db, guild.id, config.quotaPeriodStart, config.quotaPeriodEnd) : null;
    await interaction.reply({
      embeds: report ? [buildQuotaReportEmbed(report, "Current Quota Status")] : [new EmbedBuilder().setTitle("Quota Status").setDescription("Quota is not configured yet.")],
      ephemeral: true
    });
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    db.updateGuildConfig(guild.id, { quota_enabled: subcommand === "enable" ? 1 : 0 });
    await upsertQuotaStatusMessage(db, guild);
    await writeAuditAndPost(db, guild, interaction.user.id, `quota.${subcommand}`, {});
    await interaction.reply({ content: `Quota ${subcommand === "enable" ? "enabled" : "disabled"}.`, ephemeral: true });
    return;
  }

  if (subcommand === "history") {
    const rows = quotaHistory(db, guild.id, 5);
    const lines = rows.map((row) => {
      const statuses = JSON.parse(row.status_json) as Array<{ status: string }>;
      const missed = statuses.filter((status) => status.status === "missed").length;
      return `#${row.id}: ${discordTimestamp(row.period_start, "D")} - ${discordTimestamp(row.period_end, "D")} (${missed} missed)`;
    });
    await interaction.reply({ content: truncate(listOrNone(lines), 1900), ephemeral: true });
    return;
  }

  if (subcommand === "leaderboard") {
    const config = db.getGuildConfig(guild.id);
    const rows = quotaLeaderboard(db, guild.id, config.quotaPeriodStart, config.quotaPeriodEnd);
    await interaction.reply({ embeds: [buildLeaderboardEmbed(rows, "Quota Leaderboard", config.pointsEnabled)], ephemeral: true });
  }
}

async function handleQuotaExempt(interaction: ChatInputCommandInteraction, db: AppDatabase, member: GuildMember) {
  await requireAdmin(db, member);
  const guild = interaction.guild!;
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "add") {
    const moderator = interaction.options.getUser("moderator", true);
    const reason = interaction.options.getString("reason", true);
    const expiresText = interaction.options.getString("expires_at");
    const expires = expiresText ? parseDateInput(expiresText) : null;
    if (expiresText && !expires) throw new Error("Could not parse expires_at. Use an ISO date/time.");
    db.run(
      `INSERT INTO quota_exemptions (guild_id, user_id, reason, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = excluded.created_at`,
      guild.id,
      moderator.id,
      reason,
      expires?.toISOString() ?? null,
      interaction.user.id,
      nowIso()
    );
    await writeAuditAndPost(db, guild, interaction.user.id, "quota.exemption.added", { moderatorUserId: moderator.id, reason, expiresAt: expires?.toISOString() ?? null });
    await interaction.reply({ content: `Exempted <@${moderator.id}>${expires ? ` until ${discordTimestamp(expires, "F")}` : ""}.`, ephemeral: true });
    return;
  }

  if (subcommand === "remove") {
    const moderator = interaction.options.getUser("moderator", true);
    db.run("DELETE FROM quota_exemptions WHERE guild_id = ? AND user_id = ?", guild.id, moderator.id);
    await writeAuditAndPost(db, guild, interaction.user.id, "quota.exemption.removed", { moderatorUserId: moderator.id });
    await interaction.reply({ content: `Removed quota exemption for <@${moderator.id}>.`, ephemeral: true });
    return;
  }

  const rows = db.all<{ user_id: string; reason: string; expires_at: string | null }>("SELECT user_id, reason, expires_at FROM quota_exemptions WHERE guild_id = ?", guild.id);
  const lines = rows.map((row) => `<@${row.user_id}> - ${row.reason}${row.expires_at ? `, expires ${discordTimestamp(row.expires_at, "R")}` : ""}`);
  await interaction.reply({ content: truncate(listOrNone(lines), 1900), ephemeral: true });
}

async function handleTicketlog(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireAdmin(db, member);
  const guild = interaction.guild!;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "pending") {
    const rows = db.all<{ id: number; ticket_id: string | null; ticket_type: string; status: string; due_at: string }>(
      "SELECT id, ticket_id, ticket_type, status, due_at FROM pending_ticket_logs WHERE guild_id = ? AND status IN ('pending', 'needs_review', 'overdue') ORDER BY due_at ASC LIMIT 20",
      guild.id
    );
    const lines = rows.map(
      (row) =>
        `#${row.id} ${row.ticket_id ?? "unknown"} \`${row.ticket_type}\` ${row.status} - due ${discordTimestamp(row.due_at, "R")}`
    );
    await interaction.reply({ content: truncate(listOrNone(lines), 1900), ephemeral: true });
    return;
  }

  if (subcommand === "dismiss") {
    const pendingId = interaction.options.getInteger("pending_id", true);
    const reason = interaction.options.getString("reason", true);
    db.run("UPDATE pending_ticket_logs SET status = 'dismissed', admin_notes = ? WHERE guild_id = ? AND id = ?", reason, guild.id, pendingId);
    await writeAuditAndPost(db, guild, interaction.user.id, "ticket.dismissed", { pendingTicketId: pendingId, reason });
    await interaction.reply({ content: `Dismissed pending ticket #${pendingId}.`, ephemeral: true });
    return;
  }

  if (subcommand === "check-now") {
    await processOverdueTickets(db, guild);
    await interaction.reply({ content: "Ticket overdue check finished.", ephemeral: true });
    return;
  }

  if (subcommand === "map") {
    const ticketType = normalizeTicketType(interaction.options.getString("ticket_type", true));
    const action = normalizeActionName(interaction.options.getString("action", true));
    if (!db.getAction(guild.id, action)) throw new Error(`Action preset "${action}" does not exist.`);
    db.run(
      `INSERT INTO ticket_action_mappings (guild_id, ticket_type, action_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, ticket_type) DO UPDATE SET action_name = excluded.action_name, updated_at = excluded.updated_at`,
      guild.id,
      ticketType,
      action,
      nowIso(),
      nowIso()
    );
    await writeAuditAndPost(db, guild, interaction.user.id, "ticket.mapping.updated", { ticketType, action });
    await interaction.reply({ content: `Mapped ticket type \`${ticketType}\` to action \`${action}\`.`, ephemeral: true });
  }
}

async function handleStaff(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireMod(db, member);
  const guild = interaction.guild!;
  const moderator = interaction.options.getUser("moderator", true);
  const pointsEnabled = db.getGuildConfig(guild.id).pointsEnabled;
  const points = pointsEnabled ? getPointTotal(db, guild.id, moderator.id) : 0;
  const cases = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id = ? AND moderator_user_id = ? AND status = 'active'", guild.id, moderator.id)?.count ?? 0;
  const flags = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id = ? AND moderator_user_id = ? AND flags <> '' AND status = 'active'", guild.id, moderator.id)?.count ?? 0;
  const fields = [
    { name: "Moderator", value: `<@${moderator.id}>`, inline: true },
    ...(pointsEnabled ? [{ name: "Points", value: formatPoints(points), inline: true }] : []),
    { name: "Logged Actions", value: String(cases), inline: true },
    { name: "Review Flags", value: String(flags), inline: true }
  ];
  const embed = new EmbedBuilder()
    .setTitle("Staff Profile")
    .setColor(0x5865f2)
    .addFields(fields)
    .setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleLookup(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireMod(db, member);
  const guild = interaction.guild!;
  const robloxUser = interaction.options.getString("roblox_user")?.trim() || undefined;
  const discordUser = interaction.options.getString("discord_user")?.trim() || undefined;
  const robloxId = interaction.options.getString("roblox_id")?.trim() || undefined;
  const discordId = interaction.options.getString("discord_id")?.trim() || undefined;

  if (!robloxUser && !discordUser && !robloxId && !discordId) {
    await interaction.reply({ content: "Provide at least one search parameter.", ephemeral: true });
    return;
  }

  const cases = db.searchCases(guild.id, { robloxUser, discordUser, robloxId, discordId });
  if (cases.length === 0) {
    await interaction.reply({ content: "No cases found matching those search terms.", ephemeral: true });
    return;
  }

  const lines = cases.map((c) => {
    const action = c.actionDisplayName ?? c.actionName;
    const date = c.createdAt.slice(0, 10);
    const target = [
      c.robloxUsername ? `RobloxUser: ${c.robloxUsername}` : null,
      c.discordUsername ? `DiscordUser: ${c.discordUsername}` : null,
      c.robloxId ? `RobloxID: ${c.robloxId}` : null,
      c.discordId ? `DiscordID: ${c.discordId}` : null
    ].filter(Boolean).join(" | ") || c.targetUsername;
    const reason = truncate(c.reason, 60);
    const status = c.status === "void" ? " [VOID]" : c.approvalStatus === "pending" ? " [PENDING APPROVAL]" : "";
    return `**#${c.id}** ${action.toUpperCase()}${status} — ${target}\n> ${reason} — *${date}*`;
  });

  const searchTerms = [
    robloxUser ? `RobloxUser: ${robloxUser}` : null,
    discordUser ? `DiscordUser: ${discordUser}` : null,
    robloxId ? `RobloxID: ${robloxId}` : null,
    discordId ? `DiscordID: ${discordId}` : null
  ].filter(Boolean).join(", ");

  const embed = new EmbedBuilder()
    .setTitle(`Case Lookup — ${cases.length} result${cases.length === 1 ? "" : "s"}`)
    .setDescription(truncate(lines.join("\n"), 4000))
    .setFooter({ text: `Search: ${searchTerms}${cases.length === 20 ? " · Showing first 20" : ""}` })
    .setColor(0x5865f2)
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

async function handleAudit(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireAdmin(db, member);
  const limit = Math.min(Math.max(interaction.options.getInteger("limit") ?? 10, 1), 25);
  const rows = db.all<{ id: number; actor_user_id: string; action: string; details_json: string; created_at: string }>(
    "SELECT * FROM audit_events WHERE guild_id = ? ORDER BY id DESC LIMIT ?",
    interaction.guild!.id,
    limit
  );
  const lines = rows.map((row) => `#${row.id} ${row.action} by <@${row.actor_user_id}> ${discordTimestamp(row.created_at, "R")}`);
  await interaction.reply({ content: truncate(listOrNone(lines), 1900), ephemeral: true });
}

async function handleBot(interaction: ChatInputCommandInteraction, { db, env }: CommandContext) {
  const guild = interaction.guild!;
  const config = db.getGuildConfig(guild.id);
  const pendingTickets = db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM pending_ticket_logs WHERE guild_id = ? AND status IN ('pending', 'needs_review', 'overdue')",
    guild.id
  )?.count ?? 0;
  const embed = new EmbedBuilder()
    .setTitle("Bot Status")
    .setColor(0x2ecc71)
    .addFields(
      { name: "Database", value: env.databasePath },
      { name: "Point System", value: config.pointsEnabled ? "Enabled" : "Disabled", inline: true },
      { name: "Quota", value: config.quotaEnabled ? `Enabled, ends ${config.quotaPeriodEnd ? discordTimestamp(config.quotaPeriodEnd, "R") : "not scheduled"}` : "Disabled" },
      { name: "Ticket Watcher", value: config.ticketTranscriptChannelId ? `Watching <#${config.ticketTranscriptChannelId}>` : "Not configured" },
      { name: "Pending Tickets", value: String(pendingTickets), inline: true },
      ...(config.pointsEnabled ? [{ name: "Multiplier", value: formatMultiplier(activeMultiplier(config)), inline: true }] : [])
    )
    .setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleBackup(interaction: ChatInputCommandInteraction, { db, env }: CommandContext, member: GuildMember) {
  await requireAdmin(db, member);
  await interaction.deferReply({ ephemeral: true });
  const backupPath = await createBackup(db, env.backupDir);
  await writeAuditAndPost(db, interaction.guild!, interaction.user.id, "backup.created", { backupPath });
  await interaction.editReply(`Created backup: \`${backupPath}\``);
}

async function handleExport(interaction: ChatInputCommandInteraction, { db, env }: CommandContext, member: GuildMember) {
  await requireAdmin(db, member);
  await interaction.deferReply({ ephemeral: true });
  const table = interaction.options.getString("table", true) as "cases" | "points" | "quotas";
  if (table === "points") assertPointsEnabled(db, interaction.guild!.id);
  const { filePath, rows } = await exportTable(db, env.exportDir, interaction.guild!.id, table);
  const attachment = new AttachmentBuilder(filePath);
  await writeAuditAndPost(db, interaction.guild!, interaction.user.id, "export.created", { table, filePath, rows: rows.length });
  await interaction.editReply({ content: `Exported ${rows.length} ${table} records.`, files: [attachment] });
}

function readCaseTarget(interaction: ChatInputCommandInteraction): CaseTarget {
  const discordUser = interaction.options.getUser("discord_user") as User | null;
  return {
    robloxUsername: interaction.options.getString("roblox_user"),
    discordUsername: discordUser ? `${discordUser.tag} (${discordUser.id})` : null,
    robloxId: interaction.options.getString("roblox_id"),
    discordId: discordUser?.id ?? interaction.options.getString("discord_id")
  };
}

function assertPointsEnabled(db: AppDatabase, guildId: string) {
  if (!db.getGuildConfig(guildId).pointsEnabled) {
    throw new Error("The point system is disabled for this server. Use `/modshop enable` to turn it back on.");
  }
}

function caseReplyText(prefix: string, caseId: number, awardedPointsMilli: number, pointsEnabled: boolean) {
  return pointsEnabled
    ? `${prefix} case #${caseId} for ${formatPoints(awardedPointsMilli)} points.`
    : `${prefix} case #${caseId}.`;
}

function readConfigRoleUpdates(interaction: ChatInputCommandInteraction) {
  const staffRoleOptions: Array<{ key: StaffRoleKey; option: string }> = [
    { key: "staff", option: "staff_role" },
    { key: "communityManager", option: "community_manager_role" },
    { key: "headMod", option: "head_mod_role" },
    { key: "seniorMod", option: "senior_mod_role" },
    { key: "mod", option: "normal_mod_role" },
    { key: "juniorMod", option: "junior_mod_role" }
  ];
  const staffRoles = staffRoleOptions
    .map(({ key, option }) => ({ key, role: interaction.options.getRole(option) as Role | null }))
    .filter((update): update is { key: StaffRoleKey; role: Role } => Boolean(update.role));

  // Legacy: mod_role = normal mod tier, admin_role = community manager tier
  const legacyMod = interaction.options.getRole("mod_role") as Role | null;
  const legacyAdmin = interaction.options.getRole("admin_role") as Role | null;
  if (legacyMod && !staffRoles.some((r) => r.key === "mod")) {
    staffRoles.push({ key: "mod", role: legacyMod });
  }
  if (legacyAdmin && !staffRoles.some((r) => r.key === "communityManager")) {
    staffRoles.push({ key: "communityManager", role: legacyAdmin });
  }

  return {
    staffRoles,
    canRegisterRole: interaction.options.getRole("can_register_role") as Role | null,
    legacyModRole: (legacyMod ?? interaction.options.getRole("normal_mod_role") ?? interaction.options.getRole("junior_mod_role")) as Role | null,
    legacyAdminRole: (legacyAdmin ?? interaction.options.getRole("head_mod_role") ?? interaction.options.getRole("community_manager_role")) as Role | null
  };
}

function upsertStaffRole(db: AppDatabase, guildId: string, key: StaffRoleKey, role: Role) {
  const spec = staffRoleSpecs.find((entry) => entry.key === key);
  if (!spec) return;
  const timestamp = nowIso();
  db.run("DELETE FROM staff_roles WHERE guild_id = ? AND role_key = ? AND role_id <> ?", guildId, key, role.id);
  db.run(
    `INSERT INTO staff_roles (guild_id, role_id, role_key, name, level, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, role_id) DO UPDATE SET
       role_key = excluded.role_key,
       name = excluded.name,
       level = excluded.level,
       is_admin = excluded.is_admin,
       updated_at = excluded.updated_at`,
    guildId,
    role.id,
    key,
    role.name,
    spec.level,
    spec.isAdmin ? 1 : 0,
    timestamp,
    timestamp
  );
}

function readConfigActionLogChannelUpdates(interaction: ChatInputCommandInteraction) {
  const mappings = [
    { option: "logingame", actionName: "ban" },
    { option: "logstrike", actionName: "strike" },
    { option: "logrestore", actionName: "restore" },
    { option: "logdiscord", actionName: "discord" },
    { option: "logdiscord", actionName: "discord-ban" },
    { option: "logticket", actionName: "ticket" },
    { option: "logappeal", actionName: "appeal" }
  ];
  return mappings
    .map(({ option, actionName }) => ({ actionName, channel: getTextChannelOption(interaction, option) }))
    .filter((update): update is { actionName: string; channel: TextChannel } => Boolean(update.channel));
}

function upsertActionLogChannel(db: AppDatabase, guildId: string, actionName: string, channelId: string) {
  const timestamp = nowIso();
  db.run(
    `INSERT INTO action_log_channels (guild_id, action_name, channel_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, action_name) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
    guildId,
    actionName.toLowerCase(),
    channelId,
    timestamp,
    timestamp
  );
}

function readSetupRoleOverrides(interaction: ChatInputCommandInteraction): Partial<Record<StaffRoleKey, Role | null>> {
  return {
    staff: interaction.options.getRole("staff_role") as Role | null,
    communityManager: interaction.options.getRole("community_manager_role") as Role | null,
    headMod: interaction.options.getRole("head_mod_role") as Role | null,
    seniorMod: interaction.options.getRole("senior_mod_role") as Role | null,
    mod: interaction.options.getRole("normal_mod_role") as Role | null,
    juniorMod: interaction.options.getRole("junior_mod_role") as Role | null
  };
}

function readCanRegisterRoleOverride(interaction: ChatInputCommandInteraction) {
  return interaction.options.getRole("can_register_role") as Role | null;
}

function readSetupChannelOverrides(interaction: ChatInputCommandInteraction): Partial<Record<SetupChannelKey, TextChannel | null>> {
  return {
    caseLogs: getTextChannelOption(interaction, "logs_channel"),
    modAlerts: getTextChannelOption(interaction, "mod_alerts_channel"),
    quota: getTextChannelOption(interaction, "quota_channel"),
    staffRegistration: getTextChannelOption(interaction, "staff_registration_channel"),
    auditLog: getTextChannelOption(interaction, "audit_channel"),
    logBan: getTextChannelOption(interaction, "logingame_channel"),
    logStrike: getTextChannelOption(interaction, "logstrike_channel"),
    logRestore: getTextChannelOption(interaction, "logrestore_channel"),
    logDiscord: getTextChannelOption(interaction, "logdiscord_channel"),
    logTicket: getTextChannelOption(interaction, "logticket_channel"),
    logAppeal: getTextChannelOption(interaction, "logappeal_channel"),
    stewardLog: null
  };
}

function getTextChannelOption(interaction: ChatInputCommandInteraction, name: string) {
  const channel = interaction.options.getChannel(name);
  return channel?.type === ChannelType.GuildText ? (channel as TextChannel) : null;
}

async function ensureProvisionedForStaffRole(db: AppDatabase, guild: Guild) {
  const config = db.getGuildConfig(guild.id);
  const staffRole = db.listStaffRoles(guild.id).find((role) => role.key === "staff");
  const fetched = staffRole ? await guild.roles.fetch(staffRole.roleId).catch(() => null) : null;
  if (fetched) {
    const provisioned = await provisionModerationServer(guild, {
      savedRoleIds: savedRoleIdsFromDb(db, guild.id),
      savedChannelIds: savedChannelIdsFromConfig(db, guild.id)
    });
    saveProvisionedConfig(db, guild.id, provisioned, config.ownerUserId ?? undefined);
    return provisioned;
  }
  const provisioned = await provisionModerationServer(guild, {
    savedRoleIds: savedRoleIdsFromDb(db, guild.id),
    savedChannelIds: savedChannelIdsFromConfig(db, guild.id)
  });
  saveProvisionedConfig(db, guild.id, provisioned, config.ownerUserId ?? undefined);
  return provisioned;
}

function saveProvisionedConfig(db: AppDatabase, guildId: string, provisioned: ProvisionedServer, ownerUserId?: string | null) {
  db.updateGuildConfig(guildId, {
    mod_role_id: provisioned.roles.juniorMod.id,
    admin_role_id: provisioned.roles.headMod.id,
    owner_user_id: ownerUserId ?? undefined,
    action_log_channel_id: provisioned.channels.caseLogs.id,
    strike_log_channel_id: provisioned.channels.logStrike.id,
    quota_channel_id: provisioned.channels.quota.id,
    staff_registration_channel_id: provisioned.channels.staffRegistration.id,
    registration_role_id: provisioned.canRegisterRole.id,
    audit_channel_id: provisioned.channels.auditLog.id,
    alert_channel_id: provisioned.channels.modAlerts.id,
    appeal_log_channel_id: provisioned.channels.logAppeal.id,
    steward_log_channel_id: provisioned.channels.stewardLog.id
  });
  db.replaceStaffRoles(
    guildId,
    staffRoleSpecs.map((spec) => ({
      key: spec.key,
      roleId: provisioned.roles[spec.key].id,
      name: spec.name,
      level: spec.level,
      isAdmin: spec.isAdmin
    }))
  );
  db.replaceActionLogChannels(guildId, [
    { actionName: "ban", channelId: provisioned.channels.logBan.id },
    { actionName: "strike", channelId: provisioned.channels.logStrike.id },
    { actionName: "restore", channelId: provisioned.channels.logRestore.id },
    { actionName: "discord-ban", channelId: provisioned.channels.logDiscord.id },
    { actionName: "discord", channelId: provisioned.channels.logDiscord.id },
    { actionName: "ticket", channelId: provisioned.channels.logTicket.id },
    { actionName: "appeal", channelId: provisioned.channels.logAppeal.id }
  ]);
}

function savedRoleIdsFromDb(db: AppDatabase, guildId: string): Partial<Record<StaffRoleKey, string | null>> {
  const ids: Partial<Record<StaffRoleKey, string | null>> = {};
  for (const role of db.listStaffRoles(guildId)) {
    const key = normalizeStoredRoleKey(role.key, role.name);
    if (key) ids[key] = role.roleId;
  }
  return ids;
}

function savedChannelIdsFromConfig(db: AppDatabase, guildId: string): Partial<Record<SetupChannelKey, string | null>> {
  const config = db.getGuildConfig(guildId);
  return {
    caseLogs: config.actionLogChannelId,
    logBan: db.getActionLogChannelId(guildId, "ban"),
    logStrike: db.getActionLogChannelId(guildId, "strike") ?? config.strikeLogChannelId,
    logRestore: db.getActionLogChannelId(guildId, "restore"),
    logDiscord: db.getActionLogChannelId(guildId, "discord") ?? db.getActionLogChannelId(guildId, "discord-ban"),
    logTicket: db.getActionLogChannelId(guildId, "ticket"),
    logAppeal: config.appealLogChannelId,
    quota: config.quotaChannelId,
    auditLog: config.auditChannelId,
    modAlerts: config.alertChannelId,
    staffRegistration: config.staffRegistrationChannelId,
    stewardLog: config.stewardLogChannelId
  };
}

function normalizeStoredRoleKey(key: string, name: string): StaffRoleKey | null {
  if (isStaffRoleKey(key)) return key;
  const normalized = name.toLowerCase().replace(/\s+/g, "-");
  if (normalized === "staff") return "staff";
  if (normalized === "junior-mod") return "juniorMod";
  if (normalized === "mod" || normalized === "normal-mod") return "mod";
  if (normalized === "senior-mod") return "seniorMod";
  if (normalized === "head-mod") return "headMod";
  if (normalized === "community-manager") return "communityManager";
  return null;
}

function isStaffRoleKey(value: string): value is StaffRoleKey {
  return ["staff", "juniorMod", "mod", "seniorMod", "headMod", "communityManager"].includes(value);
}

function configEmbed(db: AppDatabase, guildId: string) {
  const game = db.getAutoRobloxGame(guildId) ?? db.listRobloxGames(guildId)[0];
  return configSummaryEmbed(db.getGuildConfig(guildId), {
    ingameLogChannelId: db.getActionLogChannelId(guildId, "ban"),
    robloxGame: game ? { name: game.name, universeId: game.universeId } : null
  });
}

const DEV_USER_ID = "616267913799925782";

function requireServerOwner(member: GuildMember) {
  if (member.id === DEV_USER_ID) return;
  if (member.id !== member.guild.ownerId) throw new Error("Only the server owner can use that command.");
}

function normalizeActionName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 50);
}

async function handleUpdateBot(interaction: ChatInputCommandInteraction, context: CommandContext, member: GuildMember) {
  requireServerOwner(member);
  await interaction.deferReply({ ephemeral: true });

  let pullOutput = "";
  try {
    await interaction.editReply("Pulling latest code from GitHub...");
    pullOutput = execSync("git pull", { encoding: "utf8", cwd: process.cwd() });
  } catch (error) {
    const detail = execError(error);
    await interaction.editReply(`Git pull failed:\n\`\`\`\n${detail.slice(0, 1800)}\n\`\`\``);
    return;
  }

  let buildOutput = "";
  try {
    await interaction.editReply(`Pulled.\n\`\`\`\n${pullOutput.trim().slice(0, 800)}\n\`\`\`\nBuilding...`);
    buildOutput = execSync("npm run build", { encoding: "utf8", cwd: process.cwd() });
  } catch (error) {
    const detail = execError(error);
    await interaction.editReply(`Build failed:\n\`\`\`\n${detail.slice(0, 1800)}\n\`\`\``);
    return;
  }

  let deployOutput = "";
  try {
    await interaction.editReply(`Built. Deploying slash commands...`);
    deployOutput = execSync("npm run deploy", { encoding: "utf8", cwd: process.cwd() });
  } catch (error) {
    const detail = execError(error);
    await interaction.editReply(`Deploy failed:\n\`\`\`\n${detail.slice(0, 1800)}\n\`\`\``);
    return;
  }

  const summary = [pullOutput.trim(), buildOutput.trim(), deployOutput.trim()].filter(Boolean).join("\n").slice(0, 1600);
  await interaction.editReply(`Update complete. Restarting bot...\n\`\`\`\n${summary}\n\`\`\``);
  const dataDir = path.dirname(context.env.databasePath);
  const notes = interaction.options.getString("notes") ?? undefined;
  await postGoingDown(context.db, interaction.client, dataDir, notes).catch(() => null);
  setTimeout(() => process.exit(75), 500);
}

async function handleConfigCheck(interaction: ChatInputCommandInteraction, db: AppDatabase, guildId: string) {
  const config = db.getGuildConfig(guildId);
  const staffRoles = db.listStaffRoles(guildId);
  const tierLabels: Array<{ key: string; label: string }> = [
    { key: "staff", label: "Staff" },
    { key: "communityManager", label: "Community Manager" },
    { key: "headMod", label: "Head Mod" },
    { key: "seniorMod", label: "Senior Mod" },
    { key: "mod", label: "Normal Mod" },
    { key: "juniorMod", label: "Junior Mod" }
  ];

  const ch = (id: string | null | undefined, label: string, optional = false) =>
    id ? `✅ ${label}: <#${id}>` : optional ? `⬜ ${label}: Not set (optional)` : `❌ ${label}: Not set`;
  const role = (id: string | null | undefined, label: string, optional = false) =>
    id ? `✅ ${label}: <@&${id}>` : optional ? `⬜ ${label}: Not set (optional)` : `❌ ${label}: Not set`;
  const user = (id: string | null | undefined, label: string) =>
    id ? `✅ ${label}: <@${id}>` : `❌ ${label}: Not set`;
  const bool = (value: boolean, label: string) =>
    value ? `✅ ${label}` : `❌ ${label}: Not configured`;

  const channelLines = [
    ch(config.actionLogChannelId, "Action Log (fallback)"),
    ch(db.getActionLogChannelId(guildId, "ban"), "Ingame Log"),
    ch(db.getActionLogChannelId(guildId, "strike"), "Strike Log"),
    ch(db.getActionLogChannelId(guildId, "restore"), "Restore Log"),
    ch(db.getActionLogChannelId(guildId, "discord"), "Discord Log"),
    ch(db.getActionLogChannelId(guildId, "ticket"), "Ticket Log"),
    ch(db.getActionLogChannelId(guildId, "other"), "Other Log", true),
    ch(config.appealLogChannelId ?? db.getActionLogChannelId(guildId, "appeal"), "Appeal Log"),
    ch(config.alertChannelId, "Alerts"),
    ch(config.auditChannelId, "Audit Log"),
    ch(config.quotaChannelId, "Quota Board"),
    ch(config.quotaAlertChannelId, "Quota Alerts"),
    ch(config.staffRegistrationChannelId, "Staff Registration"),
    ch(config.ticketTranscriptChannelId, "Ticket Transcripts", true),
    ch(config.evidenceArchiveChannelId, "Evidence Archive", true),
    ch(config.approvalChannelId, "CM Approval", true),
    ch(config.juniorHelpChannelId, "Junior Help", true),
    ch(config.stewardLogChannelId, "Steward Log", true),
    ch(config.shoutsChannelId, "Shouts Channel", true)
  ];
  const roleLines = [
    ...tierLabels.map(({ key, label }) => {
      const found = staffRoles.find((r) => r.key === key);
      return found ? `✅ ${label}: <@&${found.roleId}>` : `❌ ${label}: Not set`;
    }),
    role(config.registrationRoleId, "Can Register"),
    config.juniorEscalationRoleIds.length > 0 ? `✅ Junior Escalation: configured` : `⬜ Junior Escalation: Not set (optional)`,
    config.juniorOtherEscalationRoleIds.length > 0 ? `✅ Junior Other Escalation: configured` : `⬜ Junior Other Escalation: Not set (optional)`
  ];
  const otherLines = [
    user(config.ownerUserId, "Owner DM"),
    bool(config.interactiveLogEnabled, "Interactive Log Enabled"),
    bool(config.approvalEnabled, "CM Approval Enabled"),
    bool(config.pointsEnabled, "Point System Enabled"),
    bool(config.quotaEnabled, "Quota Enabled"),
    bool(Boolean(config.quotaPeriodStart && config.quotaPeriodEnd), "Quota Period Active"),
    config.linkedGuildId ? `✅ Linked Server: \`${config.linkedGuildId}\`` : `⬜ Linked Server: Not set (optional)`,
    config.moderationInvite ? `✅ Moderation Invite: set` : `⬜ Moderation Invite: Not set (optional)`,
    `${config.autoPunishDisabled.includes("ingame")  ? "❌" : "✅"} Auto-Punish Ingame Bans: ${config.autoPunishDisabled.includes("ingame")  ? "Off" : "On"}`,
    `${config.autoPunishDisabled.includes("appeal")  ? "❌" : "✅"} Auto-Punish Ingame Unbans: ${config.autoPunishDisabled.includes("appeal")  ? "Off" : "On"}`,
    `${config.autoPunishDisabled.includes("discord") ? "❌" : "✅"} Auto-Punish Discord Actions: ${config.autoPunishDisabled.includes("discord") ? "Off" : "On"}`
  ];

  const allLines = [...channelLines, ...roleLines, ...otherLines];
  const missing = allLines.filter((l) => l.startsWith("❌")).length;
  const title = missing === 0 ? "✅ All critical configs are set" : `⚠️ ${missing} critical config${missing !== 1 ? "s" : ""} not set`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(missing === 0 ? 0x2ecc71 : 0xe67e22)
    .addFields(
      { name: "Channels", value: channelLines.join("\n"), inline: false },
      { name: "Roles", value: roleLines.join("\n"), inline: false },
      { name: "Other", value: otherLines.join("\n"), inline: false }
    )
    .setFooter({ text: "⬜ = optional  ❌ = missing  ✅ = configured" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleRefresh(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember) {
  await requireAdmin(db, member);
  const guild = interaction.guild!;
  const config = db.getGuildConfig(guild.id);
  if (!config.approvalChannelId) {
    await interaction.reply({ content: "No CM approval channel is configured. Set one with `/config channels approval_channel`.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const count = await refreshApprovalChannel(db, guild);
  await interaction.editReply(`Refreshed approval channel: re-posted ${count} pending case${count !== 1 ? "s" : ""}.`);
}

// ── Promote / Demote ─────────────────────────────────────────────────────────

/**
 * The ordered tier ladder, lowest → highest.
 * "staff" (base) is intentionally excluded — it's never swapped by promote/demote.
 */
const TIER_LADDER: StaffRoleKey[] = ["juniorMod", "mod", "seniorMod", "headMod", "communityManager"];

const TIER_DISPLAY: Record<string, string> = {
  staff: "Staff",
  juniorMod: "Junior Mod",
  mod: "Mod",
  seniorMod: "Senior Mod",
  headMod: "Head Mod",
  communityManager: "Community Manager",
};

/**
 * Finds the configured staff role entry for a given tier key.
 * Matches by DB key first, then falls back to canonical name matching.
 */
function findTierConfig(key: StaffRoleKey, staffRoles: Array<{ key: string; roleId: string; name: string }>) {
  return staffRoles.find((r) => {
    if (r.key === key) return true;
    const n = r.name.toLowerCase().replace(/\s+/g, "-");
    return (key === "juniorMod" && n === "junior-mod")
      || (key === "mod" && (n === "mod" || n === "normal-mod"))
      || (key === "seniorMod" && n === "senior-mod")
      || (key === "headMod" && n === "head-mod")
      || (key === "communityManager" && n === "community-manager");
  }) ?? null;
}

/**
 * Returns the highest tier key the member currently holds, or null if none.
 * Checks by role ID then falls back to role name matching.
 */
function getMemberTierKey(
  member: GuildMember,
  staffRoles: Array<{ key: string; roleId: string; name: string }>
): StaffRoleKey | null {
  for (let i = TIER_LADDER.length - 1; i >= 0; i--) {
    const key = TIER_LADDER[i];
    const cfg = findTierConfig(key, staffRoles);
    if (!cfg) continue;
    if (member.roles.cache.has(cfg.roleId) ||
        member.roles.cache.some((r) => r.name.toLowerCase() === cfg.name.toLowerCase())) {
      return key;
    }
  }
  return null;
}

/**
 * Removes fromKey role and adds toKey role for a member in the given guild.
 * Returns a status string describing what happened.
 */
async function applyTierChange(
  guild: Guild,
  userId: string,
  fromKey: StaffRoleKey,
  toKey: StaffRoleKey,
  staffRoles: Array<{ key: string; roleId: string; name: string }>,
  reason: string
): Promise<"ok" | "no_member" | "role_missing"> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return "no_member";

  // Remove old tier role
  const fromCfg = findTierConfig(fromKey, staffRoles);
  if (fromCfg) {
    const oldRole = guild.roles.cache.get(fromCfg.roleId)
      ?? guild.roles.cache.find((r) => r.name.toLowerCase() === fromCfg.name.toLowerCase());
    if (oldRole && member.roles.cache.has(oldRole.id)) {
      await member.roles.remove(oldRole, reason).catch(() => null);
    }
  }

  // Add new tier role
  const toCfg = findTierConfig(toKey, staffRoles);
  if (!toCfg) return "role_missing";
  const newRole = guild.roles.cache.get(toCfg.roleId)
    ?? guild.roles.cache.find((r) => r.name.toLowerCase() === toCfg.name.toLowerCase());
  if (!newRole) return "role_missing";
  if (!member.roles.cache.has(newRole.id)) {
    await member.roles.add(newRole, reason).catch(() => null);
  }

  return "ok";
}

async function handlePromoteOrDemote(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  actor: GuildMember,
  direction: "promote" | "demote"
) {
  const { db } = context;
  const guild = interaction.guild!;
  const guildConfig = db.getGuildConfig(guild.id);
  const canAct = await isAdminMember(db, actor)
    || guildConfig.promoteDemoteRoleIds.some((id) => actor.roles.cache.has(id));
  if (!canAct) {
    await interaction.reply({ content: "You don't have permission to use this command.", ephemeral: true });
    return;
  }
  const targetUser = interaction.options.getUser("member", true);
  const reason = direction === "demote" ? (interaction.options.getString("reason") ?? null) : null;
  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null) as GuildMember | null;

  if (!targetMember) {
    await interaction.reply({ content: "That user isn't in this server.", ephemeral: true });
    return;
  }

  // Prevent self-promotion/demotion
  if (targetMember.id === actor.id) {
    await interaction.reply({ content: "You can't promote or demote yourself.", ephemeral: true });
    return;
  }

  const staffRoles = db.listStaffRoles(guild.id);
  const currentKey = getMemberTierKey(targetMember, staffRoles);

  if (!currentKey) {
    await interaction.reply({
      content: `${targetUser.tag} doesn't have a configured staff tier role in this server.`,
      ephemeral: true
    });
    return;
  }

  const currentIdx = TIER_LADDER.indexOf(currentKey);
  const newIdx = direction === "promote" ? currentIdx + 1 : currentIdx - 1;

  if (newIdx < 0) {
    await interaction.reply({
      content: `${targetUser.tag} is already at the lowest tier (Junior Mod) and can't be demoted further.`,
      ephemeral: true
    });
    return;
  }
  if (newIdx >= TIER_LADDER.length) {
    await interaction.reply({
      content: `${targetUser.tag} is already at the highest tier (Community Manager) and can't be promoted further.`,
      ephemeral: true
    });
    return;
  }

  const newKey = TIER_LADDER[newIdx];
  const verb = direction === "promote" ? "Promoted" : "Demoted";
  const auditReason = `${verb} by ${actor.user.tag} (${actor.id}) via /${direction}${reason ? `: ${reason}` : ""}`;

  await interaction.deferReply();

  // Apply in primary guild
  const mainResult = await applyTierChange(guild, targetMember.id, currentKey, newKey, staffRoles, auditReason);

  // Apply in linked guild if configured
  let linkedInfo = "";
  const config = db.getGuildConfig(guild.id);
  if (config.linkedGuildId) {
    const linkedGuild = interaction.client.guilds.cache.get(config.linkedGuildId)
      ?? await interaction.client.guilds.fetch(config.linkedGuildId).catch(() => null);
    if (linkedGuild) {
      const linkedStaffRoles = db.listStaffRoles(linkedGuild.id);
      const linkedResult = await applyTierChange(linkedGuild, targetMember.id, currentKey, newKey, linkedStaffRoles, auditReason);
      linkedInfo = linkedResult === "ok"
        ? `\n✅ Also applied in **${linkedGuild.name}**.`
        : linkedResult === "no_member"
          ? `\n⚠️ **${linkedGuild.name}**: member not found there (they may not be in that server).`
          : `\n⚠️ **${linkedGuild.name}**: role not configured — set it up with \`/config roles\`.`;
    } else {
      linkedInfo = "\n⚠️ Could not fetch the linked server.";
    }
  }

  const fromLabel = TIER_DISPLAY[currentKey];
  const toLabel = TIER_DISPLAY[newKey];

  if (mainResult === "ok") {
    // DM the member if this is a demotion
    if (direction === "demote") {
      const dmLines = [
        `**You have been demoted in ${guild.name}.**`,
        ``,
        `**Previous rank:** ${fromLabel}`,
        `**New rank:** ${toLabel}`,
        reason ? `**Reason:** ${reason}` : null,
        ``,
        `This action was taken by the moderation team. If you have questions, please reach out to a senior staff member.`
      ].filter(Boolean).join("\n");
      await targetUser.send(dmLines).catch(() => null);
    }

    await interaction.editReply({
      content: `${direction === "promote" ? "⬆️" : "⬇️"} **${verb}** <@${targetUser.id}>\n${fromLabel} → **${toLabel}**${linkedInfo}`
    });
  } else if (mainResult === "role_missing") {
    await interaction.editReply({
      content: `❌ The **${toLabel}** role isn't configured for this server. Set it up with \`/config roles\`.`
    });
  } else {
    await interaction.editReply({ content: "❌ Could not fetch that member." });
  }
}

// ── Fire ─────────────────────────────────────────────────────────────────────

/** Remove every configured staff role from a member in the given guild. */
async function stripAllStaffRoles(
  guild: Guild,
  userId: string,
  staffRoles: Array<{ key: string; roleId: string; name: string }>,
  reason: string
): Promise<{ removed: string[]; notInServer: boolean }> {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { removed: [], notInServer: true };

  const removed: string[] = [];
  for (const cfg of staffRoles) {
    const role = guild.roles.cache.get(cfg.roleId)
      ?? guild.roles.cache.find((r) => r.name.toLowerCase() === cfg.name.toLowerCase());
    if (role && member.roles.cache.has(role.id)) {
      await member.roles.remove(role, reason).catch(() => null);
      removed.push(cfg.name);
    }
  }
  return { removed, notInServer: false };
}

async function handleFire(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  actor: GuildMember
) {
  await requireAdmin(context.db, actor);

  const { db } = context;
  const guild = interaction.guild!;
  const targetUser = interaction.options.getUser("member", true);
  const reason = interaction.options.getString("reason") ?? "No reason provided.";

  if (targetUser.id === actor.id) {
    await interaction.reply({ content: "You can't fire yourself.", ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const fireReason = `Fired by ${actor.user.tag} (${actor.id}): ${reason}`;
  const config = db.getGuildConfig(guild.id);
  const staffRoles = db.listStaffRoles(guild.id);

  // Strip all staff roles in the primary guild
  const { removed: mainRemoved, notInServer: mainMissing } = await stripAllStaffRoles(
    guild, targetUser.id, staffRoles, fireReason
  );

  // Mark inactive in staff_members for the primary guild
  db.deactivateStaffMember(guild.id, targetUser.id);

  // Apply in linked guild if configured
  let linkedInfo = "";
  if (config.linkedGuildId) {
    const linkedGuild = interaction.client.guilds.cache.get(config.linkedGuildId)
      ?? await interaction.client.guilds.fetch(config.linkedGuildId).catch(() => null) as Guild | null;
    if (linkedGuild) {
      const linkedStaffRoles = db.listStaffRoles(linkedGuild.id);
      const { removed: linkedRemoved, notInServer: linkedMissing } = await stripAllStaffRoles(
        linkedGuild, targetUser.id, linkedStaffRoles, fireReason
      );
      db.deactivateStaffMember(linkedGuild.id, targetUser.id);
      linkedInfo = linkedMissing
        ? `\n⚠️ **${linkedGuild.name}**: member not found there.`
        : linkedRemoved.length > 0
          ? `\n✅ **${linkedGuild.name}**: removed ${linkedRemoved.join(", ")}.`
          : `\n✅ **${linkedGuild.name}**: no staff roles found to remove.`;
    } else {
      linkedInfo = "\n⚠️ Could not fetch the linked server.";
    }
  }

  // DM the fired member
  const dmLines = [
    `**You have been removed from the staff team in ${guild.name}.**`,
    ``,
    `**Reason:** ${reason}`,
    ``,
    `All staff roles have been removed. If you believe this was a mistake, please contact a senior staff member.`
  ].join("\n");
  await targetUser.send(dmLines).catch(() => null);

  const mainLine = mainMissing
    ? "Member is not in this server."
    : mainRemoved.length > 0
      ? `Removed: ${mainRemoved.join(", ")}`
      : "No staff roles found to remove.";

  await interaction.editReply({
    content: `🔴 **Fired** <@${targetUser.id}>\n**Reason:** ${reason}\n**This server:** ${mainLine}${linkedInfo}`
  });
}

// ── Setup Secondary (Jail Infrastructure) ─────────────────────────────────────

async function handleSetupSecondary(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  _member: GuildMember
) {
  const subcommand = interaction.options.getSubcommand(true);
  const { db } = context;
  const guild = interaction.guild!;

  // ── /setupsecondary roles ─────────────────────────────────────────────────
  if (subcommand === "roles") {
    await interaction.deferReply({ ephemeral: true });

    await guild.roles.fetch();

    // Alternate name aliases to try when searching by name
    const TIER_NAME_ALIASES: Record<StaffRoleKey, string[]> = {
      staff:            ["staff"],
      juniorMod:        ["junior mod", "junior moderator", "jr mod", "jr moderator", "junior"],
      mod:              ["mod", "moderator", "normal mod", "normal moderator"],
      seniorMod:        ["senior mod", "senior moderator", "sr mod", "sr moderator", "senior"],
      headMod:          ["head mod", "head moderator", "hmod", "head"],
      communityManager: ["community manager", "cm", "community mod", "community moderator"],
    };

    const tierOptions: Array<{ key: StaffRoleKey; option: string }> = [
      { key: "staff",            option: "staff_role" },
      { key: "juniorMod",        option: "junior_mod" },
      { key: "mod",              option: "mod" },
      { key: "seniorMod",        option: "senior_mod" },
      { key: "headMod",          option: "head_mod" },
      { key: "communityManager", option: "community_manager" },
    ];

    // Already-saved roles from DB so we can fall back to them
    const existingStaffRoles = db.listStaffRoles(guild.id);

    type TierResult = { key: StaffRoleKey; role: Role; source: "explicit" | "name-match" | "saved" };
    const results: TierResult[] = [];
    const notFound: StaffRoleKey[] = [];

    for (const { key, option } of tierOptions) {
      const explicit = interaction.options.getRole(option) as Role | null;
      if (explicit) {
        results.push({ key, role: explicit, source: "explicit" });
        continue;
      }

      // Try name-matching against the guild's roles
      const aliases = TIER_NAME_ALIASES[key];
      const byName = guild.roles.cache.find(
        (r) => !r.managed && aliases.some((alias) => r.name.toLowerCase() === alias)
      ) ?? null;
      if (byName) {
        results.push({ key, role: byName, source: "name-match" });
        continue;
      }

      // Fall back to already-saved DB entry for this key
      const saved = existingStaffRoles.find((r) => r.key === key);
      const savedRole = saved ? guild.roles.cache.get(saved.roleId) ?? null : null;
      if (savedRole) {
        results.push({ key, role: savedRole, source: "saved" });
        continue;
      }

      notFound.push(key);
    }

    if (results.length === 0) {
      await interaction.editReply(
        "❌ No roles found. Either pass roles explicitly (e.g. `junior_mod:@Junior Mod`) or make sure the server has roles whose names match the tier names (e.g. \"Junior Mod\", \"Mod\", \"Senior Mod\", \"Head Mod\", \"Community Manager\")."
      );
      return;
    }

    for (const { key, role } of results) {
      upsertStaffRole(db, guild.id, key, role);
    }

    // Mark as secondary — command set will be trimmed on next bot restart
    db.updateGuildConfig(guild.id, { is_secondary: 1 });

    const sourceLabel = { explicit: "✅ set", "name-match": "🔍 auto-detected", saved: "💾 kept from DB" };
    const lines = results.map(({ key, role, source }) =>
      `• **${TIER_DISPLAY[key]}** → ${role.name} (\`${role.id}\`) — ${sourceLabel[source]}`
    );
    const missingLines = notFound.length > 0
      ? `\n\n⚠️ Not found (set manually with role options): ${notFound.map((k) => `**${TIER_DISPLAY[k]}**`).join(", ")}`
      : "";

    await interaction.editReply(
      `**Staff tier roles configured:**\n${lines.join("\n")}${missingLines}\n\n` +
      `This server is now marked as a **secondary server**.\n🔄 Restart the bot to apply the trimmed command set to this server.`
    );
    return;
  }

  // ── /setupsecondary list ──────────────────────────────────────────────────
  if (subcommand === "list") {
    await interaction.deferReply({ ephemeral: true });

    const staffRoles = db.listStaffRoles(guild.id);
    const config = db.getGuildConfig(guild.id);

    const tierLines = TIER_LADDER.map((key) => {
      const cfg = findTierConfig(key, staffRoles);
      const label = TIER_DISPLAY[key];
      return cfg
        ? `• **${label}** → <@&${cfg.roleId}> (\`${cfg.roleId}\`)`
        : `• **${label}** → *(not configured)*`;
    });

    const jailLines = [
      config.jailedRoleId ? `• Jailed Role: <@&${config.jailedRoleId}>` : `• Jailed Role: *(not set — run \`/setupsecondary jail\`)*`,
      config.jailCategoryId ? `• Jail Category: <#${config.jailCategoryId}>` : null,
      config.jailChatId ? `• Jail Chat: <#${config.jailChatId}>` : null,
      config.jailAnnouncementsId ? `• Jail Announcements: <#${config.jailAnnouncementsId}>` : null,
    ].filter(Boolean);

    const promoteDemoteRoles = config.promoteDemoteRoleIds.length > 0
      ? config.promoteDemoteRoleIds.map((id) => `<@&${id}>`).join(", ")
      : "*(not set — only server admins can promote/demote)*";

    await interaction.editReply(
      `**Secondary Server Config — ${guild.name}**\n\n` +
      `**Staff Tier Roles:**\n${tierLines.join("\n")}\n\n` +
      `**Jail Infrastructure:**\n${jailLines.join("\n")}\n\n` +
      `**Promote/Demote Roles:** ${promoteDemoteRoles}`
    );
    return;
  }

  // ── /setupsecondary jail ──────────────────────────────────────────────────
  await interaction.deferReply({ ephemeral: true });
  const lines: string[] = [];

  // 1. Create/find the "Jailed" role
  let jailedRole = guild.roles.cache.find((r) => r.name === "Jailed")
    ?? await guild.roles.create({ name: "Jailed", permissions: [], reason: "Jail setup" });
  lines.push(`Role: ${jailedRole.name} (${jailedRole.id})`);

  // 2. Create/find the "Jailed" category with permission overwrites
  let jailCategory = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === "Jailed"
  ) as CategoryChannel | undefined;

  const categoryPermissions = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: jailedRole.id, allow: [PermissionFlagsBits.ViewChannel] }
  ];

  if (!jailCategory) {
    jailCategory = await guild.channels.create({
      name: "Jailed",
      type: ChannelType.GuildCategory,
      permissionOverwrites: categoryPermissions,
      reason: "Jail setup"
    }) as CategoryChannel;
    lines.push(`Created category: Jailed (${jailCategory.id})`);
  } else {
    await jailCategory.edit({ permissionOverwrites: categoryPermissions, reason: "Jail setup update" });
    lines.push(`Updated category: Jailed (${jailCategory.id})`);
  }

  // 3. Create/find #jailed-chat
  let jailChat = jailCategory.children.cache.find((c) => c.name === "jailed-chat") as TextChannel | undefined;
  if (!jailChat) {
    jailChat = await guild.channels.create({
      name: "jailed-chat",
      type: ChannelType.GuildText,
      parent: jailCategory.id,
      rateLimitPerUser: 21600,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: jailedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
      ],
      reason: "Jail setup"
    }) as TextChannel;
    lines.push(`Created channel: #jailed-chat (${jailChat.id})`);
  } else {
    await jailChat.edit({
      parent: jailCategory.id,
      rateLimitPerUser: 21600,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: jailedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
      ],
      reason: "Jail setup update"
    });
    lines.push(`Updated channel: #jailed-chat (${jailChat.id})`);
  }

  // 4. Create/find #jail-announcements
  let jailAnnouncements = jailCategory.children.cache.find((c) => c.name === "jail-announcements") as TextChannel | undefined;
  if (!jailAnnouncements) {
    jailAnnouncements = await guild.channels.create({
      name: "jail-announcements",
      type: ChannelType.GuildText,
      parent: jailCategory.id,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: jailedRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }
      ],
      reason: "Jail setup"
    }) as TextChannel;
    lines.push(`Created channel: #jail-announcements (${jailAnnouncements.id})`);
  } else {
    await jailAnnouncements.edit({
      parent: jailCategory.id,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: jailedRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }
      ],
      reason: "Jail setup update"
    });
    lines.push(`Updated channel: #jail-announcements (${jailAnnouncements.id})`);
  }

  // 5. Add deny-ViewChannel overwrite for the Jailed role to all OTHER categories
  const otherCategories = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildCategory && c.id !== jailCategory!.id
  ) as Map<string, CategoryChannel>;

  for (const category of otherCategories.values()) {
    await category.permissionOverwrites.create(
      jailedRole,
      { ViewChannel: false },
      { reason: "Jail setup: deny jailed role view" }
    ).catch(() => null);
  }

  // 6. Add deny-ViewChannel overwrite for Jailed role on top-level channels (no parent)
  const topLevelChannels = guild.channels.cache.filter(
    (c) => !c.parentId && c.type !== ChannelType.GuildCategory
  );
  for (const channel of topLevelChannels.values()) {
    if ("permissionOverwrites" in channel) {
      await (channel as TextChannel).permissionOverwrites.create(
        jailedRole,
        { ViewChannel: false },
        { reason: "Jail setup: deny jailed role view" }
      ).catch(() => null);
    }
  }

  lines.push(`Applied deny-ViewChannel to ${otherCategories.size} other categories and ${topLevelChannels.size} top-level channels.`);

  // 7. Save to guild config and mark as secondary
  db.updateGuildConfig(guild.id, {
    jailed_role_id: jailedRole.id,
    jail_category_id: jailCategory.id,
    jail_chat_id: jailChat.id,
    jail_announcements_id: jailAnnouncements.id,
    is_secondary: 1
  });

  await interaction.editReply({
    content:
      `**Jail infrastructure set up:**\n${lines.map((l) => `• ${l}`).join("\n")}\n\n` +
      `This server is now marked as a **secondary server**.\n🔄 Restart the bot to apply the trimmed command set to this server.`
  });
}

// ── Assign Roblox ─────────────────────────────────────────────────────────────

async function handleAssignRoblox(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  actor: GuildMember
) {
  await requireAdmin(context.db, actor);

  const { db } = context;
  const targetUser = interaction.options.getUser("member", true);
  const robloxUsername = interaction.options.getString("roblox_username", true).trim();

  if (!robloxUsername) {
    await interaction.reply({ content: "Roblox username cannot be empty.", ephemeral: true });
    return;
  }

  db.setStaffRoblox(targetUser.id, robloxUsername, actor.id);

  await interaction.reply({
    content: `✅ Linked **${robloxUsername}** (Roblox) to <@${targetUser.id}>.\nThis will be used for group rank changes when that feature is added.`,
    ephemeral: false
  });
}

async function replyError(interaction: ChatInputCommandInteraction, error: unknown) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const options: InteractionReplyOptions = { content: `Error: ${message}`, ephemeral: true };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: options.content as string }).catch(() => null);
  } else {
    await interaction.reply(options).catch(() => null);
  }
}
