import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import type { AppDatabase } from "../db.js";
import { canUseAccess } from "../utils/discord.js";
import { nowIso } from "../utils/time.js";
import { writeAuditAndPost } from "./audit.js";
import { staffRoleSpecs } from "./provisioning.js";
import { colors } from "../utils/theme.js";

// ── Snowflake parser ──────────────────────────────────────────────────────────
// Returns:
//   string    → valid ID parsed from the input (save it)
//   null      → field was cleared (clear the value)
//   undefined → invalid / unparseable input (skip, don't touch)

function parseSnowflake(raw: string): string | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/<[#@&]+(\d{17,20})>/) ?? trimmed.match(/^(\d{17,20})$/);
  return match ? match[1] : undefined;
}

// ── Panel embed ───────────────────────────────────────────────────────────────

function buildPanelEmbed(db: AppDatabase, guildId: string): EmbedBuilder {
  const config = db.getGuildConfig(guildId);
  const staffRoles = db.listStaffRoles(guildId);

  const ch = (id: string | null | undefined, label: string, opt = false) =>
    id ? `✅ **${label}:** <#${id}>` : opt ? `⬜ **${label}:** Not set` : `❌ **${label}:** Not set`;
  const rl = (id: string | null | undefined, label: string, opt = false) =>
    id ? `✅ **${label}:** <@&${id}>` : opt ? `⬜ **${label}:** Not set` : `❌ **${label}:** Not set`;
  const tog = (val: boolean, label: string) =>
    `${val ? "✅" : "❌"} **${label}:** ${val ? "Enabled" : "Disabled"}`;

  const tierLabels = [
    { key: "staff",            label: "Staff"             },
    { key: "juniorMod",        label: "Junior Mod"        },
    { key: "mod",              label: "Normal Mod"        },
    { key: "seniorMod",        label: "Senior Mod"        },
    { key: "headMod",          label: "Head Mod"          },
    { key: "communityManager", label: "Community Manager" }
  ];

  const rolesField = [
    ...tierLabels.map(({ key, label }) => {
      const found = staffRoles.find((r) => r.key === key);
      return found ? `✅ **${label}:** <@&${found.roleId}>` : `⬜ **${label}:** Not set`;
    }),
    rl(config.registrationRoleId, "Can Register")
  ].join("\n");

  // Core log channels (set via action_log_channels table)
  const logChannelsField = [
    ch(db.getActionLogChannelId(guildId, "ban"),     "Ingame Ban"),
    ch(db.getActionLogChannelId(guildId, "strike"),  "Strike"),
    ch(db.getActionLogChannelId(guildId, "restore"), "Restore"),
    ch(db.getActionLogChannelId(guildId, "discord"), "Discord"),
    ch(db.getActionLogChannelId(guildId, "ticket"),  "Ticket"),
    ch(config.appealLogChannelId ?? db.getActionLogChannelId(guildId, "appeal"), "Appeal"),
    ch(config.actionLogChannelId, "Action Log (fallback)")
  ].join("\n");

  // Core operational channels
  const channelsField = [
    ch(config.alertChannelId,      "Alerts"),
    ch(config.auditChannelId,      "Audit"),
    ch(config.approvalChannelId,   "CM Approval",  true),
    ch(config.juniorHelpChannelId, "Junior Help",  true),
    ch(config.quotaChannelId,      "Quota Board",  true)
  ].join("\n");

  // Secondary channels
  const moreField = [
    ch(config.quotaAlertChannelId,        "Quota Alerts",       true),
    ch(config.staffRegistrationChannelId, "Staff Registration", true),
    ch(config.loaChannelId,               "LOA Approval",       true),
    ch(config.loaLogChannelId,            "LOA Log",            true),
    ch(config.ticketTranscriptChannelId,  "Ticket Transcripts", true)
  ].join("\n");

  // Optional / specialised channels
  const optionalField = [
    ch(config.evidenceArchiveChannelId, "Evidence Archive", true),
    ch(config.stewardLogChannelId,      "Steward Log",      true),
    ch(config.shoutsChannelId,          "Shouts",           true)
  ].join("\n");

  const behaviorField = [
    tog(config.interactiveLogEnabled, "Interactive Log"),
    tog(config.approvalEnabled,       "CM Approval Flow"),
    tog(config.pointsEnabled,         "Point System"),
    tog(config.quotaEnabled,          "Quota")
  ].join("\n");

  // Count critical (non-optional) missing items for the title
  const criticalLines = [logChannelsField, channelsField].join("\n").split("\n");
  const missing = criticalLines.filter((l) => l.startsWith("❌")).length;
  const title =
    missing === 0
      ? "✅ All critical configs are set"
      : `⚠️ ${missing} critical item${missing !== 1 ? "s" : ""} not set`;

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(missing === 0 ? 0x2ecc71 : colors.voidPurple)
    .addFields(
      { name: "🎭 Roles",             value: rolesField,       inline: false },
      { name: "📋 Log Channels",      value: logChannelsField, inline: false },
      { name: "📌 Channels",          value: channelsField,    inline: false },
      { name: "📌 More Channels",     value: moreField,        inline: false },
      { name: "📌 Optional Channels", value: optionalField,    inline: false },
      { name: "⚙️ Behavior",          value: behaviorField,    inline: false }
    )
    .setFooter({ text: "✅ = set   ❌ = missing   ⬜ = optional — click a button below to edit" })
    .setTimestamp();
}

