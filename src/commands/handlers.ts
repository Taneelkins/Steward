import { execSync } from "node:child_process";
import {
  AttachmentBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  GuildMember,
  InteractionReplyOptions,
  Role,
  TextChannel,
  User
} from "discord.js";
import type { AppDatabase } from "../db.js";
import type { AppEnv } from "../env.js";
import { formatMultiplier, formatPoints, listOrNone, pointsToMilli, truncate } from "../utils/format.js";
import { canUseAccess, caseLinkComponents, commandDeniedMessage, configSummaryEmbed, hasCanRegisterRole, isAdminMember, isModMember, postToConfiguredChannel, requireAdmin, requireMod } from "../utils/discord.js";
import { dayName, discordTimestamp, nowIso, parseDateInput, parseTime, parseWeekday } from "../utils/time.js";
import { writeAuditAndPost } from "../services/audit.js";
import { commandAccess } from "../services/access.js";
import {
  activeMultiplier,
  adjustPoints,
  buildCaseLogEmbed,
  type CaseTarget,
  createCase,
  editCase,
  effectiveActionPoints,
  getPointTotal,
  getStrikeTotal,
  isWeekendMultiplierActive,
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
import { cancelPendingLogForUser, resolveLogAction, startInteractiveLog } from "../services/logWorkflow.js";
import { replyHelpMenu } from "../services/helpMenu.js";
import { normalizeTicketType, processOverdueTickets } from "../services/tickets.js";
import { refreshApprovalChannel } from "../services/cases.js";
import { deployCommandsForGuild } from "../deploy-commands.js";

export type CommandContext = {
  db: AppDatabase;
  env: AppEnv;
};

export async function handleChatInputCommand(interaction: ChatInputCommandInteraction, context: CommandContext) {
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "This bot only works inside a server.", ephemeral: true });
    return;
  }

  context.db.ensureGuild(interaction.guild.id);
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
        await handleUpdateBot(interaction, member);
        break;
      case "refresh":
        await handleRefresh(interaction, context, member);
        break;
      case "export":
        await handleExport(interaction, context, member);
        break;
      default:
        await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  } catch (error) {
    console.error(`[${interaction.commandName}] command error:`, error);
    await replyError(interaction, error);
  }
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
  const lines = [
    `Created or reused category: ${provisioned.category.name}`,
    `Roles: ${staffRoleSpecs.map((spec) => `<@&${provisioned.roles[spec.key].id}>`).join(", ")}`,
    `Registration role: <@&${provisioned.canRegisterRole.id}>`,
    `Log channels: ${[
      provisioned.channels.logBan,
      provisioned.channels.logStrike,
      provisioned.channels.logRestore,
      provisioned.channels.logDiscord,
      provisioned.channels.logTicket
    ].map((channel) => `<#${channel.id}>`).join(", ")}`,
    ownerWarnings.length > 0 ? `Warnings: ${ownerWarnings.join(" ")}` : null
  ].filter(Boolean);
  await interaction.editReply({ content: lines.join("\n"), embeds: [configEmbed(db, guild.id)] });
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
  const repaired = [
    `Checked category: ${provisioned.category.name}`,
    `Checked roles: ${staffRoleSpecs.map((spec) => `<@&${provisioned.roles[spec.key].id}>`).join(", ")}`,
    `Checked registration role: <@&${provisioned.canRegisterRole.id}>`,
    `Checked channels: ${Object.values(provisioned.channels).map((channel) => `<#${channel.id}>`).join(", ")}`,
    provisioned.warnings.length > 0 ? `Warnings: ${provisioned.warnings.join(" ")}` : "No missing setup items found."
  ];
  await interaction.editReply({ content: truncate(repaired.join("\n"), 1900), embeds: [configEmbed(db, guild.id)] });
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

async function handleQuickLog(interaction: ChatInputCommandInteraction, { db }: CommandContext, member: GuildMember, actionName: string, actionDisplayName?: string | null) {
  await submitTypedLog(interaction, db, member, actionName, actionDisplayName);
}

