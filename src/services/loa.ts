import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Guild,
  GuildMember
} from "discord.js";
import type { AppDatabase } from "../db.js";
import type { LoaRequest } from "../types.js";
import { getTextChannel, postToConfiguredChannel, safeDm } from "../utils/discord.js";
import { canUseAccess } from "../utils/discord.js";
import { discordTimestamp, nowIso } from "../utils/time.js";
import { writeAuditAndPost } from "./audit.js";
import { colors } from "../utils/theme.js";

// ── Embed builders ────────────────────────────────────────────────────────────

export function buildLoaRequestEmbed(request: LoaRequest): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📋 LOA Request")
    .setColor(colors.voidPurple)
    .addFields(
      { name: "Staff Member", value: `<@${request.userId}> (${request.username})`, inline: true },
      { name: "Duration", value: request.durationText, inline: true },
      {
        name: "Expires",
        value: request.expiresAt ? discordTimestamp(request.expiresAt, "D") : "No end date",
        inline: true
      },
      { name: "Reason", value: request.reason }
    )
    .setFooter({ text: `LOA #${request.id}` })
    .setTimestamp(new Date(request.createdAt));
}

export function buildLoaLogEmbed(request: LoaRequest): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("✅ LOA Approved")
    .setColor(0x2ecc71)
    .addFields(
      { name: "Staff Member", value: `<@${request.userId}> (${request.username})`, inline: true },
      { name: "Duration", value: request.durationText, inline: true },
      {
        name: "Expires",
        value: request.expiresAt ? discordTimestamp(request.expiresAt, "D") : "No end date",
        inline: true
      },
      { name: "Approved By", value: request.approvedBy ? `<@${request.approvedBy}>` : "Unknown", inline: true },
      { name: "Reason", value: request.reason }
    )
    .setFooter({ text: `LOA #${request.id}` })
    .setTimestamp();
}

export function buildLoaApprovalButtons(loaId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`loa:approve:${loaId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`loa:deny:${loaId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
  );
}

// ── Button handler ────────────────────────────────────────────────────────────

export async function handleLoaButton(db: AppDatabase, interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("loa:")) return false;
  if (!interaction.guild) return false;

  const parts = interaction.customId.split(":");
  const action = parts[1]; // "approve" | "deny"
  const loaId = parseInt(parts[2], 10);
  if (isNaN(loaId) || (action !== "approve" && action !== "deny")) return false;

  // Only head mods and above can approve/deny
  const member = interaction.member as GuildMember;
  if (!canUseAccess(db, member, "head")) {
    await interaction.reply({ content: "Only Head Mods and above can approve or deny LOA requests.", ephemeral: true });
    return true;
  }

  const request = db.getLoaRequest(loaId);
  if (!request) {
    await interaction.reply({ content: "LOA request not found.", ephemeral: true });
    return true;
  }
  if (request.status !== "pending") {
    await interaction.reply({ content: `This LOA has already been **${request.status}**.`, ephemeral: true });
    return true;
  }

  await interaction.deferUpdate();

  const guild = interaction.guild;

  if (action === "approve") {
    await approveLoa(db, guild, request, interaction.user.id);
  } else {
    await denyLoa(db, guild, request, interaction.user.id);
  }

  // Update the approval message — remove buttons, stamp result
  const statusLine = action === "approve"
    ? `\n\n**Approved** by <@${interaction.user.id}>`
    : `\n\n**Denied** by <@${interaction.user.id}>`;

  const updatedEmbed = buildLoaRequestEmbed(request)
    .setColor(action === "approve" ? 0x2ecc71 : 0xe74c3c)
    .setDescription(statusLine);

  await interaction.editReply({ embeds: [updatedEmbed], components: [] }).catch(() => null);
  return true;
}

// ── Approve ───────────────────────────────────────────────────────────────────

async function approveLoa(db: AppDatabase, guild: Guild, request: LoaRequest, approverId: string) {
  db.updateLoaRequest(request.id, { status: "approved", approvedBy: approverId });

  // Add quota exemption — expires when the LOA ends
  db.run(
    `INSERT INTO quota_exemptions (guild_id, user_id, reason, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       reason = excluded.reason,
       expires_at = excluded.expires_at,
       created_by = excluded.created_by,
       created_at = excluded.created_at`,
    guild.id,
    request.userId,
    `LOA #${request.id}: ${request.reason}`,
    request.expiresAt,
    approverId,
    nowIso()
  );

  // Post to LOA log channel
  const config = db.getGuildConfig(guild.id);
  const updatedRequest = { ...request, approvedBy: approverId, status: "approved" as const };
  await postToConfiguredChannel(guild, config.loaLogChannelId, {
    embeds: [buildLoaLogEmbed(updatedRequest)]
  });

  // Audit log
  await writeAuditAndPost(db, guild, approverId, "loa.approved", {
    loaId: request.id,
    userId: request.userId,
    username: request.username,
    duration: request.durationText,
    expiresAt: request.expiresAt
  });

  // DM the staff member
  try {
    const discordUser = await guild.client.users.fetch(request.userId).catch(() => null);
    if (discordUser) {
      const expiresLine = request.expiresAt
        ? `Your LOA runs until ${discordTimestamp(request.expiresAt, "D")} (${discordTimestamp(request.expiresAt, "R")}).`
        : "Your LOA has no set end date.";

      await safeDm(discordUser, {
        embeds: [
          new EmbedBuilder()
            .setTitle("LOA Approved")
            .setColor(0x2ecc71)
            .setDescription(
              `Your Leave of Absence request in **${guild.name}** has been approved.\n\n` +
              `**Duration:** ${request.durationText}\n` +
              expiresLine + "\n\n" +
              "You are now exempt from quota requirements for this period. Enjoy your time off!"
            )
            .setTimestamp()
        ]
      });
    }
  } catch {
    // DM failure is non-fatal
  }
}

// ── Deny ──────────────────────────────────────────────────────────────────────

async function denyLoa(db: AppDatabase, guild: Guild, request: LoaRequest, denierId: string) {
  db.updateLoaRequest(request.id, { status: "denied", approvedBy: denierId });

  await writeAuditAndPost(db, guild, denierId, "loa.denied", {
    loaId: request.id,
    userId: request.userId,
    username: request.username
  });

  try {
    const discordUser = await guild.client.users.fetch(request.userId).catch(() => null);
    if (discordUser) {
      await safeDm(discordUser, {
        embeds: [
          new EmbedBuilder()
            .setTitle("LOA Denied")
            .setColor(0xe74c3c)
            .setDescription(
              `Your Leave of Absence request in **${guild.name}** was not approved.\n\n` +
              "Please reach out to a Head Mod if you have questions."
            )
            .setTimestamp()
        ]
      });
    }
  } catch {
    // DM failure is non-fatal
  }
}