// ── Panel payload ─────────────────────────────────────────────────────────────

export function buildSetupPanel(db: AppDatabase, guildId: string, userId: string) {
  const config = db.getGuildConfig(guildId);

  const togBtn = (key: string, label: string, on: boolean) =>
    new ButtonBuilder()
      .setCustomId(`cfg_panel:toggle:${key}:${userId}`)
      .setLabel(`${on ? "✅" : "❌"} ${label}`)
      .setStyle(on ? ButtonStyle.Success : ButtonStyle.Danger);

  const components = [
    // Row 1 — modal buttons (5 slots, all used)
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`cfg_panel:modal:roles:${userId}`).setLabel("🎭 Roles").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg_panel:modal:log_ch:${userId}`).setLabel("📋 Log Channels").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg_panel:modal:core_ch:${userId}`).setLabel("📌 Channels").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg_panel:modal:extra_ch:${userId}`).setLabel("📌 More").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg_panel:modal:optional:${userId}`).setLabel("📌 Optional").setStyle(ButtonStyle.Secondary)
    ),
    // Row 2 — behavior toggles
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      togBtn("interactive_log", "Interactive Log", config.interactiveLogEnabled),
      togBtn("cm_approval",     "CM Approval",     config.approvalEnabled),
      togBtn("points",          "Points",          config.pointsEnabled),
      togBtn("quota",           "Quota",           config.quotaEnabled)
    ),
    // Row 3 — close
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`cfg_panel:close:${userId}`).setLabel("Close").setStyle(ButtonStyle.Danger)
    )
  ];

  return { embeds: [buildPanelEmbed(db, guildId)], components };
}

// ── Modal builders ────────────────────────────────────────────────────────────

function ri(id: string, label: string, current: string | null | undefined) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Paste role ID or @Role mention — leave blank to clear")
    .setRequired(false);
  if (current) input.setValue(`<@&${current}>`);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function ci(id: string, label: string, current: string | null | undefined) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Paste channel ID or #channel mention — leave blank to clear")
    .setRequired(false);
  if (current) input.setValue(`<#${current}>`);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function buildRolesModal(db: AppDatabase, guildId: string): ModalBuilder {
  const staffRoles = db.listStaffRoles(guildId);
  const get = (key: string) => staffRoles.find((r) => r.key === key)?.roleId ?? null;
  return new ModalBuilder()
    .setCustomId("cfg_panel:modal:roles")
    .setTitle("Edit Staff Roles")
    .addComponents(
      ri("staff",            "Staff Role",             get("staff")),
      ri("juniorMod",        "Junior Mod Role",        get("juniorMod")),
      ri("mod",              "Normal Mod Role",        get("mod")),
      ri("headMod",          "Head Mod Role",          get("headMod")),
      ri("communityManager", "Community Manager Role", get("communityManager"))
    );
}

function buildLogChannelsModal(db: AppDatabase, guildId: string): ModalBuilder {
  const g = (name: string) => db.getActionLogChannelId(guildId, name);
  return new ModalBuilder()
    .setCustomId("cfg_panel:modal:log_ch")
    .setTitle("Edit Log Channels")
    .addComponents(
      ci("ban",     "Ingame Ban Log", g("ban")),
      ci("strike",  "Strike Log",     g("strike")),
      ci("restore", "Restore Log",    g("restore")),
      ci("discord", "Discord Log",    g("discord")),
      ci("ticket",  "Ticket Log",     g("ticket"))
    );
}

function buildCoreChannelsModal(db: AppDatabase, guildId: string): ModalBuilder {
  const c = db.getGuildConfig(guildId);
  return new ModalBuilder()
    .setCustomId("cfg_panel:modal:core_ch")
    .setTitle("Edit Core Channels")
    .addComponents(
      ci("alerts",      "Alerts",      c.alertChannelId),
      ci("audit",       "Audit Log",   c.auditChannelId),
      ci("approval",    "CM Approval", c.approvalChannelId),
      ci("junior_help", "Junior Help", c.juniorHelpChannelId),
      ci("quota",       "Quota Board", c.quotaChannelId)
    );
}

