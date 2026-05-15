import fs from "node:fs";
import path from "node:path";
import { EmbedBuilder } from "discord.js";
import { colors } from "../utils/theme.js";
// ── Helpers ───────────────────────────────────────────────────────────────────
function formatOffline(ms) {
    const totalSecs = Math.round(ms / 1000);
    if (totalSecs < 60)
        return `${totalSecs}s`;
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    if (mins < 60)
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}
/**
 * Formats a raw changelog notes string into a readable list.
 * Splits on commas and newlines, capitalises each item, and renders as bullet points.
 * Example: "fixed warning command, fixed archive logs"
 *   → "• Fixed warning command\n• Fixed archive logs"
 */
function formatChangelog(notes) {
    const items = notes
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
    if (items.length === 0)
        return notes.trim();
    if (items.length === 1)
        return items[0];
    return items.map((item) => `• ${item}`).join("\n");
}
// ── Save shouts channels to disk ─────────────────────────────────────────────
// Called on every startup so restart-bot.ps1 can read which channels to post
// the "going down" embed to without needing to query the SQLite DB itself.
export function saveShoutsChannels(db, client, dataDir) {
    const entries = [];
    for (const guild of client.guilds.cache.values()) {
        const channelId = db.getGuildConfig(guild.id).shoutsChannelId;
        if (channelId)
            entries.push({ guildId: guild.id, channelId });
    }
    try {
        fs.writeFileSync(path.join(dataDir, "shouts-channels.json"), JSON.stringify(entries), "utf8");
    }
    catch {
        // non-fatal
    }
}
// ── Going-down announcement ───────────────────────────────────────────────────
// Posts "Steward Restarting" to every shouts channel and writes restart-signal.json.
// Call this from anywhere the bot is about to exit for an update (updatebot command,
// restart-bot.ps1 via going-down.js, etc.).
export async function postGoingDown(db, client, dataDir, updateNotes) {
    const exitTime = new Date().toISOString();
    const postedMessages = [];
    const downEmbed = new EmbedBuilder()
        .setColor(colors.voidPurple)
        .setTitle("🔄 Steward Restarting")
        .setDescription(`Going down for an update. Back online shortly.${updateNotes ? `\n\n**Changes:**\n${formatChangelog(updateNotes)}` : ""}`)
        .setTimestamp();
    for (const guild of client.guilds.cache.values()) {
        const channelId = db.getGuildConfig(guild.id).shoutsChannelId;
        if (!channelId)
            continue;
        const ch = guild.channels.cache.get(channelId);
        if (!ch?.isTextBased() || !("send" in ch))
            continue;
        try {
            const msg = await ch.send({ embeds: [downEmbed] });
            postedMessages.push({ channelId, messageId: msg.id });
        }
        catch {
            // non-fatal — channel may have restricted perms
        }
    }
    const signal = { reason: "update", exitTime, updateNotes, messages: postedMessages.length ? postedMessages : undefined };
    try {
        fs.writeFileSync(path.join(dataDir, "restart-signal.json"), JSON.stringify(signal), "utf8");
    }
    catch {
        // non-fatal
    }
}
// ── Startup announcement ──────────────────────────────────────────────────────
export async function postStartupAnnouncement(db, client, dataDir) {
    const signalPath = path.join(dataDir, "restart-signal.json");
    if (!fs.existsSync(signalPath))
        return;
    let signal;
    try {
        signal = JSON.parse(fs.readFileSync(signalPath, "utf8"));
        fs.unlinkSync(signalPath);
    }
    catch {
        return;
    }
    const now = Date.now();
    const exitMs = signal.exitTime ? new Date(signal.exitTime).getTime() : null;
    const offlineMs = exitMs ? now - exitMs : null;
    const offlineStr = offlineMs !== null ? formatOffline(offlineMs) : null;
    const exitTimestamp = exitMs ? `<t:${Math.floor(exitMs / 1000)}:T>` : null;
    if (signal.reason === "update" && signal.messages?.length) {
        // Edit the "going down" message that restart-bot.ps1 already posted
        const backEmbed = new EmbedBuilder()
            .setColor(colors.voidPurple)
            .setTitle("✅ Steward Back Online")
            .setDescription(`Restarted for an update.${offlineStr ? ` Down for **${offlineStr}**.` : ""}${signal.updateNotes ? `\n\n**Changes:**\n${formatChangelog(signal.updateNotes)}` : ""}`)
            .setTimestamp();
        for (const { channelId, messageId } of signal.messages) {
            // Find the channel across all guilds
            let channel = null;
            for (const guild of client.guilds.cache.values()) {
                const ch = guild.channels.cache.get(channelId);
                if (ch && (ch.isTextBased()) && "send" in ch) {
                    channel = ch;
                    break;
                }
            }
            if (!channel)
                continue;
            await channel.messages.fetch(messageId)
                .then((msg) => msg.edit({ embeds: [backEmbed] }))
                .catch(() => channel.send({ embeds: [backEmbed] }).catch(() => null));
        }
        return;
    }
    // Crash or update with no pre-posted message — post fresh
    for (const guild of client.guilds.cache.values()) {
        const channelId = db.getGuildConfig(guild.id).shoutsChannelId;
        if (!channelId)
            continue;
        const channel = guild.channels.cache.get(channelId);
        if (!channel?.isTextBased())
            continue;
        const embed = signal.reason === "update"
            ? new EmbedBuilder()
                .setColor(colors.voidPurple)
                .setTitle("✅ Steward Back Online")
                .setDescription(`Restarted for an update.${offlineStr ? ` Down for **${offlineStr}**.` : ""}${signal.updateNotes ? `\n\n**Changes:**\n${formatChangelog(signal.updateNotes)}` : ""}`)
                .setTimestamp()
            : new EmbedBuilder()
                .setColor(0xe74c3c)
                .setTitle("⚠️ Steward Restarted After Crash")
                .setDescription(`${exitTimestamp ? `Crash detected at ${exitTimestamp}.\n` : ""}${offlineStr ? `Was offline for **${offlineStr}**.\n` : ""}Steward is back online.`)
                .setTimestamp();
        await channel.send({ embeds: [embed] }).catch(() => null);
    }
}
