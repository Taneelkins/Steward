import type { Message, GuildMember, User } from "discord.js";
import type { AppDatabase } from "../db.js";
import { dmUser, postPendingLog, notifyTargetInComms } from "./crossServer.js";
import { parseRobloxDuration, formatRobloxDuration } from "./roblox.js";
import { writeAuditAndPost } from "./audit.js";

const DEV_USER_ID = "616267913799925782";

const BUTLER_RESPONSES = [
  "At once, my liege. 🎩",
  "Of course, master. Consider it done.",
  "It would be my honor.",
  "Right away, sire. Your wish is my command.",
  "As you decree, my lord.",
  "Immediately, Your Grace.",
  "Very good, master. I shall see to it.",
  "Your will be done, my liege.",
  "Delighted to serve, as always.",
  "I live to serve you, master.",
  "Most certainly, sire. Forthwith.",
  "With pleasure, my lord. 🫡"
];

const COMMAND_ALIASES: Record<string, string> = {
  jail:    "jail",
  unjail:  "unjail",
  ban:     "ban",
  unban:   "unban",
  kick:    "kick",
  warn:    "warn",
  silence: "jail",
  kill:    "ban"
};

let butlerIndex = 0;

function nextButlerResponse(): string {
  const response = BUTLER_RESPONSES[butlerIndex % BUTLER_RESPONSES.length]!;
  butlerIndex++;
  return response;
}

function extractUserId(token: string): string | null {
  const mentionMatch = token.match(/^<@!?(\d{17,19})>$/);
  if (mentionMatch) return mentionMatch[1]!;
  if (/^\d{17,19}$/.test(token)) return token;
  return null;
}

export async function handlePrefixCommand(db: AppDatabase, message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.guild) return;

  const content = message.content.trim();

  // Match "Steward <command> [args]" (case-insensitive)
  const prefixMatch = content.match(/^steward\s+(\w+)(.*)/i);
  if (!prefixMatch) return;

  const rawCommand = prefixMatch[1]!.toLowerCase();
  const rest = prefixMatch[2]!.trim();

  const command = COMMAND_ALIASES[rawCommand];
  if (!command) return;

  // Only the bot owner may command Steward
  if (message.author.id !== DEV_USER_ID) return;

  await message.reply(nextButlerResponse()).catch(() => null);
  await runPrefixCommand(db, message, command, rest);
}

