import { EmbedBuilder } from "discord.js";
import { formatPoints, listOrNone, truncate } from "../utils/format.js";
import { getTextChannel, postToConfiguredChannel, safeDm } from "../utils/discord.js";
import { addDays, computeNextQuotaEnd, dayName, discordTimestamp, nowIso } from "../utils/time.js";
import { writeAudit, writeAuditAndPost } from "./audit.js";
export function buildQuotaStatusEmbed(config) {
    const end = config.quotaPeriodEnd ?? computeNextQuotaEnd({
        timeZone: config.timezone,
        checkDay: config.quotaCheckDay,
        checkHour: config.quotaCheckHour,
        checkMinute: config.quotaCheckMinute,
        frequencyDays: config.quotaFrequencyDays
    }).toISOString();
    return new EmbedBuilder()
        .setTitle("Active Mod Quota")
        .setColor(config.quotaEnabled ? 0x3498db : 0x95a5a6)
        .addFields({ name: "Required Logs", value: String(config.quotaRequiredLogs), inline: true }, { name: "Grace", value: `${config.quotaGraceLogs} logs`, inline: true }, { name: "Status", value: config.quotaEnabled ? "Enabled" : "Disabled", inline: true }, { name: "Schedule", value: `${dayName(config.quotaCheckDay)} at ${String(config.quotaCheckHour).padStart(2, "0")}:${String(config.quotaCheckMinute).padStart(2, "0")} ${config.timezone}` }, { name: "Ends", value: `${discordTimestamp(end, "F")}\n${discordTimestamp(end, "R")}` })
        .setFooter({ text: "This message is edited when quota settings or periods change." })
        .setTimestamp();
}
export function buildQuotaReportEmbed(report, title = "Quota Period Ended") {
    const missed = report.statuses.filter((status) => status.status === "missed");
    const close = report.statuses.filter((status) => status.status === "close");
    const exempt = report.statuses.filter((status) => status.status === "exempt");
    const missedLines = missed.map((status) => `<@${status.userId}> - ${status.loggedActions}/${status.requiredLogs} logs, missing ${status.missing}`);
    const closeLines = close.map((status) => `<@${status.userId}> - ${status.loggedActions}/${status.requiredLogs} logs`);
    const exemptLines = exempt.map((status) => `<@${status.userId}> - ${truncate(status.exemptionReason ?? "Exempt", 120)}`);
    return new EmbedBuilder()
        .setTitle(title)
        .setColor(missed.length > 0 ? 0xe74c3c : 0x2ecc71)
        .addFields({
        name: "Period",
        value: `${discordTimestamp(report.periodStart, "F")} to ${discordTimestamp(report.periodEnd, "F")}`
    }, { name: "Missed", value: truncate(listOrNone(missedLines), 1000), inline: false }, { name: "Close", value: truncate(listOrNone(closeLines), 1000), inline: false }, { name: "Exempt", value: truncate(listOrNone(exemptLines), 1000), inline: false }, { name: "Summary", value: `${report.statuses.length} staff checked. ${missed.length} missed, ${close.length} close.` })
        .setTimestamp(new Date(report.createdAt));
}
export async function ensureQuotaPeriod(db, guild) {
    let config = db.getGuildConfig(guild.id);
    if (!config.quotaPeriodStart || !config.quotaPeriodEnd) {
        const start = nowIso();
        const end = computeNextQuotaEnd({
            timeZone: config.timezone,
            checkDay: config.quotaCheckDay,
            checkHour: config.quotaCheckHour,
            checkMinute: config.quotaCheckMinute,
            frequencyDays: config.quotaFrequencyDays,
            from: new Date()
        }).toISOString();
        db.updateGuildConfig(guild.id, {
            quota_period_start: start,
            quota_period_end: end,
            quota_warning_sent_at: null
        });
        await snapshotRoster(db, guild, start, end);
        config = db.getGuildConfig(guild.id);
    }
    await upsertQuotaStatusMessage(db, guild);
}
export async function snapshotRoster(db, guild, periodStart, periodEnd) {
    const config = db.getGuildConfig(guild.id);
    const staffRoles = db.listStaffRoles(guild.id);
    const staffRoleIds = new Set(staffRoles.map((role) => role.roleId));
    if (config.modRoleId)
        staffRoleIds.add(config.modRoleId);
    if (staffRoleIds.size === 0)
        return;
    const roleQuotas = db.all("SELECT * FROM role_quotas WHERE guild_id = ?", guild.id);
    const timestamp = nowIso();
    const members = await guild.members.fetch().catch(() => null);
    if (!members)
        return;
    db.run("DELETE FROM quota_roster_snapshots WHERE guild_id = ? AND period_start = ? AND period_end = ?", guild.id, periodStart, periodEnd);
    for (const member of members.values()) {
        if (member.user.bot || !member.roles.cache.some((role) => staffRoleIds.has(role.id)))
            continue;
        const quota = pickQuotaForMember(member, roleQuotas, config, staffRoles);
        db.run(`INSERT INTO quota_roster_snapshots (
        guild_id, period_start, period_end, user_id, role_id, required_logs, grace_logs, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, guild.id, periodStart, periodEnd, member.id, quota.roleId, quota.requiredLogs, quota.graceLogs, timestamp);
    }
}
export function buildQuotaReport(db, guildId, periodStart, periodEnd) {
    const snapshots = db.all("SELECT user_id, role_id, required_logs, grace_logs FROM quota_roster_snapshots WHERE guild_id = ? AND period_start = ? AND period_end = ?", guildId, periodStart, periodEnd);
    const exemptions = db.all("SELECT user_id, reason, expires_at FROM quota_exemptions WHERE guild_id = ?", guildId);
    const exemptionByUser = new Map(exemptions
        .filter((exemption) => !exemption.expires_at || new Date(exemption.expires_at).getTime() >= new Date(periodEnd).getTime())
        .map((exemption) => [exemption.user_id, exemption]));
    const statuses = snapshots.map((snapshot) => {
        const loggedActions = db.get(`SELECT COUNT(*) AS count FROM moderation_cases
         WHERE guild_id = ? AND moderator_user_id = ? AND created_at >= ? AND created_at < ? AND status = 'active'`, guildId, snapshot.user_id, periodStart, periodEnd)?.count ?? 0;
        const exemption = exemptionByUser.get(snapshot.user_id);
        if (exemption) {
            return {
                userId: snapshot.user_id,
                requiredLogs: snapshot.required_logs,
                loggedActions,
                missing: Math.max(snapshot.required_logs - loggedActions, 0),
                status: "exempt",
                exemptionReason: exemption.reason
            };
        }
        const missing = Math.max(snapshot.required_logs - loggedActions, 0);
        const status = loggedActions >= snapshot.required_logs ? "met" : loggedActions + snapshot.grace_logs >= snapshot.required_logs ? "close" : "missed";
        return {
            userId: snapshot.user_id,
            requiredLogs: snapshot.required_logs,
            loggedActions,
            missing,
            status
        };
    });
    return {
        guildId,
        periodStart,
        periodEnd,
        statuses,
        createdAt: nowIso()
    };
}
export async function closeQuotaPeriod(db, guild, actorUserId = "system", reason = "Scheduled quota close") {
    await ensureQuotaPeriod(db, guild);
    const config = db.getGuildConfig(guild.id);
    if (!config.quotaPeriodStart || !config.quotaPeriodEnd)
        return null;
    const report = buildQuotaReport(db, guild.id, config.quotaPeriodStart, config.quotaPeriodEnd);
    db.run("INSERT INTO quota_reports (guild_id, period_start, period_end, status_json, created_at) VALUES (?, ?, ?, ?, ?)", guild.id, report.periodStart, report.periodEnd, JSON.stringify(report.statuses), report.createdAt);
    writeAudit(db, guild.id, actorUserId, "quota.closed", { reason, periodStart: report.periodStart, periodEnd: report.periodEnd });
    const reportEmbed = buildQuotaReportEmbed(report);
    await postToConfiguredChannel(guild, config.quotaChannelId, {
        content: "Quota period ended.",
        embeds: [reportEmbed],
        allowedMentions: { parse: [] }
    });
    const staffRoleIds = db.listStaffRoles(guild.id).map((role) => role.roleId);
    const mentionRoleIds = staffRoleIds.length > 0 ? staffRoleIds : config.modRoleId ? [config.modRoleId] : [];
    await postToConfiguredChannel(guild, config.alertChannelId, {
        content: mentionRoleIds.length > 0 ? `${mentionRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")} quota period ended.` : "Quota period ended.",
        embeds: [reportEmbed],
        allowedMentions: mentionRoleIds.length > 0 ? { roles: mentionRoleIds } : { parse: [] }
    });
    if (config.ownerUserId) {
        const owner = await guild.client.users.fetch(config.ownerUserId).catch(() => null);
        if (owner) {
            const sent = await safeDm(owner, { embeds: [reportEmbed] });
            if (!sent) {
                await postToConfiguredChannel(guild, config.alertChannelId, {
                    content: `<@${config.ownerUserId}> I could not DM the quota report, so I posted it here.`,
                    embeds: [reportEmbed],
                    allowedMentions: { users: [config.ownerUserId] }
                });
            }
        }
    }
    const nextStart = config.quotaPeriodEnd;
    const nextEnd = computeNextQuotaEnd({
        timeZone: config.timezone,
        checkDay: config.quotaCheckDay,
        checkHour: config.quotaCheckHour,
        checkMinute: config.quotaCheckMinute,
        frequencyDays: config.quotaFrequencyDays,
        from: addDays(config.quotaPeriodEnd, 1)
    }).toISOString();
    db.updateGuildConfig(guild.id, {
        quota_period_start: nextStart,
        quota_period_end: nextEnd,
        quota_warning_sent_at: null
    });
    await snapshotRoster(db, guild, nextStart, nextEnd);
    await upsertQuotaStatusMessage(db, guild);
    return report;
}
export async function maybeSendQuotaWarning(db, guild) {
    const config = db.getGuildConfig(guild.id);
    if (!config.quotaEnabled || !config.quotaPeriodStart || !config.quotaPeriodEnd || config.quotaWarningSentAt)
        return;
    const warningAt = new Date(new Date(config.quotaPeriodEnd).getTime() - config.quotaWarningHours * 60 * 60 * 1000);
    if (Date.now() < warningAt.getTime())
        return;
    const report = buildQuotaReport(db, guild.id, config.quotaPeriodStart, config.quotaPeriodEnd);
    const below = report.statuses.filter((status) => status.status === "missed" || status.status === "close");
    if (below.length > 0) {
        const mentions = below.map((status) => `<@${status.userId}>`).join(" ");
        const lines = below.map((status) => `<@${status.userId}> - ${status.loggedActions}/${status.requiredLogs}`).join("\n");
        const embed = new EmbedBuilder()
            .setTitle("Quota Warning")
            .setColor(0xf1c40f)
            .setDescription(`Quota ends ${discordTimestamp(config.quotaPeriodEnd, "R")}.`)
            .addFields({ name: "Below or Close", value: truncate(lines, 1000) })
            .setTimestamp();
        await postToConfiguredChannel(guild, config.quotaChannelId, {
            content: mentions,
            embeds: [embed],
            allowedMentions: { users: below.map((status) => status.userId) }
        });
    }
    db.updateGuildConfig(guild.id, { quota_warning_sent_at: nowIso() });
}
export async function processQuotaTimers(db, guild) {
    await ensureQuotaPeriod(db, guild);
    const config = db.getGuildConfig(guild.id);
    if (!config.quotaEnabled || !config.quotaPeriodEnd)
        return;
    await maybeSendQuotaWarning(db, guild);
    if (Date.now() >= new Date(config.quotaPeriodEnd).getTime()) {
        await closeQuotaPeriod(db, guild);
    }
}
export async function upsertQuotaStatusMessage(db, guild) {
    const config = db.getGuildConfig(guild.id);
    if (!config.quotaChannelId)
        return;
    const channel = await getTextChannel(guild, config.quotaChannelId);
    if (!channel)
        return;
    const embed = buildQuotaStatusEmbed(config);
    if (config.quotaStatusMessageId) {
        const message = await channel.messages.fetch(config.quotaStatusMessageId).catch(() => null);
        if (message) {
            await message.edit({ embeds: [embed] }).catch(() => null);
            return;
        }
    }
    const message = await channel.send({ embeds: [embed] }).catch(() => null);
    if (message) {
        db.updateGuildConfig(guild.id, { quota_status_message_id: message.id });
    }
}
export async function setQuotaSchedule(db, guild, actorId, values) {
    const start = nowIso();
    const end = computeNextQuotaEnd({
        timeZone: values.timezone,
        checkDay: values.checkDay,
        checkHour: values.checkHour,
        checkMinute: values.checkMinute,
        frequencyDays: values.frequencyDays,
        from: new Date()
    }).toISOString();
    db.updateGuildConfig(guild.id, {
        quota_check_day: values.checkDay,
        quota_check_hour: values.checkHour,
        quota_check_minute: values.checkMinute,
        timezone: values.timezone,
        quota_frequency_days: values.frequencyDays,
        quota_period_start: start,
        quota_period_end: end,
        quota_warning_sent_at: null
    });
    await snapshotRoster(db, guild, start, end);
    await upsertQuotaStatusMessage(db, guild);
    await writeAuditAndPost(db, guild, actorId, "quota.schedule.updated", values);
}
function pickQuotaForMember(member, roleQuotas, config, staffRoles = []) {
    const matching = roleQuotas.filter((quota) => member.roles.cache.has(quota.role_id));
    if (matching.length === 0) {
        const highestStaffRole = staffRoles.filter((role) => member.roles.cache.has(role.roleId)).sort((a, b) => b.level - a.level)[0];
        return {
            roleId: highestStaffRole?.roleId ?? config.modRoleId,
            requiredLogs: config.quotaRequiredLogs,
            graceLogs: config.quotaGraceLogs
        };
    }
    const strictest = matching.sort((a, b) => b.required_logs - a.required_logs)[0];
    return {
        roleId: strictest.role_id,
        requiredLogs: strictest.required_logs,
        graceLogs: strictest.grace_logs
    };
}
export function quotaHistory(db, guildId, limit = 5) {
    return db.all("SELECT * FROM quota_reports WHERE guild_id = ? ORDER BY id DESC LIMIT ?", guildId, limit);
}
export function quotaLeaderboard(db, guildId, periodStart, periodEnd) {
    if (periodStart && periodEnd) {
        return db.all(`SELECT moderator_user_id, COUNT(*) AS logs, COALESCE(SUM(awarded_points_milli), 0) AS points
       FROM moderation_cases
       WHERE guild_id = ? AND created_at >= ? AND created_at < ? AND status = 'active'
       GROUP BY moderator_user_id ORDER BY logs DESC, points DESC LIMIT 20`, guildId, periodStart, periodEnd);
    }
    return db.all(`SELECT moderator_user_id, COUNT(*) AS logs, COALESCE(SUM(awarded_points_milli), 0) AS points
     FROM moderation_cases
     WHERE guild_id = ? AND status = 'active'
     GROUP BY moderator_user_id ORDER BY logs DESC, points DESC LIMIT 20`, guildId);
}
export function buildLeaderboardEmbed(rows, title = "Quota Leaderboard", showPoints = true) {
    const lines = rows.map((row, index) => showPoints
        ? `${index + 1}. <@${row.moderator_user_id}> - ${row.logs} logs, ${formatPoints(row.points)} points`
        : `${index + 1}. <@${row.moderator_user_id}> - ${row.logs} logs`);
    return new EmbedBuilder().setTitle(title).setColor(0x1abc9c).setDescription(truncate(listOrNone(lines), 2000)).setTimestamp();
}
