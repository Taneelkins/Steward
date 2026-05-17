/**
 * Cross-server punishment commands.
 *
 * Secondary-server staff run /jail /unjail /ban /unban /kick.
 * The bot:
 *   1. Performs the Discord action (role assign, ban, kick, etc.)
 *   2. Pings the target in the secondary server's crossserverCommsChannel
 *   3. Posts a "pending log" embed in the main server's log channel
 *      with a "✏️ Fill in Details" button so any main-server staff
 *      can open the interactive log workflow pre-filled with the target's info.
 *
 * Button custom-ID format:  cs:{subtype}:{discordId}:{duration}
 *   subtype:  mute | ban | kick | warn | mute-appeal | ban-appeal | kick-appeal
 *   discordId: 17-19 digit snowflake
 *   duration:  e.g. "7d" or "" for indefinite
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

// ── Action map ────────────────────────────────────────────────────────────────

const ACTION_META: Record<string, { actionName: string; actionDisplayName: string; appealType?: string; isAppeal: boolean; color: number; emoji: string }> = {
  mute:        { actionName: "discord", actionDisplayName: "Discord Mute",  isAppeal: false, color: colors.voidPurple,  emoji: "🔇" },
  ban:         { actionName: "discord", actionDisplayName: "Discord Ban",   isAppeal: false, color: 0xe74c3c,           emoji: "🔨" },
  kick:        { actionName: "discord", actionDisplayName: "Discord Kick",  isAppeal: false, color: 0xe67e22,           emoji: "👢" },
  warn:        { actionName: "discord", actionDisplayName: "Discord Warn",  isAppeal: false, color: 0xf1c40f,           emoji: "⚠️" },
  "mute-appeal": { actionName: "appeal", actionDisplayName: "Appeal",       appealType: "mute", isAppeal: true, color: 0x2ecc71, emoji: "📋" },
  "ban-appeal":  { actionName: "appeal", actionDisplayName: "Appeal",       appealType: "ban",  isAppeal: true, color: 0x2ecc71, emoji: "📋" },
  "kick-appeal": { actionName: "appeal", actionDisplayName: "Appeal",       appealType: "kick", isAppeal: true, color: 0x2ecc71, emoji: "📋" },
};

// ── Button helpers ────────────────────────────────────────────────────────────

function buildFillButton(subtype: string, discordId: string, duration: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cs:${subtype}:${discordId}:${duration}`)
      .setLabel("✏️ Fill in Details")
      .setStyle(ButtonStyle.Primary)
  );
}

// ── Post pending log to main server ─────────────────────────────────────────

async function postPendingLog(
  client: Client,
  db: AppDatabase,
  secondaryGuildId: string,
  subtype: string,
  discordId: string,
  discordUsername: string,
  duration: string,
  secondaryGuildName: string
) {
  const mainGuildId = db.findMainGuildForSecondary(secondaryGuildId);
  if (!mainGuildId) return;

  const mainConfig = db.getGuildConfig(mainGuildId);
  const meta = ACTION_META[subtype];
  if (!meta) return;

  // Pick the right channel: appeal log for appeals, discord log for actions
  const channelId = meta.isAppeal
    ? (mainConfig.appealLogChannelId ?? mainConfig.actionLogChannelId)
    : (db.getActionLogChannelId(mainGuildId, "discord") ?? mainConfig.actionLogChannelId);
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
    .setTitle(`${meta.emoji} Pending ${meta.actionDisplayName} Log`)
    .setDescription(
      `A **${meta.isAppeal ? "appeal" : meta.actionDisplayName.toLowerCase()}** was issued in **${secondaryGuildName}**.\n` +
      `Click **Fill in Details** to complete the log.`
    )
    .addFields(
      { name: "User", value: `<@${discordId}> (${discordUsername})`, inline: true },
      { name: "Action", value: meta.actionDisplayName + (meta.appealType ? ` (${meta.appealType})` : ""), inline: true },
      ...(duration ? [{ name: "Duration", value: duration, inline: true }] : [])
    )
    .setTimestamp()
    .setFooter({ text: `From: ${secondaryGuildName}` });

  await channel.send({ embeds: [embed], components: [buildFillButton(subtype, discordId, duration)] }).catch(() => null);
}

// ── Notify user in secondary server's crossservercomms ───────────────────────

async function notifyUserInComms(
  secondaryGuild: import("discord.js").Guild,
  db: AppDatabase,
  discordId: string,
  message: string
) {
  const channelId = db.getGuildConfig(secondaryGuild.id).crossserverCommsChannelId;
  if (!channelId) return;
  try {
    const ch = await secondaryGuild.channels.fetch(channelId);
    if (ch?.isTextBased() && "send" in ch) {
      await (ch as TextChannel).send(`<@${discordId}> ${message}`).catch(() => null);
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

  try {
    // Remove all saved roles and add jailed role
    for (const roleId of savedRoleIds) {
      await target.roles.remove(roleId).catch(() => null);
    }
    await target.roles.add(config.jailedRoleId);
  } catch (err) {
    await interaction.editReply(`❌ Failed to assign jailed role: ${err instanceof Error ? err.message : "Unknown error"}`);
    return;
  }

  // After the null-guard above, durationSecs is number | undefined (never null here).
  const safeDurationSecs = durationSecs ?? undefined;

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

  const durationDisplay = safeDurationSecs !== undefined ? formatRobloxDuration(safeDurationSecs) : "indefinitely";

  // Notify user in crossservercomms
  await notifyUserInComms(guild, db, target.id,
    `you have been **jailed** in **${guild.name}** ${safeDurationSecs !== undefined ? `for **${durationDisplay}**` : "indefinitely"}. ` +
    `Please wait for staff to review your case.`
  );

  // Post pending mute log in main server
  await postPendingLog(
    interaction.client, db, guild.id, "mute",
    target.id, target.user.username,
    safeDurationSecs !== undefined ? durationDisplay : "",
    guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.jail", {
    target: target.id, username: target.user.username, duration: durationDisplay
  });

  await interaction.editReply(
    `✅ **${target.user.username}** has been jailed${durationSecs !== undefined ? ` for **${durationDisplay}**` : " indefinitely"}.\n` +
    `A pending mute log has been posted in the main server for staff to complete.`
  );
}

// ── /unjail ──────────────────────────────────────────────────────────────────

export async function handleCrossUnjail(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
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

  await interaction.deferReply({ ephemeral: true });

  // Get saved roles from DB, restore them, remove jailed role
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

  // Notify user
  await notifyUserInComms(guild, db, target.id,
    `you have been **unjailed** in **${guild.name}**. Your roles have been restored.`
  );

  // Post pending appeal log in main server
  await postPendingLog(
    interaction.client, db, guild.id, "mute-appeal",
    target.id, target.user.username, "", guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.unjail", {
    target: target.id, username: target.user.username
  });

  await interaction.editReply(
    `✅ **${target.user.username}** has been unjailed. Roles restored.\n` +
    `A pending appeal log has been posted in the main server.`
  );
}

// ── /ban (secondary) ─────────────────────────────────────────────────────────

export async function handleCrossBan(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  const target = interaction.options.getUser("user");
  if (!target) {
    await interaction.reply({ content: "❌ User not found.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await guild.bans.create(target.id, { reason: `Banned by ${interaction.user.username} via /ban` });
  } catch (err) {
    await interaction.editReply(`❌ Failed to ban: ${err instanceof Error ? err.message : "Unknown error"}`);
    return;
  }

  // Try to notify user in comms before they're banned (they may already be gone)
  await notifyUserInComms(guild, db, target.id,
    `you have been **banned** from **${guild.name}**.`
  );

  await postPendingLog(
    interaction.client, db, guild.id, "ban",
    target.id, target.username, "", guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.ban", {
    target: target.id, username: target.username
  });

  await interaction.editReply(
    `✅ **${target.username}** has been banned.\n` +
    `A pending ban log has been posted in the main server.`
  );
}

// ── /unban (secondary) ───────────────────────────────────────────────────────

export async function handleCrossUnban(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  const userId = interaction.options.getString("user_id", true).trim();

  if (!/^\d{17,19}$/.test(userId)) {
    await interaction.reply({ content: "❌ Invalid user ID. Provide a Discord user ID (17-19 digits).", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let username = userId;
  try {
    const bannedUser = await guild.bans.fetch(userId);
    username = bannedUser.user.username;
    await guild.bans.remove(userId, `Unbanned by ${interaction.user.username} via /unban`);
  } catch (err) {
    await interaction.editReply(`❌ Failed to unban: ${err instanceof Error ? err.message : "Unknown error"} (User may not be banned.)`);
    return;
  }

  await postPendingLog(
    interaction.client, db, guild.id, "ban-appeal",
    userId, username, "", guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.unban", {
    target: userId, username
  });

  await interaction.editReply(
    `✅ **${username}** has been unbanned.\n` +
    `A pending ban appeal log has been posted in the main server.`
  );
}

// ── /kick (secondary) ────────────────────────────────────────────────────────

export async function handleCrossKick(interaction: ChatInputCommandInteraction, db: AppDatabase) {
  const guild = interaction.guild!;
  const target = interaction.options.getMember("user") as GuildMember | null;
  if (!target) {
    await interaction.reply({ content: "❌ User not found in this server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Notify before kick so they still receive the ping
  await notifyUserInComms(guild, db, target.id,
    `you have been **kicked** from **${guild.name}**.`
  );

  try {
    await target.kick(`Kicked by ${interaction.user.username} via /kick`);
  } catch (err) {
    await interaction.editReply(`❌ Failed to kick: ${err instanceof Error ? err.message : "Unknown error"}`);
    return;
  }

  await postPendingLog(
    interaction.client, db, guild.id, "kick",
    target.id, target.user.username, "", guild.name
  );

  await writeAuditAndPost(db, guild, interaction.user.id, "crossserver.kick", {
    target: target.id, username: target.user.username
  });

  await interaction.editReply(
    `✅ **${target.user.username}** has been kicked.\n` +
    `A pending kick log has been posted in the main server.`
  );
}

// ── Button handler ────────────────────────────────────────────────────────────

export async function handleCrossServerButton(db: AppDatabase, interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("cs:")) return false;
  if (!interaction.guild) return false;

  const parts = interaction.customId.split(":");
  // format: cs:{subtype}:{discordId}:{duration}
  // subtype itself may contain hyphens (e.g. mute-appeal) — parts[1] always subtype, parts[2] discordId, parts[3] duration
  const subtype    = parts[1];
  const discordId  = parts[2];
  const duration   = parts[3] ?? "";

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
    punishmentLength: duration || null
  });

  return true;
}
