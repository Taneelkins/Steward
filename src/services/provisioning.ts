import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type CategoryChannel,
  type Guild,
  type PermissionResolvable,
  type Role,
  type TextChannel
} from "discord.js";
import { accessPermissionBits } from "./access.js";

export type StaffRoleKey = "staff" | "juniorMod" | "mod" | "seniorMod" | "headMod" | "communityManager";
export type SetupChannelKey =
  | "caseLogs"
  | "logBan"
  | "logStrike"
  | "logRestore"
  | "logDiscord"
  | "logTicket"
  | "quota"
  | "auditLog"
  | "modAlerts"
  | "staffRegistration"
  | "ticketTranscripts"
  | "evidenceArchive";

export type StaffRoleSpec = {
  key: StaffRoleKey;
  name: string;
  level: number;
  isAdmin: boolean;
  permissions: PermissionResolvable;
};

export type SetupChannelSpec = {
  key: SetupChannelKey;
  name: string;
  topic: string;
};

export type ProvisioningOptions = {
  categoryName?: string;
  roleOverrides?: Partial<Record<StaffRoleKey, Role | null>>;
  canRegisterRoleOverride?: Role | null;
  channelOverrides?: Partial<Record<SetupChannelKey, TextChannel | null>>;
  savedRoleIds?: Partial<Record<StaffRoleKey, string | null>>;
  savedCanRegisterRoleId?: string | null;
  savedChannelIds?: Partial<Record<SetupChannelKey, string | null>>;
};

export const staffRoleSpecs: StaffRoleSpec[] = [
  { key: "staff", name: "Staff", level: 0, isAdmin: false, permissions: [] },
  { key: "juniorMod", name: "Junior Mod", level: 1, isAdmin: false, permissions: [accessPermissionBits.junior] },
  { key: "mod", name: "Mod", level: 2, isAdmin: false, permissions: [accessPermissionBits.normal] },
  { key: "seniorMod", name: "Senior Mod", level: 3, isAdmin: false, permissions: [accessPermissionBits.normal] },
  { key: "headMod", name: "Head Mod", level: 4, isAdmin: true, permissions: [accessPermissionBits.junior, accessPermissionBits.normal, accessPermissionBits.head] },
  { key: "communityManager", name: "Community manager", level: 5, isAdmin: true, permissions: [accessPermissionBits.community] }
];

export const setupChannelSpecs: SetupChannelSpec[] = [
  { key: "caseLogs", name: "case-logs", topic: "Fallback moderation case logs." },
  { key: "logBan", name: "logban", topic: "Ban moderation logs." },
  { key: "logStrike", name: "logstrike", topic: "Strike moderation logs and strike alerts." },
  { key: "logRestore", name: "logrestore", topic: "Restore moderation logs." },
  { key: "logDiscord", name: "log-discord", topic: "Discord-ban moderation logs." },
  { key: "logTicket", name: "logticket", topic: "Ticket moderation logs and ticket alerts." },
  { key: "quota", name: "quota-alerts", topic: "Quota status, warnings, and reports." },
  { key: "auditLog", name: "audit-log", topic: "Bot audit events." },
  { key: "modAlerts", name: "mod-alerts", topic: "Administrative alerts, review flags, and quota-end pings." },
  { key: "staffRegistration", name: "staff-registration", topic: "Staff registration notices." },
  { key: "ticketTranscripts", name: "ticket-transcripts", topic: "Ticket Tool transcript watcher channel." },
  { key: "evidenceArchive", name: "evidence-archive", topic: "Protected archived evidence re-uploaded by the moderation ledger bot." }
];

export type ProvisionedServer = {
  category: CategoryChannel;
  roles: Record<StaffRoleKey, Role>;
  canRegisterRole: Role;
  channels: Record<SetupChannelKey, TextChannel>;
  warnings: string[];
};

