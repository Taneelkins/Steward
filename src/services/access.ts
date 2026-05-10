import { PermissionFlagsBits } from "discord.js";

export type CommandAccess = "public" | "register" | "junior" | "normal" | "head" | "community" | "owner";
export type StaffTier = "junior" | "normal" | "head" | "community";

export const accessPermissionBits = {
  register: PermissionFlagsBits.UseExternalSounds,
  junior: PermissionFlagsBits.CreatePrivateThreads,
  normal: PermissionFlagsBits.ManageEvents,
  head: PermissionFlagsBits.BanMembers,
  community: PermissionFlagsBits.ManageGuild
} as const;

export const commandAccess: Record<string, CommandAccess> = {
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
  case: "normal",
  action: "head",
  addpoints: "head",
  removepoints: "head",
  multiplier: "head",
  quota: "junior",
  ticketlog: "head",
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

export function tierAllows(tier: StaffTier | null, access: CommandAccess) {
  if (access === "public") return true;
  if (access === "register") return false;
  if (access === "owner") return false;
  if (!tier) return false;
  if (tier === "community") return true;
  if (tier === "head") return access === "head" || access === "normal" || access === "junior";
  if (tier === "normal") return access === "normal";
  return access === "junior";
}
