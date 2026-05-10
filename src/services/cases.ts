import type { Guild, GuildMember, User } from "discord.js";
import { EmbedBuilder } from "discord.js";
import type { AppDatabase } from "../db.js";
import type { ActionPreset, CaseMediaLink, ModerationCase } from "../types.js";
import { formatMultiplier, formatPoints, truncate } from "../utils/format.js";
import { caseLinkComponents, postToConfiguredChannel, transcriptFieldValue, userLabel } from "../utils/discord.js";
import { colors } from "../utils/theme.js";
import { nowIso, parseDateInput } from "../utils/time.js";
import { writeAudit, writeAuditAndPost } from "./audit.js";

export type CreateCaseInput = {
  guild: Guild;
  target?: User;
  targetInfo?: CaseTarget;
  moderator: GuildMember;
  actionName: string;
  actionDisplayName?: string | null;
  reason: string;
  evidence?: string | null;
  notes?: string | null;
  noAction?: boolean;
  ticketId?: string | null;
  transcriptUrl?: string | null;
  mediaLinks?: CaseMediaLink[];
  appealType?: string | null;
  appealResult?: "accepted" | "denied" | null;
  punishmentLength?: string | null;
  happenedAt?: string | null;
};

export type CaseTarget = {
  robloxUsername?: string | null;
  discordUsername?: string | null;
  robloxId?: string | null;
  discordId?: string | null;
};

export type CaseFlags = {
  duplicate: boolean;
  late: boolean;
  burst: boolean;
  noActionHeavy: boolean;
};

const FAST_POINTS_WINDOW_MINUTES = 15;
const FAST_POINTS_THRESHOLD_MILLI = 10000;

export function buildCaseLogEmbed(record: ModerationCase, options: { showPoints?: boolean } = {}) {
  const showPoints = options.showPoints ?? true;
  const appealStatus = record.appealResult === "accepted" ? "Appeal Approved" : record.appealResult === "denied" ? "Appeal Denied" : null;
  const information = [
    `Reason: ${record.reason}`,
    `Evidence: ${record.evidence ?? "None"}`,
    `Notes: ${record.notes ?? "None"}`,
    `Strikes: ${record.strikes}`,
    `Case ID: ${record.id}`,
    record.punishmentLength ? `Punishment Length: ${record.punishmentLength}` : null,
    record.ticketId ? `Ticket ID: ${record.ticketId}` : null,
    record.transcriptUrl ? `Transcript: ${transcriptFieldValue(record.transcriptUrl)}` : null,
    record.mediaLinks.length > 0 ? `Media: ${record.mediaLinks.map((link) => link.label).join(", ")}` : null,
    record.flags ? `Flags: ${record.flags}` : null
  ].filter(Boolean);

  const fields = [
    { name: "Target", value: truncate(formatCaseTarget(record), 1000), inline: false },
    ...(appealStatus ? [{ name: "Status", value: appealStatus, inline: true }] : []),
    { name: "Information", value: truncate(information.join("\n"), 1000), inline: false },
    ...(showPoints
      ? [
          { name: "Multiplier", value: formatMultiplier(record.multiplierMilli), inline: true },
          { name: "Amount of Points Granted", value: formatPoints(record.awardedPointsMilli), inline: true }
        ]
      : []),
    { name: "Moderator", value: `<@${record.moderatorUserId}>\n${truncate(record.moderatorUsername, 120)}`, inline: false }
  ];

  return new EmbedBuilder()
    .setTitle(caseEmbedTitle(record))
    .setColor(caseEmbedColor(record))
    .addFields(fields)
    .setFooter({ text: `Case #${record.id}` })
    .setTimestamp(new Date(record.createdAt));
}

export function formatLoggedActionName(value: string) {
  return cleanActionDisplayName(value).toUpperCase();
}

function caseEmbedTitle(record: ModerationCase) {
  if (record.actionName === "appeal") {
    return `${cleanActionDisplayName(record.appealType ?? record.actionDisplayName ?? "Appeal")} Appeal`;
  }
  return `LOGGED ${formatLoggedActionName(record.actionDisplayName ?? record.actionName)}`;
}