export async function provisionModerationServer(guild: Guild, options: ProvisioningOptions = {}): Promise<ProvisionedServer> {
  await guild.roles.fetch();
  await guild.channels.fetch();

  const warnings: string[] = [];
  const roles = {} as Record<StaffRoleKey, Role>;
  for (const spec of staffRoleSpecs) {
    roles[spec.key] = await resolveRole(guild, spec, options.roleOverrides?.[spec.key], options.savedRoleIds?.[spec.key], warnings);
  }
  const canRegisterRole = await resolveRole(
    guild,
    { key: "staff", name: "Can register", level: 0, isAdmin: false, permissions: [accessPermissionBits.register] },
    options.canRegisterRoleOverride,
    options.savedCanRegisterRoleId,
    warnings
  );

  const category = await upsertCategory(guild, options.categoryName ?? "Mod Ledger", roles, warnings);
  const channels = {} as Record<SetupChannelKey, TextChannel>;
  for (const spec of setupChannelSpecs) {
    channels[spec.key] = await resolveTextChannel(
      guild,
      category,
      spec,
      options.channelOverrides?.[spec.key],
      options.savedChannelIds?.[spec.key],
      warnings
    );
  }

  return { category, roles, canRegisterRole, channels, warnings };
}

export async function assignStaffRole(guild: Guild, userId: string, role: Role, reason = "Moderation ledger staff registration") {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.roles.cache.has(role.id)) return false;
  await member.roles.add(role, reason);
  return true;
}

async function resolveRole(
  guild: Guild,
  spec: StaffRoleSpec,
  override: Role | null | undefined,
  savedRoleId: string | null | undefined,
  warnings: string[]
) {
  const saved = savedRoleId ? await guild.roles.fetch(savedRoleId).catch(() => null) : null;
  const existingByName = guild.roles.cache.find((role) => !role.managed && role.name.toLowerCase() === spec.name.toLowerCase());
  const role = override ?? saved ?? existingByName ?? null;

  if (!role) {
    return guild.roles.create({
      name: spec.name,
      permissions: spec.permissions,
      mentionable: false,
      reason: "Moderation ledger setup repair"
    });
  }

  if (!role.editable) {
    warnings.push(`Could not update permissions for ${role.name}; move the bot role above it if needed.`);
    return role;
  }

  return role.edit({
    permissions: new PermissionsBitField(role.permissions.bitfield).add(spec.permissions),
    mentionable: false,
    reason: "Moderation ledger setup repair"
  });
}

async function upsertCategory(guild: Guild, name: string, roles: Record<StaffRoleKey, Role>, warnings: string[]) {
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === name.toLowerCase()
  ) as CategoryChannel | undefined;
  const permissionOverwrites = await buildPermissionOverwrites(guild, roles);

  if (!existing) {
    return guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites,
      reason: "Moderation ledger setup repair"
    });
  }

  await existing.permissionOverwrites.set(permissionOverwrites, "Moderation ledger setup repair").catch(() => {
    warnings.push(`Could not refresh permissions on ${existing.name}; check the bot's Manage Channels permission.`);
  });
  return existing;
}

async function resolveTextChannel(
  guild: Guild,
  category: CategoryChannel,
  spec: SetupChannelSpec,
  override: TextChannel | null | undefined,
  savedChannelId: string | null | undefined,
  warnings: string[]
) {
  const saved = savedChannelId ? await guild.channels.fetch(savedChannelId).catch(() => null) : null;
  const savedText = saved?.type === ChannelType.GuildText ? (saved as TextChannel) : null;
  const existingByName = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name.toLowerCase() === spec.name.toLowerCase()
  ) as TextChannel | undefined;
  const channel = override ?? savedText ?? existingByName ?? null;

  if (!channel) {
    return guild.channels.create({
      name: spec.name,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: spec.topic,
      reason: "Moderation ledger setup repair"
    });
  }

  await channel.edit({ topic: spec.topic, reason: "Moderation ledger setup repair" }).catch(() => {
    warnings.push(`Could not update the topic for #${channel.name}.`);
  });

  if (!override && !savedText && channel.parentId !== category.id) {
    await channel.setParent(category.id, { lockPermissions: true }).catch(() => {
      warnings.push(`Could not move #${channel.name} into ${category.name}.`);
    });
  } else if (channel.parentId === category.id) {
    await channel.lockPermissions().catch(() => {
      warnings.push(`Could not sync permissions for #${channel.name}.`);
    });
  }

  return channel;
}

async function buildPermissionOverwrites(guild: Guild, roles: Record<StaffRoleKey, Role>) {
  const botMember = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    ...staffRoleSpecs.map((spec) => ({
      id: roles[spec.key].id,
      allow: spec.isAdmin
        ? [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ManageChannels
          ]
        : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    })),
    ...(botMember
      ? [
          {
            id: botMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ManageChannels
            ]
          }
        ]
      : [])
  ];
}
