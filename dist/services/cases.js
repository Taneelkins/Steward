import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } from "discord.js";
import { formatMultiplier, formatPoints, truncate } from "../utils/format.js";
import { caseLinkComponents, getStaffTier, getTextChannel, postToConfiguredChannel, transcriptFieldValue, userLabel } from "../utils/discord.js";
import { colors } from "../utils/theme.js";
import { nowIso, parseDateInput } from "../utils/time.js";
import { writeAudit, writeAuditAndPost } from "./audit.js";
import { banRobloxPlayer, kickActivePlayer, lookupRobloxUser, parseRobloxDuration, unbanRobloxPlayer } from "./roblox.js";
const FAST_POINTS_WINDOW_MINUTES = 15;
const FAST_POINTS_THRESHOLD_MILLI = 10000;
export function buildCaseLogEmbed(record, options = {}) {
    const showPoints = options.showPoints ?? true;
    const { warningNumber, punishmentExecuted, ingameBanExecuted, ingameBanFailed, ingameUnbanExecuted, ingameUnbanFailed } = options;
    const isWarnLog = ((record.actionDisplayName ?? record.actionName).toLowerCase().includes("warn") && record.actionName === "discord");
    const appealStatus = record.appealResult === "accepted" ? "Appeal Approved" : record.appealResult === "denied" ? "Appeal Denied" : null;
    const information = [
        `Reason: ${record.reason}`,
        `Evidence: ${record.evidence ?? "None"}`,
        `Notes: ${record.notes ?? "None"}`,
        // Warn logs track warnings separately — don't show misleading "Strikes: 0"
        isWarnLog ? null : `Strikes: ${record.strikes}`,
        `Case ID: ${record.id}`,
        record.punishmentLength ? `Punishment Length: ${record.punishmentLength}` : null,
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
        { name: "Moderator", value: `<@${record.moderatorUserId}>\n${truncate(record.moderatorUsername, 120)}`, inline: false },
        // Warn confirmation — added when Execute Punishment is clicked (warningNumber is passed in)
        ...(isWarnLog && warningNumber !== undefined
            ? [{ name: "⚠️ Warning Issued", value: `Warning **#${warningNumber}** issued and user DM'd.`, inline: false }]
            : []),
        // Punishment executed stamp — added after ban/kick/timeout is carried out
        ...(!isWarnLog && punishmentExecuted
            ? [{ name: "⚡ Punishment Executed", value: "**Punishment Executed**", inline: false }]
            : []),
        // Ingame ban auto-execution stamp
        ...(ingameBanExecuted ? [{ name: "⚡ Ingame Ban Executed", value: "**Player has been banned in-game.**", inline: false }] : []),
        ...(ingameBanFailed ? [{ name: "⚠️ Ingame Ban Failed", value: ingameBanFailed.slice(0, 1024), inline: false }] : []),
        // Ingame unban auto-execution stamp
        ...(ingameUnbanExecuted ? [{ name: "✅ Ingame Ban Reversed", value: "**Player has been unbanned in-game.**", inline: false }] : []),
        ...(ingameUnbanFailed ? [{ name: "⚠️ Ingame Unban Failed", value: ingameUnbanFailed.slice(0, 1024), inline: false }] : [])
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
    if (display.includes("rule break") && display.includes("approved"))
        return colors.appealApproved;
    if (display.includes("rule break") && display.includes("denied"))
        return colors.appealDenied;
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
        record.discordId ? `DiscordID: ${record.discordId}` : null
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
    const requiresApproval = Boolean(config.approvalEnabled && config.approvalChannelId && !isCm && input.moderator.id !== input.guild.ownerId);
    const juniorNeedsReview = isJuniorOnlyMod(db, input.moderator) && Boolean(config.juniorHelpChannelId);
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
        transcript_url, media_links_json, appeal_type, appeal_result, punishment_length,
        created_at, updated_at, approval_status, junior_review_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, guildId, target.targetKey, target.targetLabel, target.robloxUsername, target.discordUsername, target.robloxId, target.discordId, input.moderator.id, userLabel(input.moderator), actionName, actionDisplayName, reason, input.evidence ?? null, input.notes ?? null, basePointsMilli, multiplierMilli, awardedPointsMilli, strikes, flagText, flags.late ? 1 : 0, input.noAction ? 1 : 0, input.transcriptUrl ?? null, mediaLinks.length > 0 ? JSON.stringify(mediaLinks) : null, input.appealType ?? null, input.appealResult ?? null, input.punishmentLength ?? null, timestamp, timestamp, requiresApproval ? "pending" : null, juniorNeedsReview ? "pending" : null);
        const caseId = Number(result.lastInsertRowid);
        if (!requiresApproval && !juniorNeedsReview && config.pointsEnabled && awardedPointsMilli !== 0) {
            db.run(`INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'award', ?, ?)`, guildId, input.moderator.id, caseId, awardedPointsMilli, `Case #${caseId}: ${actionDisplayName}`, input.moderator.id, timestamp);
        }
        if (strikes > 0) {
            db.run("INSERT INTO strikes (guild_id, target_user_id, case_id, amount, active, created_at) VALUES (?, ?, ?, ?, 1, ?)", guildId, target.targetKey, caseId, strikes, timestamp);
        }
        writeAudit(db, guildId, input.moderator.id, "case.created", { caseId, actionName, actionDisplayName, awardedPointsMilli, pointsEnabled: config.pointsEnabled, flags: flagText, target: target.targetKey });
        return caseId;
    });
    const record = db.getCase(guildId, id);
    if (!record)
        throw new Error("Case was created but could not be loaded.");
    const juniorEscalation = getJuniorEscalation(db, input.moderator, actionName);
    if (juniorNeedsReview && juniorEscalation) {
        await postJuniorReviewRequest(db, input.guild, record, juniorEscalation);
    }
    else {
        const embed = buildCaseLogEmbed(record, { showPoints: config.pointsEnabled });
        // Show upcoming warning number on Discord Warn logs so mods know what number this will be
        const isWarnLog = (actionDisplayName ?? actionName).toLowerCase().includes("warn") && actionName === "discord";
        if (isWarnLog && record.discordId) {
            const prevWarns = db.countWarnings(guildId, record.discordId);
            const upcomingNumber = prevWarns + 1;
            embed.addFields({
                name: "⚠️ Warning",
                value: prevWarns === 0
                    ? `This will be **Warning #${upcomingNumber}** — no prior warnings on record. Press **Execute Punishment** to issue it.`
                    : `**${prevWarns}** prior warning(s) on record. This will be **Warning #${upcomingNumber}**. Press **Execute Punishment** to issue it.`,
                inline: false
            });
        }
        if (juniorEscalation) {
            embed.addFields({
                name: "Staff Review Required",
                value: `This log was submitted by a Junior Moderator. ${juniorEscalation.mentions} needs to review this action.`,
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
        const linkComponents = caseLinkComponents(record.transcriptUrl, record.mediaLinks);
        const appealChannel = actionName === "appeal" ? config.appealLogChannelId : null;
        const logChannelId = appealChannel ?? db.getActionLogChannelId(guildId, actionName) ?? config.actionLogChannelId;
        const logMsg = await postToConfiguredChannel(input.guild, logChannelId, {
            ...(juniorEscalation ? { content: `${juniorEscalation.mentions} Junior Moderator log needs review.` } : {}),
            embeds: [embed],
            ...(linkComponents.length > 0 ? { components: linkComponents } : {}),
            ...(juniorEscalation?.roleIds.length ? { allowedMentions: { roles: juniorEscalation.roleIds, users: juniorEscalation.userIds } } : {})
        });
        if (logMsg && logChannelId) {
            db.updateCaseLogMessage(guildId, id, logChannelId, logMsg.id);
        }
        if (requiresApproval) {
            await postApprovalRequest(db, input.guild, record);
        }
    }
    if (strikes > 0) {
        await maybePostStrikeAlert(db, input.guild, record);
    }
    if (config.pointsEnabled) {
        await maybePostFastPointsAlert(db, input.guild, record);
    }
    return record;
}
// ── Ingame ban/unban auto-execution ──────────────────────────────────────────
/** True for cases that represent an in-game ban (action "ban" from the log workflow or /ingameban). */
export function isIngameBanCase(record) {
    return record.actionName === "ban" && !record.isNoAction;
}
/** True for accepted appeal logs that are for an in-game ban. */
export function isIngameBanAppealAccepted(record) {
    return (record.actionName === "appeal" &&
        record.appealResult === "accepted" &&
        (record.appealType ?? "").toLowerCase().includes("ingame"));
}
async function resolveRobloxUserId(record) {
    if (record.robloxId) {
        const parsed = parseInt(record.robloxId, 10);
        if (!isNaN(parsed))
            return parsed;
    }
    if (record.robloxUsername) {
        const user = await lookupRobloxUser(record.robloxUsername);
        return user?.id ?? null;
    }
    return null;
}
async function stampCaseLog(db, guild, record, extraOptions) {
    const refreshed = db.getCase(guild.id, record.id) ?? record;
    if (!refreshed.logChannelId || !refreshed.logMessageId)
        return;
    const config = db.getGuildConfig(guild.id);
    const channel = await getTextChannel(guild, refreshed.logChannelId);
    const msg = await channel?.messages.fetch(refreshed.logMessageId).catch(() => null);
    if (!msg)
        return;
    const embed = buildCaseLogEmbed(refreshed, { showPoints: config.pointsEnabled, ...extraOptions });
    const linkRows = caseLinkComponents(refreshed.transcriptUrl, refreshed.mediaLinks);
    await msg.edit({ embeds: [embed], components: linkRows }).catch(() => null);
}
/**
 * Auto-execute an in-game ban for a case. Fire-and-forget safe — errors are caught internally.
 * Pass the caseId so we always work off the freshest record (log message IDs populated).
 */
export async function autoExecuteIngameBan(db, guild, caseId) {
    const record = db.getCase(guild.id, caseId);
    if (!record || !isIngameBanCase(record))
        return;
    const config = db.getGuildConfig(guild.id);
    if (config.autoPunishDisabled.includes("ingame"))
        return;
    const game = db.getAutoRobloxGame(guild.id);
    if (!game) {
        const games = db.listRobloxGames(guild.id);
        const msg = games.length === 0
            ? "No Roblox game configured. Use `/roblox add` to set one up."
            : `Multiple games configured with no default. Use \`/roblox set-default <name>\` to pick one.`;
        await stampCaseLog(db, guild, record, { ingameBanFailed: msg }).catch(() => null);
        return;
    }
    const robloxUserId = await resolveRobloxUserId(record);
    if (!robloxUserId) {
        await stampCaseLog(db, guild, record, { ingameBanFailed: "No Roblox username or ID on this case — ban not executed." }).catch(() => null);
        return;
    }
    const durationSeconds = parseRobloxDuration(record.punishmentLength) ?? undefined;
    const result = await banRobloxPlayer({
        universeId: game.universeId,
        apiKey: game.apiKey,
        robloxUserId,
        displayReason: record.reason.slice(0, 400),
        privateReason: `Case #${record.id}: ${record.reason}`.slice(0, 400),
        durationSeconds
    });
    if (result.success) {
        await kickActivePlayer(game.universeId, game.apiKey, robloxUserId, record.reason);
        await stampCaseLog(db, guild, record, { ingameBanExecuted: true }).catch(() => null);
    }
    else {
        await stampCaseLog(db, guild, record, { ingameBanFailed: result.error }).catch(() => null);
    }
}
/**
 * Auto-execute an in-game unban for an accepted ingame ban appeal case.
 */
export async function autoExecuteIngameUnban(db, guild, caseId) {
    const record = db.getCase(guild.id, caseId);
    if (!record || !isIngameBanAppealAccepted(record))
        return;
    const config = db.getGuildConfig(guild.id);
    if (config.autoPunishDisabled.includes("appeal"))
        return;
    const game = db.getAutoRobloxGame(guild.id);
    if (!game) {
        const games = db.listRobloxGames(guild.id);
        const msg = games.length === 0
            ? "No Roblox game configured."
            : "Multiple games configured with no default. Use `/roblox set-default <name>`.";
        await stampCaseLog(db, guild, record, { ingameUnbanFailed: msg }).catch(() => null);
        return;
    }
    const robloxUserId = await resolveRobloxUserId(record);
    if (!robloxUserId) {
        await stampCaseLog(db, guild, record, { ingameUnbanFailed: "No Roblox username or ID on this case — unban not executed." }).catch(() => null);
        return;
    }
    const result = await unbanRobloxPlayer({ universeId: game.universeId, apiKey: game.apiKey, robloxUserId });
    if (result.success) {
        await stampCaseLog(db, guild, record, { ingameUnbanExecuted: true }).catch(() => null);
    }
    else {
        await stampCaseLog(db, guild, record, { ingameUnbanFailed: result.error }).catch(() => null);
    }
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
function isJuniorOnlyMod(db, member) {
    const roles = db.listStaffRoles(member.guild.id);
    const hasRoleKey = (key) => roles.some((role) => role.key === key && member.roles.cache.has(role.roleId));
    return hasRoleKey("juniorMod") && !hasRoleKey("mod") && !hasRoleKey("seniorMod") && !hasRoleKey("headMod") && !hasRoleKey("communityManager");
}
function getJuniorEscalation(db, member, actionName) {
    const isOther = actionName === "other" || actionName === "case-note";
    const config = db.getGuildConfig(member.guild.id);
    const roles = db.listStaffRoles(member.guild.id);
    if (!isJuniorOnlyMod(db, member))
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
    const isOwnerOrAdmin = guildMember.id === interaction.guild.ownerId || guildMember.permissions.has(PermissionFlagsBits.Administrator);
    const tier = getStaffTier(db, guildMember);
    if (!isOwnerOrAdmin && tier !== "community") {
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
        await updateCaseLogAfterApproval(db, interaction.guild, record, "approved", interaction.user.id);
        // Auto-execute ingame ban / unban now that the case is approved
        if (isIngameBanCase(record)) {
            autoExecuteIngameBan(db, interaction.guild, caseId).catch((err) => console.error("[cases] CM-approval autoExecuteIngameBan:", err));
        }
        else if (isIngameBanAppealAccepted(record)) {
            autoExecuteIngameUnban(db, interaction.guild, caseId).catch((err) => console.error("[cases] CM-approval autoExecuteIngameUnban:", err));
        }
    }
    else {
        db.run("UPDATE moderation_cases SET approval_status = 'denied', updated_at = ? WHERE guild_id = ? AND id = ?", timestamp, interaction.guild.id, caseId);
        await interaction.update({
            embeds: [buildApprovalEmbed(record, "denied", interaction.user.id)],
            components: []
        });
        await updateCaseLogAfterApproval(db, interaction.guild, record, "denied", interaction.user.id);
    }
    return true;
}
async function updateCaseLogAfterApproval(db, guild, record, status, reviewerUserId) {
    if (!record.logChannelId || !record.logMessageId)
        return;
    const channel = await getTextChannel(guild, record.logChannelId);
    if (!channel)
        return;
    const msg = await channel.messages.fetch(record.logMessageId).catch(() => null);
    if (!msg)
        return;
    const config = db.getGuildConfig(guild.id);
    const updatedRecord = db.getCase(guild.id, record.id) ?? record;
    const embed = buildCaseLogEmbed(updatedRecord, { showPoints: config.pointsEnabled });
    const statusLabel = status === "approved" ? "✅ Approved" : "❌ Denied";
    embed.addFields({ name: "CM Approval", value: `${statusLabel} by <@${reviewerUserId}>`, inline: false });
    const executeRow = status === "approved" ? buildExecutePunishmentButton(updatedRecord, config) : null;
    const linkComponents = caseLinkComponents(updatedRecord.transcriptUrl, updatedRecord.mediaLinks);
    await msg.edit({
        embeds: [embed],
        components: [...(executeRow ? [executeRow] : []), ...linkComponents]
    }).catch(() => null);
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
// ── Junior Mod Review System ────────────────────────────────────────────────
function buildJuniorReviewEmbed(record, status, opts = {}) {
    const statusColor = status === "approved" ? 0x2ecc71 : status === "denied" ? 0xe74c3c : 0xf39c12;
    const statusText = status === "approved" ? "✅ Approved" : status === "denied" ? "❌ Denied" : "⏳ Pending Review";
    const information = [
        `Reason: ${record.reason}`,
        `Evidence: ${record.evidence ?? "None"}`,
        `Notes: ${record.notes ?? "None"}`,
        record.punishmentLength ? `Punishment Length: ${record.punishmentLength}` : null,
        record.transcriptUrl ? `Transcript: ${transcriptFieldValue(record.transcriptUrl)}` : null,
        record.mediaLinks.length > 0 ? `Media: ${record.mediaLinks.map((l) => l.label).join(", ")}` : null
    ].filter(Boolean);
    const fields = [
        { name: "Status", value: statusText, inline: true },
        { name: "Junior Moderator", value: `<@${record.moderatorUserId}>`, inline: true },
        { name: "Action", value: record.actionDisplayName ?? record.actionName, inline: true },
        ...(record.actionName === "appeal" && record.appealType
            ? [{ name: "Appeal Type", value: record.appealType, inline: true }]
            : []),
        ...(record.actionName === "appeal" && record.appealResult
            ? [{ name: "Appeal Result", value: record.appealResult === "accepted" ? "✅ Accepted" : "❌ Denied", inline: true }]
            : []),
        { name: "Target", value: truncate(formatCaseTarget(record), 1000), inline: false },
        { name: "Information", value: truncate(information.join("\n"), 1000), inline: false }
    ];
    if (opts.reviewerUserId)
        fields.push({ name: "Reviewed By", value: `<@${opts.reviewerUserId}>`, inline: true });
    if (opts.denialReason)
        fields.push({ name: "Denial Reason", value: truncate(opts.denialReason, 500), inline: false });
    return new EmbedBuilder()
        .setTitle(`Junior Mod Review — ${record.actionDisplayName ?? record.actionName} — Case #${record.id}`)
        .setColor(statusColor)
        .addFields(fields)
        .setTimestamp();
}
function buildJuniorReviewComponents(record) {
    const actionRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`junior_review:approve:${record.id}`).setLabel("✅ Approve").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`junior_review:deny:${record.id}`).setLabel("❌ Deny").setStyle(ButtonStyle.Danger));
    return [actionRow, ...caseLinkComponents(record.transcriptUrl, record.mediaLinks)];
}
async function postJuniorReviewRequest(db, guild, record, escalation) {
    const config = db.getGuildConfig(guild.id);
    const embed = buildJuniorReviewEmbed(record, "pending");
    const components = buildJuniorReviewComponents(record);
    const msg = await postToConfiguredChannel(guild, config.juniorHelpChannelId, {
        content: `${escalation.mentions} A Junior Moderator has submitted a log for review.`,
        embeds: [embed],
        components,
        allowedMentions: { roles: escalation.roleIds, users: escalation.userIds }
    });
    if (msg) {
        db.run("UPDATE moderation_cases SET junior_review_message_id = ? WHERE guild_id = ? AND id = ?", msg.id, guild.id, record.id);
    }
}
export async function resubmitJuniorReviewCase(db, guild, record, moderator) {
    const escalation = getJuniorEscalation(db, moderator, record.actionName);
    if (!escalation)
        return;
    await postJuniorReviewRequest(db, guild, record, escalation);
}
export async function handleJuniorReviewButton(db, interaction) {
    if (!interaction.customId.startsWith("junior_review:"))
        return false;
    if (!interaction.guild)
        return false;
    const [, action, caseIdStr] = interaction.customId.split(":");
    const caseId = parseInt(caseIdStr, 10);
    if (isNaN(caseId) || (action !== "approve" && action !== "deny"))
        return false;
    const guildMember = interaction.member;
    const isOwnerOrAdmin = guildMember.id === interaction.guild.ownerId || guildMember.permissions.has(PermissionFlagsBits.Administrator);
    const tier = getStaffTier(db, guildMember);
    if (!isOwnerOrAdmin && (tier === "junior" || tier === null)) {
        await interaction.reply({ content: "Junior Moderators cannot approve or deny logs.", ephemeral: true });
        return true;
    }
    const record = db.getCase(interaction.guild.id, caseId);
    if (!record) {
        await interaction.reply({ content: `Case #${caseId} was not found.`, ephemeral: true });
        return true;
    }
    if (record.juniorReviewStatus !== "pending") {
        await interaction.reply({ content: `Case #${caseId} has already been ${record.juniorReviewStatus ?? "processed"}.`, ephemeral: true });
        return true;
    }
    if (action === "approve") {
        const config = db.getGuildConfig(interaction.guild.id);
        const timestamp = nowIso();
        db.transaction(() => {
            db.run("UPDATE moderation_cases SET junior_review_status = 'approved', updated_at = ? WHERE guild_id = ? AND id = ?", timestamp, interaction.guild.id, caseId);
            if (config.pointsEnabled && record.awardedPointsMilli !== 0) {
                db.run(`INSERT INTO point_ledger (guild_id, moderator_user_id, case_id, amount_milli, reason, type, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'award', ?, ?)`, interaction.guild.id, record.moderatorUserId, caseId, record.awardedPointsMilli, `Case #${caseId}: ${record.actionDisplayName ?? record.actionName}`, interaction.user.id, timestamp);
            }
        });
        const config2 = db.getGuildConfig(interaction.guild.id);
        const appealChannel = record.actionName === "appeal" ? config2.appealLogChannelId : null;
        const logChannelId2 = appealChannel ?? db.getActionLogChannelId(interaction.guild.id, record.actionName) ?? config2.actionLogChannelId;
        const logEmbed = buildCaseLogEmbed(record, { showPoints: config.pointsEnabled });
        const linkComponents = caseLinkComponents(record.transcriptUrl, record.mediaLinks);
        const juniorLogMsg = await postToConfiguredChannel(interaction.guild, logChannelId2, {
            content: `Junior Mod <@${record.moderatorUserId}> ticket verified by Moderator <@${interaction.user.id}>`,
            embeds: [logEmbed],
            ...(linkComponents.length > 0 ? { components: linkComponents } : {}),
            allowedMentions: { users: [record.moderatorUserId, interaction.user.id] }
        });
        if (juniorLogMsg && logChannelId2) {
            db.updateCaseLogMessage(interaction.guild.id, record.id, logChannelId2, juniorLogMsg.id);
        }
        await interaction.update({
            embeds: [buildJuniorReviewEmbed(record, "approved", { reviewerUserId: interaction.user.id })],
            components: []
        });
        // Auto-execute ingame ban / unban now that the junior log is approved
        if (isIngameBanCase(record)) {
            autoExecuteIngameBan(db, interaction.guild, caseId).catch((err) => console.error("[cases] junior-approval autoExecuteIngameBan:", err));
        }
        else if (isIngameBanAppealAccepted(record)) {
            autoExecuteIngameUnban(db, interaction.guild, caseId).catch((err) => console.error("[cases] junior-approval autoExecuteIngameUnban:", err));
        }
    }
    else {
        const modal = new ModalBuilder()
            .setCustomId(`junior_deny_reason:${caseId}`)
            .setTitle("Deny Log — Enter Reason")
            .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("Reason for denial (required)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000)));
        await interaction.showModal(modal);
    }
    return true;
}
export async function handleJuniorReviewModal(db, interaction) {
    if (!interaction.customId.startsWith("junior_deny_reason:"))
        return false;
    if (!interaction.guild)
        return false;
    const caseId = parseInt(interaction.customId.split(":")[1], 10);
    if (isNaN(caseId))
        return false;
    await interaction.deferReply({ ephemeral: true });
    const reason = interaction.fields.getTextInputValue("reason").trim();
    const record = db.getCase(interaction.guild.id, caseId);
    if (!record || record.juniorReviewStatus !== "pending") {
        await interaction.editReply("This case cannot be denied right now.");
        return false;
    }
    const config = db.getGuildConfig(interaction.guild.id);
    db.run("UPDATE moderation_cases SET junior_review_status = 'denied', updated_at = ? WHERE guild_id = ? AND id = ?", nowIso(), interaction.guild.id, caseId);
    if (record.juniorReviewMessageId && config.juniorHelpChannelId) {
        const channel = await getTextChannel(interaction.guild, config.juniorHelpChannelId);
        if (channel) {
            const msg = await channel.messages.fetch(record.juniorReviewMessageId).catch(() => null);
            if (msg) {
                await msg.edit({
                    embeds: [buildJuniorReviewEmbed(record, "denied", { reviewerUserId: interaction.user.id, denialReason: reason })],
                    components: []
                }).catch(() => null);
            }
        }
    }
    const juniorUser = await interaction.client.users.fetch(record.moderatorUserId).catch(() => null);
    if (juniorUser) {
        const dmEmbed = new EmbedBuilder()
            .setTitle("❌ Log Denied")
            .setColor(0xe74c3c)
            .setDescription(`Your log was reviewed and denied by <@${interaction.user.id}>.`)
            .addFields({ name: "Case", value: `#${record.id} — ${record.actionDisplayName ?? record.actionName}`, inline: true }, { name: "Target", value: truncate(formatCaseTarget(record), 500), inline: true }, { name: "Reason for Denial", value: truncate(reason, 1000), inline: false }, {
            name: "Your Log Details",
            value: truncate([
                `Reason: ${record.reason}`,
                `Evidence: ${record.evidence ?? "None"}`,
                `Notes: ${record.notes ?? "None"}`,
                record.punishmentLength ? `Punishment: ${record.punishmentLength}` : null
            ].filter(Boolean).join("\n"), 800),
            inline: false
        }, {
            name: "How to Edit & Resubmit",
            value: "Run `/log` in the server. Your denied log will be pre-loaded for editing — make your changes and submit again.",
            inline: false
        })
            .setTimestamp();
        await juniorUser.send({ embeds: [dmEmbed] }).catch(() => null);
    }
    await interaction.editReply(`Case #${caseId} denied. The Junior Moderator has been notified.`);
    return record;
}
function extractDiscordTargetId(record) {
    if (record.discordId)
        return record.discordId;
    if (record.targetUserId.startsWith("discord:"))
        return record.targetUserId.slice("discord:".length);
    return null;
}
export function parsePunishmentLength(value) {
    if (!value)
        return null;
    const s = value.trim();
    // Units in descending specificity so "months" is checked before bare "m"
    const patterns = [
        [/(\d+)\s*(?:years?|yrs?)\b/gi, 365 * 24 * 3600_000],
        [/(\d+)\s*months?\b/gi, 30 * 24 * 3600_000],
        [/(\d+)\s*(?:weeks?|wks?)\b/gi, 7 * 24 * 3600_000],
        [/(\d+)\s*days?\b/gi, 24 * 3600_000],
        [/(\d+)\s*hours?\b/gi, 3600_000],
        [/(\d+)\s*(?:minutes?|mins?)\b/gi, 60_000],
        [/(\d+)\s*(?:seconds?|secs?)\b/gi, 1000],
        [/(\d+)\s*y(?!\w)/gi, 365 * 24 * 3600_000],
        [/(\d+)\s*mo(?!\w)/gi, 30 * 24 * 3600_000],
        [/(\d+)\s*w(?!\w)/gi, 7 * 24 * 3600_000],
        [/(\d+)\s*d(?!\w)/gi, 24 * 3600_000],
        [/(\d+)\s*h(?!\w)/gi, 3600_000],
        [/(\d+)\s*m(?!\w)/gi, 60_000],
        [/(\d+)\s*s(?!\w)/gi, 1000],
    ];
    // Track which character positions have already been matched to avoid double-counting
    const consumed = new Set();
    let total = 0;
    let matched = false;
    for (const [re, mult] of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(s)) !== null) {
            if (!consumed.has(m.index)) {
                for (let i = m.index; i < m.index + m[0].length; i++)
                    consumed.add(i);
                total += parseInt(m[1], 10) * mult;
                matched = true;
            }
        }
    }
    return matched ? total : null;
}
function mapCaseToPunishment(record) {
    const display = (record.actionDisplayName ?? record.actionName).toLowerCase();
    if (display.includes("ban") || record.actionName === "ban")
        return { kind: "ban" };
    if (display.includes("kick"))
        return { kind: "kick" };
    if (display.includes("timeout") || display.includes("mute")) {
        const raw = parsePunishmentLength(record.punishmentLength);
        const MAX_TIMEOUT = 27 * 24 * 60 * 60 * 1000;
        const durationMs = raw ? Math.min(Math.max(raw, 60_000), MAX_TIMEOUT) : MAX_TIMEOUT;
        return { kind: "timeout", durationMs };
    }
    return { kind: "warn" };
}
export function buildExecutePunishmentButton(record, config) {
    if (!config.linkedGuildId)
        return null;
    if (!extractDiscordTargetId(record))
        return null;
    const isAppealAccept = record.actionName === "appeal" && record.appealResult === "accepted";
    const isDiscordAction = record.actionName === "discord" || record.actionName === "discord-ban";
    if (!isDiscordAction && !isAppealAccept)
        return null;
    // If auto-punish is disabled for discord actions, suppress the button too
    if (config.autoPunishDisabled?.includes("discord"))
        return null;
    const label = isAppealAccept ? "✅ Reverse Punishment" : "⚡ Execute Punishment";
    const style = isAppealAccept ? ButtonStyle.Success : ButtonStyle.Danger;
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`execute_punishment:${record.id}`)
        .setLabel(label)
        .setStyle(style));
}
export async function handleExecutePunishment(db, interaction) {
    if (!interaction.customId.startsWith("execute_punishment:"))
        return false;
    if (!interaction.guild)
        return false;
    const caseId = parseInt(interaction.customId.split(":")[1], 10);
    if (isNaN(caseId))
        return false;
    await interaction.deferReply({ ephemeral: true });
    const record = db.getCase(interaction.guild.id, caseId);
    if (!record) {
        await interaction.editReply(`Case #${caseId} not found.`);
        return true;
    }
    if (interaction.user.id !== record.moderatorUserId) {
        await interaction.editReply("Only the moderator who submitted this case can execute the punishment.");
        return true;
    }
    const config = db.getGuildConfig(interaction.guild.id);
    if (!config.linkedGuildId) {
        await interaction.editReply("No linked community server configured. Use `/config behavior linked_server:<guild_id>`.");
        return true;
    }
    const discordTargetId = extractDiscordTargetId(record);
    if (!discordTargetId) {
        await interaction.editReply("This case has no Discord user ID. Punishments can only be executed on Discord targets.");
        return true;
    }
    const linkedGuild = await interaction.client.guilds.fetch(config.linkedGuildId).catch(() => null);
    if (!linkedGuild) {
        await interaction.editReply(`Cannot access linked server \`${config.linkedGuildId}\`. Make sure the bot has joined it.`);
        return true;
    }
    const targetUser = await interaction.client.users.fetch(discordTargetId).catch(() => null);
    const auditReason = `${record.actionDisplayName ?? record.actionName}: ${record.reason}`.slice(0, 512);
    // ── Appeal accepted: reverse the punishment ──────────────────────────────
    if (record.actionName === "appeal" && record.appealResult === "accepted") {
        const appealTypeLower = (record.appealType ?? "").toLowerCase();
        let resultMsg = "";
        let inviteUrl = null;
        try {
            if (appealTypeLower.includes("ban")) {
                await linkedGuild.members.unban(discordTargetId, `Appeal #${record.id} accepted`);
                resultMsg = `<@${discordTargetId}> has been **unbanned** from **${linkedGuild.name}**.`;
                const ch = linkedGuild.channels.cache.find(c => c.type === ChannelType.GuildText);
                const invite = ch ? await ch.createInvite({ maxAge: 7 * 24 * 3600, maxUses: 1, reason: `Appeal #${record.id} accepted` }).catch(() => null) : null;
                inviteUrl = invite?.url ?? null;
            }
            else if (appealTypeLower.includes("timeout") || appealTypeLower.includes("mute")) {
                const member = await linkedGuild.members.fetch(discordTargetId).catch(() => null);
                if (!member)
                    throw new Error("User is not in the linked server.");
                await member.timeout(null, `Appeal #${record.id} accepted`);
                resultMsg = `<@${discordTargetId}>'s timeout has been **removed** in **${linkedGuild.name}**.`;
            }
            else if (appealTypeLower.includes("kick")) {
                resultMsg = `Kick reversed (informational — cannot undo a kick).`;
                const ch = linkedGuild.channels.cache.find(c => c.type === ChannelType.GuildText);
                const invite = ch ? await ch.createInvite({ maxAge: 7 * 24 * 3600, maxUses: 1, reason: `Appeal #${record.id} accepted` }).catch(() => null) : null;
                inviteUrl = invite?.url ?? null;
            }
            else {
                resultMsg = `Appeal accepted (no automatic reversal for appeal type: ${record.appealType ?? "unknown"}).`;
            }
        }
        catch (err) {
            await interaction.editReply(`❌ Failed to reverse punishment: ${err instanceof Error ? err.message : "Unknown error."}`);
            return true;
        }
        if (targetUser) {
            const dmLines = [
                `**Your appeal has been accepted.**`,
                ``,
                `**Case:** #${record.id}`,
                record.appealType ? `**Appeal Type:** ${record.appealType}` : null,
                `**Reviewed by:** ${interaction.user.username}`,
                inviteUrl ? `\n**Rejoin ${linkedGuild.name}:** ${inviteUrl}` : null
            ].filter(Boolean).join("\n");
            await targetUser.send(dmLines).catch(() => null);
        }
        await writeAuditAndPost(db, interaction.guild, interaction.user.id, "punishment.reversed", {
            caseId: record.id, discordTargetId, linkedGuildId: config.linkedGuildId, appealType: record.appealType
        });
        // If a persistent timeout was active for this user, remove it now that their appeal was accepted
        if (appealTypeLower.includes("timeout") || appealTypeLower.includes("mute")) {
            db.deletePersistentTimeoutForTarget(interaction.guild.id, config.linkedGuildId, discordTargetId);
        }
        await postStewardLog(db, interaction.guild, config, record, interaction.user.id, "appeal-reversal", true);
        const dmNote = targetUser ? " DM sent." : " (Could not DM user.)";
        await interaction.editReply(`✅ ${resultMsg}${inviteUrl ? ` Invite: ${inviteUrl}` : ""}${dmNote}`);
        return true;
    }
    // ── Standard punishment execution ────────────────────────────────────────
    const punishment = mapCaseToPunishment(record);
    // ── Warn: record in DB + DM with warning number ──────────────────────────
    if (punishment.kind === "warn") {
        const prevCount = db.countWarnings(interaction.guild.id, discordTargetId);
        db.addWarning(interaction.guild.id, discordTargetId, record.id, record.reason, record.moderatorUserId);
        const warningNumber = prevCount + 1;
        if (targetUser) {
            const dm = [
                `**⚠️ You have received a warning in ${linkedGuild.name}.**`,
                ``,
                `**Warning #${warningNumber}**`,
                `**Reason:** ${record.reason}`,
                record.evidence ? `**Evidence:** ${record.evidence}` : null,
                ``,
                config.moderationInvite ? `To appeal: ${config.moderationInvite}` : null
            ].filter(Boolean).join("\n");
            await targetUser.send(dm).catch(() => null);
        }
        // Update the log channel message to stamp the confirmed warning number on the embed
        const warnRecord = db.getCase(interaction.guild.id, record.id);
        if (warnRecord?.logChannelId && warnRecord.logMessageId) {
            const logCh = await getTextChannel(interaction.guild, warnRecord.logChannelId);
            const logMsg = await logCh?.messages.fetch(warnRecord.logMessageId).catch(() => null);
            if (logMsg) {
                const updatedEmbed = buildCaseLogEmbed(warnRecord, { showPoints: config.pointsEnabled, warningNumber });
                const linkRows = caseLinkComponents(warnRecord.transcriptUrl, warnRecord.mediaLinks);
                await logMsg.edit({ embeds: [updatedEmbed], components: linkRows }).catch(() => null);
            }
        }
        await writeAuditAndPost(db, interaction.guild, interaction.user.id, "punishment.executed", {
            caseId: record.id, discordTargetId, linkedGuildId: config.linkedGuildId, action: "warn", success: true
        });
        await postStewardLog(db, interaction.guild, config, record, interaction.user.id, "warn", true);
        const dmNote = targetUser ? " DM sent." : " (Could not DM user — they may have DMs disabled.)";
        await interaction.editReply(`✅ <@${discordTargetId}> warned (warning **#${warningNumber}**).${dmNote}`);
        return true;
    }
    const actionLabel = punishment.kind === "ban" ? "banned" : punishment.kind === "kick" ? "kicked" : "timed out";
    // Check if the user is already punished
    if (punishment.kind === "ban") {
        const existingBan = await linkedGuild.bans.fetch(discordTargetId).catch(() => null);
        if (existingBan) {
            await interaction.editReply(`⚠️ <@${discordTargetId}> is already banned from **${linkedGuild.name}**. No action taken.`);
            return true;
        }
    }
    else if (punishment.kind === "timeout") {
        const member = await linkedGuild.members.fetch(discordTargetId).catch(() => null);
        if (member?.communicationDisabledUntil && member.communicationDisabledUntil.getTime() > Date.now()) {
            const until = `<t:${Math.floor(member.communicationDisabledUntil.getTime() / 1000)}:R>`;
            await interaction.editReply(`⚠️ <@${discordTargetId}> is already timed out in **${linkedGuild.name}** (expires ${until}). No action taken.`);
            return true;
        }
    }
    // DM before banning so the message can reach them
    if (targetUser) {
        const dmLines = [
            `**You have been ${actionLabel} in ${linkedGuild.name}.**`,
            ``,
            `**Moderator:** ${record.moderatorUsername} (${record.moderatorUserId})`,
            `**Reason:** ${record.reason}`,
            record.evidence ? `**Evidence:** ${record.evidence}` : null,
            punishment.kind === "timeout" ? `**Duration:** ${record.punishmentLength ?? "unknown"}` : null,
            ``,
            config.moderationInvite ? `To appeal: ${config.moderationInvite}` : null
        ].filter(Boolean).join("\n");
        await targetUser.send(dmLines).catch(() => null);
    }
    let success = true;
    let errorMsg = "";
    try {
        if (punishment.kind === "ban") {
            await linkedGuild.members.ban(discordTargetId, { reason: auditReason, deleteMessageSeconds: 0 });
        }
        else if (punishment.kind === "kick") {
            const member = await linkedGuild.members.fetch(discordTargetId).catch(() => null);
            if (!member) {
                success = false;
                errorMsg = "User is not in the linked server.";
            }
            else
                await member.kick(auditReason);
        }
        else if (punishment.kind === "timeout") {
            const member = await linkedGuild.members.fetch(discordTargetId).catch(() => null);
            if (!member) {
                success = false;
                errorMsg = "User is not in the linked server.";
            }
            else {
                const MAX_TIMEOUT = 27 * 24 * 60 * 60 * 1000; // 27 days (safely under Discord's 28-day limit)
                const capped = Math.min(punishment.durationMs, MAX_TIMEOUT);
                await member.timeout(capped, auditReason);
                if (capped < punishment.durationMs)
                    errorMsg = `(Duration capped at 27 days — Discord's maximum)`;
            }
        }
    }
    catch (err) {
        success = false;
        errorMsg = err instanceof Error ? err.message : "Unknown error.";
    }
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "punishment.executed", {
        caseId: record.id, discordTargetId, linkedGuildId: config.linkedGuildId, action: punishment.kind, success, error: success ? undefined : errorMsg
    });
    if (success) {
        // Schedule persistent timeout renewal for indefinite or >27-day timeouts
        if (punishment.kind === "timeout") {
            const rawDuration = parsePunishmentLength(record.punishmentLength);
            const MAX_TIMEOUT = 27 * 24 * 60 * 60 * 1000;
            if (!rawDuration || rawDuration > MAX_TIMEOUT) {
                const renewAfter = new Date(Date.now() + 26 * 24 * 60 * 60 * 1000).toISOString();
                db.schedulePersistentTimeout({ guildId: interaction.guild.id, linkedGuildId: config.linkedGuildId, discordTargetId, caseId: record.id, renewAfter });
            }
        }
        // Schedule temp ban unban if a duration was given
        if (punishment.kind === "ban") {
            const rawDuration = parsePunishmentLength(record.punishmentLength);
            if (rawDuration) {
                const unbanAt = new Date(Date.now() + rawDuration).toISOString();
                db.scheduleUnban({
                    guildId: interaction.guild.id,
                    linkedGuildId: config.linkedGuildId,
                    discordTargetId,
                    caseId: record.id,
                    unbanAt,
                    moderationInvite: config.moderationInvite,
                    caseAction: record.actionDisplayName ?? record.actionName,
                    caseReason: record.reason
                });
            }
        }
        // Edit the log channel message to stamp "Punishment Executed" on the embed
        const execRecord = db.getCase(interaction.guild.id, record.id);
        if (execRecord?.logChannelId && execRecord.logMessageId) {
            const execLogCh = await getTextChannel(interaction.guild, execRecord.logChannelId);
            const execLogMsg = await execLogCh?.messages.fetch(execRecord.logMessageId).catch(() => null);
            if (execLogMsg) {
                const executedEmbed = buildCaseLogEmbed(execRecord, { showPoints: config.pointsEnabled, punishmentExecuted: true });
                const linkRows = caseLinkComponents(execRecord.transcriptUrl, execRecord.mediaLinks);
                await execLogMsg.edit({ embeds: [executedEmbed], components: linkRows }).catch(() => null);
            }
        }
        // Post to steward log
        await postStewardLog(db, interaction.guild, config, record, interaction.user.id, punishment.kind, success);
        const dmNote = targetUser ? " DM sent." : " (Could not DM user.)";
        const capNote = errorMsg ? `\n⚠️ ${errorMsg}` : "";
        await interaction.editReply(`✅ <@${discordTargetId}> has been ${actionLabel} in **${linkedGuild.name}**.${dmNote}${capNote}`);
    }
    else {
        await interaction.editReply(`❌ Failed to ${punishment.kind} \`${discordTargetId}\`: ${errorMsg}\n\nCheck bot permissions in the linked server.`);
    }
    return true;
}
async function postStewardLog(db, guild, config, record, executorUserId, actionKind, success) {
    if (!config.stewardLogChannelId)
        return;
    const reloadedRecord = db.getCase(guild.id, record.id) ?? record;
    // Build a direct message link if we have both channel and message IDs.
    // Fall back to a channel-level link if only the channel ID is known (e.g. older cases
    // created before log_channel_id/log_message_id tracking was added, or cases whose
    // channel couldn't be determined at creation time).
    const msgUrl = reloadedRecord.logChannelId && reloadedRecord.logMessageId
        ? `https://discord.com/channels/${guild.id}/${reloadedRecord.logChannelId}/${reloadedRecord.logMessageId}`
        : null;
    const fallbackChannelId = reloadedRecord.logChannelId
        ?? db.getActionLogChannelId(guild.id, reloadedRecord.actionName)
        ?? config.actionLogChannelId;
    const channelUrl = !msgUrl && fallbackChannelId
        ? `https://discord.com/channels/${guild.id}/${fallbackChannelId}`
        : null;
    const caseLink = msgUrl
        ? `**Log:** [Case #${record.id}](${msgUrl})`
        : channelUrl
            ? `**Log:** [Case #${record.id}](${channelUrl})`
            : `**Case:** #${record.id}`;
    const lines = [
        `**Action:** ${actionKind.charAt(0).toUpperCase() + actionKind.slice(1)}${success ? "" : " ❌ (failed)"}`,
        `**Moderator:** <@${executorUserId}>`,
        `**Target:** ${reloadedRecord.discordId ? `<@${reloadedRecord.discordId}>` : reloadedRecord.targetUsername}`,
        `**When:** <t:${Math.floor(Date.now() / 1000)}:f>`,
        caseLink
    ].join("\n");
    await postToConfiguredChannel(guild, config.stewardLogChannelId, { content: lines, allowedMentions: { parse: [] } });
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