function caseEmbedColor(record: ModerationCase) {
  if (record.actionName === "appeal") {
    return record.appealResult === "accepted" ? colors.appealApproved : colors.appealDenied;
  }
  const display = `${record.actionDisplayName ?? record.actionName}`.toLowerCase();
  if (display.includes("discord warn")) return colors.discordWarn;
  if (display.includes("discord timeout")) return colors.discordTimeout;
  if (display.includes("discord mute")) return colors.discordMute;
  if (display.includes("discord ban")) return colors.discordBan;
  if (display.includes("ingame ban") || record.actionName === "ban") return colors.ingameBan;
  if (record.actionName === "strike") return colors.discordWarn;
  if (record.actionName === "restore") return colors.darkEmerald;
  if (record.actionName === "ticket") return colors.mutedBlue;
  return record.isNoAction ? colors.charcoal : colors.neutral;
}

function cleanActionDisplayName(value: string | null | undefined) {
  const clean = value
    ?.replace(/[`*_~|<>\r\n]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (clean || "ACTION").slice(0, 80);
}

export function formatCaseTarget(record: Pick<ModerationCase, "targetUsername" | "robloxUsername" | "discordUsername" | "robloxId" | "discordId">) {
  const lines = [
    record.robloxUsername ? `RobloxUser: ${record.robloxUsername}` : null,
    record.discordUsername ? `DiscordUser: ${record.discordUsername}` : null,
    record.robloxId ? `RobloxID: ${record.robloxId}` : null,
    record.discordId ? `DiscordID: ${record.discordUsername ? `<@${record.discordId}>` : record.discordId}` : null
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : record.targetUsername;
}

export function calculateAwardedPoints(basePointsMilli: number, multiplierMilli: number) {
  return Math.round((basePointsMilli * multiplierMilli) / 1000);
}

export function effectiveActionPoints(action: ActionPreset, at = new Date()) {
  const overrideActive =
    action.overrideBasePointsMilli !== null &&
    (!action.overrideEndsAt || new Date(action.overrideEndsAt).getTime() > at.getTime());

  return {
    basePointsMilli: overrideActive ? action.overrideBasePointsMilli! : action.basePointsMilli,
    noActionPointsMilli: overrideActive ? action.overrideNoActionPointsMilli ?? action.noActionPointsMilli : action.noActionPointsMilli,
    overrideActive,
    overrideEndsAt: overrideActive ? action.overrideEndsAt : null
  };
}

export function isWeekendMultiplierActive(config: { timezone?: string }, at = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: config.timezone ?? "America/New_York"
  }).format(at);
  return weekday === "Sat" || weekday === "Sun";
}

export function activeMultiplier(config: { multiplierMilli: number; multiplierEndsAt: string | null; timezone?: string }, at = new Date()) {
  const configured = config.multiplierEndsAt && new Date(config.multiplierEndsAt).getTime() <= at.getTime() ? 1000 : config.multiplierMilli;
  const weekend = isWeekendMultiplierActive(config, at) ? 1500 : 1000;
  return Math.max(configured, weekend);
}

export function detectFlags(
  db: AppDatabase,
  guildId: string,
  moderatorUserId: string,
  targetUserId: string,
  actionName: string,
  reason: string,
  noAction: boolean,
  happenedAt?: string | null
): CaseFlags {
  const sinceDuplicate = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const duplicate = Boolean(
    db.get<{ id: number }>(
      `SELECT id FROM moderation_cases
       WHERE guild_id = ? AND target_user_id = ? AND action_name = ? AND lower(reason) = lower(?)
       AND created_at >= ? AND status = 'active' LIMIT 1`,
      guildId,
      targetUserId,
      actionName,
      reason,
      sinceDuplicate
    )
  );

  const sinceBurst = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const burst =
    (db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM moderation_cases
       WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ? AND status = 'active'`,
      guildId,
      moderatorUserId,
      sinceBurst
    )?.count ?? 0) >= 8;

  const sinceNoAction = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentTotal =
    db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ? AND status = 'active'",
      guildId,
      moderatorUserId,
      sinceNoAction
    )?.count ?? 0;
  const recentNoAction =
    db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ? AND is_no_action = 1 AND status = 'active'",
      guildId,
      moderatorUserId,
      sinceNoAction
    )?.count ?? 0;
  const noActionHeavy = noAction && recentTotal >= 5 && recentNoAction / Math.max(recentTotal, 1) >= 0.7;

  const happenedDate = parseDateInput(happenedAt);
  const late = Boolean(happenedDate && Date.now() - happenedDate.getTime() > 24 * 60 * 60 * 1000);

  return { duplicate, late, burst, noActionHeavy };
}

