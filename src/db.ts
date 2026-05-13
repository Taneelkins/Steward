import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActionPreset, CaseMediaLink, GuildConfig, ModerationCase, PendingTicketLog, RobloxGame } from "./types.js";
import { nowIso } from "./utils/time.js";

type DbValue = string | number | bigint | null;

export type StaffRoleConfig = {
  key: string;
  roleId: string;
  name: string;
  level: number;
  isAdmin: boolean;
};

export type StaffMember = {
  userId: string;
  registeredBy: string;
  registeredAt: string;
  active: boolean;
};

export class AppDatabase {
  readonly sqlite: DatabaseSync;
  readonly filePath: string;
  private readonly defaultTimezone: string;

  constructor(filePath: string, defaultTimezone: string) {
    this.filePath = filePath;
    this.defaultTimezone = defaultTimezone;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.sqlite = new DatabaseSync(filePath);
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close() {
    this.sqlite.close();
  }

  exec(sql: string) {
    this.sqlite.exec(sql);
  }

  run(sql: string, ...params: DbValue[]) {
    return this.sqlite.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: DbValue[]) {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: DbValue[]) {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T) {
    this.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.exec("COMMIT;");
      return result;
    } catch (error) {
      this.exec("ROLLBACK;");
      throw error;
    }
  }

  ensureGuild(guildId: string) {
    const existing = this.get<{ guild_id: string }>("SELECT guild_id FROM guild_configs WHERE guild_id = ?", guildId);
    const timestamp = nowIso();
    if (!existing) {
      this.run(
        `INSERT INTO guild_configs (
          guild_id, timezone, quota_required_logs, quota_grace_logs, quota_enabled,
          quota_frequency_days, quota_check_day, quota_check_hour, quota_check_minute,
          quota_warning_hours, multiplier_milli, created_at, updated_at
        ) VALUES (?, ?, 0, 0, 0, 7, 0, 21, 0, 24, 1000, ?, ?)`,
        guildId,
        this.defaultTimezone,
        timestamp,
        timestamp
      );
    }
    this.ensureDefaultActions(guildId);
    this.ensureDefaultStrikeThresholds(guildId);
  }

