/**
 * Cross-server punishment commands.
 *
 * Secondary-server staff run /jail /unjail /ban /unban /kick /warn.
 * The bot:
 *   1. Performs the Discord action (role assign, ban, kick, etc.)
 *   2. Pings the TARGET in the secondary server's crossserverCommsChannel
 *      (so they know what happened)
 *   3. Posts an INCOMPLETE log embed in the MAIN server's crossserverCommsChannel,
 *      pinging the MODERATOR who ran the command, with a "✏️ Fill in Details" button
 *      so they can finish the log and submit it to the correct log channel.
 *
 * Button custom-ID format:  cs:{subtype}:{discordId}:{duration}:{reason}
 *   subtype:  mute | ban | kick | warn | mute-appeal | ban-appeal | kick-appeal
 *   discordId: 17-19 digit snowflake
 *   duration:  e.g. "7d" or "" for indefinite
 *   reason:    truncated to 55 chars, colons in reason are safe (parse with slice(4).join(":"))
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  TextChannel
} from "discord.js";
import type { Client } from "discord.js";
import type { AppDatabase } from "../db.js";
import { startPrefilledLogFromButton } from "./logWorkflow.js";
import { writeAuditAndPost } from "./audit.js";
import { parseRobloxDuration, formatRobloxDuration } from "./roblox.js";
import { colors } from "../utils/theme.js";
import { getStaffTier } from "../utils/discord.js";
import { tierAllows } from "./access.js";

// ── Permission helpers ────────────────────────────────────────────────────────

/** Returns true if the interaction member has at least mod (normal) tier. */
function isMod(db: AppDatabase, interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member as GuildMember | null;
  if (!member) return false;
  const tier = getStaffTier(db, member);
  return tierAllows(tier, "normal");
}

// ── Action map ────────────────────────────────────────────────────────────────

const ACTION_META: Record<string, {
  actionName: string;
  actionDisplayName: string;
  appealType?: string;
  isAppeal: boolean;
  color: number;
  emoji: string;
}> = {
  mute:          { actionName: "discord", actionDisplayName: "Discord Mute",  isAppeal: false, color: colors.voidPurple, emoji: "🔇" },
  ban:           { actionName: "discord", actionDisplayName: "Discord Ban",   isAppeal: false, color: 0xe74c3c,          emoji: "🔨" },
  kick:          { actionName: "discord", actionDisplayName: "Discord Kick",  isAppeal: false, color: 0xe67e22,          emoji: "👢" },
  warn:          { actionName: "discord", actionDisplayName: "Discord Warn",  isAppeal: false, color: 0xf1c40f,          emoji: "⚠️" },
  "mute-appeal": { actionName: "appeal",  actionDisplayName: "Appeal",        appealType: "mute", isAppeal: true, color: 0x2ecc71, emoji: "📋" },
  "ban-appeal":  { actionName: "appeal",  actionDisplayName: "Appeal",        appealType: "ban",  isAppeal: true, color: 0x2ecc71, emoji: "📋" },
  "kick-appeal": { actionName: "appeal",  actionDisplayName: "Appeal",        appealType: "kick", isAppeal: true, color: 0x2ecc71, emoji: "📋" },
};

// ── Button builder ─────────────────────────────────────────────────────────────