export function flagsToText(flags: CaseFlags) {
  return Object.entries(flags)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .join(",");
}

export async function createCase(db: AppDatabase, input: CreateCaseInput) {
  const guildId = input.guild.id;
  const actionName = input.actionName.toLowerCase();
  const action = db.getAction(guildId, actionName);
  if (!action || !action.enabled) throw new Error(`Action preset "${actionName}" is not enabled.`);
  if (action.evidenceRequired && !input.evidence) {
    throw new Error(`Evidence is required for "${action.displayName}".`);
  }
  const actionDisplayName = input.actionDisplayName ? cleanActionDisplayName(input.actionDisplayName) : action.displayName;

  const config = db.getGuildConfig(guildId);
  const multiplierMilli = config.pointsEnabled ? activeMultiplier(config) : 1000;
  const actionPoints = effectiveActionPoints(action);
  const basePointsMilli = config.pointsEnabled ? input.noAction ? actionPoints.noActionPointsMilli : actionPoints.basePointsMilli : 0;
  const awardedPointsMilli = config.pointsEnabled ? calculateAwardedPoints(basePointsMilli, multiplierMilli) : 0;
  const strikes = input.noAction ? 0 : action.defaultStrikes;
  const timestamp = nowIso();
  const mediaLinks = normalizeMediaLinks(input.mediaLinks);
  const target = normalizeCaseTarget(input.targetInfo ?? (input.target ? targetFromDiscordUser(input.target) : null));
  if (!target) throw new Error("Provide at least one target field: RobloxUser, DiscordUser, RobloxID, or DiscordID.");
  const reason = input.reason.trim() || "No reason provided.";
  const flags = detectFlags(
    db,
    guildId,
    input.moderator.id,
    target.targetKey,
    actionName,
    reason,
    Boolean(input.noAction),
    input.happenedAt
  );
  const flagText = flagsToText(flags);

  const id = db.transaction(() => {
    const result = db.run(
      `INSERT INTO moderation_cases (
        guild_id, target_user_id, target_username, roblox_username, discord_username,
        roblox_id, discord_id, moderator_user_id, moderator_username,
        action_name, action_display_name, reason, evidence, notes, base_points_milli, multiplier_milli,
        awarded_points_milli, strikes, status, flags, is_late, is_no_action,
        ticket_id, transcript_url, media_links_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      guildId,
      target.targetKey,
      target.targetLabel,
      target.robloxUsername,
      target.discordUsername,
      target.robloxId,
      target.discordId,
      input.moderator.id,
      userLabel(input.moderator),
      actionName,
      actionDisplayName,
      reason,
      input.evidence ?? null,
      input.notes ?? null,
      basePointsMilli,
      multiplierMilli,
      awardedPointsMilli,
      strikes,
      flagText,
      flags.late ? 1 : 0,
      input.noAction ? 1 : 0,
      input.ticketId ?? null,
      input.transcriptUrl ?? null,
      mediaLinks.length > 0 ? JSON.stringify(mediaLinks) : null,
      timestamp,
      timestamp
    );
    const caseId = Number(result.lastInsertRowid);
    if (config.pointsEnabled && awardedPointsMilli !== 0) {
      db.run(
        `INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'award', ?, ?)`,
        guildId,
        input.moderator.id,
        caseId,
        awardedPointsMilli,
        `Case #${caseId}: ${actionDisplayName}`,
        input.moderator.id,
        timestamp
      );
    }
    if (strikes > 0) {
      db.run(
        "INSERT INTO strikes (guild_id, target_user_id, case_id, amount, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        guildId,
        target.targetKey,
        caseId,
        strikes,
        timestamp
      );
    }
    if (input.ticketId) {
      db.run(
        "UPDATE pending_ticket_logs SET status = 'logged', logged_case_id = ? WHERE guild_id = ? AND ticket_id = ? AND status IN ('pending', 'needs_review', 'overdue')",
        caseId,
        guildId,
        input.ticketId
      );
    }
    writeAudit(db, guildId, input.moderator.id, "case.created", { caseId, actionName, actionDisplayName, awardedPointsMilli, pointsEnabled: config.pointsEnabled, flags: flagText, target: target.targetKey });
    return caseId;
  });

  const record = db.getCase(guildId, id);
  if (!record) throw new Error("Case was created but could not be loaded.");

  const juniorBanReview = getJuniorBanReview(db, input.moderator, actionName);
  const embed = buildCaseLogEmbed(record, { showPoints: config.pointsEnabled });
  if (juniorBanReview) {
    embed.addFields({
      name: "Senior Moderator Review Required",
      value: [
        "This ban was logged by a Junior Moderator.",
        `${juniorBanReview.seniorRoleMention} needs to review this log.`,
        `${juniorBanReview.seniorRoleMention} needs to complete the actual ban.`
      ].join("\n"),
      inline: false
    });
  }
  const components = caseLinkComponents(record.transcriptUrl, record.mediaLinks);
  await postToConfiguredChannel(input.guild, db.getActionLogChannelId(guildId, actionName) ?? config.actionLogChannelId, {
    ...(juniorBanReview ? { content: `${juniorBanReview.seniorRoleMention} Junior Moderator ban log needs review and completion.` } : {}),
    embeds: [embed],
    ...(components.length > 0 ? { components } : {}),
    ...(juniorBanReview ? { allowedMentions: { roles: [juniorBanReview.seniorRoleId] } } : {})
  });
  if (strikes > 0) {
    await maybePostStrikeAlert(db, input.guild, record);
  }
  if (config.pointsEnabled) {
    await maybePostFastPointsAlert(db, input.guild, record);
  }
  return record;
}