async function runPrefixCommand(db: AppDatabase, message: Message, command: string, args: string): Promise<void> {
  const guild = message.guild!;
  const client = message.client;
  const config = db.getGuildConfig(guild.id);
  const tokens = args.split(/\s+/).filter(Boolean);

  const reply = async (text: string) => {
    await message.reply(text).catch(() => null);
  };

  // ── jail ──────────────────────────────────────────────────────────────────────
  if (command === "jail") {
    if (!config.jailedRoleId) { await reply("❌ Jail role not configured."); return; }

    const targetId = tokens[0] ? extractUserId(tokens[0]) : null;
    if (!targetId) { await reply("❌ Please mention a user or provide a user ID."); return; }

    let target: GuildMember | null = null;
    try { target = await guild.members.fetch(targetId); } catch { /* not found */ }
    if (!target) { await reply("❌ User not found in this server."); return; }
    if (target.id === message.author.id) { await reply("❌ You cannot jail yourself."); return; }

    // Second token is optional duration if it looks like one (e.g. "7d", "2h")
    let durationStr: string | null = null;
    let reason = "";
    if (tokens[1] && /^\d+[smhdw]$/i.test(tokens[1])) {
      durationStr = tokens[1];
      reason = tokens.slice(2).join(" ");
    } else {
      reason = tokens.slice(1).join(" ");
    }

    const durationSecs = durationStr ? parseRobloxDuration(durationStr) : undefined;
    if (durationStr && durationSecs === null) {
      await reply(`❌ Could not parse duration: \`${durationStr}\`. Try "7d", "24h", "30m".`);
      return;
    }
    const safeDurationSecs = durationSecs ?? undefined;
    const durationDisplay = safeDurationSecs !== undefined ? formatRobloxDuration(safeDurationSecs) : "indefinitely";

    const savedRoleIds = target.roles.cache
      .filter(r => r.id !== guild.id && r.id !== config.jailedRoleId)
      .map(r => r.id);

    await dmUser(client, target.id, [
      `**You have been muted in ${guild.name}.**`,
      ``,
      `**Moderator:** ${message.author.username}`,
      reason ? `**Reason:** ${reason}` : null,
      safeDurationSecs !== undefined ? `**Duration:** ${durationDisplay}` : null,
      ``,
      config.moderationInvite ? `To appeal: ${config.moderationInvite}` : null
    ]);

    try {
      for (const roleId of savedRoleIds) {
        await target.roles.remove(roleId).catch(() => null);
      }
      await target.roles.add(config.jailedRoleId);
    } catch (err) {
      await reply(`❌ Failed to assign jailed role: ${err instanceof Error ? err.message : "Unknown error"}`);
      return;
    }

    const unjailAt = safeDurationSecs !== undefined
      ? new Date(Date.now() + safeDurationSecs * 1000).toISOString()
      : null;
    db.scheduleUnjail({ guildId: guild.id, linkedGuildId: guild.id, discordTargetId: target.id, caseId: null, savedRoleIds, unjailAt });

    await notifyTargetInComms(guild, db, target.id,
      `you have been **jailed** in **${guild.name}**${safeDurationSecs !== undefined ? ` for **${durationDisplay}**` : " indefinitely"}. Please wait for staff to review your case.`
    );
    await postPendingLog(client, db, guild.id, "mute", target.id, target.user.username,
      safeDurationSecs !== undefined ? durationDisplay : "", reason, message.author.id, guild.name);
    await writeAuditAndPost(db, guild, message.author.id, "crossserver.jail", {
      target: target.id, username: target.user.username, duration: durationDisplay, reason
    });

    await reply(`✅ **${target.user.username}** has been jailed${safeDurationSecs !== undefined ? ` for **${durationDisplay}**` : " indefinitely"}.`);

  // ── unjail ────────────────────────────────────────────────────────────────────
  } else if (command === "unjail") {
    if (!config.jailedRoleId) { await reply("❌ Jail role not configured."); return; }

    const targetId = tokens[0] ? extractUserId(tokens[0]) : null;
    if (!targetId) { await reply("❌ Please mention a user or provide a user ID."); return; }

    let target: GuildMember | null = null;
    try { target = await guild.members.fetch(targetId); } catch { /* not found */ }
    if (!target) { await reply("❌ User not found in this server."); return; }

    const reason = tokens.slice(1).join(" ");

    const jailRecord = db.getJailedMember(guild.id, target.id);
    const savedRoleIds: string[] = jailRecord ? JSON.parse(jailRecord.saved_role_ids_json) as string[] : [];

    try {
      await target.roles.remove(config.jailedRoleId).catch(() => null);
      for (const roleId of savedRoleIds) {
        if (guild.roles.cache.has(roleId)) {
          await target.roles.add(roleId).catch(() => null);
        }
      }
    } catch (err) {
      await reply(`❌ Failed to remove jailed role: ${err instanceof Error ? err.message : "Unknown error"}`);
      return;
    }

    db.deleteUnjailForTarget(guild.id, target.id);

    await dmUser(client, target.id, [
      `**Your mute in ${guild.name} has been lifted.**`,
      ``,
      reason ? `**Reason:** ${reason}` : null,
      `Your roles have been restored.`
    ]);
    await notifyTargetInComms(guild, db, target.id,
      `you have been **unjailed** in **${guild.name}**. Your roles have been restored.`
    );
    await postPendingLog(client, db, guild.id, "mute-appeal", target.id, target.user.username, "", reason, message.author.id, guild.name);
    await writeAuditAndPost(db, guild, message.author.id, "crossserver.unjail", {
      target: target.id, username: target.user.username, reason
    });

    await reply(`✅ **${target.user.username}** has been unjailed. Roles restored.`);

  // ── ban ───────────────────────────────────────────────────────────────────────
  } else if (command === "ban") {
    const targetId = tokens[0] ? extractUserId(tokens[0]) : null;
    if (!targetId) { await reply("❌ Please mention a user or provide a user ID."); return; }

    let targetUser: User | null = null;
    try { targetUser = await client.users.fetch(targetId); } catch { /* not found */ }
    if (!targetUser) { await reply("❌ User not found."); return; }

    const reason = tokens.slice(1).join(" ");

    await dmUser(client, targetUser.id, [
      `**You have been banned from ${guild.name}.**`,
      ``,
      `**Moderator:** ${message.author.username}`,
      reason ? `**Reason:** ${reason}` : null,
      ``,
      config.moderationInvite ? `To appeal: ${config.moderationInvite}` : null
    ]);

    try {
      await guild.bans.create(targetUser.id, { reason: `Banned by ${message.author.username}${reason ? `: ${reason}` : ""}` });
    } catch (err) {
      await reply(`❌ Failed to ban: ${err instanceof Error ? err.message : "Unknown error"}`);
      return;
    }

    await postPendingLog(client, db, guild.id, "ban", targetUser.id, targetUser.username, "", reason, message.author.id, guild.name);
    await writeAuditAndPost(db, guild, message.author.id, "crossserver.ban", {
      target: targetUser.id, username: targetUser.username, reason
    });

    await reply(`✅ **${targetUser.username}** has been banned.`);

  // ── unban ─────────────────────────────────────────────────────────────────────
  } else if (command === "unban") {
    const resolvedId = tokens[0] ? extractUserId(tokens[0]) : null;
    if (!resolvedId) { await reply("❌ Please provide a user ID to unban."); return; }

    const reason = tokens.slice(1).join(" ");

    let username = resolvedId;
    try {
      const bannedUser = await guild.bans.fetch(resolvedId);
      username = bannedUser.user.username;
      await guild.bans.remove(resolvedId, `Unbanned by ${message.author.username}${reason ? `: ${reason}` : ""}`);
    } catch (err) {
      await reply(`❌ Failed to unban: ${err instanceof Error ? err.message : "Unknown error"} (User may not be banned.)`);
      return;
    }

    await dmUser(client, resolvedId, [
      `**Your ban from ${guild.name} has been lifted.**`,
      ``,
      reason ? `**Reason:** ${reason}` : null,
      config.moderationInvite ? `Rejoin: ${config.moderationInvite}` : null
    ]);
    await postPendingLog(client, db, guild.id, "ban-appeal", resolvedId, username, "", reason, message.author.id, guild.name);
    await writeAuditAndPost(db, guild, message.author.id, "crossserver.unban", {
      target: resolvedId, username, reason
    });

    await reply(`✅ **${username}** has been unbanned.`);

  // ── kick ──────────────────────────────────────────────────────────────────────
  } else if (command === "kick") {
    const targetId = tokens[0] ? extractUserId(tokens[0]) : null;
    if (!targetId) { await reply("❌ Please mention a user or provide a user ID."); return; }

    let target: GuildMember | null = null;
    try { target = await guild.members.fetch(targetId); } catch { /* not found */ }
    if (!target) { await reply("❌ User not found in this server."); return; }

    const reason = tokens.slice(1).join(" ");

    await dmUser(client, target.id, [
      `**You have been kicked from ${guild.name}.**`,
      ``,
      `**Moderator:** ${message.author.username}`,
      reason ? `**Reason:** ${reason}` : null,
      ``,
      config.moderationInvite ? `To appeal: ${config.moderationInvite}` : null
    ]);
    await notifyTargetInComms(guild, db, target.id,
      `you have been **kicked** from **${guild.name}**${reason ? ` — reason: ${reason}` : ""}.`
    );

    try {
      await target.kick(`Kicked by ${message.author.username}${reason ? `: ${reason}` : ""}`);
    } catch (err) {
      await reply(`❌ Failed to kick: ${err instanceof Error ? err.message : "Unknown error"}`);
      return;
    }

    await postPendingLog(client, db, guild.id, "kick", target.id, target.user.username, "", reason, message.author.id, guild.name);
    await writeAuditAndPost(db, guild, message.author.id, "crossserver.kick", {
      target: target.id, username: target.user.username, reason
    });

    await reply(`✅ **${target.user.username}** has been kicked.`);

  // ── warn ──────────────────────────────────────────────────────────────────────
  } else if (command === "warn") {
    const targetId = tokens[0] ? extractUserId(tokens[0]) : null;
    if (!targetId) { await reply("❌ Please mention a user or provide a user ID."); return; }

    let target: GuildMember | null = null;
    try { target = await guild.members.fetch(targetId); } catch { /* not found */ }
    if (!target) { await reply("❌ User not found in this server."); return; }
    if (target.id === message.author.id) { await reply("❌ You cannot warn yourself."); return; }

    const reason = tokens.slice(1).join(" ");

    await dmUser(client, target.id, [
      `**⚠️ You have received a warning in ${guild.name}.**`,
      ``,
      `**Moderator:** ${message.author.username}`,
      reason ? `**Reason:** ${reason}` : null,
      ``,
      config.moderationInvite ? `To appeal: ${config.moderationInvite}` : null
    ]);
    await notifyTargetInComms(guild, db, target.id,
      `you have received a **warning** in **${guild.name}**${reason ? ` — reason: ${reason}` : ""}. Please take note.`
    );
    await postPendingLog(client, db, guild.id, "warn", target.id, target.user.username, "", reason, message.author.id, guild.name);
    await writeAuditAndPost(db, guild, message.author.id, "crossserver.warn", {
      target: target.id, username: target.user.username, reason
    });

    await reply(`✅ **${target.user.username}** has been warned.`);
  }
}