function buildFillButton(
  subtype: string,
  discordId: string,
  duration: string,
  reason: string
): ActionRowBuilder<ButtonBuilder> {
  // Truncate reason so the full customId stays well under Discord's 100-char limit.
  // Format: cs:{subtype}:{discordId}:{duration}:{reason}
  const safeReason = reason.slice(0, 55);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cs:${subtype}:${discordId}:${duration}:${safeReason}`)
      .setLabel("✏️ Fill in Details")
      .setStyle(ButtonStyle.Primary)
  );
}

// ── Post incomplete log to main server's crossserverCommsChannel ──────────────

async function postPendingLog(
  client: Client,
  db: AppDatabase,
  secondaryGuildId: string,
  subtype: string,
  discordId: string,
  discordUsername: string,
  duration: string,
  reason: string,
  modId: string,
  secondaryGuildName: string
) {
  // If this guild has a main server linked, post there. Otherwise it IS the main server — post here.
  const mainGuildId = db.findMainGuildForSecondary(secondaryGuildId) ?? secondaryGuildId;

  const mainConfig = db.getGuildConfig(mainGuildId);
  const meta = ACTION_META[subtype];
  if (!meta) return;

  // Post to the main server's cross-server comms channel (not the log channel).
  // The mod clicks "Fill in Details" to complete the log, which then submits
  // to the correct log channel (discord mute log, appeal log, etc.).
  const channelId = mainConfig.crossserverCommsChannelId;
  if (!channelId) return;

  const mainGuild = client.guilds.cache.get(mainGuildId);
  if (!mainGuild) return;

  let channel: TextChannel | null = null;
  try {
    const ch = await mainGuild.channels.fetch(channelId);
    if (ch?.isTextBased() && "send" in ch) channel = ch as TextChannel;
  } catch { return; }
  if (!channel) return;

  const durationText = duration ? ` for **${duration}**` : "";
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} Incomplete ${meta.actionDisplayName} Log`)
    .setDescription(
      `<@${modId}>, you just performed a **${meta.actionDisplayName}** in **${secondaryGuildName}**.\n` +
      `An incomplete log has been created for you — click **Fill in Details** to finish it and submit it to the log channel.`
    )
    .addFields(
      { name: "User", value: `<@${discordId}> (${discordUsername})`, inline: true },
      { name: "Action", value: meta.actionDisplayName + (meta.appealType ? ` (${meta.appealType} appeal)` : ""), inline: true },
      ...(duration ? [{ name: "Duration", value: duration, inline: true }] : []),
      ...(reason ? [{ name: "Reason", value: reason, inline: false }] : [])
    )
    .setTimestamp()
    .setFooter({ text: `From: ${secondaryGuildName}` });

  await channel.send({
    embeds: [embed],
    components: [buildFillButton(subtype, discordId, duration, reason)]
  }).catch(() => null);
}

// ── DM the punished/released user ─────────────────────────────────────────────

async function dmUser(
  client: Client,
  targetId: string,
  lines: (string | null)[]
) {
  try {
    const user = await client.users.fetch(targetId);
    await user.send(lines.filter(Boolean).join("\n")).catch(() => null);
  } catch { /* user not found or DMs disabled — non-fatal */ }
}

// ── Ping the TARGET in the secondary server's crossservercomms ────────────────

async function notifyTargetInComms(
  secondaryGuild: import("discord.js").Guild,
  db: AppDatabase,
  targetId: string,
  message: string
) {
  const channelId = db.getGuildConfig(secondaryGuild.id).crossserverCommsChannelId;
  if (!channelId) return;
  try {
    const ch = await secondaryGuild.channels.fetch(channelId);
    if (ch?.isTextBased() && "send" in ch) {
      await (ch as TextChannel).send(`<@${targetId}> ${message}`).catch(() => null);
    }
  } catch { /* non-fatal */ }
}

// ── /jail ────────────────────────────────────────────────────────────────────