function targetFromDiscordUser(user: User): CaseTarget {
  return {
    discordId: user.id,
    discordUsername: userLabel(user)
  };
}

function normalizeCaseTarget(target: CaseTarget | null) {
  if (!target) return null;
  const robloxUsername = cleanOptional(target.robloxUsername);
  const discordUsername = cleanOptional(target.discordUsername);
  const robloxId = cleanOptional(target.robloxId);
  const discordId = cleanOptional(target.discordId);
  if (!robloxUsername && !discordUsername && !robloxId && !discordId) return null;
  const targetKey = discordId ? `discord:${discordId}` : robloxId ? `roblox:${robloxId}` : robloxUsername ? `roblox-user:${robloxUsername.toLowerCase()}` : `discord-user:${discordUsername?.toLowerCase()}`;
  const targetLabel = [
    robloxUsername ? `RobloxUser ${robloxUsername}` : null,
    robloxId ? `RobloxID ${robloxId}` : null,
    discordUsername ? `DiscordUser ${discordUsername}` : null,
    discordId ? `DiscordID ${discordId}` : null
  ].filter(Boolean).join(" | ");

  return { robloxUsername, discordUsername, robloxId, discordId, targetKey, targetLabel };
}

function normalizeMediaLinks(links: CaseMediaLink[] | null | undefined) {
  const deduped = new Map<string, CaseMediaLink>();
  for (const link of links ?? []) {
    const label = link.label.trim().slice(0, 80);
    const url = link.url.trim();
    const kind = link.kind === "image" || link.kind === "video" ? link.kind : "file";
    if (!label || !url) continue;
    deduped.set(`${label}:${url}`, { label, url, kind });
  }
  return [...deduped.values()].slice(0, 20);
}