async function submitTypedLog(interaction: ChatInputCommandInteraction, db: AppDatabase, member: GuildMember, actionName: string, actionDisplayName?: string | null) {
  const guild = interaction.guild!;
  const transcriptLink = interaction.options.getString("transcript_link");
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
    ticketId: interaction.options.getString("ticket_id"),
    transcriptUrl: transcriptLink,
    appealType,
    appealResult,
    punishmentLength
  });
  const pointsEnabled = db.getGuildConfig(guild.id).pointsEnabled;
  await interaction.reply({
    content: caseReplyText(`Logged ${record.actionDisplayName ?? record.actionName}`, record.id, record.awardedPointsMilli, pointsEnabled),
    embeds: [buildCaseLogEmbed(record, { showPoints: pointsEnabled })],
    components: caseLinkComponents(record.transcriptUrl, record.mediaLinks),
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
    const linkedServer = interaction.options.getString("linked_server");
    const moderationInvite = interaction.options.getString("moderation_invite");
    db.updateGuildConfig(guild.id, {
      interactive_log_enabled: interactiveLog === null ? undefined : interactiveLog ? 1 : 0,
      ...(linkedServer !== null ? { linked_guild_id: linkedServer || null } : {}),
      ...(moderationInvite !== null ? { moderation_invite: moderationInvite || null } : {})
    });
    await writeAuditAndPost(db, guild, interaction.user.id, "config.behavior.updated", { interactiveLog, linkedServer, moderationInvite });
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
    owner_user_id: interaction.options.getUser("owner")?.id,
    ticket_tool_bot_id: interaction.options.getString("ticket_tool_bot_id") ?? undefined
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
      ticketId: interaction.options.getString("ticket_id"),
      transcriptUrl: transcriptLink,
      happenedAt: interaction.options.getString("happened_at")
    });
    const pointsEnabled = db.getGuildConfig(guild.id).pointsEnabled;
    await interaction.reply({
      content: caseReplyText("Logged", record.id, record.awardedPointsMilli, pointsEnabled),
      embeds: [buildCaseLogEmbed(record, { showPoints: pointsEnabled })],
      components: caseLinkComponents(record.transcriptUrl, record.mediaLinks),
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
  const table = interaction.options.getString("table", true) as "cases" | "points" | "quotas" | "tickets";
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
    ticketTranscripts: getTextChannelOption(interaction, "ticket_transcripts_channel"),
    logBan: getTextChannelOption(interaction, "logingame_channel"),
    logStrike: getTextChannelOption(interaction, "logstrike_channel"),
    logRestore: getTextChannelOption(interaction, "logrestore_channel"),
    logDiscord: getTextChannelOption(interaction, "logdiscord_channel"),
    logTicket: getTextChannelOption(interaction, "logticket_channel"),
    logAppeal: getTextChannelOption(interaction, "logappeal_channel")
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
    ticket_transcript_channel_id: provisioned.channels.ticketTranscripts.id,
    alert_channel_id: provisioned.channels.modAlerts.id,
    appeal_log_channel_id: provisioned.channels.logAppeal.id
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
    ticketTranscripts: config.ticketTranscriptChannelId
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
  return configSummaryEmbed(db.getGuildConfig(guildId), {
    ingameLogChannelId: db.getActionLogChannelId(guildId, "ban")
  });
}

function requireServerOwner(member: GuildMember) {
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

async function handleUpdateBot(interaction: ChatInputCommandInteraction, member: GuildMember) {
  requireServerOwner(member);
  await interaction.deferReply({ ephemeral: true });

  let pullOutput = "";
  try {
    await interaction.editReply("Pulling latest code from GitHub...");
    pullOutput = execSync("git pull", { encoding: "utf8", cwd: process.cwd() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await interaction.editReply(`Git pull failed:\n\`\`\`\n${msg.slice(0, 1800)}\n\`\`\``);
    return;
  }

  let buildOutput = "";
  try {
    await interaction.editReply(`Pulled.\n\`\`\`\n${pullOutput.trim().slice(0, 800)}\n\`\`\`\nBuilding...`);
    buildOutput = execSync("npm run build", { encoding: "utf8", cwd: process.cwd() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await interaction.editReply(`Build failed:\n\`\`\`\n${msg.slice(0, 1800)}\n\`\`\``);
    return;
  }

  let deployOutput = "";
  try {
    await interaction.editReply(`Built. Deploying slash commands...`);
    deployOutput = execSync("npm run deploy", { encoding: "utf8", cwd: process.cwd() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await interaction.editReply(`Deploy failed:\n\`\`\`\n${msg.slice(0, 1800)}\n\`\`\``);
    return;
  }

  const summary = [pullOutput.trim(), buildOutput.trim(), deployOutput.trim()].filter(Boolean).join("\n").slice(0, 1600);
  await interaction.editReply(`Update complete. Restarting bot...\n\`\`\`\n${summary}\n\`\`\``);
  setTimeout(() => process.exit(75), 1500);
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
    ch(config.juniorHelpChannelId, "Junior Help", true)
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
    bool(config.pointsEnabled, "Point System Enabled"),
    bool(config.quotaEnabled, "Quota Enabled"),
    bool(Boolean(config.quotaPeriodStart && config.quotaPeriodEnd), "Quota Period Active"),
    config.linkedGuildId ? `✅ Linked Server: \`${config.linkedGuildId}\`` : `⬜ Linked Server: Not set (optional)`,
    config.moderationInvite ? `✅ Moderation Invite: set` : `⬜ Moderation Invite: Not set (optional)`
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

async function replyError(interaction: ChatInputCommandInteraction, error: unknown) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const options: InteractionReplyOptions = { content: `Error: ${message}`, ephemeral: true };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: options.content as string }).catch(() => null);
  } else {
    await interaction.reply(options).catch(() => null);
  }
}
