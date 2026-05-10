import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { formatMultiplier, formatPoints, truncate } from "../utils/format.js";
import { caseLinkComponents, getStaffTier, getTextChannel, postToConfiguredChannel, transcriptFieldValue, userLabel } from "../utils/discord.js";
import { colors } from "../utils/theme.js";
import { nowIso, parseDateInput } from "../utils/time.js";
import { writeAudit, writeAuditAndPost } from "./audit.js";
const FAST_POINTS_WINDOW_MINUTES = 15;
const FAST_POINTS_THRESHOLD_MILLI = 10000;
export function buildCaseLogEmbed(record, options = {}) {
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
export function formatLoggedActionName(value) {
    return cleanActionDisplayName(value).toUpperCase();
}
function caseEmbedTitle(record) {
    if (record.actionName === "appeal") {
        return `${cleanActionDisplayName(record.appealType ?? record.actionDisplayName ?? "Appeal")} Appeal`;
    }
    return `LOGGED ${formatLoggedActionName(record.actionDisplayName ?? record.actionName)}`;
}
function caseEmbedColor(record) {
    if (record.actionName === "appeal") {
        return record.appealResult === "accepted" ? colors.appealApproved : colors.appealDenied;
    }
    const display = `${record.actionDisplayName ?? record.actionName}`.toLowerCase();
    if (display.includes("discord warn"))
        return colors.discordWarn;
    if (display.includes("discord timeout"))
        return colors.discordTimeout;
    if (display.includes("discord mute"))
        return colors.discordMute;
    if (display.includes("discord ban"))
        return colors.discordBan;
    if (display.includes("ingame ban") || record.actionName === "ban")
        return colors.ingameBan;
    if (record.actionName === "strike")
        return colors.discordWarn;
    if (record.actionName === "restore")
        return colors.darkEmerald;
    if (record.actionName === "ticket")
        return colors.mutedBlue;
    return record.isNoAction ? colors.charcoal : colors.neutral;
}
function cleanActionDisplayName(value) {
    const clean = value
        ?.replace(/[`*_~|<>\r\n]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return (clean || "ACTION").slice(0, 80);
}
export function formatCaseTarget(record) {
    const lines = [
        record.robloxUsername ? `RobloxUser: ${record.robloxUsername}` : null,
        record.discordUsername ? `DiscordUser: ${record.discordUsername}` : null,
        record.robloxId ? `RobloxID: ${record.robloxId}` : null,
        record.discordId ? `DiscordID: ${record.discordUsername ? `<@${record.discordId}>` : record.discordId}` : null
    ].filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : record.targetUsername;
}
export function calculateAwardedPoints(basePointsMilli, multiplierMilli) {
    return Math.round((basePointsMilli * multiplierMilli) / 1000);
}
export function effectiveActionPoints(action, at = new Date()) {
    const overrideActive = action.overrideBasePointsMilli !== null &&
        (!action.overrideEndsAt || new Date(action.overrideEndsAt).getTime() > at.getTime());
    return {
        basePointsMilli: overrideActive ? action.overrideBasePointsMilli : action.basePointsMilli,
        noActionPointsMilli: overrideActive ? action.overrideNoActionPointsMilli ?? action.noActionPointsMilli : action.noActionPointsMilli,
        overrideActive,
        overrideEndsAt: overrideActive ? action.overrideEndsAt : null
    };
}
export function isWeekendMultiplierActive(config, at = new Date()) {
    const weekday = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        timeZone: config.timezone ?? "America/New_York"
    }).format(at);
    return weekday === "Sat" || weekday === "Sun";
}
export function activeMultiplier(config, at = new Date()) {
    const configured = config.multiplierEndsAt && new Date(config.multiplierEndsAt).getTime() <= at.getTime() ? 1000 : config.multiplierMilli;
    const weekend = isWeekendMultiplierActive(config, at) ? 1500 : 1000;
    return Math.max(configured, weekend);
}
export function detectFlags(db, guildId, moderatorUserId, targetUserId, actionName, reason, noAction, happenedAt) {
    const sinceDuplicate = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const duplicate = Boolean(db.get(`SELECT id FROM moderation_cases
       WHERE guild_id = ? AND target_user_id = ? AND action_name = ? AND lower(reason) = lower(?)
       AND created_at >= ? AND status = 'active' LIMIT 1`, guildId, targetUserId, actionName, reason, sinceDuplicate));
    const sinceBurst = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const burst = (db.get(`SELECT COUNT(*) AS count FROM moderation_cases
       WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ? AND status = 'active'`, guildId, moderatorUserId, sinceBurst)?.count ?? 0) >= 8;
    const sinceNoAction = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentTotal = db.get("SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ? AND status = 'active'", guildId, moderatorUserId, sinceNoAction)?.count ?? 0;
    const recentNoAction = db.get("SELECT COUNT(*) AS count FROM moderation_cases WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ? AND is_no_action = 1 AND status = 'active'", guildId, moderatorUserId, sinceNoAction)?.count ?? 0;
    const noActionHeavy = noAction && recentTotal >= 5 && recentNoAction / Math.max(recentTotal, 1) >= 0.7;
    const happenedDate = parseDateInput(happenedAt);
    const late = Boolean(happenedDate && Date.now() - happenedDate.getTime() > 24 * 60 * 60 * 1000);
    return { duplicate, late, burst, noActionHeavy };
}
export function flagsToText(flags) {
    return Object.entries(flags)
        .filter(([, value]) => value)
        .map(([key]) => key)
        .join(",");
}
export async function createCase(db, input) {
    const guildId = input.guild.id;
    const actionName = input.actionName.toLowerCase();
    const action = db.getAction(guildId, actionName);
    if (!action || !action.enabled)
        throw new Error(`Action preset "${actionName}" is not enabled.`);
    if (action.evidenceRequired && !input.evidence) {
        throw new Error(`Evidence is required for "${action.displayName}".`);
    }
    const actionDisplayName = input.actionDisplayName ? cleanActionDisplayName(input.actionDisplayName) : action.displayName;
    const config = db.getGuildConfig(guildId);
    const isCm = getStaffTier(db, input.moderator) === "community";
    const requiresApproval = Boolean(config.approvalChannelId && !isCm && input.moderator.id !== input.guild.ownerId);
    const multiplierMilli = config.pointsEnabled ? activeMultiplier(config) : 1000;
    const actionPoints = effectiveActionPoints(action);
    const basePointsMilli = config.pointsEnabled ? input.noAction ? actionPoints.noActionPointsMilli : actionPoints.basePointsMilli : 0;
    const awardedPointsMilli = config.pointsEnabled ? calculateAwardedPoints(basePointsMilli, multiplierMilli) : 0;
    const strikes = input.noAction ? 0 : action.defaultStrikes;
    const timestamp = nowIso();
    const mediaLinks = normalizeMediaLinks(input.mediaLinks);
    const target = normalizeCaseTarget(input.targetInfo ?? (input.target ? targetFromDiscordUser(input.target) : null));
    if (!target)
        throw new Error("Provide at least one target field: RobloxUser, DiscordUser, RobloxID, or DiscordID.");
    const reason = input.reason.trim() || "No reason provided.";
    const flags = detectFlags(db, guildId, input.moderator.id, target.targetKey, actionName, reason, Boolean(input.noAction), input.happenedAt);
    const flagText = flagsToText(flags);
    const id = db.transaction(() => {
        const result = db.run(`INSERT INTO moderation_cases (
        guild_id, target_user_id, target_username, roblox_username, discord_username,
        roblox_id, discord_id, moderator_user_id, moderator_username,
        action_name, action_display_name, reason, evidence, notes, base_points_milli, multiplier_milli,
        awarded_points_milli, strikes, status, flags, is_late, is_no_action,
        ticket_id, transcript_url, media_links_json, created_at, updated_at, approval_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, guildId, target.targetKey, target.targetLabel, target.robloxUsername, target.discordUsername, target.robloxId, target.discordId, input.moderator.id, userLabel(input.moderator), actionName, actionDisplayName, reason, input.evidence ?? null, input.notes ?? null, basePointsMilli, multiplierMilli, awardedPointsMilli, strikes, flagText, flags.late ? 1 : 0, input.noAction ? 1 : 0, input.ticketId ?? null, input.transcriptUrl ?? null, mediaLinks.length > 0 ? JSON.stringify(mediaLinks) : null, timestamp, timestamp, requiresApproval ? "pending" : null);
        const caseId = Number(result.lastInsertRowid);
        if (!requiresApproval && config.pointsEnabled && awardedPointsMilli !== 0) {
            db.run(`INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'award', ?, ?)`, guildId, input.moderator.id, caseId, awardedPointsMilli, `Case #${caseId}: ${actionDisplayName}`, input.moderator.id, timestamp);
        }
        if (strikes > 0) {
            db.run("INSERT INTO strikes (guild_id, target_user_id, case_id, amount, active, created_at) VALUES (?, ?, ?, ?, 1, ?)", guildId, target.targetKey, caseId, strikes, timestamp);
        }
        if (input.ticketId) {
            db.run("UPDATE pending_ticket_logs SET status = 'logged', logged_case_id = ? WHERE guild_id = ? AND ticket_id = ? AND status IN ('pending', 'needs_review', 'overdue')", caseId, guildId, input.ticketId);
        }
        writeAudit(db, guildId, input.moderator.id, "case.created", { caseId, actionName, actionDisplayName, awardedPointsMilli, pointsEnabled: config.pointsEnabled, flags: flagText, target: target.targetKey });
        return caseId;
    });
    const record = db.getCase(guildId, id);
    if (!record)
        throw new Error("Case was created but could not be loaded.");
    const juniorEscalation = getJuniorEscalation(db, input.moderator, actionName);
    const embed = buildCaseLogEmbed(record, { showPoints: config.pointsEnabled });
    if (juniorEscalation) {
        embed.addFields({
            name: "Staff Review Required",
            value: [
                "This log was submitted by a Junior Moderator.",
                `${juniorEscalation.mentions} needs to review this action.`
            ].join("\n"),
            inline: false
        });
    }
    if (requiresApproval) {
        embed.addFields({
            name: "⏳ Pending CM Approval",
            value: "This log requires Community Manager approval before it counts toward quota and points.",
            inline: false
        });
    }
    const components = caseLinkComponents(record.transcriptUrl, record.mediaLinks);
    const appealChannel = actionName === "appeal" ? config.appealLogChannelId : null;
    const logChannel = appealChannel ?? db.getActionLogChannelId(guildId, actionName) ?? config.actionLogChannelId;
    await postToConfiguredChannel(input.guild, logChannel, {
        ...(juniorEscalation ? { content: `${juniorEscalation.mentions} Junior Moderator log needs review.` } : {}),
        embeds: [embed],
        ...(components.length > 0 ? { components } : {}),
        ...(juniorEscalation?.roleIds.length ? { allowedMentions: { roles: juniorEscalation.roleIds, users: juniorEscalation.userIds } } : {})
    });
    if (requiresApproval) {
        await postApprovalRequest(db, input.guild, record);
    }
    if (strikes > 0) {
        await maybePostStrikeAlert(db, input.guild, record);
    }
    if (config.pointsEnabled) {
        await maybePostFastPointsAlert(db, input.guild, record);
    }
    return record;
}
function targetFromDiscordUser(user) {
    return {
        discordId: user.id,
        discordUsername: userLabel(user)
    };
}
function normalizeCaseTarget(target) {
    if (!target)
        return null;
    const robloxUsername = cleanOptional(target.robloxUsername);
    const discordUsername = cleanOptional(target.discordUsername);
    const robloxId = cleanOptional(target.robloxId);
    const discordId = cleanOptional(target.discordId);
    if (!robloxUsername && !discordUsername && !robloxId && !discordId)
        return null;
    const targetKey = discordId ? `discord:${discordId}` : robloxId ? `roblox:${robloxId}` : robloxUsername ? `roblox-user:${robloxUsername.toLowerCase()}` : `discord-user:${discordUsername?.toLowerCase()}`;
    const targetLabel = [
        robloxUsername ? `RobloxUser ${robloxUsername}` : null,
        robloxId ? `RobloxID ${robloxId}` : null,
        discordUsername ? `DiscordUser ${discordUsername}` : null,
        discordId ? `DiscordID ${discordId}` : null
    ].filter(Boolean).join(" | ");
    return { robloxUsername, discordUsername, robloxId, discordId, targetKey, targetLabel };
}
function normalizeMediaLinks(links) {
    const deduped = new Map();
    for (const link of links ?? []) {
        const label = link.label.trim().slice(0, 80);
        const url = link.url.trim();
        const kind = link.kind === "image" || link.kind === "video" ? link.kind : "file";
        if (!label || !url)
            continue;
        deduped.set(`${label}:${url}`, { label, url, kind });
    }
    return [...deduped.values()].slice(0, 20);
}
function cleanOptional(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, 200) : null;
}
export async function voidCase(db, guild, actorId, caseId, reason) {
    const record = db.getCase(guild.id, caseId);
    if (!record)
        throw new Error(`Case #${caseId} was not found.`);
    if (record.status === "void")
        throw new Error(`Case #${caseId} is already void.`);
    const timestamp = nowIso();
    db.transaction(() => {
        db.run("UPDATE moderation_cases SET status = 'void', voided_at = ?, void_reason = ?, updated_at = ? WHERE guild_id = ? AND id = ?", timestamp, reason, timestamp, guild.id, caseId);
        db.run("UPDATE strikes SET active = 0 WHERE guild_id = ? AND case_id = ?", guild.id, caseId);
        if (record.awardedPointsMilli !== 0) {
            db.run(`INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'void', ?, ?)`, guild.id, record.moderatorUserId, caseId, -record.awardedPointsMilli, `Void case #${caseId}: ${reason}`, actorId, timestamp);
        }
        writeAudit(db, guild.id, actorId, "case.voided", { caseId, reason });
    });
    await writeAuditAndPost(db, guild, actorId, "case.voided", { caseId, reason });
}
export async function editCase(db, guild, actorId, caseId, values) {
    const record = db.getCase(guild.id, caseId);
    if (!record)
        throw new Error(`Case #${caseId} was not found.`);
    const reason = values.reason ?? record.reason;
    const evidence = values.evidence === undefined ? record.evidence : values.evidence;
    const notes = values.notes === undefined ? record.notes : values.notes;
    db.run("UPDATE moderation_cases SET reason = ?, evidence = ?, notes = ?, updated_at = ? WHERE guild_id = ? AND id = ?", reason, evidence ?? null, notes ?? null, nowIso(), guild.id, caseId);
    await writeAuditAndPost(db, guild, actorId, "case.edited", {
        caseId,
        adminReason: values.adminReason,
        reasonChanged: values.reason !== undefined,
        evidenceChanged: values.evidence !== undefined,
        notesChanged: values.notes !== undefined
    });
}
export async function adjustPoints(db, guild, actorId, moderatorUserId, amountMilli, reason) {
    db.run(`INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
     VALUES (?, ?, NULL, ?, ?, 'adjustment', ?, ?)`, guild.id, moderatorUserId, amountMilli, reason, actorId, nowIso());
    await writeAuditAndPost(db, guild, actorId, "points.adjusted", { moderatorUserId, amountMilli, reason });
}
export function getPointTotal(db, guildId, moderatorUserId, since) {
    const row = since
        ? db.get("SELECT COALESCE(SUM(amount_milli), 0) AS total FROM point_ledger WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ?", guildId, moderatorUserId, since)
        : db.get("SELECT COALESCE(SUM(amount_milli), 0) AS total FROM point_ledger WHERE guild_id = ? AND moderator_user_id = ?", guildId, moderatorUserId);
    return row?.total ?? 0;
}
export function getStrikeTotal(db, guildId, targetUserId) {
    return (db.get("SELECT COALESCE(SUM(amount), 0) AS total FROM strikes WHERE guild_id = ? AND target_user_id = ? AND active = 1", guildId, targetUserId)?.total ?? 0);
}
function getJuniorEscalation(db, member, actionName) {
    const isOther = actionName === "other" || actionName === "case-note";
    const roles = db.listStaffRoles(member.guild.id);
    const config = db.getGuildConfig(member.guild.id);
    const hasRoleKey = (key) => roles.some((role) => role.key === key && member.roles.cache.has(role.roleId));
    const juniorOnly = hasRoleKey("juniorMod") &&
        !hasRoleKey("mod") &&
        !hasRoleKey("seniorMod") &&
        !hasRoleKey("headMod") &&
        !hasRoleKey("communityManager");
    if (!juniorOnly)
        return null;
    let roleIds = [];
    let userIds = [];
    if (isOther) {
        roleIds = config.juniorOtherEscalationRoleIds;
        userIds = config.juniorOtherEscalationUserIds;
    }
    else {
        // all other actions: use juniorEscalationRoleIds, falling back to seniorMod + mod
        if (config.juniorEscalationRoleIds.length > 0 || config.juniorEscalationUserIds.length > 0) {
            roleIds = config.juniorEscalationRoleIds;
            userIds = config.juniorEscalationUserIds;
        }
        else {
            const defaultRoles = [
                roles.find((r) => r.key === "seniorMod")?.roleId,
                roles.find((r) => r.key === "mod")?.roleId
            ].filter((id) => Boolean(id));
            roleIds = defaultRoles;
        }
    }
    if (roleIds.length === 0 && userIds.length === 0)
        return null;
    const mentions = [
        ...roleIds.map((id) => `<@&${id}>`),
        ...userIds.map((id) => `<@${id}>`)
    ].join(" ");
    return { roleIds, userIds, mentions };
}
function buildApprovalEmbed(record, status, reviewedByUserId) {
    const statusColor = status === "approved" ? 0x2ecc71 : status === "denied" ? 0xe74c3c : 0xf39c12;
    const statusText = status === "approved" ? "✅ Approved" : status === "denied" ? "❌ Denied" : "⏳ Pending CM Approval";
    const fields = [
        { name: "Moderator", value: `<@${record.moderatorUserId}>`, inline: true },
        { name: "Action", value: record.actionDisplayName ?? record.actionName, inline: true },
        { name: "Status", value: statusText, inline: true },
        { name: "Target", value: truncate(formatCaseTarget(record), 1000), inline: false },
        { name: "Reason", value: truncate(record.reason, 500), inline: false }
    ];
    if (record.notes)
        fields.push({ name: "Notes", value: truncate(record.notes, 300), inline: false });
    if (reviewedByUserId)
        fields.push({ name: "Reviewed By", value: `<@${reviewedByUserId}>`, inline: true });
    return new EmbedBuilder()
        .setTitle(`CM Approval: ${record.actionDisplayName ?? record.actionName} — Case #${record.id}`)
        .setColor(statusColor)
        .addFields(fields)
        .setTimestamp();
}
function buildApprovalComponents(caseId) {
    return [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`approval:approve:${caseId}`).setLabel("Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`approval:deny:${caseId}`).setLabel("Deny").setStyle(ButtonStyle.Danger))
    ];
}
async function postApprovalRequest(db, guild, record) {
    const config = db.getGuildConfig(guild.id);
    if (!config.approvalChannelId)
        return;
    const embed = buildApprovalEmbed(record, "pending");
    const components = buildApprovalComponents(record.id);
    const msg = await postToConfiguredChannel(guild, config.approvalChannelId, {
        embeds: [embed],
        components,
        allowedMentions: { parse: [] }
    });
    if (msg) {
        db.run("UPDATE moderation_cases SET approval_message_id = ? WHERE guild_id = ? AND id = ?", msg.id, guild.id, record.id);
    }
}
export async function handleApprovalButton(db, interaction) {
    if (!interaction.customId.startsWith("approval:"))
        return false;
    if (!interaction.guild)
        return false;
    const parts = interaction.customId.split(":");
    if (parts.length !== 3)
        return false;
    const [, action, caseIdStr] = parts;
    if (action !== "approve" && action !== "deny")
        return false;
    const caseId = parseInt(caseIdStr, 10);
    if (isNaN(caseId))
        return false;
    const guildMember = interaction.member;
    const tier = getStaffTier(db, guildMember);
    if (tier !== "community") {
        await interaction.reply({ content: "Only Community Managers can approve or deny cases.", ephemeral: true });
        return true;
    }
    const record = db.getCase(interaction.guild.id, caseId);
    if (!record) {
        await interaction.reply({ content: `Case #${caseId} was not found.`, ephemeral: true });
        return true;
    }
    if (record.approvalStatus !== "pending") {
        await interaction.reply({ content: `Case #${caseId} has already been ${record.approvalStatus ?? "processed"}.`, ephemeral: true });
        return true;
    }
    const timestamp = nowIso();
    if (action === "approve") {
        const config = db.getGuildConfig(interaction.guild.id);
        db.transaction(() => {
            db.run("UPDATE moderation_cases SET approval_status = 'approved', updated_at = ? WHERE guild_id = ? AND id = ?", timestamp, interaction.guild.id, caseId);
            if (config.pointsEnabled && record.awardedPointsMilli !== 0) {
                db.run(`INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'award', ?, ?)`, interaction.guild.id, record.moderatorUserId, caseId, record.awardedPointsMilli, `Case #${caseId}: ${record.actionDisplayName ?? record.actionName}`, interaction.user.id, timestamp);
            }
        });
        await interaction.update({
            embeds: [buildApprovalEmbed(record, "approved", interaction.user.id)],
            components: []
        });
    }
    else {
        db.run("UPDATE moderation_cases SET approval_status = 'denied', updated_at = ? WHERE guild_id = ? AND id = ?", timestamp, interaction.guild.id, caseId);
        await interaction.update({
            embeds: [buildApprovalEmbed(record, "denied", interaction.user.id)],
            components: []
        });
    }
    return true;
}
export async function refreshApprovalChannel(db, guild) {
    const config = db.getGuildConfig(guild.id);
    if (!config.approvalChannelId)
        return 0;
    const channel = await getTextChannel(guild, config.approvalChannelId);
    if (!channel)
        return 0;
    // Fetch and delete existing messages
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages && messages.size > 0) {
        await channel.bulkDelete(messages).catch(async () => {
            for (const msg of messages.values()) {
                await msg.delete().catch(() => null);
            }
        });
    }
    // Re-post all pending cases
    const pendingRows = db.all("SELECT id FROM moderation_cases WHERE guild_id = ? AND approval_status = 'pending' AND status = 'active' ORDER BY id ASC", guild.id);
    let count = 0;
    for (const { id } of pendingRows) {
        const record = db.getCase(guild.id, id);
        if (!record || record.approvalStatus !== "pending")
            continue;
        const embed = buildApprovalEmbed(record, "pending");
        const components = buildApprovalComponents(record.id);
        const msg = await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } }).catch(() => null);
        if (msg) {
            db.run("UPDATE moderation_cases SET approval_message_id = ? WHERE guild_id = ? AND id = ?", msg.id, guild.id, record.id);
            count++;
        }
    }
    return count;
}
async function maybePostFastPointsAlert(db, guild, record) {
    const since = new Date(Date.now() - FAST_POINTS_WINDOW_MINUTES * 60 * 1000).toISOString();
    const summary = db.get(`SELECT COALESCE(SUM(amount_milli), 0) AS total, COUNT(*) AS count
     FROM point_ledger
     WHERE guild_id = ? AND moderator_user_id = ? AND type = 'award' AND amount_milli > 0 AND created_at >= ?`, guild.id, record.moderatorUserId, since);
    const total = summary?.total ?? 0;
    if (total < FAST_POINTS_THRESHOLD_MILLI)
        return;
    const recentWarning = db.get("SELECT id FROM audit_events WHERE guild_id = ? AND actor_user_id = ? AND action = 'points.fast-warning' AND created_at >= ? LIMIT 1", guild.id, record.moderatorUserId, since);
    if (recentWarning)
        return;
    const config = db.getGuildConfig(guild.id);
    const embed = new EmbedBuilder()
        .setTitle("Fast Points Review")
        .setColor(0xf1c40f)
        .addFields({ name: "Moderator", value: `<@${record.moderatorUserId}>`, inline: true }, { name: "Points Gained", value: formatPoints(total), inline: true }, { name: "Time Period", value: `Last ${FAST_POINTS_WINDOW_MINUTES} minutes`, inline: true }, {
        name: "Review Note",
        value: "This moderator gained points quickly. Their activity may need to be reviewed.",
        inline: false
    })
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
async function maybePostStrikeAlert(db, guild, record) {
    const config = db.getGuildConfig(guild.id);
    const total = getStrikeTotal(db, guild.id, record.targetUserId);
    const thresholds = db.all("SELECT strike_count, label FROM strike_thresholds WHERE guild_id = ? AND strike_count <= ? ORDER BY strike_count DESC LIMIT 1", guild.id, total);
    const strikeEmbed = new EmbedBuilder()
        .setTitle("Strike Added")
        .setColor(0xe67e22)
        .addFields({ name: "Member", value: truncate(formatCaseTarget(record), 1000), inline: true }, { name: "Added", value: String(record.strikes), inline: true }, { name: "Active Total", value: String(total), inline: true }, { name: "Case", value: `#${record.id}`, inline: true })
        .setTimestamp();
    await postToConfiguredChannel(guild, config.strikeLogChannelId, { embeds: [strikeEmbed] });
    if (thresholds[0]) {
        const alertEmbed = new EmbedBuilder()
            .setTitle("Strike Threshold Reached")
            .setColor(0xe74c3c)
            .addFields({ name: "Member", value: truncate(formatCaseTarget(record), 1000), inline: true }, { name: "Threshold", value: `${thresholds[0].strike_count} - ${thresholds[0].label}`, inline: true }, { name: "Active Total", value: String(total), inline: true })
            .setTimestamp();
        await postToConfiguredChannel(guild, config.alertChannelId, { embeds: [alertEmbed] });
    }
}
