import { PermissionFlagsBits } from "discord.js";
export const accessPermissionBits = {
    register: PermissionFlagsBits.UseExternalSounds,
    junior: PermissionFlagsBits.CreatePrivateThreads,
    normal: PermissionFlagsBits.ManageEvents,
    head: PermissionFlagsBits.BanMembers,
    community: PermissionFlagsBits.ManageGuild
};
export const commandAccess = {
    help: "public",
    log: "public",
    points: "public",
    strikes: "public",
    logban: "public",
    logstrike: "public",
    logrestore: "public",
    logdiscord: "public",
    logticket: "public",
    register: "register",
    multi: "junior",
    checkpoints: "junior",
    staff: "junior",
    bot: "junior",
    logedit: "public",
    case: "normal",
    lookup: "normal",
    warnings: "normal",
    ingameban: "normal",
    ingameunban: "head",
    roblox: "head",
    autopunish: "head",
    action: "head",
    addpoints: "head",
    removepoints: "head",
    multiplier: "head",
    quota: "junior",
    audit: "head",
    setup: "owner",
    update: "owner",
    updatebot: "owner",
    modshop: "community",
    config: "community",
    backup: "community",
    export: "community",
    refresh: "community"
};
export function tierAllows(tier, access) {
    if (access === "public")
        return true;
    if (access === "register")
        return false;
    if (access === "owner")
        return false;
    if (!tier)
        return false;
    if (tier === "community")
        return true;
    if (tier === "head")
        return access === "head" || access === "normal" || access === "junior";
    if (tier === "normal")
        return access === "normal" || access === "junior";
    return access === "junior";
}
