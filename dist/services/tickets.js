import { addHours, nowIso } from "../utils/time.js";
export function parseTicketToolMessage(message) {
    const embedText = message.embeds
        .flatMap((embed) => [
        embed.title,
        embed.description,
        embed.footer?.text,
        ...embed.fields.flatMap((field) => [field.name, field.value])
    ])
        .filter(Boolean)
        .join("\n");
    const attachmentText = message.attachments.map((attachment) => `${attachment.name ?? ""} ${attachment.url}`).join("\n");
    const source = [message.content, embedText, attachmentText, message.channel.isTextBased() && "name" in message.channel ? message.channel.name : ""]
        .filter(Boolean)
        .join("\n");
    const openerUserId = findUserNearLabel(source, ["opened by", "opener", "creator", "created by", "user", "member"]) ?? null;
    const ticketId = firstMatch(source, [
        /ticket(?:\s*id)?[:#\s-]+([a-z0-9_-]{2,40})/i,
        /transcript[:#\s-]+([a-z0-9_-]{2,40})/i,
        /#([a-z0-9_-]*ticket[a-z0-9_-]*)/i
    ]) ?? message.id;
    const ticketType = firstMatch(source, [
        /(?:ticket\s*)?(?:type|category|panel)[:\s-]+([^\n|]{2,80})/i,
        /(?:reason)[:\s-]+([^\n|]{2,80})/i
    ])?.trim() ?? "other";
    const transcriptUrl = message.attachments.first()?.url ?? firstMatch(source, [/https?:\/\/\S+/i]) ?? message.url;
    const closedChannelId = findChannelNearLabel(source, ["channel", "ticket channel", "closed channel", "closed in"]) ?? null;
    const closedChannelName = findTextNearLabel(source, ["ticket name", "ticket channel", "channel name", "closed in", "channel"]) ?? null;
    return {
        ticketId,
        ticketType: normalizeTicketType(ticketType),
        openerUserId,
        transcriptUrl,
        closedChannelId,
        closedChannelName
    };
}
export async function handlePotentialTranscript(db, message) {
    if (!message.guild || message.author.bot === false)
        return;
    const guild = message.guild;
    const config = db.getGuildConfig(guild.id);
    if (!config.ticketTranscriptChannelId || message.channelId !== config.ticketTranscriptChannelId)
        return;
    if (config.ticketToolBotId && message.author.id !== config.ticketToolBotId)
        return;
    const parsed = parseTicketToolMessage(message);
    const dueAt = addHours(new Date(), 12).toISOString();
    db.transaction(() => {
        db.run(`INSERT OR IGNORE INTO pending_ticket_logs (
        guild_id, transcript_message_id, transcript_channel_id, ticket_id, ticket_type,
        opener_user_id, closed_channel_id, closed_channel_name, transcript_url, status, created_at, due_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, guild.id, message.id, message.channelId, parsed.ticketId, parsed.ticketType, parsed.openerUserId, parsed.closedChannelId, parsed.closedChannelName, parsed.transcriptUrl, "pending", nowIso(), dueAt);
        db.updateGuildConfig(guild.id, { last_transcript_message_id: message.id });
    });
}
export async function processOverdueTickets(db, guild) {
    db.run("UPDATE pending_ticket_logs SET status = 'overdue' WHERE guild_id = ? AND status IN ('pending', 'needs_review') AND due_at <= ?", guild.id, nowIso());
}
export function resolveTicketAction(db, guildId, ticketType) {
    const normalized = normalizeTicketType(ticketType);
    const mapping = db.get("SELECT action_name FROM ticket_action_mappings WHERE guild_id = ? AND ticket_type = ?", guildId, normalized);
    if (mapping && db.getAction(guildId, mapping.action_name))
        return mapping.action_name;
    if (db.getAction(guildId, normalized))
        return normalized;
    return "other";
}
export function normalizeTicketType(value) {
    return value
        .toLowerCase()
        .replace(/[`*_~|]/g, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9_-]/g, "")
        .replace(/-+/g, "-")
        .slice(0, 50) || "other";
}
function findTextNearLabel(source, labels) {
    const lines = source.split(/\n+/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const lower = line.toLowerCase();
        if (labels.some((label) => lower.includes(label))) {
            // Value may be on the same line after a colon, or on the next line
            const sameLine = line.replace(/^[^:]+:\s*/i, "").trim();
            const nextLine = (lines[index + 1] ?? "").trim();
            const candidate = sameLine || nextLine;
            if (candidate && candidate.length < 100)
                return candidate;
        }
    }
    return null;
}
function firstMatch(source, patterns) {
    for (const pattern of patterns) {
        const match = pattern.exec(source);
        if (match?.[1])
            return match[1];
        if (match?.[0] && pattern.source.startsWith("https"))
            return match[0];
    }
    return null;
}
function findUserNearLabel(source, labels) {
    const lines = source.split(/\n+/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const lower = line.toLowerCase();
        if (labels.some((label) => lower.includes(label))) {
            const match = /<@!?(\d+)>/.exec(`${line}\n${lines[index + 1] ?? ""}`);
            if (match)
                return match[1];
        }
    }
    return null;
}
function findChannelNearLabel(source, labels) {
    const lines = source.split(/\n+/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const lower = line.toLowerCase();
        if (labels.some((label) => lower.includes(label))) {
            const match = /<#(\d{15,25})>/.exec(`${line}\n${lines[index + 1] ?? ""}`);
            if (match)
                return match[1];
        }
    }
    return null;
}