function buildExtraChannelsModal(db: AppDatabase, guildId: string): ModalBuilder {
  const c = db.getGuildConfig(guildId);
  return new ModalBuilder()
    .setCustomId("cfg_panel:modal:extra_ch")
    .setTitle("Edit More Channels")
    .addComponents(
      ci("quota_alerts",       "Quota Alerts",        c.quotaAlertChannelId),
      ci("staff_reg",          "Staff Registration",  c.staffRegistrationChannelId),
      ci("loa",                "LOA Approval",        c.loaChannelId),
      ci("loa_log",            "LOA Log",             c.loaLogChannelId),
      ci("ticket_transcripts", "Ticket Transcripts",  c.ticketTranscriptChannelId)
    );
}

function buildOptionalModal(db: AppDatabase, guildId: string): ModalBuilder {
  const c = db.getGuildConfig(guildId);
  const staffRoles = db.listStaffRoles(guildId);
  const getRole = (key: string) => staffRoles.find((r) => r.key === key)?.roleId ?? null;
  return new ModalBuilder()
    .setCustomId("cfg_panel:modal:optional")
    .setTitle("Edit Optional / Extra Config")
    .addComponents(
      ci("evidence_archive", "Evidence Archive",  c.evidenceArchiveChannelId),
      ci("steward_log",      "Steward Log",       c.stewardLogChannelId),
      ci("shouts",           "Shouts Channel",    c.shoutsChannelId),
      ri("seniorMod",        "Senior Mod Role",   getRole("seniorMod")),
      ri("can_register",     "Can Register Role", c.registrationRoleId)
    );
}

// ── Button handler ────────────────────────────────────────────────────────────

export async function handleSetupPanelButton(db: AppDatabase, interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("cfg_panel:")) return false;
  if (!interaction.guild) return false;

  const member = interaction.member as GuildMember;
  if (!canUseAccess(db, member, "owner")) {
    await interaction.reply({ content: "Only the server owner can use the setup panel.", ephemeral: true });
    return true;
  }

  const parts   = interaction.customId.split(":");
  const section = parts[1]; // "modal" | "toggle" | "close"
  const key     = parts[2]; // modal name or toggle key
  const guildId = interaction.guild.id;

  if (section === "close") {
    await interaction.update({ content: "Setup panel closed.", embeds: [], components: [] });
    return true;
  }

  if (section === "toggle") {
    const config = db.getGuildConfig(guildId);
    if      (key === "interactive_log") db.updateGuildConfig(guildId, { interactive_log_enabled: config.interactiveLogEnabled ? 0 : 1 });
    else if (key === "cm_approval")     db.updateGuildConfig(guildId, { approval_enabled:        config.approvalEnabled       ? 0 : 1 });
    else if (key === "points")          db.updateGuildConfig(guildId, { points_enabled:           config.pointsEnabled         ? 0 : 1 });
    else if (key === "quota")           db.updateGuildConfig(guildId, { quota_enabled:            config.quotaEnabled          ? 0 : 1 });
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "config.behavior.updated", { key, via: "setup_panel" });
    await interaction.update(buildSetupPanel(db, guildId, interaction.user.id));
    return true;
  }

  if (section === "modal") {
    let modal: ModalBuilder;
    if      (key === "roles")    modal = buildRolesModal(db, guildId);
    else if (key === "log_ch")   modal = buildLogChannelsModal(db, guildId);
    else if (key === "core_ch")  modal = buildCoreChannelsModal(db, guildId);
    else if (key === "extra_ch") modal = buildExtraChannelsModal(db, guildId);
    else if (key === "optional") modal = buildOptionalModal(db, guildId);
    else return false;
    await interaction.showModal(modal);
    return true;
  }

  return false;
}

// ── Modal submit handler ──────────────────────────────────────────────────────

