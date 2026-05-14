import fs from "node:fs";
import path from "node:path";
import { EmbedBuilder, type Client, type TextChannel, type NewsChannel, type ThreadChannel } from "discord.js";
import type { AppDatabase } from "../db.js";
import { colors } from "../utils/theme.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type ShoutsEntry = { guildId: string; channelId: string };

type RestartMessage = { channelId: string; messageId: string };

type RestartSignal = {
  reason: "crash" | "update";
  exitTime: string;
  messages?: RestartMessage[]; // present for update restarts — used to edit the "going down" message
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatOffline(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

// ── Save shouts channels to disk ─────────────────────────────────────────────
// Called on every startup so restart-bot.ps1 can read which channels to post
// the "going down" embed to without needing to query the SQLite DB itself.

export function saveShoutsChannels(db: AppDatabase, client: Client, dataDir: string): void {
  const entries: ShoutsEntry[] = [];
  for (const guild of client.guilds.cache.values()) {
    const channelId = db.getGuildConfig(guild.id).shoutsChannelId;
    if (channelId) entries.push({ guildId: guild.id, channelId });
  }
  try {
    fs.writeFileSync(path.join(dataDir, "shouts-channels.json"), JSON.stringify(entries), "utf8");
  } catch {
    // non-fatal
  }
}

// ── Going-down announcement ───────────────────────────────────────────────────
// Posts "Steward Restarting" to every shouts channel and writes restart-signal.json.
// Call this from anywhere the bot is about to exit for an update (updatebot command,
// restart-bot.ps1 via going-down.js, etc.).

export async function postGoingDown(db: AppDatabase, client: Client, dataDir: string): Promise<void> {
  const exitTime = new Date().toISOString();
  const postedMessages: RestartMessage[] = [];

  const downEmbed = new EmbedBuilder()
    .setColor(colors.voidPurple)
    .setTitle("🔄 Steward Restarting")
    .setDescription("Going down for an update. Back online shortly.")
    .setTimestamp();

  for (const guild of client.guilds.cache.values()) {
    const channelId = db.getGuildConfig(guild.id).shoutsChannelId;
    if (!channelId) continue;
    const ch = guild.channels.cache.get(channelId);
    if (!ch?.isTextBased() || !("send" in ch)) continue;
    try {
      const msg = await (ch as TextChannel | NewsChannel | ThreadChannel).send({ embeds: [downEmbed] });
      postedMessages.push({ channelId, messageId: msg.id });
    } catch {
      // non-fatal — channel may have restricted perms
    }
  }

  const signal: RestartSignal = { reason: "update", exitTime, messages: postedMessages.length ? postedMessages : undefined };
  try {
    fs.writeFileSync(path.join(dataDir, "restart-signal.json"), JSON.stringify(signal), "utf8");
  } catch {
    // non-fatal
  }
}

// ── Startup announcement ──────────────────────────────────────────────────────

export async function postStartupAnnouncement(db: AppDatabase, client: Client, dataDir: string) {
  const signalPath = path.join(dataDir, "restart-signal.json");
  if (!fs.existsSync(signalPath)) return;

  let signal: RestartSignal;
  try {
    signal = JSON.parse(fs.readFileSync(signalPath, "utf8")) as RestartSignal;
    fs.unlinkSync(signalPath);
  } catch {
    return;
  }

  const now = Date.now();
  const exitMs = new Date(signal.exitTime).getTime();
  const offlineMs = now - exitMs;
  const offlineStr = formatOffline(offlineMs);
  const exitTimestamp = `<t:${Math.floor(exitMs / 1000)}:T>`;

  if (signal.reason === "update" && signal.messages?.length) {
    // Edit the "going down" message that restart-bot.ps1 already posted
    const backEmbed = new EmbedBuilder()
      .setColor(colors.voidPurple)
      .setTitle("✅ Steward Back Online")
      .setDescription(`Restarted for an update.\nWas offline for **${offlineStr}**.`)
      .setTimestamp();

    for (const { channelId, messageId } of signal.messages) {
      // Find the channel across all guilds
      let channel: TextChannel | NewsChannel | ThreadChannel | null = null;
      for (const guild of client.guilds.cache.values()) {
        const ch = guild.channels.cache.get(channelId);
        if (ch && (ch.isTextBased()) && "send" in ch) {
          channel = ch as TextChannel | NewsChannel | ThreadChannel;
          break;
        }
      }
      if (!channel) continue;
      await channel.messages.fetch(messageId)
        .then((msg) => msg.edit({ embeds: [backEmbed] }))
        .catch(() => (channel as TextChannel | NewsChannel | ThreadChannel).send({ embeds: [backEmbed] }).catch(() => null));
    }
    return;
  }

  // Crash or update with no pre-posted message — post fresh
  for (const guild of client.guilds.cache.values()) {
    const channelId = db.getGuildConfig(guild.id).shoutsChannelId;
    if (!channelId) continue;
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) continue;

    const embed = signal.reason === "update"
      ? new EmbedBuilder()
          .setColor(colors.voidPurple)
          .setTitle("✅ Steward Back Online")
          .setDescription(`Restarted for an update.\nWas offline for **${offlineStr}**.`)
          .setTimestamp()
      : new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle("⚠️ Steward Restarted After Crash")
          .setDescription(
            `Crash detected at ${exitTimestamp}.\nWas offline for **${offlineStr}**.\nSteward is back online.`
          )
          .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(() => null);
  }
}