  private ensureDefaultActions(guildId: string) {
    const defaults = [
      { name: "ban", display: "Ban", points: 2000, noAction: 500, strikes: 0, evidenceRequired: true },
      { name: "strike", display: "Strike", points: 1000, noAction: 250, strikes: 1, evidenceRequired: true },
      { name: "restore", display: "Restore", points: 1000, noAction: 250, strikes: 0, evidenceRequired: true },
      { name: "discord", display: "Discord", points: 2000, noAction: 500, strikes: 0, evidenceRequired: true },
      { name: "discord-ban", display: "Discord Ban", points: 2000, noAction: 500, strikes: 0, evidenceRequired: true },
      { name: "appeal", display: "Appeal", points: 0, noAction: 0, strikes: 0, evidenceRequired: false },
      { name: "ticket", display: "Ticket", points: 1000, noAction: 250, strikes: 0, evidenceRequired: false },
      { name: "warning", display: "Warning", points: 1000, noAction: 250, strikes: 1, evidenceRequired: false },
      { name: "timeout-log", display: "Timeout Log", points: 2000, noAction: 500, strikes: 0, evidenceRequired: false },
      { name: "case-note", display: "Case Note", points: 0, noAction: 0, strikes: 0, evidenceRequired: false },
      { name: "other", display: "Other", points: 1000, noAction: 250, strikes: 0, evidenceRequired: false }
    ];
    const timestamp = nowIso();
    for (const action of defaults) {
      this.run(
        `INSERT OR IGNORE INTO action_presets (
          guild_id, name, display_name, base_points_milli, no_action_points_milli,
          default_strikes, evidence_required, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        guildId,
        action.name,
        action.display,
        action.points,
        action.noAction,
        action.strikes,
        action.evidenceRequired ? 1 : 0,
        timestamp,
        timestamp
      );
    }
  }

  private ensureDefaultStrikeThresholds(guildId: string) {
    const timestamp = nowIso();
    this.run(
      "INSERT OR IGNORE INTO strike_thresholds (guild_id, strike_count, label, created_at) VALUES (?, 3, 'Staff alert', ?)",
      guildId,
      timestamp
    );
    this.run(
      "INSERT OR IGNORE INTO strike_thresholds (guild_id, strike_count, label, created_at) VALUES (?, 5, 'Urgent staff alert', ?)",
      guildId,
      timestamp
    );
  }

  updateCaseLogMessage(guildId: string, caseId: number, channelId: string, messageId: string) {
    this.run(
      "UPDATE moderation_cases SET log_channel_id = ?, log_message_id = ?, updated_at = ? WHERE guild_id = ? AND id = ?",
      channelId,
      messageId,
      nowIso(),
      guildId,
      caseId
    );
  }

  schedulePersistentTimeout(values: { guildId: string; linkedGuildId: string; discordTargetId: string; caseId: number | null; renewAfter: string }) {
    this.run("DELETE FROM persistent_timeouts WHERE guild_id = ? AND linked_guild_id = ? AND discord_target_id = ?", values.guildId, values.linkedGuildId, values.discordTargetId);
    this.run(
      "INSERT INTO persistent_timeouts (guild_id, linked_guild_id, discord_target_id, case_id, renew_after, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      values.guildId, values.linkedGuildId, values.discordTargetId, values.caseId ?? null, values.renewAfter, nowIso()
    );
  }

  deletePersistentTimeout(id: number) {
    this.run("DELETE FROM persistent_timeouts WHERE id = ?", id);
  }

  deletePersistentTimeoutForTarget(guildId: string, linkedGuildId: string, discordTargetId: string) {
    this.run("DELETE FROM persistent_timeouts WHERE guild_id = ? AND linked_guild_id = ? AND discord_target_id = ?", guildId, linkedGuildId, discordTargetId);
  }

  getDuePersistentTimeouts() {
    return this.all<PersistentTimeoutRow>(
      "SELECT * FROM persistent_timeouts WHERE renew_after <= ?",
      nowIso()
    );
  }

  scheduleUnban(values: { guildId: string; linkedGuildId: string; discordTargetId: string; caseId: number | null; unbanAt: string; moderationInvite?: string | null; caseAction?: string | null; caseReason?: string | null }) {
    this.run("DELETE FROM scheduled_unbans WHERE guild_id = ? AND linked_guild_id = ? AND discord_target_id = ?", values.guildId, values.linkedGuildId, values.discordTargetId);
    this.run(
      "INSERT INTO scheduled_unbans (guild_id, linked_guild_id, discord_target_id, case_id, unban_at, moderation_invite, case_action, case_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      values.guildId, values.linkedGuildId, values.discordTargetId, values.caseId ?? null,
      values.unbanAt, values.moderationInvite ?? null, values.caseAction ?? null, values.caseReason ?? null, nowIso()
    );
  }

  deleteScheduledUnban(id: number) {
    this.run("DELETE FROM scheduled_unbans WHERE id = ?", id);
  }

  getDueScheduledUnbans() {
    return this.all<ScheduledUnbanRow>(
      "SELECT * FROM scheduled_unbans WHERE unban_at <= ?",
      nowIso()
    );
  }

  addWarning(guildId: string, discordTargetId: string, caseId: number | null, reason: string | null, moderatorUserId: string) {
    this.run(
      "INSERT INTO warnings (guild_id, discord_target_id, case_id, reason, moderator_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      guildId, discordTargetId, caseId ?? null, reason ?? null, moderatorUserId, nowIso()
    );
  }

  countWarnings(guildId: string, discordTargetId: string): number {
    return this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND discord_target_id = ?",
      guildId, discordTargetId
    )?.n ?? 0;
  }

  // ── Roblox Games ─────────────────────────────────────────────────────────

  upsertRobloxGame(guildId: string, universeId: string, apiKey: string, name: string) {
    const timestamp = nowIso();
    this.run(
      `INSERT INTO roblox_games (guild_id, universe_id, api_key, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, universe_id) DO UPDATE SET
         api_key = excluded.api_key,
         name = excluded.name,
         updated_at = excluded.updated_at`,
      guildId, universeId, apiKey, name.trim().slice(0, 80), timestamp, timestamp
    );
  }

  removeRobloxGame(guildId: string, nameOrUniverseId: string): boolean {
    const result = this.run(
      "DELETE FROM roblox_games WHERE guild_id = ? AND (LOWER(name) = LOWER(?) OR universe_id = ?)",
      guildId, nameOrUniverseId, nameOrUniverseId
    );
    return (result.changes ?? 0) > 0;
  }

  listRobloxGames(guildId: string): RobloxGame[] {
    return this.all<RobloxGameRow>(
      "SELECT * FROM roblox_games WHERE guild_id = ? ORDER BY created_at ASC",
      guildId
    ).map(mapRobloxGame);
  }

  getRobloxGame(guildId: string, nameOrUniverseId: string): RobloxGame | undefined {
    const row = this.get<RobloxGameRow>(
      "SELECT * FROM roblox_games WHERE guild_id = ? AND (LOWER(name) = LOWER(?) OR universe_id = ?) LIMIT 1",
      guildId, nameOrUniverseId, nameOrUniverseId
    );
    return row ? mapRobloxGame(row) : undefined;
  }

  /** Returns the single configured game, or the one marked default if multiple. Returns undefined if none or ambiguous. */
  getAutoRobloxGame(guildId: string): RobloxGame | undefined {
    const games = this.listRobloxGames(guildId);
    if (games.length === 0) return undefined;
    if (games.length === 1) return games[0];
    return games.find((g) => g.isDefault);
  }

  setDefaultRobloxGame(guildId: string, nameOrUniverseId: string): boolean {
    const game = this.getRobloxGame(guildId, nameOrUniverseId);
    if (!game) return false;
    this.transaction(() => {
      this.run("UPDATE roblox_games SET is_default = 0 WHERE guild_id = ?", guildId);
      this.run("UPDATE roblox_games SET is_default = 1 WHERE guild_id = ? AND id = ?", guildId, game.id);
    });
    return true;
  }

  isLinkedCommunityServer(guildId: string): boolean {
    return Boolean(this.get("SELECT 1 FROM guild_configs WHERE linked_guild_id = ?", guildId));
  }

  getGuildConfig(guildId: string): GuildConfig {
    this.ensureGuild(guildId);
    const row = this.get<GuildConfigRow>("SELECT * FROM guild_configs WHERE guild_id = ?", guildId);
    if (!row) throw new Error("Guild config was not created.");
    return mapGuildConfig(row);
  }

  updateGuildConfig(guildId: string, values: Partial<GuildConfigRow>) {
    this.ensureGuild(guildId);
    const entries = Object.entries(values).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const params = entries.map(([, value]) => value as DbValue);
    this.run(
      `UPDATE guild_configs SET ${assignments}, updated_at = ? WHERE guild_id = ?`,
      ...params,
      nowIso(),
      guildId
    );
  }

  replaceStaffRoles(guildId: string, roles: StaffRoleConfig[]) {
    this.ensureGuild(guildId);
    const timestamp = nowIso();
    this.transaction(() => {
      this.run("DELETE FROM staff_roles WHERE guild_id = ?", guildId);
      for (const role of roles) {
        this.run(
          `INSERT INTO staff_roles (guild_id, role_id, role_key, name, level, is_admin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          guildId,
          role.roleId,
          role.key,
          role.name,
          role.level,
          role.isAdmin ? 1 : 0,
          timestamp,
          timestamp
        );
      }
    });
  }

  listStaffRoles(guildId: string) {
    this.ensureGuild(guildId);
    return this.all<StaffRoleRow>(
      "SELECT * FROM staff_roles WHERE guild_id = ? ORDER BY level ASC",
      guildId
    ).map(mapStaffRole);
  }

  replaceActionLogChannels(guildId: string, mappings: Array<{ actionName: string; channelId: string }>) {
    this.ensureGuild(guildId);
    const timestamp = nowIso();
    this.transaction(() => {
      this.run("DELETE FROM action_log_channels WHERE guild_id = ?", guildId);
      for (const mapping of mappings) {
        this.run(
          `INSERT INTO action_log_channels (guild_id, action_name, channel_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          guildId,
          mapping.actionName.toLowerCase(),
          mapping.channelId,
          timestamp,
          timestamp
        );
      }
    });
  }

  getActionLogChannelId(guildId: string, actionName: string) {
    this.ensureGuild(guildId);
    return this.get<{ channel_id: string }>(
      "SELECT channel_id FROM action_log_channels WHERE guild_id = ? AND action_name = ?",
      guildId,
      actionName.toLowerCase()
    )?.channel_id ?? null;
  }

  registerStaffMember(guildId: string, userId: string, registeredBy: string) {
    this.ensureGuild(guildId);
    this.run(
      `INSERT INTO staff_members (guild_id, user_id, registered_by, registered_at, active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET
         registered_by = excluded.registered_by,
         registered_at = excluded.registered_at,
         active = 1`,
      guildId,
      userId,
      registeredBy,
      nowIso()
    );
  }

  listRegisteredStaff(guildId: string) {
    this.ensureGuild(guildId);
    return this.all<StaffMemberRow>(
      "SELECT * FROM staff_members WHERE guild_id = ? AND active = 1 ORDER BY registered_at ASC",
      guildId
    ).map(mapStaffMember);
  }

  getAction(guildId: string, name: string): ActionPreset | undefined {
    this.ensureGuild(guildId);
    const row = this.get<ActionPresetRow>(
      "SELECT * FROM action_presets WHERE guild_id = ? AND name = ?",
      guildId,
      name.toLowerCase()
    );
    return row ? mapAction(row) : undefined;
  }

  listActions(guildId: string) {
    this.ensureGuild(guildId);
    return this.all<ActionPresetRow>(
      "SELECT * FROM action_presets WHERE guild_id = ? ORDER BY enabled DESC, name ASC",
      guildId
    ).map(mapAction);
  }

  getCase(guildId: string, id: number): ModerationCase | undefined {
    const row = this.get<CaseRow>("SELECT * FROM moderation_cases WHERE guild_id = ? AND id = ?", guildId, id);
    return row ? mapCase(row) : undefined;
  }

  searchCases(guildId: string, params: { robloxUser?: string; discordUser?: string; robloxId?: string; discordId?: string }, limit = 20) {
    const conditions: string[] = [];
    const args: (string | number)[] = [guildId];
    if (params.robloxUser) {
      conditions.push("LOWER(roblox_username) LIKE LOWER(?)");
      args.push(`%${params.robloxUser}%`);
    }
    if (params.discordUser) {
      conditions.push("LOWER(discord_username) LIKE LOWER(?)");
      args.push(`%${params.discordUser}%`);
    }
    if (params.robloxId) {
      conditions.push("roblox_id = ?");
      args.push(params.robloxId);
    }
    if (params.discordId) {
      conditions.push("(discord_id = ? OR target_user_id = ?)");
      args.push(params.discordId, `discord:${params.discordId}`);
    }
    if (conditions.length === 0) return [];
    args.push(limit);
    return this.all<CaseRow>(
      `SELECT * FROM moderation_cases WHERE guild_id = ? AND (${conditions.join(" OR ")}) ORDER BY created_at DESC LIMIT ?`,
      ...args
    ).map(mapCase);
  }

  listRecentCases(guildId: string, limit = 10) {
    return this.all<CaseRow>(
      "SELECT * FROM moderation_cases WHERE guild_id = ? ORDER BY id DESC LIMIT ?",
      guildId,
      limit
    ).map(mapCase);
  }

  getPendingTicket(guildId: string, id: number) {
    const row = this.get<PendingTicketRow>("SELECT * FROM pending_ticket_logs WHERE guild_id = ? AND id = ?", guildId, id);
    return row ? mapPendingTicket(row) : undefined;
  }

  insertEvidenceArchive(values: {
    guildId: string;
    caseId: number | null;
    sourceMessageUrl: string;
    archivedMessageUrl: string;
    moderatorUserId: string;
    targetUserId?: string | null;
    reason?: string | null;
  }) {
    this.run(
      `INSERT INTO evidence_archives (
        guild_id, case_id, source_message_url, archived_message_url, moderator_user_id,
        target_user_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      values.guildId,
      values.caseId,
      values.sourceMessageUrl,
      values.archivedMessageUrl,
      values.moderatorUserId,
      values.targetUserId ?? null,
      values.reason ?? null,
      nowIso()
    );
  }

  migrate() {
    this.exec(`
      CREATE TABLE IF NOT EXISTS guild_configs (
        guild_id TEXT PRIMARY KEY,
        mod_role_id TEXT,
        admin_role_id TEXT,
        action_log_channel_id TEXT,
        strike_log_channel_id TEXT,
        alert_channel_id TEXT,
          audit_channel_id TEXT,
          quota_channel_id TEXT,
          quota_alert_channel_id TEXT,
          staff_registration_channel_id TEXT,
          registration_role_id TEXT,
          ticket_transcript_channel_id TEXT,
        linked_guild_id TEXT,
        moderation_invite TEXT,
        owner_user_id TEXT,
        ticket_tool_bot_id TEXT,
        evidence_archive_channel_id TEXT,
        appeal_log_channel_id TEXT,
        approval_channel_id TEXT,
        junior_escalation_role_ids_json TEXT,
        junior_escalation_user_ids_json TEXT,
        junior_other_escalation_role_ids_json TEXT,
        junior_other_escalation_user_ids_json TEXT,
        points_enabled INTEGER NOT NULL DEFAULT 1,
        timezone TEXT NOT NULL,
        quota_required_logs INTEGER NOT NULL DEFAULT 0,
        quota_grace_logs INTEGER NOT NULL DEFAULT 0,
        quota_enabled INTEGER NOT NULL DEFAULT 0,
        quota_frequency_days INTEGER NOT NULL DEFAULT 7,
        quota_check_day INTEGER NOT NULL DEFAULT 0,
        quota_check_hour INTEGER NOT NULL DEFAULT 21,
        quota_check_minute INTEGER NOT NULL DEFAULT 0,
        quota_period_start TEXT,
        quota_period_end TEXT,
        quota_status_message_id TEXT,
        quota_warning_hours INTEGER NOT NULL DEFAULT 24,
        quota_warning_sent_at TEXT,
        multiplier_milli INTEGER NOT NULL DEFAULT 1000,
        multiplier_ends_at TEXT,
        last_transcript_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS action_presets (
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        base_points_milli INTEGER NOT NULL,
        no_action_points_milli INTEGER NOT NULL DEFAULT 0,
        override_base_points_milli INTEGER,
        override_no_action_points_milli INTEGER,
        override_ends_at TEXT,
        override_reason TEXT,
        override_created_by TEXT,
        default_strikes INTEGER NOT NULL DEFAULT 0,
        evidence_required INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, name)
      );

      CREATE TABLE IF NOT EXISTS moderation_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        target_username TEXT NOT NULL,
        roblox_username TEXT,
        discord_username TEXT,
        roblox_id TEXT,
        discord_id TEXT,
        moderator_user_id TEXT NOT NULL,
        moderator_username TEXT NOT NULL,
        action_name TEXT NOT NULL,
        action_display_name TEXT,
        reason TEXT NOT NULL,
        evidence TEXT,
        notes TEXT,
        base_points_milli INTEGER NOT NULL,
        multiplier_milli INTEGER NOT NULL,
        awarded_points_milli INTEGER NOT NULL,
        strikes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        flags TEXT NOT NULL DEFAULT '',
        is_late INTEGER NOT NULL DEFAULT 0,
        is_no_action INTEGER NOT NULL DEFAULT 0,
        ticket_id TEXT,
        transcript_url TEXT,
        media_links_json TEXT,
        appeal_type TEXT,
        appeal_result TEXT,
        punishment_length TEXT,
        approval_status TEXT,
        approval_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        voided_at TEXT,
        void_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS point_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        moderator_user_id TEXT NOT NULL,
        case_id INTEGER,
        amount_milli INTEGER NOT NULL,
        reason TEXT NOT NULL,
        type TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strikes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        case_id INTEGER,
        amount INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strike_thresholds (
        guild_id TEXT NOT NULL,
        strike_count INTEGER NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, strike_count)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quota_exemptions (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        expires_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS role_quotas (
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        required_logs INTEGER NOT NULL,
        grace_logs INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );

      CREATE TABLE IF NOT EXISTS quota_roster_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role_id TEXT,
        required_logs INTEGER NOT NULL,
        grace_logs INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quota_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        status_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_ticket_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        transcript_message_id TEXT NOT NULL,
        transcript_channel_id TEXT NOT NULL,
        ticket_id TEXT,
        ticket_type TEXT NOT NULL,
        opener_user_id TEXT,
        closed_channel_id TEXT,
        closed_channel_name TEXT,
        transcript_url TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        logged_case_id INTEGER,
        admin_notes TEXT,
        UNIQUE (guild_id, transcript_message_id)
      );

      CREATE TABLE IF NOT EXISTS ticket_action_mappings (
        guild_id TEXT NOT NULL,
        ticket_type TEXT NOT NULL,
        action_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, ticket_type)
      );

      CREATE TABLE IF NOT EXISTS staff_roles (
        guild_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        role_key TEXT,
        name TEXT NOT NULL,
        level INTEGER NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );

      CREATE TABLE IF NOT EXISTS staff_members (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        registered_by TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS action_log_channels (
        guild_id TEXT NOT NULL,
        action_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, action_name)
      );

      CREATE TABLE IF NOT EXISTS evidence_archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        case_id INTEGER,
        source_message_url TEXT NOT NULL,
        archived_message_url TEXT NOT NULL,
        moderator_user_id TEXT NOT NULL,
        target_user_id TEXT,
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS persistent_timeouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        linked_guild_id TEXT NOT NULL,
        discord_target_id TEXT NOT NULL,
        case_id INTEGER,
        renew_after TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_unbans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        linked_guild_id TEXT NOT NULL,
        discord_target_id TEXT NOT NULL,
        case_id INTEGER,
        unban_at TEXT NOT NULL,
        moderation_invite TEXT,
        case_action TEXT,
        case_reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        discord_target_id TEXT NOT NULL,
        case_id INTEGER,
        reason TEXT,
        moderator_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cases_guild_created ON moderation_cases (guild_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cases_mod_created ON moderation_cases (guild_id, moderator_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cases_target_created ON moderation_cases (guild_id, target_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ledger_mod ON point_ledger (guild_id, moderator_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pending_due ON pending_ticket_logs (guild_id, status, due_at);
      CREATE INDEX IF NOT EXISTS idx_warnings_target ON warnings (guild_id, discord_target_id);

      CREATE TABLE IF NOT EXISTS roblox_games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        universe_id TEXT NOT NULL,
        api_key TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Game',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(guild_id, universe_id)
      );

      CREATE INDEX IF NOT EXISTS idx_roblox_games_guild ON roblox_games (guild_id);
    `);

    this.ensureColumn("guild_configs", "staff_registration_channel_id", "TEXT");
    this.ensureColumn("guild_configs", "registration_role_id", "TEXT");
    this.ensureColumn("guild_configs", "interactive_log_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("guild_configs", "approval_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("guild_configs", "points_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("guild_configs", "evidence_archive_channel_id", "TEXT");
    this.ensureColumn("guild_configs", "appeal_log_channel_id", "TEXT");
    this.ensureColumn("guild_configs", "approval_channel_id", "TEXT");
    this.ensureColumn("guild_configs", "quota_alert_channel_id", "TEXT");
    this.ensureColumn("guild_configs", "junior_escalation_role_ids_json", "TEXT");
    this.ensureColumn("guild_configs", "junior_escalation_user_ids_json", "TEXT");
    this.ensureColumn("guild_configs", "junior_other_escalation_role_ids_json", "TEXT");
    this.ensureColumn("guild_configs", "junior_other_escalation_user_ids_json", "TEXT");
    this.ensureColumn("action_presets", "override_base_points_milli", "INTEGER");
    this.ensureColumn("action_presets", "override_no_action_points_milli", "INTEGER");
    this.ensureColumn("action_presets", "override_ends_at", "TEXT");
    this.ensureColumn("action_presets", "override_reason", "TEXT");
    this.ensureColumn("action_presets", "override_created_by", "TEXT");
    this.ensureColumn("moderation_cases", "roblox_username", "TEXT");
    this.ensureColumn("moderation_cases", "discord_username", "TEXT");
    this.ensureColumn("moderation_cases", "roblox_id", "TEXT");
    this.ensureColumn("moderation_cases", "discord_id", "TEXT");
    this.ensureColumn("moderation_cases", "action_display_name", "TEXT");
    this.ensureColumn("moderation_cases", "media_links_json", "TEXT");
    this.ensureColumn("moderation_cases", "appeal_type", "TEXT");
    this.ensureColumn("moderation_cases", "appeal_result", "TEXT");
    this.ensureColumn("moderation_cases", "punishment_length", "TEXT");
    this.ensureColumn("moderation_cases", "approval_status", "TEXT");
    this.ensureColumn("moderation_cases", "approval_message_id", "TEXT");
    this.ensureColumn("moderation_cases", "junior_review_status", "TEXT");
    this.ensureColumn("moderation_cases", "junior_review_message_id", "TEXT");
    this.ensureColumn("guild_configs", "junior_help_channel_id", "TEXT");
    this.ensureColumn("guild_configs", "linked_guild_id", "TEXT");
    this.ensureColumn("guild_configs", "moderation_invite", "TEXT");
    this.ensureColumn("guild_configs", "steward_log_channel_id", "TEXT");
    this.ensureColumn("pending_ticket_logs", "closed_channel_id", "TEXT");
    this.ensureColumn("pending_ticket_logs", "closed_channel_name", "TEXT");
    this.ensureColumn("staff_roles", "role_key", "TEXT");
    this.ensureColumn("moderation_cases", "log_message_id", "TEXT");
    this.ensureColumn("moderation_cases", "log_channel_id", "TEXT");
    this.ensureColumn("roblox_games", "is_default", "INTEGER NOT NULL DEFAULT 0");
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (columns.some((row) => row.name === column)) return;
    this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

type GuildConfigRow = {
  guild_id: string;
  mod_role_id: string | null;
  admin_role_id: string | null;
  action_log_channel_id: string | null;
  strike_log_channel_id: string | null;
  alert_channel_id: string | null;
  audit_channel_id: string | null;
  quota_channel_id: string | null;
  quota_alert_channel_id: string | null;
  staff_registration_channel_id: string | null;
  registration_role_id: string | null;
  ticket_transcript_channel_id: string | null;
  linked_guild_id: string | null;
  moderation_invite: string | null;
  owner_user_id: string | null;
  ticket_tool_bot_id: string | null;
  evidence_archive_channel_id: string | null;
  appeal_log_channel_id: string | null;
  approval_channel_id: string | null;
  junior_help_channel_id: string | null;
  steward_log_channel_id: string | null;
  junior_escalation_role_ids_json: string | null;
  junior_escalation_user_ids_json: string | null;
  junior_other_escalation_role_ids_json: string | null;
  junior_other_escalation_user_ids_json: string | null;
  interactive_log_enabled: number;
  approval_enabled: number;
  points_enabled: number;
  timezone: string;
  quota_required_logs: number;
  quota_grace_logs: number;
  quota_enabled: number;
  quota_frequency_days: number;
  quota_check_day: number;
  quota_check_hour: number;
  quota_check_minute: number;
  quota_period_start: string | null;
  quota_period_end: string | null;
  quota_status_message_id: string | null;
  quota_warning_hours: number;
  quota_warning_sent_at: string | null;
  multiplier_milli: number;
  multiplier_ends_at: string | null;
  last_transcript_message_id: string | null;
  created_at: string;
  updated_at: string;
};

type ActionPresetRow = {
  guild_id: string;
  name: string;
  display_name: string;
  base_points_milli: number;
  no_action_points_milli: number;
  override_base_points_milli: number | null;
  override_no_action_points_milli: number | null;
  override_ends_at: string | null;
  override_reason: string | null;
  override_created_by: string | null;
  default_strikes: number;
  evidence_required: number;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type CaseRow = {
  id: number;
  guild_id: string;
  target_user_id: string;
  target_username: string;
  roblox_username: string | null;
  discord_username: string | null;
  roblox_id: string | null;
  discord_id: string | null;
  moderator_user_id: string;
  moderator_username: string;
  action_name: string;
  action_display_name: string | null;
  reason: string;
  evidence: string | null;
  notes: string | null;
  base_points_milli: number;
  multiplier_milli: number;
  awarded_points_milli: number;
  strikes: number;
  status: "active" | "void";
  flags: string;
  is_late: number;
  is_no_action: number;
  ticket_id: string | null;
  transcript_url: string | null;
  media_links_json: string | null;
  appeal_type: string | null;
  appeal_result: "accepted" | "denied" | null;
  punishment_length: string | null;
  approval_status: string | null;
  approval_message_id: string | null;
  junior_review_status: string | null;
  junior_review_message_id: string | null;
  log_message_id: string | null;
  log_channel_id: string | null;
  created_at: string;
  updated_at: string;
  voided_at: string | null;
  void_reason: string | null;
};

export type PersistentTimeoutRow = {
  id: number;
  guild_id: string;
  linked_guild_id: string;
  discord_target_id: string;
  case_id: number | null;
  renew_after: string;
  created_at: string;
};

export type ScheduledUnbanRow = {
  id: number;
  guild_id: string;
  linked_guild_id: string;
  discord_target_id: string;
  case_id: number | null;
  unban_at: string;
  moderation_invite: string | null;
  case_action: string | null;
  case_reason: string | null;
  created_at: string;
};

type PendingTicketRow = {
  id: number;
  guild_id: string;
  transcript_message_id: string;
  transcript_channel_id: string;
  ticket_id: string | null;
  ticket_type: string;
  opener_user_id: string | null;
  closed_channel_id: string | null;
  closed_channel_name: string | null;
  transcript_url: string | null;
  status: "pending" | "logged" | "dismissed" | "needs_review" | "overdue";
  created_at: string;
  due_at: string;
  logged_case_id: number | null;
  admin_notes: string | null;
};

type StaffRoleRow = {
  guild_id: string;
  role_id: string;
  role_key: string | null;
  name: string;
  level: number;
  is_admin: number;
  created_at: string;
  updated_at: string;
};

type StaffMemberRow = {
  guild_id: string;
  user_id: string;
  registered_by: string;
  registered_at: string;
  active: number;
};

function mapGuildConfig(row: GuildConfigRow): GuildConfig {
  return {
    guildId: row.guild_id,
    modRoleId: row.mod_role_id,
    adminRoleId: row.admin_role_id,
    actionLogChannelId: row.action_log_channel_id,
    strikeLogChannelId: row.strike_log_channel_id,
    alertChannelId: row.alert_channel_id,
    auditChannelId: row.audit_channel_id,
    quotaChannelId: row.quota_channel_id,
    quotaAlertChannelId: row.quota_alert_channel_id,
    staffRegistrationChannelId: row.staff_registration_channel_id,
    registrationRoleId: row.registration_role_id,
    ticketTranscriptChannelId: row.ticket_transcript_channel_id,
    linkedGuildId: row.linked_guild_id,
    moderationInvite: row.moderation_invite,
    ownerUserId: row.owner_user_id,
    ticketToolBotId: row.ticket_tool_bot_id,
    evidenceArchiveChannelId: row.evidence_archive_channel_id,
    appealLogChannelId: row.appeal_log_channel_id,
    approvalChannelId: row.approval_channel_id,
    juniorHelpChannelId: row.junior_help_channel_id,
    stewardLogChannelId: row.steward_log_channel_id,
    juniorEscalationRoleIds: parseStringList(row.junior_escalation_role_ids_json),
    juniorEscalationUserIds: parseStringList(row.junior_escalation_user_ids_json),
    juniorOtherEscalationRoleIds: parseStringList(row.junior_other_escalation_role_ids_json),
    juniorOtherEscalationUserIds: parseStringList(row.junior_other_escalation_user_ids_json),
    interactiveLogEnabled: row.interactive_log_enabled !== 0,
    approvalEnabled: row.approval_enabled !== 0,
    pointsEnabled: row.points_enabled !== 0,
    timezone: row.timezone,
    quotaRequiredLogs: row.quota_required_logs,
    quotaGraceLogs: row.quota_grace_logs,
    quotaEnabled: row.quota_enabled === 1,
    quotaFrequencyDays: row.quota_frequency_days,
    quotaCheckDay: row.quota_check_day,
    quotaCheckHour: row.quota_check_hour,
    quotaCheckMinute: row.quota_check_minute,
    quotaPeriodStart: row.quota_period_start,
    quotaPeriodEnd: row.quota_period_end,
    quotaStatusMessageId: row.quota_status_message_id,
    quotaWarningHours: row.quota_warning_hours,
    quotaWarningSentAt: row.quota_warning_sent_at,
    multiplierMilli: row.multiplier_milli,
    multiplierEndsAt: row.multiplier_ends_at,
    lastTranscriptMessageId: row.last_transcript_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAction(row: ActionPresetRow): ActionPreset {
  return {
    guildId: row.guild_id,
    name: row.name,
    displayName: row.display_name,
    basePointsMilli: row.base_points_milli,
    noActionPointsMilli: row.no_action_points_milli,
    overrideBasePointsMilli: row.override_base_points_milli,
    overrideNoActionPointsMilli: row.override_no_action_points_milli,
    overrideEndsAt: row.override_ends_at,
    overrideReason: row.override_reason,
    overrideCreatedBy: row.override_created_by,
    defaultStrikes: row.default_strikes,
    evidenceRequired: row.evidence_required === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCase(row: CaseRow): ModerationCase {
  return {
    id: row.id,
    guildId: row.guild_id,
    targetUserId: row.target_user_id,
    targetUsername: row.target_username,
    robloxUsername: row.roblox_username,
    discordUsername: row.discord_username,
    robloxId: row.roblox_id,
    discordId: row.discord_id,
    moderatorUserId: row.moderator_user_id,
    moderatorUsername: row.moderator_username,
    actionName: row.action_name,
    actionDisplayName: row.action_display_name,
    reason: row.reason,
    evidence: row.evidence,
    notes: row.notes,
    basePointsMilli: row.base_points_milli,
    multiplierMilli: row.multiplier_milli,
    awardedPointsMilli: row.awarded_points_milli,
    strikes: row.strikes,
    status: row.status,
    flags: row.flags,
    isLate: row.is_late === 1,
    isNoAction: row.is_no_action === 1,
    ticketId: row.ticket_id,
    transcriptUrl: row.transcript_url,
    mediaLinks: parseMediaLinks(row.media_links_json),
    appealType: row.appeal_type,
    appealResult: row.appeal_result === "accepted" || row.appeal_result === "denied" ? row.appeal_result : null,
    punishmentLength: row.punishment_length,
    approvalStatus: mapApprovalStatus(row.approval_status),
    approvalMessageId: row.approval_message_id,
    juniorReviewStatus: mapApprovalStatus(row.junior_review_status),
    juniorReviewMessageId: row.junior_review_message_id ?? null,
    logMessageId: row.log_message_id ?? null,
    logChannelId: row.log_channel_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason
  };
}

function mapApprovalStatus(value: string | null): "pending" | "approved" | "denied" | null {
  if (value === "pending" || value === "approved" || value === "denied") return value;
  return null;
}

function parseMediaLinks(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): CaseMediaLink | null => {
        if (!item || typeof item !== "object") return null;
        const link = item as { label?: unknown; url?: unknown; kind?: unknown };
        const sourceUrl = typeof (item as { sourceUrl?: unknown }).sourceUrl === "string" ? (item as { sourceUrl: string }).sourceUrl : null;
        if (typeof link.label !== "string" || typeof link.url !== "string") return null;
        const kind: CaseMediaLink["kind"] = link.kind === "image" || link.kind === "video" ? link.kind : "file";
        return { label: link.label, url: link.url, kind, sourceUrl };
      })
      .filter((item): item is CaseMediaLink => Boolean(item));
  } catch {
    return [];
  }
}

function parseStringList(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && /^\d{15,25}$/.test(item));
  } catch {
    return [];
  }
}

function mapPendingTicket(row: PendingTicketRow): PendingTicketLog {
  return {
    id: row.id,
    guildId: row.guild_id,
    transcriptMessageId: row.transcript_message_id,
    transcriptChannelId: row.transcript_channel_id,
    ticketId: row.ticket_id,
    ticketType: row.ticket_type,
    openerUserId: row.opener_user_id,
    closedChannelId: row.closed_channel_id,
    closedChannelName: row.closed_channel_name,
    transcriptUrl: row.transcript_url,
    status: row.status,
    createdAt: row.created_at,
    dueAt: row.due_at,
    loggedCaseId: row.logged_case_id,
    adminNotes: row.admin_notes
  };
}

function mapStaffRole(row: StaffRoleRow): StaffRoleConfig {
  return {
    key: row.role_key ?? row.name.toLowerCase().replace(/\s+/g, "-"),
    roleId: row.role_id,
    name: row.name,
    level: row.level,
    isAdmin: row.is_admin === 1
  };
}

function mapStaffMember(row: StaffMemberRow): StaffMember {
  return {
    userId: row.user_id,
    registeredBy: row.registered_by,
    registeredAt: row.registered_at,
    active: row.active === 1
  };
}

type RobloxGameRow = {
  id: number;
  guild_id: string;
  universe_id: string;
  api_key: string;
  name: string;
  is_default: number;
  created_at: string;
  updated_at: string;
};

function mapRobloxGame(row: RobloxGameRow): RobloxGame {
  return {
    id: row.id,
    guildId: row.guild_id,
    universeId: row.universe_id,
    apiKey: row.api_key,
    name: row.name,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