export async function handleCrossJail(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  const config = db.getGuildConfig(guild.id);

  if (!config.jailedRoleId) {
    await interaction.reply({ content: "❌ Jail role not configured. Run `/setupsecondary jail` first.", ephemeral: true });
    return;
  }

  const target = interaction.options.getMember("user") as GuildMember | null;
  if (!target) {
    await interaction.reply({ content: "❌ User not found in this server.", ephemeral: true });
    return;
  }
  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "❌ You cannot jail yourself.", ephemeral: true });
    return;
  }

  const durationStr = interaction.options.getString("duration") ?? null;
  const reason = interaction.options.getString("reason") ?? "";
  const durationSecs = durationStr ? parseRobloxDuration(durationStr) : undefined;
  if (durationStr && durationSecs === null) {
    await interaction.reply({ content: `❌ Could not parse duration: \`${durationStr}\`. Try "7d", "24h", "30m".`, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Save current roles (excluding @everyone and jailed role) then apply jailed role
  const savedRoleIds = target.roles.cache
    .filter(r => r.id !== guild.id && r.id !== config.jailedRoleId)
    .map(r => r.id);

  // After the null-guard above, durationSecs is number | undefined (never null here).
  const safeDurationSecs = durationSecs ?? undefined;
  const durationDisplay = safeDurationSecs !== undefined ? formatRobloxDuration(safeDurationSecs) : "indefinitely";

  // DM target before applying role
  await dmUser(interaction.client, target.id, [
    `**You have been muted in ${guild.name}.**`,
    ``,
    `**Moderator:** ${interaction.user.username}`,
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
    await interaction.editReply(`❌ Failed to assign jailed role: ${err instanceof Error ? err.message : "Unknown error"}`);
    return;
  }

  // Schedule unjail in DB
  const unjailAt = safeDurationSecs !== undefined
    ? new Date(Date.now() + safeDurationSecs * 1000).toISOString()
    : null;
  db.scheduleUnjail({
    guildId: guild.id,
    linkedGuildId: guild.id,
    discordTargetId: target.id,
    caseId: null,
    savedRoleIds,
    unjailAt
  });

  // Ping the target in secondary crossservercomms
  await notifyTargetInComms(guild, db, target.id,
    `you have been **jailed** in **${guild.name}**${safeDurationSecs !== undefined ? ` for **${durationDisplay}**` : " indefinitely"}. ` +
    `Please wait for staff to review your case.`
  );

  // Post incomplete mute log in main server's crossservercomms, pinging the mod
  await postPendingLog(
    interaction.client, db, guild.id, "mute",
    target.id, target.user.username,
    safeDurationSecs !== undefined ? durationDisplay : "",
    reason,
    interaction.user.id,
    guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.jail", {
    target: target.id, username: target.user.username, duration: durationDisplay, reason
  });

  await interaction.editReply(
    `✅ **${target.user.username}** has been jailed${safeDurationSecs !== undefined ? ` for **${durationDisplay}**` : " indefinitely"}.\n` +
    `An incomplete mute log has been posted in the main server for you to finish.`
  );
}

// ── /unjail ──────────────────────────────────────────────────────────────────

export async function handleCrossUnjail(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  if (!isMod(db, interaction)) {
    await interaction.reply({ content: "❌ You need the Mod role or higher to use this command.", ephemeral: true });
    return;
  }

  const config = db.getGuildConfig(guild.id);

  if (!config.jailedRoleId) {
    await interaction.reply({ content: "❌ Jail role not configured.", ephemeral: true });
    return;
  }

  const target = interaction.options.getMember("user") as GuildMember | null;
  if (!target) {
    await interaction.reply({ content: "❌ User not found in this server.", ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason") ?? "";

  await interaction.deferReply({ ephemeral: true });

  // Restore saved roles and remove jailed role
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
    await interaction.editReply(`❌ Failed to remove jailed role: ${err instanceof Error ? err.message : "Unknown error"}`);
    return;
  }

  db.deleteUnjailForTarget(guild.id, target.id);

  // DM target
  await dmUser(interaction.client, target.id, [
    `**Your mute in ${guild.name} has been lifted.**`,
    ``,
    reason ? `**Reason:** ${reason}` : null,
    `Your roles have been restored.`
  ]);

  // Ping target in secondary crossservercomms
  await notifyTargetInComms(guild, db, target.id,
    `you have been **unjailed** in **${guild.name}**. Your roles have been restored.`
  );

  // Post incomplete appeal log in main server's crossservercomms, pinging the mod
  await postPendingLog(
    interaction.client, db, guild.id, "mute-appeal",
    target.id, target.user.username, "",
    reason,
    interaction.user.id,
    guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.unjail", {
    target: target.id, username: target.user.username, reason
  });

  await interaction.editReply(
    `✅ **${target.user.username}** has been unjailed. Roles restored.\n` +
    `An incomplete appeal log has been posted in the main server for you to finish.`
  );
}

// ── /ban ─────────────────────────────────────────────────────────────────────

export async function handleCrossBan(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  if (!isMod(db, interaction)) {
    await interaction.reply({ content: "❌ You need the Mod role or higher to use this command.", ephemeral: true });
    return;
  }

  const target = interaction.options.getUser("user");
  if (!target) {
    await interaction.reply({ content: "❌ User not found.", ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason") ?? "";

  const config = db.getGuildConfig(guild.id);

  await interaction.deferReply({ ephemeral: true });

  // DM before banning
  await dmUser(interaction.client, target.id, [
    `**You have been banned from ${guild.name}.**`,
    ``,
    `**Moderator:** ${interaction.user.username}`,
    reason ? `**Reason:** ${reason}` : null,
    ``,
    config.moderationInvite ? `To appeal: ${config.moderationInvite}` : null
  ]);

  try {
    await guild.bans.create(target.id, { reason: `Banned by ${interaction.user.username} via /ban${reason ? `: ${reason}` : ""}` });
  } catch (err) {
    await interaction.editReply(`❌ Failed to ban: ${err instanceof Error ? err.message : "Unknown error"}`);
    return;
  }

  // Try to notify target in comms before they're banned (they may already be gone)
  await notifyTargetInComms(guild, db, target.id,
    `you have been **banned** from **${guild.name}**${reason ? ` — reason: ${reason}` : ""}.`
  );

  await postPendingLog(
    interaction.client, db, guild.id, "ban",
    target.id, target.username, "",
    reason,
    interaction.user.id,
    guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.ban", {
    target: target.id, username: target.username, reason
  });

  await interaction.editReply(
    `✅ **${target.username}** has been banned.\n` +
    `An incomplete ban log has been posted in the main server for you to finish.`
  );
}

// ── /unban ───────────────────────────────────────────────────────────────────

export async function handleCrossUnban(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  if (!isMod(db, interaction)) {
    await interaction.reply({ content: "❌ You need the Mod role or higher to use this command.", ephemeral: true });
    return;
  }

  const userId = interaction.options.getString("user_id", true).trim();

  if (!/^\d{17,19}$/.test(userId)) {
    await interaction.reply({ content: "❌ Invalid user ID. Provide a Discord user ID (17-19 digits).", ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason") ?? "";

  await interaction.deferReply({ ephemeral: true });

  let username = userId;
  try {
    const bannedUser = await guild.bans.fetch(userId);
    username = bannedUser.user.username;
    await guild.bans.remove(userId, `Unbanned by ${interaction.user.username} via /unban${reason ? `: ${reason}` : ""}`);
  } catch (err) {
    await interaction.editReply(`❌ Failed to unban: ${err instanceof Error ? err.message : "Unknown error"} (User may not be banned.)`);
    return;
  }

  // DM after successful unban
  const unbanConfig = db.getGuildConfig(guild.id);
  await dmUser(interaction.client, userId, [
    `**Your ban from ${guild.name} has been lifted.**`,
    ``,
    reason ? `**Reason:** ${reason}` : null,
    unbanConfig.moderationInvite ? `Rejoin: ${unbanConfig.moderationInvite}` : null
  ]);

  await postPendingLog(
    interaction.client, db, guild.id, "ban-appeal",
    userId, username, "",
    reason,
    interaction.user.id,
    guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.unban", {
    target: userId, username, reason
  });

  await interaction.editReply(
    `✅ **${username}** has been unbanned.\n` +
    `An incomplete ban appeal log has been posted in the main server for you to finish.`
  );
}

// ── /kick ─────────────────────────────────────────────────────────────────────

export async function handleCrossKick(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  if (!isMod(db, interaction)) {
    await interaction.reply({ content: "❌ You need the Mod role or higher to use this command.", ephemeral: true });
    return;
  }

  const target = interaction.options.getMember("user") as GuildMember | null;
  if (!target) {
    await interaction.reply({ content: "❌ User not found in this server.", ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason") ?? "";

  const kickConfig = db.getGuildConfig(guild.id);

  await interaction.deferReply({ ephemeral: true });

  // DM + comms ping before kick so messages reach them
  await dmUser(interaction.client, target.id, [
    `**You have been kicked from ${guild.name}.**`,
    ``,
    `**Moderator:** ${interaction.user.username}`,
    reason ? `**Reason:** ${reason}` : null,
    ``,
    kickConfig.moderationInvite ? `To appeal: ${kickConfig.moderationInvite}` : null
  ]);

  // Notify before kick so they still receive the ping
  await notifyTargetInComms(guild, db, target.id,
    `you have been **kicked** from **${guild.name}**${reason ? ` — reason: ${reason}` : ""}.`
  );

  try {
    await target.kick(`Kicked by ${interaction.user.username} via /kick${reason ? `: ${reason}` : ""}`);
  } catch (err) {
    await interaction.editReply(`❌ Failed to kick: ${err instanceof Error ? err.message : "Unknown error"}`);
    return;
  }

  await postPendingLog(
    interaction.client, db, guild.id, "kick",
    target.id, target.user.username, "",
    reason,
    interaction.user.id,
    guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.kick", {
    target: target.id, username: target.user.username, reason
  });

  await interaction.editReply(
    `✅ **${target.user.username}** has been kicked.\n` +
    `An incomplete kick log has been posted in the main server for you to finish.`
  );
}

// ── /warn ─────────────────────────────────────────────────────────────────────

export async function handleCrossWarn(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  const target = interaction.options.getMember("user") as GuildMember | null;
  if (!target) {
    await interaction.reply({ content: "❌ User not found in this server.", ephemeral: true });
    return;
  }
  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "❌ You cannot warn yourself.", ephemeral: true });
    return;
  }

  const reason = interaction.options.getString("reason") ?? "";

  const warnConfig = db.getGuildConfig(guild.id);

  await interaction.deferReply({ ephemeral: true });

  // DM target
  await dmUser(interaction.client, target.id, [
    `**⚠️ You have received a warning in ${guild.name}.**`,
    ``,
    `**Moderator:** ${interaction.user.username}`,
    reason ? `**Reason:** ${reason}` : null,
    ``,
    warnConfig.moderationInvite ? `To appeal: ${warnConfig.moderationInvite}` : null
  ]);

  // Notify target in secondary crossservercomms
  await notifyTargetInComms(guild, db, target.id,
    `you have received a **warning** in **${guild.name}**${reason ? ` — reason: ${reason}` : ""}. Please take note.`
  );

  // Post incomplete warn log in main server's crossservercomms, pinging the mod
  await postPendingLog(
    interaction.client, db, guild.id, "warn",
    target.id, target.user.username, "",
    reason,
    interaction.user.id,
    guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.warn", {
    target: target.id, username: target.user.username, reason
  });

  await interaction.editReply(
    `✅ **${target.user.username}** has been warned${reason ? ` — reason: ${reason}` : ""}.\n` +
    `An incomplete warn log has been posted in the main server for you to finish.`
  );
}

// ── Button handler ────────────────────────────────────────────────────────────

export async function handleCrossServerButton(db: AppDatabase, interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("cs:")) return false;
  if (!interaction.guild) return false;

  // Format: cs:{subtype}:{discordId}:{duration}:{reason...}
  const parts = interaction.customId.split(":");
  const subtype   = parts[1];
  const discordId = parts[2];
  const duration  = parts[3] ?? "";
  // reason may contain colons, so join everything after index 4
  const reason    = parts.slice(4).join(":") || null;

  const meta = ACTION_META[subtype];
  if (!meta || !discordId) return false;

  // Resolve Discord username at click time
  let discordUsername: string | null = null;
  try {
    const user = await interaction.client.users.fetch(discordId);
    discordUsername = user.username;
  } catch { /* leave null */ }

  await startPrefilledLogFromButton(interaction, db, {
    actionName: meta.actionName,
    actionDisplayName: meta.actionDisplayName,
    appealType: meta.appealType ?? null,
    discordId,
    discordUsername,
    punishmentLength: duration || null,
    reason,
    isTicketedAction: false   // cross-server actions are always non-ticketed
  });

  return true;
}