export async function handleSetupPanelModal(db: AppDatabase, interaction: ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("cfg_panel:modal:")) return false;
  if (!interaction.guild) return false;

  const member = interaction.member as GuildMember;
  if (!canUseAccess(db, member, "owner")) {
    await interaction.reply({ content: "Only the server owner can use the setup panel.", ephemeral: true });
    return true;
  }

  const guildId = interaction.guild.id;
  const section = interaction.customId.split(":")[2];
  const f       = (id: string) => interaction.fields.getTextInputValue(id);

  if (section === "roles") {
    const keys = ["staff", "juniorMod", "mod", "headMod", "communityManager"] as const;
    for (const key of keys) {
      const id = parseSnowflake(f(key));
      if (id === undefined) continue;
      if (id === null) {
        db.run("DELETE FROM staff_roles WHERE guild_id = ? AND role_key = ?", guildId, key);
        continue;
      }
      const spec = staffRoleSpecs.find((s) => s.key === key);
      if (!spec) continue;
      db.run(
        `INSERT INTO staff_roles (guild_id, role_id, role_key, name, level, is_admin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, role_id) DO UPDATE SET
           role_key = excluded.role_key, name = excluded.name,
           level = excluded.level, is_admin = excluded.is_admin, updated_at = excluded.updated_at`,
        guildId, id, key, spec.name, spec.level, spec.isAdmin ? 1 : 0, nowIso(), nowIso()
      );
      db.run("DELETE FROM staff_roles WHERE guild_id = ? AND role_key = ? AND role_id <> ?", guildId, key, id);
    }
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "config.roles.updated", { via: "setup_panel" });
  }

  if (section === "log_ch") {
    for (const name of ["ban", "strike", "restore", "discord", "ticket"]) {
      const id = parseSnowflake(f(name));
      if (!id) continue;
      db.run(
        `INSERT INTO action_log_channels (guild_id, action_name, channel_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, action_name) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
        guildId, name, id, nowIso(), nowIso()
      );
    }
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "config.channels.updated", { via: "setup_panel", type: "log_channels" });
  }

  if (section === "core_ch") {
    const map: Array<[string, string]> = [
      ["alerts",      "alert_channel_id"],
      ["audit",       "audit_channel_id"],
      ["approval",    "approval_channel_id"],
      ["junior_help", "junior_help_channel_id"],
      ["quota",       "quota_channel_id"]
    ];
    const updates: Record<string, string | null> = {};
    for (const [fieldId, dbKey] of map) {
      const id = parseSnowflake(f(fieldId));
      if (id !== undefined) updates[dbKey] = id;
    }
    if (Object.keys(updates).length) db.updateGuildConfig(guildId, updates);
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "config.channels.updated", { via: "setup_panel", type: "core_channels" });
  }

  if (section === "extra_ch") {
    const map: Array<[string, string]> = [
      ["quota_alerts",       "quota_alert_channel_id"],
      ["staff_reg",          "staff_registration_channel_id"],
      ["loa",                "loa_channel_id"],
      ["loa_log",            "loa_log_channel_id"],
      ["ticket_transcripts", "ticket_transcript_channel_id"]
    ];
    const updates: Record<string, string | null> = {};
    for (const [fieldId, dbKey] of map) {
      const id = parseSnowflake(f(fieldId));
      if (id !== undefined) updates[dbKey] = id;
    }
    if (Object.keys(updates).length) db.updateGuildConfig(guildId, updates);
    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "config.channels.updated", { via: "setup_panel", type: "extra_channels" });
  }

  if (section === "optional") {
    // Channels
    const channelMap: Array<[string, string]> = [
      ["evidence_archive", "evidence_archive_channel_id"],
      ["steward_log",      "steward_log_channel_id"],
      ["shouts",           "shouts_channel_id"]
    ];
    const chUpdates: Record<string, string | null> = {};
    for (const [fieldId, dbKey] of channelMap) {
      const id = parseSnowflake(f(fieldId));
      if (id !== undefined) chUpdates[dbKey] = id;
    }
    if (Object.keys(chUpdates).length) db.updateGuildConfig(guildId, chUpdates);

    // Roles — seniorMod and canRegister
    const seniorId = parseSnowflake(f("seniorMod"));
    if (seniorId !== undefined) {
      if (seniorId === null) {
        db.run("DELETE FROM staff_roles WHERE guild_id = ? AND role_key = ?", guildId, "seniorMod");
      } else {
        const spec = staffRoleSpecs.find((s) => s.key === "seniorMod");
        if (spec) {
          db.run(
            `INSERT INTO staff_roles (guild_id, role_id, role_key, name, level, is_admin, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(guild_id, role_id) DO UPDATE SET
               role_key = excluded.role_key, name = excluded.name,
               level = excluded.level, is_admin = excluded.is_admin, updated_at = excluded.updated_at`,
            guildId, seniorId, "seniorMod", spec.name, spec.level, spec.isAdmin ? 1 : 0, nowIso(), nowIso()
          );
          db.run("DELETE FROM staff_roles WHERE guild_id = ? AND role_key = ? AND role_id <> ?", guildId, "seniorMod", seniorId);
        }
      }
    }

    const canRegisterId = parseSnowflake(f("can_register"));
    if (canRegisterId !== undefined) {
      db.updateGuildConfig(guildId, { registration_role_id: canRegisterId });
    }

    await writeAuditAndPost(db, interaction.guild, interaction.user.id, "config.optional.updated", { via: "setup_panel" });
  }

  // Refresh the original panel message
  await interaction.deferUpdate().catch(() => null);
  await interaction.editReply(buildSetupPanel(db, guildId, interaction.user.id)).catch(async () => {
    await interaction.followUp({ ...buildSetupPanel(db, guildId, interaction.user.id), ephemeral: true }).catch(() => null);
  });
  return true;
}
