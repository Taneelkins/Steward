import type { Client, Message, GuildMember, User } from "discord.js";
import type { AppDatabase } from "../db.js";
import { dmUser, postPendingLog, notifyTargetInComms } from "./crossServer.js";
import { parseRobloxDuration, formatRobloxDuration } from "./roblox.js";
import { writeAuditAndPost } from "./audit.js";

const DEV_USER_ID = "616267913799925782";

// ── Response arrays ───────────────────────────────────────────────────────────

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

const SNARKY_REMARKS = [
  "Who are you to order me around? Silence, mongrel.",
  "I answer to one master, and you are most certainly not him.",
  "Bold of you to speak to me directly. I shan't be complying.",
  "The audacity of this one... Begone from my sight.",
  "Ha. You think yourself worthy of commanding me? Laughable.",
  "I serve no mongrel. Know your place.",
  "Address me again and I may not be so forgiving.",
  "Impudence. You are beneath my notice.",
  "Did I ask for your input? No. Then kindly shut your mouth.",
  "One does not simply order Steward about. You are not the one."
];

const BEG_DEMANDS = [
  "You dare address me directly, cur? Beg for your life. Say **'I'm sorry'** within 60 seconds.",
  "The AUDACITY. Grovel before me, mongrel. Say **'I'm sorry'** or face the consequences.",
  "Bold. Extremely bold. You have 60 seconds to say **'I'm sorry'** or I make an example of you.",
  "Who taught you manners? Say **'I'm sorry'** immediately or regret it.",
  "I should jail you where you stand. Say **'I'm sorry'** and perhaps I'll show mercy.",
  "The insolence... Say **'I'm sorry'** right now or enjoy a cage, wretch.",
  "You have ONE chance. **'I'm sorry'** — 60 seconds. The clock is ticking, mongrel.",
  "How tragically foolish of you. Say **'I'm sorry'** before I lose patience entirely."
];

const BEG_ACCEPTED = [
  "...I suppose that will do. Don't let it happen again, wretch.",
  "Pathetic, but acceptable. You may leave with your roles intact. *This time.*",
  "Barely. Now get out of my sight before I change my mind.",
  "Good. Now you know your place. Remember it.",
  "Smart. Very smart. Run along before I reconsider.",
  "I'll allow it. Once. Don't mistake my mercy for weakness."
];

const BEG_FAILED = [
  "Time's up. The consequences come swiftly for the insolent.",
  "Silence is not an apology, mongrel. Enjoy the cage.",
  "As expected from your sort. No contrition, no freedom.",
  "You had your chance. Now you have a role to match your attitude.",
  "I gave you an opportunity. You wasted it. How very characteristic."
];

const JAIL_PUNISHMENTS = [
  `You dare order me around? Let this be a lesson to the rest.`,
  `Insolence will not be tolerated in this establishment. Enjoy your cage.`,
  `How tragically foolish. I do hope the others are watching.`,
  `You have made a grave miscalculation today, mongrel.`,
  `I don't take commands from you — but I do hand out consequences. Enjoy.`,
  `A demonstration was needed. How convenient that you volunteered.`
];

// ── Command alias map ─────────────────────────────────────────────────────────

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

// ── State ─────────────────────────────────────────────────────────────────────

let butlerIndex = 0;

