import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { tierAllows } from "../services/access.js";
import { formatPoints, truncate } from "./format.js";
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
        : "Saved — press the View Transcript button below to see it.";
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
export function caseLinkComponents(transcriptUrl, mediaLinks = [], caseId) {
    const buttons = [];
    const transcriptHref = normalizeHttpUrl(transcriptUrl);
    if (transcriptHref) {
        // Valid URL — show as a clickable link button
        buttons.push(new ButtonBuilder().setLabel("Transcript").setStyle(ButtonStyle.Link).setURL(transcriptHref));
    }
    else if (transcriptUrl && caseId !== undefined) {
        // Saved but not a valid URL — show a button that reveals the raw value ephemerally
        buttons.push(new ButtonBuilder()
            .setCustomId(`transcript_raw:${caseId}`)
            .setLabel("View Transcript")
            .setStyle(ButtonStyle.Secondary));
    }
    for (const link of mediaLinks) {
        const url = normalizeHttpUrl(link.url);
        if (url) {
            buttons.push(new ButtonBuilder().setLabel(link.label.slice(0, 80)).setStyle(ButtonStyle.Link).setURL(url));
        }
    }
    const rows = [];
    for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
    }
    return rows;
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
    const memberHasId = (roleId) => member.roles.cache.has(roleId);
    // Name fallback: checks if the member has any Discord role whose name matches a
    // configured role for that key. Handles role ID mismatches (e.g. role was recreated).
    const memberHasName = (key) => roles.some((role) => staffRoleKeyMatches(role.key, role.name, key) && member.roles.cache.some((r) => r.name.toLowerCase() === role.name.toLowerCase()));
    // Base staff check — ID first, name fallback
    const staff = roles.find((role) => role.key === "staff" || role.name.toLowerCase() === "staff");
    const hasBaseStaff = staff
        ? memberHasId(staff.roleId) || member.roles.cache.some((r) => r.name.toLowerCase() === "staff")
        : member.roles.cache.some((r) => r.name.toLowerCase() === "staff");
    if (!hasBaseStaff)
        return null;
    // Tier checks — ID first, then name fallback against configured role names
    const hasKey = (key) => roles.some((role) => staffRoleKeyMatches(role.key, role.name, key) && memberHasId(role.roleId)) || memberHasName(key);
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
    const robloxValue = extra.robloxGame
        ? `**${extra.robloxGame.name}**\nUniverse \`${extra.robloxGame.universeId}\``
        : "Not configured — run `/roblox`";
    return new EmbedBuilder()
        .setTitle("Bot Configuration")
        .setColor(colors.voidPurple)
        .addFields({ name: "Mod Role", value: config.modRoleId ? `<@&${config.modRoleId}>` : "Not set", inline: true }, { name: "Admin Role", value: config.adminRoleId ? `<@&${config.adminRoleId}>` : "Not set", inline: true }, { name: "Owner DM", value: config.ownerUserId ? `<@${config.ownerUserId}>` : "Not set", inline: true }, { name: "Action Logs", value: config.actionLogChannelId ? `<#${config.actionLogChannelId}>` : "Not set", inline: true }, { name: "Ingame Log", value: extra.ingameLogChannelId ? `<#${extra.ingameLogChannelId}>` : "Not set", inline: true }, { name: "Appeal Log", value: config.appealLogChannelId ? `<#${config.appealLogChannelId}>` : "Not set", inline: true }, { name: "Quota Board", value: config.quotaChannelId ? `<#${config.quotaChannelId}>` : "Not set", inline: true }, { name: "Quota Alerts", value: config.quotaAlertChannelId ? `<#${config.quotaAlertChannelId}>` : "Not set", inline: true }, { name: "Staff Registration", value: config.staffRegistrationChannelId ? `<#${config.staffRegistrationChannelId}>` : "Not set", inline: true }, { name: "Can Register", value: config.registrationRoleId ? `<@&${config.registrationRoleId}>` : "Not set", inline: true }, { name: "Ticket Transcripts", value: config.ticketTranscriptChannelId ? `<#${config.ticketTranscriptChannelId}>` : "Not set", inline: true }, { name: "Approval Channel", value: config.approvalChannelId ? `<#${config.approvalChannelId}>` : "Not set", inline: true }, { name: "Junior Help", value: config.juniorHelpChannelId ? `<#${config.juniorHelpChannelId}>` : "Not set", inline: true }, { name: "Steward Actions", value: config.stewardLogChannelId ? `<#${config.stewardLogChannelId}>` : "Not set", inline: true }, { name: "LOA Approval", value: config.loaChannelId ? `<#${config.loaChannelId}>` : "Not set", inline: true }, { name: "LOA Log", value: config.loaLogChannelId ? `<#${config.loaLogChannelId}>` : "Not set", inline: true }, { name: "Shouts Channel", value: config.shoutsChannelId ? `<#${config.shoutsChannelId}>` : "Not set", inline: true }, { name: "Roblox Game", value: robloxValue, inline: true }, { name: "Timezone", value: config.timezone, inline: true }, { name: "Interactive Log", value: config.interactiveLogEnabled ? "Enabled" : "Disabled", inline: true }, { name: "CM Approval Toggle", value: config.approvalEnabled ? "Enabled" : "Disabled", inline: true }, { name: "Point System", value: config.pointsEnabled ? "Enabled" : "Disabled", inline: true }, { name: "Jr. Approval Points", value: config.juniorApprovalPointsMilli === 0 ? "Disabled" : formatPoints(config.juniorApprovalPointsMilli), inline: true }, { name: "Quota Enabled", value: config.quotaEnabled ? "Yes" : "No", inline: true }, { name: "Jail Role", value: config.jailedRoleId ? `<@&${config.jailedRoleId}>` : "Not set", inline: true }, { name: "Jail Category", value: config.jailCategoryId ? `<#${config.jailCategoryId}>` : "Not set", inline: true }, { name: "Jail Chat", value: config.jailChatId ? `<#${config.jailChatId}>` : "Not set", inline: true }, { name: "Jail Announcements", value: config.jailAnnouncementsId ? `<#${config.jailAnnouncementsId}>` : "Not set", inline: true }, { name: "Promote/Demote Roles", value: config.promoteDemoteRoleIds.length > 0 ? config.promoteDemoteRoleIds.map((id) => `<@&${id}>`).join(", ") : "None", inline: true }, {
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
    });
}
export function textPreview(channel, fallback = "Unknown") {
    return channel && "name" in channel ? `#${truncate(channel.name, 80)}` : fallback;
}
