import fs from "node:fs";
import path from "node:path";
import { EmbedBuilder, type Client } from "discord.js";
import type { AppDatabase } from "../db.js";
import { colors } from "../utils/theme.js";

type RestartSignal = {
  reason: "crash" | "update";
  exitTime: string;
};

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

  for (const guild of client.guilds.cache.values()) {
    const config = db.getGuildConfig(guild.id);
    const channelId = config.shoutsChannelId;
    if (!channelId) continue;

    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) continue;

    const embed =
      signal.reason === "update"
        ? new EmbedBuilder()
            .setColor(colors.voidPurple)
            .setTitle("🔄 Bot Updated")
            .setDescription("A new update was deployed. Bot has restarted and is back online.")
            .setTimestamp()
        : new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle("⚠️ Bot Restarted After Crash")
            .setDescription(
              `Crash detected at ${exitTimestamp}.\nWas offline for **${offlineStr}**.\nBot is back online now.`
            )
            .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(() => null);
  }
}
