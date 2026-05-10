import type { Client, Guild } from "discord.js";
import type { AppDatabase } from "./db.js";
import { processQuotaTimers } from "./services/quota.js";
import { nowIso } from "./utils/time.js";

export async function runStartupRecovery(db: AppDatabase, client: Client) {
  for (const guild of client.guilds.cache.values()) {
    await recoverGuild(db, guild);
  }
}

export function startScheduler(db: AppDatabase, client: Client, intervalSeconds: number) {
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

async function recoverGuild(db: AppDatabase, guild: Guild) {
  db.ensureGuild(guild.id);
  const config = db.getGuildConfig(guild.id);
  if (config.multiplierEndsAt && new Date(config.multiplierEndsAt).getTime() <= Date.now()) {
    db.updateGuildConfig(guild.id, { multiplier_milli: 1000, multiplier_ends_at: null });
  }
  db.run("DELETE FROM quota_exemptions WHERE guild_id = ? AND expires_at IS NOT NULL AND expires_at <= ?", guild.id, nowIso());
  await processQuotaTimers(db, guild);
}
