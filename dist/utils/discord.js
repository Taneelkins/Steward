import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { tierAllows } from "../services/access.js";
import { truncate } from "./format.js";
import { colors } from "./theme.js";
// Bot developer — always has full authority in every server
const DEV_USER_ID = "616267913799925782";
export function userLabel(user) {
    const raw = "user" in user ? user.user : user;
    return `${raw.tag} (${raw.id})`;
}
export async function getTextChannel(guild, channelId) {
    if (!channelId)
        return null;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText)
        return null;
    return channel;
}
export async function postToConfiguredChannel(guild, channelId, options) {
    const channel = await getTextChannel(guild, channelId);
    if (!channel)
        return null;
    return channel.send(options).catch(() => null);
}
export async function safeDm(user, options) {
    return user.send(options).catch(() => null);
}
export function normalizeHttpUrl(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return null;
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return null;
        return url.href;
    }
    catch {
        return null;
    }
}
export function transcriptFieldValue(value) {
    if (!value)
        return "None";
    return normalizeHttpUrl(value)
        ? "Open with the Transcript button below."
        : "Saved, but the link is not a valid HTTP or HTTPS URL for a Discord button.";
}
export function transcriptLinkButton(value) {
    const url = normalizeHttpUrl(value);
    if (!url)
        return null;
    return new ButtonBuilder().setLabel("Transcript").setStyle(ButtonStyle.Link).setURL(url);
}
export function labeledLinkComponents(links) {
    const buttons = links
        .map((link) => {
        const url = normalizeHttpUrl(link.url);
        if (!url)
            return null;
        return new ButtonBuilder()
            .setLabel(link.label.slice(0, 80))
            .setStyle(ButtonStyle.Link)
            .setURL(url);
    })
        .filter((button) => Boolean(button));
    const rows = [];
    for (let index = 0; index < buttons.length && rows.length < 5; index += 5) {
        rows.push(new ActionRowBuilder().addComponents(...buttons.slice(index, index + 5)));
    }
    return rows;
}
export function transcriptLinkComponents(value) {
    return labeledLinkComponents([{ label: "Transcript", url: value }]);
}
export function caseLinkComponents(transcriptUrl, mediaLinks = []) {
    return labeledLinkComponents([
        { label: "Transcript", url: transcriptUrl },
        ...mediaLinks.map((link) => ({ label: link.label, url: link.url }))
    ]);
}
export async function isAdminMember(db, member) {
    if (member.id === DEV_USER_ID)
        return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator))
        return true;
    return getStaffTier(db, member) === "head" || getStaffTier(db, member) === "community";
}
export async function isModMember(db, member) {
    if (await isAdminMember(db, member))
        return true;
    return getStaffTier(db, member) !== null;
}
export function hasCanRegisterRole(db, member) {
    const config = db.getGuildConfig(member.guild.id);
    if (config.registrationRoleId && member.roles.cache.has(config.registrationRoleId))
        return true;
    return member.roles.cache.some((role) => role.name.toLowerCase() === "can register");
}
export function getStaffTier(db, member) {
    const roles = db.listStaffRoles(member.guild.id);
    const staff = roles.find((role) => role.key === "staff" || role.name.toLowerCase() === "staff");
    const hasBaseStaff = staff ? member.roles.cache.has(staff.roleId) : member.roles.cache.some((role) => role.name.toLowerCase() === "staff");
    if (!hasBaseStaff)
        return null;
    const hasKey = (key) => roles.some((role) => staffRoleKeyMatches(role.key, role.name, key) && member.roles.cache.has(role.roleId));
    if (hasKey("communityManager"))
        return "community";
    if (hasKey("headMod"))
        return "head";
    if (hasKey("mod") || hasKey("seniorMod"))
        return "normal";
    if (hasKey("juniorMod"))
        return "junior";
    return null;
}
function staffRoleKeyMatches(storedKey, name, expected) {
    if (storedKey === expected)
        return true;
    const normalized = name.toLowerCase().replace(/\s+/g, "-");
    return ((expected === "staff" && normalized === "staff") ||
        (expected === "juniorMod" && normalized === "junior-mod") ||
        (expected === "mod" && (normalized === "mod" || normalized === "normal-mod")) ||
        (expected === "seniorMod" && normalized === "senior-mod") ||
        (expected === "headMod" && normalized === "head-mod") ||
        (expected === "communityManager" && normalized === "community-manager"));
}
export function canUseAccess(db, member, access) {
    if (member.id === DEV_USER_ID)
        return true;
    if (access === "owner")
        return member.id === member.guild.ownerId;
    if (access === "public")
        return true;
    if (access === "register")
        return hasCanRegisterRole(db, member);
    if (member.permissions.has(PermissionFlagsBits.Administrator))
        return true;
    return tierAllows(getStaffTier(db, member), access);
}
export function commandDeniedMessage(access) {
    if (access === "owner")
        return "Only the server owner can use that command.";
    if (access === "register")
        return "Only members with the Can register role can use that command.";
    if (access === "public")
        return "You can use that command.";
    return "You need the configured Staff role and the required staff tier for that command.";
}
export async function requireAdmin(db, member) {
    if (!(await isAdminMember(db, member))) {
        throw new Error("Only configured admins can use that command.");
    }
}
export async function requireMod(db, member) {
    if (!(await isModMember(db, member))) {
        throw new Error("Only configured moderators can use that command.");
    }
}
export function configSummaryEmbed(config, extra = {}) {
    return new EmbedBuilder()
        .setTitle("Bot Configuration")
        .setColor(colors.voidPurple)
        .addFields({ name: "Mod Role", value: config.modRoleId ? `<@&${config.modRoleId}>` : "Not set", inline: true }, { name: "Admin Role", value: config.adminRoleId ? `<@&${config.adminRoleId}>` : "Not set", inline: true }, { name: "Owner DM", value: config.ownerUserId ? `<@${config.ownerUserId}>` : "Not set", inline: true }, { name: "Action Logs", value: config.actionLogChannelId ? `<#${config.actionLogChannelId}>` : "Not set", inline: true }, { name: "Ingame Log", value: extra.ingameLogChannelId ? `<#${extra.ingameLogChannelId}>` : "Not set", inline: true }, { name: "Appeal Log", value: config.appealLogChannelId ? `<#${config.appealLogChannelId}>` : "Not set", inline: true }, { name: "Quota Board", value: config.quotaChannelId ? `<#${config.quotaChannelId}>` : "Not set", inline: true }, { name: "Quota Alerts", value: config.quotaAlertChannelId ? `<#${config.quotaAlertChannelId}>` : "Not set", inline: true }, { name: "Staff Registration", value: config.staffRegistrationChannelId ? `<#${config.staffRegistrationChannelId}>` : "Not set", inline: true }, { name: "Can Register", value: config.registrationRoleId ? `<@&${config.registrationRoleId}>` : "Not set", inline: true }, { name: "Ticket Transcripts", value: config.ticketTranscriptChannelId ? `<#${config.ticketTranscriptChannelId}>` : "Not set", inline: true }, { name: "Approval Channel", value: config.approvalChannelId ? `<#${config.approvalChannelId}>` : "Not set", inline: true }, { name: "Junior Help", value: config.juniorHelpChannelId ? `<#${config.juniorHelpChannelId}>` : "Not set", inline: true }, { name: "Steward Actions", value: config.stewardLogChannelId ? `<#${config.stewardLogChannelId}>` : "Not set", inline: true }, { name: "Timezone", value: config.timezone, inline: true }, { name: "Interactive Log", value: config.interactiveLogEnabled ? "Enabled" : "Disabled", inline: true }, { name: "CM Approval Toggle", value: config.approvalEnabled ? "Enabled" : "Disabled", inline: true }, { name: "Point System", value: config.pointsEnabled ? "Enabled" : "Disabled", inline: true }, { name: "Quota Enabled", value: config.quotaEnabled ? "Yes" : "No", inline: true });
}
export function textPreview(channel, fallback = "Unknown") {
    return channel && "name" in channel ? `#${truncate(channel.name, 80)}` : fallback;
}
