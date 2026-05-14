/**
 * going-down.ts
 *
 * Standalone script run by restart-bot.ps1 BEFORE killing the bot process.
 * Posts a "Steward Restarting" embed to every configured shouts channel,
 * then writes restart-signal.json with the message IDs so the bot can edit
 * them to "back online" on next startup.
 *
 * Usage: node dist/going-down.js
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client, EmbedBuilder, Events, GatewayIntentBits } from "discord.js";
import { AppDatabase } from "./db.js";
import { readEnv } from "./env.js";
import { colors } from "./utils/theme.js";

const env = readEnv();
const db = new AppDatabase(env.databasePath, env.defaultTimezone);
const dataDir = path.dirname(env.databasePath);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  const exitTime = new Date().toISOString();
  const postedMessages: Array<{ channelId: string; messageId: string }> = [];

  const downEmbed = new EmbedBuilder()
    .setColor(colors.voidPurple)
    .setTitle("🔄 Steward Restarting")
    .setDescription("Going down for an update. Back online shortly.")
    .setTimestamp();

  for (const guild of readyClient.guilds.cache.values()) {
    const channelId = db.getGuildConfig(guild.id).shoutsChannelId;
    if (!channelId) continue;
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) continue;
    try {
      const msg = await (channel as { send: Function }).send({ embeds: [downEmbed] });
      postedMessages.push({ channelId, messageId: msg.id });
      console.log(`Posted going-down message to channel ${channelId} (msg ${msg.id})`);
    } catch (err) {
      console.warn(`Could not post going-down message to channel ${channelId}:`, err);
    }
  }

  // Write the restart signal
  const signal: Record<string, unknown> = { reason: "update", exitTime };
  if (postedMessages.length > 0) signal.messages = postedMessages;
  fs.writeFileSync(path.join(dataDir, "restart-signal.json"), JSON.stringify(signal), "utf8");
  console.log("Restart signal written.");

  db.close();
  client.destroy();
  process.exit(0);
});

// Timeout safety net — if Discord login hangs, bail after 15s
setTimeout(() => {
  console.warn("going-down.js timed out — writing signal without message IDs.");
  const signal = { reason: "update", exitTime: new Date().toISOString() };
  fs.writeFileSync(path.join(dataDir, "restart-signal.json"), JSON.stringify(signal), "utf8");
  db.close();
  process.exit(0);
}, 15_000);

client.login(env.discordToken).catch((err) => {
  console.warn("going-down.js login failed:", err);
  const signal = { reason: "update", exitTime: new Date().toISOString() };
  fs.writeFileSync(path.join(dataDir, "restart-signal.json"), JSON.stringify(signal), "utf8");
  db.close();
  process.exit(0);
});
