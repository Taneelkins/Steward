import type { Guild } from "discord.js";
import { EmbedBuilder } from "discord.js";
import type { AppDatabase } from "../db.js";
import { postToConfiguredChannel } from "../utils/discord.js";
import { nowIso } from "../utils/time.js";

export function writeAudit(db: AppDatabase, guildId: string, actorUserId: string, action: string, details: unknown) {
  db.run(
    "INSERT INTO audit_events (guild_id, actor_user_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)",
    guildId,
    actorUserId,
    action,
    JSON.stringify(details),
    nowIso()
  );
}

export async function writeAuditAndPost(
  db: AppDatabase,
  guild: Guild,
  actorUserId: string,
  action: string,
  details: Record<string, unknown>
) {
  writeAudit(db, guild.id, actorUserId, action, details);
  const config = db.getGuildConfig(guild.id);
  const embed = new EmbedBuilder()
    .setTitle("Audit Event")
    .setColor(0x9b59b6)
    .addFields(
      { name: "Action", value: action, inline: true },
      { name: "Actor", value: `<@${actorUserId}>`, inline: true },
      { name: "Details", value: `\`\`\`json\n${JSON.stringify(details, null, 2).slice(0, 900)}\n\`\`\`` }
    )
    .setTimestamp();
  await postToConfiguredChannel(guild, config.auditChannelId, { embeds: [embed] });
}
