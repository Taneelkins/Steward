import { processQuotaTimers } from "./services/quota.js";
import { handlePotentialTranscript, processOverdueTickets } from "./services/tickets.js";
import { getTextChannel } from "./utils/discord.js";
import { nowIso } from "./utils/time.js";
export async function runStartupRecovery(db, client) {
    for (const guild of client.guilds.cache.values()) {
        await recoverGuild(db, guild);
    }
}
export function startScheduler(db, client, intervalSeconds) {
    const interval = setInterval(() => {
        for (const guild of client.guilds.cache.values()) {
            recoverGuild(db, guild).catch((error) => {
                console.error(`Scheduled recovery failed for guild ${guild.id}:`, error);
            });
        }
    }, Math.max(intervalSeconds, 10) * 1000);
    interval.unref();
    return interval;
}
async function recoverGuild(db, guild) {
    db.ensureGuild(guild.id);
    const config = db.getGuildConfig(guild.id);
    if (config.multiplierEndsAt && new Date(config.multiplierEndsAt).getTime() <= Date.now()) {
        db.updateGuildConfig(guild.id, { multiplier_milli: 1000, multiplier_ends_at: null });
    }
    db.run("DELETE FROM quota_exemptions WHERE guild_id = ? AND expires_at IS NOT NULL AND expires_at <= ?", guild.id, nowIso());
    await processQuotaTimers(db, guild);
    await processOverdueTickets(db, guild);
    await catchUpTranscripts(db, guild);
}
async function catchUpTranscripts(db, guild) {
    const config = db.getGuildConfig(guild.id);
    if (!config.ticketTranscriptChannelId)
        return;
    const channel = await getTextChannel(guild, config.ticketTranscriptChannelId);
    if (!channel)
        return;
    const messages = await channel.messages
        .fetch(config.lastTranscriptMessageId ? { after: config.lastTranscriptMessageId, limit: 100 } : { limit: 25 })
        .catch(() => null);
    if (!messages || messages.size === 0)
        return;
    const ordered = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const message of ordered) {
        await handlePotentialTranscript(db, message);
    }
    const newest = ordered.at(-1);
    if (newest) {
        db.updateGuildConfig(guild.id, { last_transcript_message_id: newest.id });
    }
}