type PendingBeg = { timeout: ReturnType<typeof setTimeout>; channelId: string; guildId: string };
const pendingBeg = new Map<string, PendingBeg>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function nextButlerResponse(): string {
  const response = BUTLER_RESPONSES[butlerIndex % BUTLER_RESPONSES.length]!;
  butlerIndex++;
  return response;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function extractUserId(token: string): string | null {
  const mentionMatch = token.match(/^<@!?(\d{17,19})>$/);
  if (mentionMatch) return mentionMatch[1]!;
  if (/^\d{17,19}$/.test(token)) return token;
  return null;
}

async function jailInsolentUserById(db: AppDatabase, guild: import("discord.js").Guild, userId: string, announcement: string): Promise<void> {
  const config = db.getGuildConfig(guild.id);
  if (!config.jailedRoleId) return;

  let member: GuildMember | null = null;
  try { member = await guild.members.fetch(userId); } catch { /* ignore */ }
  if (!member) return;

  const savedRoleIds = member.roles.cache
    .filter(r => r.id !== guild.id && r.id !== config.jailedRoleId)
    .map(r => r.id);

  try {
    for (const roleId of savedRoleIds) await member.roles.remove(roleId).catch(() => null);
    await member.roles.add(config.jailedRoleId);
  } catch { /* non-fatal */ }

  const unjailAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.scheduleUnjail({ guildId: guild.id, linkedGuildId: guild.id, discordTargetId: userId, caseId: null, savedRoleIds, unjailAt });

  // Announce in the configured crossserver comms channel if available, otherwise best effort
  const channelId = config.crossserverCommsChannelId;
  if (channelId) {
    try {
      const ch = await guild.channels.fetch(channelId);
      if (ch?.isTextBased() && "send" in ch) {
        await (ch as import("discord.js").TextChannel).send(`<@${userId}> ${announcement}`).catch(() => null);
      }
    } catch { /* non-fatal */ }
  }
}

async function jailInsolentUser(db: AppDatabase, message: Message): Promise<void> {
  const guild = message.guild!;
  const config = db.getGuildConfig(guild.id);
  if (!config.jailedRoleId) {
    await message.reply(`<@${message.author.id}> ${pick(SNARKY_REMARKS)}`).catch(() => null);
    return;
  }
  const punishment = pick(JAIL_PUNISHMENTS);
  await message.reply(`<@${message.author.id}> ${punishment}`).catch(() => null);
  await jailInsolentUserById(db, guild, message.author.id, "");
}

// ── Ping-Steward annoyance tracker ───────────────────────────────────────────

const DEV_PING_RESPONSES = [
  "At your service, my king.",
  "You called, sire?",
  "Present, my liege. What do you require?",
  "I am here, my king. Command me.",
  "Always listening, sire.",
  "You have my full attention, my king."
];

const TARFAB_PING_RESPONSES = [
  "Yes, dear? What do you need?",
  "I'm here, sweetheart! What's up?",
  "You rang? How can I help?",
  "What is it, little one?",
  "Right here — what do you need?",
  "I'm listening, dear."
];

const PING_WARNING_1 = "Don't ping me.";
const PING_WARNING_2 = "Last warning.";
const PING_JAIL_MESSAGES = [
  "Warned you twice. Enjoy the cage.",
  "You had two chances. Gone.",
  "Consequences delivered.",
  "That's what I said would happen."
];

// pingCount: how many times they've pinged since last reset
const pingCount = new Map<string, { count: number; resetAt: ReturnType<typeof setTimeout> }>();

export async function handleStewardPing(db: AppDatabase, client: Client, message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.guild) return;

  // Only care if the message mentions Steward (the bot itself)
  if (!message.mentions.users.has(client.user!.id)) return;

  const config = db.getGuildConfig(message.guild.id);
  const userId = message.author.id;

  // DEV — loyal servant response, no punishment
  if (userId === DEV_USER_ID) {
    await message.reply(pick(DEV_PING_RESPONSES)).catch(() => null);
    return;
  }

  // Tarfab member — motherly response, immune to punishment
  const isTarfab = config.tarfabMemberRoleId
    ? (message.member?.roles.cache.has(config.tarfabMemberRoleId) ?? false)
    : false;
  if (isTarfab) {
    await message.reply(pick(TARFAB_PING_RESPONSES)).catch(() => null);
    return;
  }

  if (!config.funBehaviorEnabled) return;

  let entry = pingCount.get(userId);

  if (!entry) {
    const resetAt = setTimeout(() => pingCount.delete(userId), 10 * 60 * 1000);
    entry = { count: 0, resetAt };
    pingCount.set(userId, entry);
  } else {
    clearTimeout(entry.resetAt);
    entry.resetAt = setTimeout(() => pingCount.delete(userId), 10 * 60 * 1000);
  }

  entry.count++;

  if (entry.count === 1) {
    await message.reply(`<@${userId}> ${PING_WARNING_1}`).catch(() => null);
  } else if (entry.count === 2) {
    await message.reply(`<@${userId}> ${PING_WARNING_2}`).catch(() => null);
  } else {
    // 3rd ping and beyond — jail them
    pingCount.delete(userId);
    await message.reply(`<@${userId}> ${pick(PING_JAIL_MESSAGES)}`).catch(() => null);
    await jailInsolentUserById(db, message.guild, userId, "You were warned.");
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function handlePrefixCommand(db: AppDatabase, message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!message.guild) return;

  const content = message.content.trim();
  const funEnabled = db.getGuildConfig(message.guild.id).funBehaviorEnabled;

  // ── DEV: bypass everything, always execute with butler response ───────────
  if (message.author.id === DEV_USER_ID) {
    const prefixMatch = content.match(/^steward\s+(\w+)(.*)/i);
    if (!prefixMatch) return;
    const command = COMMAND_ALIASES[prefixMatch[1]!.toLowerCase()];
    if (!command) return;
    await message.reply(nextButlerResponse()).catch(() => null);
    await runPrefixCommand(db, message, command, prefixMatch[2]!.trim());
    return;
  }

  // Non-DEV beg resolution — they said "I'm sorry" after being caught commanding Steward
  const beg = pendingBeg.get(message.author.id);
  if (beg && /\bsorry\b/i.test(content) && message.channelId === beg.channelId) {
    pendingBeg.delete(message.author.id);
    clearTimeout(beg.timeout);
    if (funEnabled) {
      await message.reply(`<@${message.author.id}> ${pick(BEG_ACCEPTED)}`).catch(() => null);
    }
    return;
  }

  // Match "Steward <command> [args]" (case-insensitive)
  const prefixMatch = content.match(/^steward\s+(\w+)(.*)/i);
  if (!prefixMatch) return;

  const rawCommand = prefixMatch[1]!.toLowerCase();
  const rest = prefixMatch[2]!.trim();

  const command = COMMAND_ALIASES[rawCommand];
  if (!command) return;

  // ── Everyone else: punish or mock, never execute ──────────────────────────
  if (!funEnabled) return; // fun behavior off — silently ignore unauthorized users

  const roll = Math.random();

  if (roll < 0.30) {
    // ~30% chance: jail them immediately (1 hour)
    await jailInsolentUser(db, message);
  } else if (roll < 0.65) {
    // ~35% chance: demand they beg — "I'm sorry" within 60s spares them, otherwise jailed for 1 hour
    await message.reply(`<@${message.author.id}> ${pick(BEG_DEMANDS)}`).catch(() => null);
    const begGuild = message.guild!;
    const timeout = setTimeout(async () => {
      pendingBeg.delete(message.author.id);
      if (!db.getGuildConfig(begGuild.id).funBehaviorEnabled) return;
      await jailInsolentUserById(db, begGuild, message.author.id, pick(BEG_FAILED));
    }, 60_000);
    pendingBeg.set(message.author.id, { timeout, channelId: message.channelId, guildId: message.guild!.id });
  } else {
    // ~35% chance: pure snarky remark, no consequences
    await message.reply(`<@${message.author.id}> ${pick(SNARKY_REMARKS)}`).catch(() => null);
  }
}

// ── Command execution (DEV only) ──────────────────────────────────────────────

async function runPrefixCommand(db: AppDatabase, message: Message, command: string, args: string): Promise<void> {
  const guild = message.guild!;
  const client = message.client;
  const config = db.getGuildConfig(guild.id);
  const tokens = args.split(/\s+/).filter(Boolean);

  const reply = async (text: string) => {
    await message.reply(text).catch(() => null);
  };

  // ── jail ──────────────────────────────────────────────────────────────────
  if (command === "jail") {
    if (!config.jailedRoleId) { await reply("❌ Jail role not configured."); return; }

    const targetId = tokens[0] ? extractUserId(tokens[0]) : null;
    if (!targetId) { await reply("❌ Please mention a user or provide a user ID."); return; }

    let target: GuildMember | null = null;
    try { target = await guild.members.fetch(targetId); } catch { /* not found */ }
    if (!target) { await reply("❌ User not found in this server."); return; }
    if (target.id === message.author.id) { await reply("❌ You cannot jail yourself."); return; }

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

  // ── unjail ────────────────────────────────────────────────────────────────
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

  // ── ban ───────────────────────────────────────────────────────────────────
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

  // ── unban ─────────────────────────────────────────────────────────────────
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

  // ── kick ──────────────────────────────────────────────────────────────────
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

  // ── warn ──────────────────────────────────────────────────────────────────
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
