import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Guild,
  GuildMember,
  MessageCreateOptions,
  PermissionFlagsBits,
  TextBasedChannel,
  TextChannel,
  User
} from "discord.js";
import type { AppDatabase } from "../db.js";
import type { GuildConfig } from "../types.js";
import { type CommandAccess, type StaffTier, tierAllows } from "../services/access.js";
import { truncate } from "./format.js";
import { colors } from "./theme.js";

// Bot developer — always has full authority in every server
const DEV_USER_ID = "616267913799925782";

export function userLabel(user: User | GuildMember) {
  const raw = "user" in user ? user.user : user;
  return `${raw.tag} (${raw.id})`;
}

export async function getTextChannel(guild: Guild, channelId: string | null | undefined) {
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel as TextChannel;
}

export async function postToConfiguredChannel(
  guild: Guild,
  channelId: string | null | undefined,
  options: MessageCreateOptions
) {
  const channel = await getTextChannel(guild, channelId);
  if (!channel) return null;
  return channel.send(options).catch(() => null);
}

export async function safeDm(user: User, options: MessageCreateOptions) {
  return user.send(options).catch(() => null);
}

export function normalizeHttpUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function transcriptFieldValue(value: string | null | undefined) {
  if (!value) return "None";
  return normalizeHttpUrl(value)
    ? "Open with the Transcript button below."
    : "Saved, but the link is not a valid HTTP or HTTPS URL for a Discord button.";
}

export function transcriptLinkButton(value: string | null | undefined) {
  const url = normalizeHttpUrl(value);
  if (!url) return null;
  return new ButtonBuilder().setLabel("Transcript").setStyle(ButtonStyle.Link).setURL(url);
}

export function labeledLinkComponents(links: Array<{ label: string; url: string | null | undefined }>) {
  const buttons = links
    .map((link) => {
      const url = normalizeHttpUrl(link.url);
      if (!url) return null;
      return new ButtonBuilder()
        .setLabel(link.label.slice(0, 80))
        .setStyle(ButtonStyle.Link)
        .setURL(url);
    })
    .filter((button): button is ButtonBuilder => Boolean(button));

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length && rows.length < 5; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)));
  }
  return rows;
}

export function transcriptLinkComponents(value: string | null | undefined) {
  return labeledLinkComponents([{ label: "Transcript", url: value }]);
}

export function caseLinkComponents(transcriptUrl: string | null | undefined, mediaLinks: Array<{ label: string; url: string }> = []) {
  return labeledLinkComponents([
    { label: "Transcript", url: transcriptUrl },
    ...mediaLinks.map((link) => ({ label: link.label, url: link.url }))
  ]);
}

export async function isAdminMember(db: AppDatabase, member: GuildMember) {
  if (member.id === DEV_USER_ID) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return getStaffTier(db, member) === "head" || getStaffTier(db, member) === "community";
}

export async function isModMember(db: AppDatabase, member: GuildMember) {
  if (await isAdminMember(db, member)) return true;
  return getStaffTier(db, member) !== null;
}

export function hasCanRegisterRole(db: AppDatabase, member: GuildMember) {
  const config = db.getGuildConfig(member.guild.id);
  if (config.registrationRoleId && member.roles.cache.has(config.registrationRoleId)) return true;
  return member.roles.cache.some((role) => role.name.toLowerCase() === "can register");
}

export function getStaffTier(db: AppDatabase, member: GuildMember): StaffTier | null {
  const roles = db.listStaffRoles(member.guild.id);
  const staff = roles.find((role) => role.key === "staff" || role.name.toLowerCase() === "staff");
  const hasBaseStaff = staff ? member.roles.cache.has(staff.roleId) : member.roles.cache.some((role) => role.name.toLowerCase() === "staff");
  if (!hasBaseStaff) return null;

  const hasKey = (key: string) => roles.some((role) => staffRoleKeyMatches(role.key, role.name, key) && member.roles.cache.has(role.roleId));
  if (hasKey("communityManager")) return "community";
  if (hasKey("headMod")) return "head";
  if (hasKey("mod") || hasKey("seniorMod")) return "normal";
  if (hasKey("juniorMod")) return "junior";
  return null;
}

function staffRoleKeyMatches(storedKey: string, name: string, expected: string) {
  if (storedKey === expected) return true;
  const normalized = name.toLowerCase().replace(/\s+/g, "-");
  return (
    (expected === "staff" && normalized === "staff") ||
    (expected === "juniorMod" && normalized === "junior-mod") ||
    (expected === "mod" && (normalized === "mod" || normalized === "normal-mod")) ||
    (expected === "seniorMod" && normalized === "senior-mod") ||
    (expected === "headMod" && normalized === "head-mod") ||
    (expected === "communityManager" && normalized === "community-manager")
  );
}

export function canUseAccess(db: AppDatabase, member: GuildMember, access: CommandAccess) {
  if (member.id === DEV_USER_ID) return true;
  if (access === "owner") return member.id === member.guild.ownerId;
  if (access === "public") return true;
  if (access === "register") return hasCanRegisterRole(db, member);
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return tierAllows(getStaffTier(db, member), access);
}

