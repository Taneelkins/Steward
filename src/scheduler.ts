import { ChannelType, type Client, type Guild, type TextChannel } from "discord.js";
import type { AppDatabase } from "./db.js";
import { processQuotaTimers } from "./services/quota.js";
import { nowIso } from "./utils/time.js";

export async function runStartupRecovery(db: AppDatabase, client: Client) {
  for (const guild of client.guilds.cache.values()) {
    await recoverGuild(db, guild);
  }
  await processPersistentTimeouts(db, client);
  await processScheduledUnbans(db, client);
}

export function startScheduler(db: AppDatabase, client: Client, intervalSeconds: number) {
  const interval = setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      recoverGuild(db, guild).catch((error) => {
        console.error(`Scheduled recovery failed for guild ${guild.id}:`, error);
      });
    }
    processPersistentTimeouts(db, client).catch((error) => {
      console.error("Persistent timeout renewal failed:", error);
    });
    processScheduledUnbans(db, client).catch((error) => {
      console.error("Scheduled unban processing failed:", error);
    });
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

async function processPersistentTimeouts(db: AppDatabase, client: Client) {
  const due = db.getDuePersistentTimeouts();
  for (const row of due) {
    try {
      const linkedGuild = await client.guilds.fetch(row.linked_guild_id).catch(() => null);
      if (!linkedGuild) { db.deletePersistentTimeout(row.id); continue; }
      const member = await linkedGuild.members.fetch(row.discord_target_id).catch(() => null);
      if (!member) { db.deletePersistentTimeout(row.id); continue; }
      const MAX_TIMEOUT = 27 * 24 * 60 * 60 * 1000;
      await member.timeout(MAX_TIMEOUT, "Persistent indefinite timeout renewal").catch(() => null);
      const renewAfter = new Date(Date.now() + 26 * 24 * 60 * 60 * 1000).toISOString();
      db.run("UPDATE persistent_timeouts SET renew_after = ? WHERE id = ?", renewAfter, row.id);
    } catch (error) {
      console.error(`Failed to renew persistent timeout for ${row.discord_target_id}:`, error);
    }
  }
}

async function processScheduledUnbans(db: AppDatabase, client: Client) {
  const due = db.getDueScheduledUnbans();
  for (const row of due) {
    try {
      const linkedGuild = await client.guilds.fetch(row.linked_guild_id).catch(() => null);
      if (!linkedGuild) { db.deleteScheduledUnban(row.id); continue; }
      await linkedGuild.members.unban(row.discord_target_id, `Temp ban expired — case ${row.case_id ?? "unknown"}`).catch(() => null);
      db.deleteScheduledUnban(row.id);

      const user = await client.users.fetch(row.discord_target_id).catch(() => null);
      if (user) {
        const inviteChannel = linkedGuild.channels.cache.find((c) => c.type === ChannelType.GuildText) as TextChannel | undefined;
        const invite = inviteChannel ? await inviteChannel.createInvite({ maxAge: 7 * 24 * 3600, maxUses: 1, reason: "Temp ban expired" }).catch(() => null) : null;
        const dmLines = [
          `**Your temporary ban from ${linkedGuild.name} has expired.**`,
          ``,
          row.case_action ? `**Ban reason:** ${row.case_reason ?? "No reason recorded"}` : null,
          invite ? `**Rejoin ${linkedGuild.name}:** ${invite.url}` : null,
          !invite && row.moderation_invite ? `**Server invite:** ${row.moderation_invite}` : null
        ].filter(Boolean).join("\n");
        await user.send(dmLines).catch(() => null);
      }
    } catch (error) {
      console.error(`Failed to process scheduled unban for ${row.discord_target_id}:`, error);
    }
  }
}