function cleanOptional(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

export async function voidCase(db: AppDatabase, guild: Guild, actorId: string, caseId: number, reason: string) {
  const record = db.getCase(guild.id, caseId);
  if (!record) throw new Error(`Case #${caseId} was not found.`);
  if (record.status === "void") throw new Error(`Case #${caseId} is already void.`);
  const timestamp = nowIso();

  db.transaction(() => {
    db.run(
      "UPDATE moderation_cases SET status = 'void', voided_at = ?, void_reason = ?, updated_at = ? WHERE guild_id = ? AND id = ?",
      timestamp,
      reason,
      timestamp,
      guild.id,
      caseId
    );
    db.run("UPDATE strikes SET active = 0 WHERE guild_id = ? AND case_id = ?", guild.id, caseId);
    if (record.awardedPointsMilli !== 0) {
      db.run(
        `INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'void', ?, ?)`,
        guild.id,
        record.moderatorUserId,
        caseId,
        -record.awardedPointsMilli,
        `Void case #${caseId}: ${reason}`,
        actorId,
        timestamp
      );
    }
    writeAudit(db, guild.id, actorId, "case.voided", { caseId, reason });
  });

  await writeAuditAndPost(db, guild, actorId, "case.voided", { caseId, reason });
}

export async function editCase(
  db: AppDatabase,
  guild: Guild,
  actorId: string,
  caseId: number,
  values: { reason?: string | null; evidence?: string | null; notes?: string | null; adminReason: string }
) {
  const record = db.getCase(guild.id, caseId);
  if (!record) throw new Error(`Case #${caseId} was not found.`);
  const reason = values.reason ?? record.reason;
  const evidence = values.evidence === undefined ? record.evidence : values.evidence;
  const notes = values.notes === undefined ? record.notes : values.notes;
  db.run(
    "UPDATE moderation_cases SET reason = ?, evidence = ?, notes = ?, updated_at = ? WHERE guild_id = ? AND id = ?",
    reason,
    evidence ?? null,
    notes ?? null,
    nowIso(),
    guild.id,
    caseId
  );
  await writeAuditAndPost(db, guild, actorId, "case.edited", {
    caseId,
    adminReason: values.adminReason,
    reasonChanged: values.reason !== undefined,
    evidenceChanged: values.evidence !== undefined,
    notesChanged: values.notes !== undefined
  });
}

export async function adjustPoints(
  db: AppDatabase,
  guild: Guild,
  actorId: string,
  moderatorUserId: string,
  amountMilli: number,
  reason: string
) {
  db.run(
    `INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
     VALUES (?, ?, NULL, ?, ?, 'adjustment', ?, ?)`,
    guild.id,
    moderatorUserId,
    amountMilli,
    reason,
    actorId,
    nowIso()
  );
  await writeAuditAndPost(db, guild, actorId, "points.adjusted", { moderatorUserId, amountMilli, reason });
}

export function getPointTotal(db: AppDatabase, guildId: string, moderatorUserId: string, since?: string | null) {
  const row = since
    ? db.get<{ total: number }>(
        "SELECT COALESCE(SUM(amount_milli), 0) AS total FROM point_ledger WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ?",
        guildId,
        moderatorUserId,
        since
      )
    : db.get<{ total: number }>(
        "SELECT COALESCE(SUM(amount_milli), 0) AS total FROM point_ledger WHERE guild_id = ? AND moderator_user_id = ?",
        guildId,
        moderatorUserId
      );
  return row?.total ?? 0;
}

export function getStrikeTotal(db: AppDatabase, guildId: string, targetUserId: string) {
  return (
    db.get<{ total: number }>(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM strikes WHERE guild_id = ? AND target_user_id = ? AND active = 1",
      guildId,
      targetUserId
    )?.total ?? 0
  );
}

function getJuniorBanReview(db: AppDatabase, member: GuildMember, actionName: string) {
  if (actionName !== "ban") return null;
  const roles = db.listStaffRoles(member.guild.id);
  const hasRoleKey = (key: string) =>
    roles.some((role) => role.key === key && member.roles.cache.has(role.roleId));
  const juniorOnly =
    hasRoleKey("juniorMod") &&
    !hasRoleKey("mod") &&
    !hasRoleKey("seniorMod") &&
    !hasRoleKey("headMod") &&
    !hasRoleKey("communityManager");
  if (!juniorOnly) return null;
  const seniorRole = roles.find((role) => role.key === "seniorMod");
  if (!seniorRole) return null;
  return {
    seniorRoleId: seniorRole.roleId,
    seniorRoleMention: `<@&${seniorRole.roleId}>`
  };
}

async function maybePostFastPointsAlert(db: AppDatabase, guild: Guild, record: ModerationCase) {
  const since = new Date(Date.now() - FAST_POINTS_WINDOW_MINUTES * 60 * 1000).toISOString();
  const summary = db.get<{ total: number; count: number }>(
    `SELECT COALESCE(SUM(amount_milli), 0) AS total, COUNT(*) AS count
     FROM point_ledger
     WHERE guild_id = ? AND moderator_user_id = ? AND type = 'award' AND amount_milli > 0 AND created_at >= ?`,
    guild.id,
    record.moderatorUserId,
    since
  );
  const total = summary?.total ?? 0;
  if (total < FAST_POINTS_THRESHOLD_MILLI) return;

  const recentWarning = db.get<{ id: number }>(
    "SELECT id FROM audit_events WHERE guild_id = ? AND actor_user_id = ? AND action = 'points.fast-warning' AND created_at >= ? LIMIT 1",
    guild.id,
    record.moderatorUserId,
    since
  );
  if (recentWarning) return;

  const config = db.getGuildConfig(guild.id);
  const embed = new EmbedBuilder()
    .setTitle("Fast Points Review")
    .setColor(0xf1c40f)
    .addFields(
      { name: "Moderator", value: `<@${record.moderatorUserId}>`, inline: true },
      { name: "Points Gained", value: formatPoints(total), inline: true },
      { name: "Time Period", value: `Last ${FAST_POINTS_WINDOW_MINUTES} minutes`, inline: true },
      {
        name: "Review Note",
        value: "This moderator gained points quickly. Their activity may need to be reviewed.",
        inline: false
      }
    )
    .setTimestamp();

  await postToConfiguredChannel(guild, config.alertChannelId ?? config.auditChannelId, {
    embeds: [embed],
    allowedMentions: { parse: [] }
  });
  writeAudit(db, guild.id, record.moderatorUserId, "points.fast-warning", {
    pointsMilli: total,
    entries: summary?.count ?? 0,
    windowMinutes: FAST_POINTS_WINDOW_MINUTES
  });
}

async function maybePostStrikeAlert(db: AppDatabase, guild: Guild, record: ModerationCase) {
  const config = db.getGuildConfig(guild.id);
  const total = getStrikeTotal(db, guild.id, record.targetUserId);
  const thresholds = db.all<{ strike_count: number; label: string }>(
    "SELECT strike_count, label FROM strike_thresholds WHERE guild_id = ? AND strike_count <= ? ORDER BY strike_count DESC LIMIT 1",
    guild.id,
    total
  );
  const strikeEmbed = new EmbedBuilder()
    .setTitle("Strike Added")
    .setColor(0xe67e22)
    .addFields(
      { name: "Member", value: truncate(formatCaseTarget(record), 1000), inline: true },
      { name: "Added", value: String(record.strikes), inline: true },
      { name: "Active Total", value: String(total), inline: true },
      { name: "Case", value: `#${record.id}`, inline: true }
    )
    .setTimestamp();
  await postToConfiguredChannel(guild, config.strikeLogChannelId, { embeds: [strikeEmbed] });

  if (thresholds[0]) {
    const alertEmbed = new EmbedBuilder()
      .setTitle("Strike Threshold Reached")
      .setColor(0xe74c3c)
      .addFields(
        { name: "Member", value: truncate(formatCaseTarget(record), 1000), inline: true },
        { name: "Threshold", value: `${thresholds[0].strike_count} - ${thresholds[0].label}`, inline: true },
        { name: "Active Total", value: String(total), inline: true }
      )
      .setTimestamp();
    await postToConfiguredChannel(guild, config.alertChannelId, { embeds: [alertEmbed] });
  }
}
