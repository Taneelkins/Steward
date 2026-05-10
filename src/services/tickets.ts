import type { ButtonInteraction, Guild, GuildMember, Message, TextChannel } from "discord.js";
import { ChannelType, EmbedBuilder } from "discord.js";
import type { AppDatabase } from "../db.js";
import type { PendingTicketLog } from "../types.js";
import { formatPoints, truncate } from "../utils/format.js";
import { isModMember, postToConfiguredChannel, ticketActionButtons, transcriptFieldValue, transcriptLinkComponents } from "../utils/discord.js";
import { addHours, discordTimestamp, nowIso } from "../utils/time.js";
import { writeAuditAndPost } from "./audit.js";
import { createCase } from "./cases.js";

export type ParsedTicketTranscript = {
  ticketId: string | null;
  ticketType: string;
  openerUserId: string | null;
  transcriptUrl: string | null;
  closedChannelId: string | null;
  closedChannelName: string | null;
};

export function parseTicketToolMessage(message: Message): ParsedTicketTranscript {
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
  const ticketId =
    firstMatch(source, [
      /ticket(?:\s*id)?[:#\s-]+([a-z0-9_-]{2,40})/i,
      /transcript[:#\s-]+([a-z0-9_-]{2,40})/i,
      /#([a-z0-9_-]*ticket[a-z0-9_-]*)/i
    ]) ?? message.id;
  const ticketType =
    firstMatch(source, [
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

export async function handlePotentialTranscript(db: AppDatabase, message: Message) {
  if (!message.guild || message.author.bot === false) return;
  const guild = message.guild;
  const config = db.getGuildConfig(guild.id);
  if (!config.ticketTranscriptChannelId || message.channelId !== config.ticketTranscriptChannelId) return;
  if (config.ticketToolBotId && message.author.id !== config.ticketToolBotId) return;

  const parsed = parseTicketToolMessage(message);
  const dueAt = addHours(new Date(), 12).toISOString();
  let pendingId: number | null = null;

  db.transaction(() => {
    const result = db.run(
      `INSERT OR IGNORE INTO pending_ticket_logs (
        guild_id, transcript_message_id, transcript_channel_id, ticket_id, ticket_type,
        opener_user_id, closed_channel_id, closed_channel_name, transcript_url, status, created_at, due_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      guild.id,
      message.id,
      message.channelId,
      parsed.ticketId,
      parsed.ticketType,
      parsed.openerUserId,
      parsed.closedChannelId,
      parsed.closedChannelName,
      parsed.transcriptUrl,
      "pending",
      nowIso(),
      dueAt
    );
    pendingId = Number(result.lastInsertRowid);
    db.updateGuildConfig(guild.id, { last_transcript_message_id: message.id });
  });

  if (!pendingId) return;
  const pending = db.getPendingTicket(guild.id, pendingId);
  if (!pending) return;

  // Post prompt in the closed ticket channel if it still exists; otherwise post to ticket alert.
  const closedChannel = await resolveClosedChannel(guild, pending);
  if (closedChannel) {
    await sendTicketLogPromptToChannel(db, pending, closedChannel);
    return;
  }
  await announcePendingTicket(db, guild, pending);
}

export async function announcePendingTicket(db: AppDatabase, guild: Guild, pending: PendingTicketLog) {
  const config = db.getGuildConfig(guild.id);
  const embed = buildPendingTicketEmbed(pending);
  await postToConfiguredChannel(guild, config.ticketAlertChannelId ?? config.alertChannelId, {
    content: "Ticket transcript detected. Staff can log it with `/log` if action is needed.",
    embeds: [embed],
    components: [ticketActionButtons(pending.id, pending.transcriptUrl)],
    allowedMentions: { parse: [] }
  });
}

export async function sendTicketLogPromptToChannel(db: AppDatabase, pending: PendingTicketLog, channel: TextChannel) {
  const embed = buildPendingTicketEmbed(pending);
  await channel.send({
    content: "This ticket has been closed. Use the buttons below to log it or dismiss it.",
    embeds: [embed],
    components: [ticketActionButtons(pending.id, pending.transcriptUrl)],
    allowedMentions: { parse: [] }
  }).catch(() => null);
}

export function buildPendingTicketEmbed(pending: PendingTicketLog) {
  return new EmbedBuilder()
    .setTitle("Ticket Transcript Detected")
    .setColor(0x3498db)
    .addFields(
      { name: "Ticket", value: pending.ticketId ?? `Pending #${pending.id}`, inline: true },
      { name: "Type", value: pending.ticketType, inline: true },
      { name: "Due", value: `${discordTimestamp(pending.dueAt, "F")}\n${discordTimestamp(pending.dueAt, "R")}`, inline: true },
      { name: "Opener", value: pending.openerUserId ? `<@${pending.openerUserId}>` : "Unknown", inline: true },
      { name: "Transcript", value: transcriptFieldValue(pending.transcriptUrl), inline: false }
    )
    .setFooter({ text: `Pending ticket log #${pending.id}` })
    .setTimestamp(new Date(pending.createdAt));
}

export async function processOverdueTickets(db: AppDatabase, guild: Guild) {
  const overdue = db.all<{
    id: number;
    guild_id: string;
    transcript_message_id: string;
    transcript_channel_id: string;
    ticket_id: string | null;
    ticket_type: string;
    opener_user_id: string | null;
    transcript_url: string | null;
    status: "pending" | "needs_review";
    created_at: string;
    due_at: string;
    logged_case_id: number | null;
    admin_notes: string | null;
  }>(
    "SELECT * FROM pending_ticket_logs WHERE guild_id = ? AND status IN ('pending', 'needs_review') AND due_at <= ?",
    guild.id,
    nowIso()
  );

  for (const row of overdue) {
    // Mark as overdue in the DB; no alert is sent (alerts disabled).
    db.run("UPDATE pending_ticket_logs SET status = 'overdue' WHERE guild_id = ? AND id = ?", guild.id, row.id);
  }
}

export async function handleTicketButton(db: AppDatabase, interaction: ButtonInteraction) {
  if (!interaction.guild || !interaction.member || !interaction.customId.startsWith("ticketlog:")) return false;
  const [, action, rawId] = interaction.customId.split(":");
  const pending = db.getPendingTicket(interaction.guild.id, Number(rawId));
  if (!pending) {
    await interaction.reply({ content: "That pending ticket log no longer exists.", ephemeral: true });
    return true;
  }
  const member = interaction.member as GuildMember;
  const isMod = await isModMember(db, member);
  if (!isMod) {
    await interaction.reply({ content: "Only moderators can use these buttons.", ephemeral: true });
    return true;
  }

  if (action === "action") {
    await interaction.reply({
      content: `Use \`/log\` and include ticket ID \`${pending.ticketId ?? pending.id}\`. I kept the pending ticket open until a full action log is submitted.`,
      ephemeral: true
    });
    return true;
  }

  if (action === "dismiss") {
    const config = db.getGuildConfig(interaction.guild.id);
    const isAdmin = Boolean(config.adminRoleId && member.roles.cache.has(config.adminRoleId)) || member.permissions.has("Administrator");
    if (!isAdmin) {
      await interaction.reply({ content: "Only admins can dismiss pending ticket logs.", ephemeral: true });
      return true;
    }
    db.run(
      "UPDATE pending_ticket_logs SET status = 'dismissed', admin_notes = ? WHERE guild_id = ? AND id = ?",
      `Dismissed by ${interaction.user.id}`,
      interaction.guild.id,
      pending.id
    );
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "ticket.dismissed", { pendingTicketId: pending.id });
    await interaction.reply({ content: `Dismissed pending ticket log #${pending.id}.`, ephemeral: true });
    return true;
  }

  if (action === "noaction") {
    if (!pending.openerUserId) {
      await interaction.reply({ content: "I cannot log no-action because the ticket opener was not detected.", ephemeral: true });
      return true;
    }
    const target = await interaction.guild.client.users.fetch(pending.openerUserId).catch(() => null);
    if (!target) {
      await interaction.reply({ content: "I could not fetch the ticket opener.", ephemeral: true });
      return true;
    }
    const actionName = resolveTicketAction(db, interaction.guild.id, pending.ticketType, true);
    const record = await createCase(db, {
      guild: interaction.guild,
      targetInfo: { discordId: target.id, discordUsername: `${target.tag} (${target.id})` },
      moderator: member,
      actionName,
      reason: `Ticket closed with no moderation action: ${pending.ticketType}`,
      evidence: pending.transcriptUrl,
      notes: `No-action ticket log from pending ticket #${pending.id}`,
      noAction: true,
      ticketId: pending.ticketId ?? String(pending.id),
      transcriptUrl: pending.transcriptUrl
    });
    db.run(
      "UPDATE pending_ticket_logs SET status = 'logged', logged_case_id = ? WHERE guild_id = ? AND id = ?",
      record.id,
      interaction.guild.id,
      pending.id
    );
    const pointsEnabled = db.getGuildConfig(interaction.guild.id).pointsEnabled;
    await interaction.reply({
      content: pointsEnabled ? `Logged no-action ticket as case #${record.id} for ${formatPoints(record.awardedPointsMilli)} points.` : `Logged no-action ticket as case #${record.id}.`,
      components: transcriptLinkComponents(record.transcriptUrl),
      ephemeral: true
    });
    return true;
  }

  return false;
}

export function resolveTicketAction(db: AppDatabase, guildId: string, ticketType: string, noAction = false) {
  const normalized = normalizeTicketType(ticketType);
  const mapping = db.get<{ action_name: string }>(
    "SELECT action_name FROM ticket_action_mappings WHERE guild_id = ? AND ticket_type = ?",
    guildId,
    normalized
  );
  if (mapping && db.getAction(guildId, mapping.action_name)) return mapping.action_name;
  if (db.getAction(guildId, normalized)) return normalized;
  return noAction ? "case-note" : "other";
}

export function normalizeTicketType(value: string) {
  return value
    .toLowerCase()
    .replace(/[`*_~|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 50) || "other";
}

async function resolveClosedChannel(guild: Guild, pending: PendingTicketLog): Promise<TextChannel | null> {
  // Try by stored channel ID first
  if (pending.closedChannelId) {
    const ch = await guild.channels.fetch(pending.closedChannelId).catch(() => null);
    if (ch && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }
  // Try by channel name
  if (pending.closedChannelName) {
    await guild.channels.fetch().catch(() => null);
    const name = pending.closedChannelName.toLowerCase().replace(/^#+/, "");
    const ch = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && "name" in c && c.name.toLowerCase() === name
    );
    if (ch && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }
  return null;
}

function findTextNearLabel(source: string, labels: string[]) {
  const lines = source.split(/\n+/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lower = line.toLowerCase();
    if (labels.some((label) => lower.includes(label))) {
      // Value may be on the same line after a colon, or on the next line
      const sameLine = line.replace(/^[^:]+:\s*/i, "").trim();
      const nextLine = (lines[index + 1] ?? "").trim();
      const candidate = sameLine || nextLine;
      if (candidate && candidate.length < 100) return candidate;
    }
  }
  return null;
}

function firstMatch(source: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1]) return match[1];
    if (match?.[0] && pattern.source.startsWith("https")) return match[0];
  }
  return null;
}

function findUserNearLabel(source: string, labels: string[]) {
  const lines = source.split(/\n+/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lower = line.toLowerCase();
    if (labels.some((label) => lower.includes(label))) {
      const match = /<@!?(\d+)>/.exec(`${line}\n${lines[index + 1] ?? ""}`);
      if (match) return match[1];
    }
  }
  return null;
}

function findChannelNearLabel(source: string, labels: string[]) {
  const lines = source.split(/\n+/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lower = line.toLowerCase();
    if (labels.some((label) => lower.includes(label))) {
      const match = /<#(\d{15,25})>/.exec(`${line}\n${lines[index + 1] ?? ""}`);
      if (match) return match[1];
    }
  }
  return null;
}