export function commandDeniedMessage(access: CommandAccess) {
  if (access === "owner") return "Only the server owner can use that command.";
  if (access === "register") return "Only members with the Can register role can use that command.";
  if (access === "public") return "You can use that command.";
  return "You need the configured Staff role and the required staff tier for that command.";
}

export async function requireAdmin(db: AppDatabase, member: GuildMember) {
  if (!(await isAdminMember(db, member))) {
    throw new Error("Only configured admins can use that command.");
  }
}

export async function requireMod(db: AppDatabase, member: GuildMember) {
  if (!(await isModMember(db, member))) {
    throw new Error("Only configured moderators can use that command.");
  }
}

export function configSummaryEmbed(
  config: GuildConfig,
  extra: { ingameLogChannelId?: string | null; robloxGame?: { name: string; universeId: string } | null } = {}
) {
  const robloxValue = extra.robloxGame
    ? `**${extra.robloxGame.name}**\nUniverse \`${extra.robloxGame.universeId}\``
    : "Not configured — run `/roblox`";

  return new EmbedBuilder()
    .setTitle("Bot Configuration")
    .setColor(colors.voidPurple)
    .addFields(
      { name: "Mod Role", value: config.modRoleId ? `<@&${config.modRoleId}>` : "Not set", inline: true },
      { name: "Admin Role", value: config.adminRoleId ? `<@&${config.adminRoleId}>` : "Not set", inline: true },
      { name: "Owner DM", value: config.ownerUserId ? `<@${config.ownerUserId}>` : "Not set", inline: true },
      { name: "Action Logs", value: config.actionLogChannelId ? `<#${config.actionLogChannelId}>` : "Not set", inline: true },
      { name: "Ingame Log", value: extra.ingameLogChannelId ? `<#${extra.ingameLogChannelId}>` : "Not set", inline: true },
      { name: "Appeal Log", value: config.appealLogChannelId ? `<#${config.appealLogChannelId}>` : "Not set", inline: true },
      { name: "Quota Board", value: config.quotaChannelId ? `<#${config.quotaChannelId}>` : "Not set", inline: true },
      { name: "Quota Alerts", value: config.quotaAlertChannelId ? `<#${config.quotaAlertChannelId}>` : "Not set", inline: true },
      { name: "Staff Registration", value: config.staffRegistrationChannelId ? `<#${config.staffRegistrationChannelId}>` : "Not set", inline: true },
      { name: "Can Register", value: config.registrationRoleId ? `<@&${config.registrationRoleId}>` : "Not set", inline: true },
      { name: "Ticket Transcripts", value: config.ticketTranscriptChannelId ? `<#${config.ticketTranscriptChannelId}>` : "Not set", inline: true },
      { name: "Approval Channel", value: config.approvalChannelId ? `<#${config.approvalChannelId}>` : "Not set", inline: true },
      { name: "Junior Help", value: config.juniorHelpChannelId ? `<#${config.juniorHelpChannelId}>` : "Not set", inline: true },
      { name: "Steward Actions", value: config.stewardLogChannelId ? `<#${config.stewardLogChannelId}>` : "Not set", inline: true },
      { name: "LOA Approval", value: config.loaChannelId ? `<#${config.loaChannelId}>` : "Not set", inline: true },
      { name: "LOA Log", value: config.loaLogChannelId ? `<#${config.loaLogChannelId}>` : "Not set", inline: true },
      { name: "Shouts Channel", value: config.shoutsChannelId ? `<#${config.shoutsChannelId}>` : "Not set", inline: true },
      { name: "Roblox Game", value: robloxValue, inline: true },
      { name: "Timezone", value: config.timezone, inline: true },
      { name: "Interactive Log", value: config.interactiveLogEnabled ? "Enabled" : "Disabled", inline: true },
      { name: "CM Approval Toggle", value: config.approvalEnabled ? "Enabled" : "Disabled", inline: true },
      { name: "Point System", value: config.pointsEnabled ? "Enabled" : "Disabled", inline: true },
      { name: "Quota Enabled", value: config.quotaEnabled ? "Yes" : "No", inline: true },
      {
        name: "Auto-Punish",
        value: (() => {
          const d = config.autoPunishDisabled;
          const lines = [
            `Ingame Bans: ${d.includes("ingame") ? "❌ Off" : "✅ On"}`,
            `Ingame Unbans: ${d.includes("appeal") ? "❌ Off" : "✅ On"}`,
            `Discord Actions: ${d.includes("discord") ? "❌ Off" : "✅ On"}`
          ];
          return lines.join("\n");
        })(),
        inline: true
      }
    );
}

export function textPreview(channel: TextBasedChannel | null, fallback = "Unknown") {
  return channel && "name" in channel ? `#${truncate(channel.name, 80)}` : fallback;
}
