import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "./utils/time.js";
export class AppDatabase {
    sqlite;
    filePath;
    defaultTimezone;
    constructor(filePath, defaultTimezone) {
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
    exec(sql) {
        this.sqlite.exec(sql);
    }
    run(sql, ...params) {
        return this.sqlite.prepare(sql).run(...params);
    }
    get(sql, ...params) {
        return this.sqlite.prepare(sql).get(...params);
    }
    all(sql, ...params) {
        return this.sqlite.prepare(sql).all(...params);
    }
    transaction(fn) {
        this.exec("BEGIN IMMEDIATE;");
        try {
            const result = fn();
            this.exec("COMMIT;");
            return result;
        }
        catch (error) {
            this.exec("ROLLBACK;");
            throw error;
        }
    }
    ensureGuild(guildId) {
        const existing = this.get("SELECT guild_id FROM guild_configs WHERE guild_id = ?", guildId);
        const timestamp = nowIso();
        if (!existing) {
            this.run(`INSERT INTO guild_configs (
          guild_id, timezone, quota_required_logs, quota_grace_logs, quota_enabled,
          quota_frequency_days, quota_check_day, quota_check_hour, quota_check_minute,
          quota_warning_hours, multiplier_milli, created_at, updated_at
        ) VALUES (?, ?, 0, 0, 0, 7, 0, 21, 0, 24, 1000, ?, ?)`, guildId, this.defaultTimezone, timestamp, timestamp);
        }
        this.ensureDefaultActions(guildId);
        this.ensureDefaultStrikeThresholds(guildId);
    }
    ensureDefaultActions(guildId) {
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
            this.run(`INSERT OR IGNORE INTO action_presets (
          guild_id, name, display_name, base_points_milli, no_action_points_milli,
          default_strikes, evidence_required, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, guildId, action.name, action.display, action.points, action.noAction, action.strikes, action.evidenceRequired ? 1 : 0, timestamp, timestamp);
        }
    }
    ensureDefaultStrikeThresholds(guildId) {
        const timestamp = nowIso();
        this.run("INSERT OR IGNORE INTO strike_thresholds (guild_id, strike_count, label, created_at) VALUES (?, 3, 'Staff alert', ?)", guildId, timestamp);
        this.run("INSERT OR IGNORE INTO strike_thresholds (guild_id, strike_count, label, created_at) VALUES (?, 5, 'Urgent staff alert', ?)", guildId, timestamp);
    }
    updateCaseLogMessage(guildId, caseId, channelId, messageId) {
        this.run("UPDATE moderation_cases SET log_channel_id = ?, log_message_id = ?, updated_at = ? WHERE guild_id = ? AND id = ?", channelId, messageId, nowIso(), guildId, caseId);
    }
    schedulePersistentTimeout(values) {
        this.run("DELETE FROM persistent_timeouts WHERE guild_id = ? AND linked_guild_id = ? AND discord_target_id = ?", values.guildId, values.linkedGuildId, values.discordTargetId);
        this.run("INSERT INTO persistent_timeouts (guild_id, linked_guild_id, discord_target_id, case_id, renew_after, created_at) VALUES (?, ?, ?, ?, ?, ?)", values.guildId, values.linkedGuildId, values.discordTargetId, values.caseId ?? null, values.renewAfter, nowIso());
    }
    deletePersistentTimeout(id) {
        this.run("DELETE FROM persistent_timeouts WHERE id = ?", id);
    }
    deletePersistentTimeoutForTarget(guildId, linkedGuildId, discordTargetId) {
        this.run("DELETE FROM persistent_timeouts WHERE guild_id = ? AND linked_guild_id = ? AND discord_target_id = ?", guildId, linkedGuildId, discordTargetId);
    }
    getDuePersistentTimeouts() {
        return this.all("SELECT * FROM persistent_timeouts WHERE renew_after <= ?", nowIso());
    }
    scheduleUnban(values) {
        this.run("DELETE FROM scheduled_unbans WHERE guild_id = ? AND linked_guild_id = ? AND discord_target_id = ?", values.guildId, values.linkedGuildId, values.discordTargetId);
        this.run("INSERT INTO scheduled_unbans (guild_id, linked_guild_id, discord_target_id, case_id, unban_at, moderation_invite, case_action, case_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", values.guildId, values.linkedGuildId, values.discordTargetId, values.caseId ?? null, values.unbanAt, values.moderationInvite ?? null, values.caseAction ?? null, values.caseReason ?? null, nowIso());
    }
    deleteScheduledUnban(id) {
        this.run("DELETE FROM scheduled_unbans WHERE id = ?", id);
    }
    getDueScheduledUnbans() {
        return this.all("SELECT * FROM scheduled_unbans WHERE unban_at <= ?", nowIso());
    }
    addWarning(guildId, discordTargetId, caseId, reason, moderatorUserId) {
        this.run("INSERT INTO warnings (guild_id, discord_target_id, case_id, reason, moderator_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", guildId, discordTargetId, caseId ?? null, reason ?? null, moderatorUserId, nowIso());
    }
    countWarnings(guildId, discordTargetId) {
        return this.get("SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND discord_target_id = ?", guildId, discordTargetId)?.n ?? 0;
    }
    // ── Roblox Games ─────────────────────────────────────────────────────────
    upsertRobloxGame(guildId, universeId, apiKey, name) {
        const timestamp = nowIso();
        this.run(`INSERT INTO roblox_games (guild_id, universe_id, api_key, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, universe_id) DO UPDATE SET
         api_key = excluded.api_key,
         name = excluded.name,
         updated_at = excluded.updated_at`, guildId, universeId, apiKey, name.trim().slice(0, 80), timestamp, timestamp);
    }
    removeRobloxGame(guildId, nameOrUniverseId) {
        const result = this.run("DELETE FROM roblox_games WHERE guild_id = ? AND (LOWER(name) = LOWER(?) OR universe_id = ?)", guildId, nameOrUniverseId, nameOrUniverseId);
        return (result.changes ?? 0) > 0;
    }
    listRobloxGames(guildId) {
        return this.all("SELECT * FROM roblox_games WHERE guild_id = ? ORDER BY created_at ASC", guildId).map(mapRobloxGame);
    }
    getRobloxGame(guildId, nameOrUniverseId) {
        const row = this.get("SELECT * FROM roblox_games WHERE guild_id = ? AND (LOWER(name) = LOWER(?) OR universe_id = ?) LIMIT 1", guildId, nameOrUniverseId, nameOrUniverseId);
        return row ? mapRobloxGame(row) : undefined;
    }
    /** Returns the single configured game, or the one marked default if multiple. Returns undefined if none or ambiguous. */
    getAutoRobloxGame(guildId) {
        const games = this.listRobloxGames(guildId);
        if (games.length === 0)
            return undefined;
        if (games.length === 1)
            return games[0];
        return games.find((g) => g.isDefault);
    }
    setDefaultRobloxGame(guildId, nameOrUniverseId) {
        const game = this.getRobloxGame(guildId, nameOrUniverseId);
        if (!game)
            return false;
        this.transaction(() => {
            this.run("UPDATE roblox_games SET is_default = 0 WHERE guild_id = ?", guildId);
            this.run("UPDATE roblox_games SET is_default = 1 WHERE guild_id = ? AND id = ?", guildId, game.id);
        });
        return true;
    }
    // ── LOA Requests ───────────────────────────────────────────────────────────
    createLoaRequest(values) {
        const now = nowIso();
        const result = this.run(`INSERT INTO loa_requests (guild_id, user_id, username, reason, duration_text, expires_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, values.guildId, values.userId, values.username, values.reason, values.durationText, values.expiresAt, now, now);
        return result.lastInsertRowid;
    }
    getLoaRequest(id) {
        const row = this.get("SELECT * FROM loa_requests WHERE id = ?", id);
        return row ? mapLoaRequest(row) : undefined;
    }
    updateLoaRequest(id, values) {
        const fields = { updated_at: nowIso() };
        if (values.status !== undefined)
            fields["status"] = values.status;
        if ("approvalMessageId" in values)
            fields["approval_message_id"] = values.approvalMessageId;
        if ("approvalChannelId" in values)
            fields["approval_channel_id"] = values.approvalChannelId;
        if ("approvedBy" in values)
            fields["approved_by"] = values.approvedBy;
        const entries = Object.entries(fields);
        const assignments = entries.map(([k]) => `${k} = ?`).join(", ");
        this.run(`UPDATE loa_requests SET ${assignments} WHERE id = ?`, ...entries.map(([, v]) => v), id);
    }
    isLinkedCommunityServer(guildId) {
        return Boolean(this.get("SELECT 1 FROM guild_configs WHERE linked_guild_id = ?", guildId));
    }
    setAutoPunishDisabled(guildId, disabled) {
        this.ensureGuild(guildId);
        this.run("UPDATE guild_configs SET auto_punish_disabled_json = ?, updated_at = ? WHERE guild_id = ?", JSON.stringify(disabled), nowIso(), guildId);
    }
    getGuildConfig(guildId) {
        this.ensureGuild(guildId);
        const row = this.get("SELECT * FROM guild_configs WHERE guild_id = ?", guildId);
        if (!row)
            throw new Error("Guild config was not created.");
        return mapGuildConfig(row);
    }
    updateGuildConfig(guildId, values) {
        this.ensureGuild(guildId);
        const entries = Object.entries(values).filter(([, value]) => value !== undefined);
        if (entries.length === 0)
            return;
        const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
        const params = entries.map(([, value]) => value);
        this.run(`UPDATE guild_configs SET ${assignments}, updated_at = ? WHERE guild_id = ?`, ...params, nowIso(), guildId);
    }
    replaceStaffRoles(guildId, roles) {
        this.ensureGuild(guildId);
        const timestamp = nowIso();
        this.transaction(() => {
            this.run("DELETE FROM staff_roles WHERE guild_id = ?", guildId);
            for (const role of roles) {
                this.run(`INSERT INTO staff_roles (guild_id, role_id, role_key, name, level, is_admin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, guildId, role.roleId, role.key, role.name, role.level, role.isAdmin ? 1 : 0, timestamp, timestamp);
            }
        });
    }
    listStaffRoles(guildId) {
        this.ensureGuild(guildId);
        return this.all("SELECT * FROM staff_roles WHERE guild_id = ? ORDER BY level ASC", guildId).map(mapStaffRole);
    }
    replaceActionLogChannels(guildId, mappings) {
        this.ensureGuild(guildId);
        const timestamp = nowIso();
        this.transaction(() => {
            this.run("DELETE FROM action_log_channels WHERE guild_id = ?", guildId);
            for (const mapping of mappings) {
                this.run(`INSERT INTO action_log_channels (guild_id, action_name, channel_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`, guildId, mapping.actionName.toLowerCase(), mapping.channelId, timestamp, timestamp);
            }
        });
    }
    getActionLogChannelId(guildId, actionName) {
        this.ensureGuild(guildId);
        return this.get("SELECT channel_id FROM action_log_channels WHERE guild_id = ? AND action_name = ?", guildId, actionName.toLowerCase())?.channel_id ?? null;
    }
    registerStaffMember(guildId, userId, registeredBy) {
        this.ensureGuild(guildId);
        this.run(`INSERT INTO staff_members (guild_id, user_id, registered_by, registered_at, active)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET
         registered_by = excluded.registered_by,
         registered_at = excluded.registered_at,
         active = 1`, guildId, userId, registeredBy, nowIso());
    }
    listRegisteredStaff(guildId) {
        this.ensureGuild(guildId);
        return this.all("SELECT * FROM staff_members WHERE guild_id = ? AND active = 1 ORDER BY registered_at ASC", guildId).map(mapStaffMember);
    }
    getAction(guildId, name) {
        this.ensureGuild(guildId);
        const row = this.get("SELECT * FROM action_presets WHERE guild_id = ? AND name = ?", guildId, name.toLowerCase());
        return row ? mapAction(row) : undefined;
    }
    listActions(guildId) {
        this.ensureGuild(guildId);
        return this.all("SELECT * FROM action_presets WHERE guild_id = ? ORDER BY enabled DESC, name ASC", guildId).map(mapAction);
    }
    getCase(guildId, id) {
        const row = this.get("SELECT * FROM moderation_cases WHERE guild_id = ? AND id = ?", guildId, id);
        return row ? mapCase(row) : undefined;
    }
    searchCases(guildId, params, limit = 20) {
        const conditions = [];
        const args = [guildId];
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
        if (conditions.length === 0)
            return [];
        args.push(limit);
        return this.all(`SELECT * FROM moderation_cases WHERE guild_id = ? AND (${conditions.join(" OR ")}) ORDER BY created_at DESC LIMIT ?`, ...args).map(mapCase);
    }
    listRecentCases(guildId, limit = 10) {
        return this.all("SELECT * FROM moderation_cases WHERE guild_id = ? ORDER BY id DESC LIMIT ?", guildId, limit).map(mapCase);
    }
    getPendingTicket(guildId, id) {
        const row = this.get("SELECT * FROM pending_ticket_logs WHERE guild_id = ? AND id = ?", guildId, id);
        return row ? mapPendingTicket(row) : undefined;
    }
    insertEvidenceArchive(values) {
        this.run(`INSERT INTO evidence_archives (
        guild_id, case_id, source_message_url, archived_message_url, moderator_user_id,
        target_user_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, values.guildId, values.caseId, values.sourceMessageUrl, values.archivedMessageUrl, values.moderatorUserId, values.targetUserId ?? null, values.reason ?? null, nowIso());
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

      CREATE TABLE IF NOT EXISTS loa_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        reason TEXT NOT NULL,
        duration_text TEXT NOT NULL,
        expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        approval_message_id TEXT,
        approval_channel_id TEXT,
        approved_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
        this.ensureColumn("guild_configs", "auto_punish_disabled_json", "TEXT");
        this.ensureColumn("guild_configs", "loa_channel_id", "TEXT");
        this.ensureColumn("guild_configs", "loa_log_channel_id", "TEXT");
    }
    ensureColumn(table, column, definition) {
        const columns = this.all(`PRAGMA table_info(${table})`);
        if (columns.some((row) => row.name === column))
            return;
        this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
}
function mapGuildConfig(row) {
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
        autoPunishDisabled: parseStringList(row.auto_punish_disabled_json),
        loaChannelId: row.loa_channel_id,
        loaLogChannelId: row.loa_log_channel_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}
function mapAction(row) {
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
function mapCase(row) {
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
function mapApprovalStatus(value) {
    if (value === "pending" || value === "approved" || value === "denied")
        return value;
    return null;
}
function parseMediaLinks(value) {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map((item) => {
            if (!item || typeof item !== "object")
                return null;
            const link = item;
            const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl : null;
            if (typeof link.label !== "string" || typeof link.url !== "string")
                return null;
            const kind = link.kind === "image" || link.kind === "video" ? link.kind : "file";
            return { label: link.label, url: link.url, kind, sourceUrl };
        })
            .filter((item) => Boolean(item));
    }
    catch {
        return [];
    }
}
function parseStringList(value) {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((item) => typeof item === "string" && /^\d{15,25}$/.test(item));
    }
    catch {
        return [];
    }
}
function mapPendingTicket(row) {
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
function mapStaffRole(row) {
    return {
        key: row.role_key ?? row.name.toLowerCase().replace(/\s+/g, "-"),
        roleId: row.role_id,
        name: row.name,
        level: row.level,
        isAdmin: row.is_admin === 1
    };
}
function mapStaffMember(row) {
    return {
        userId: row.user_id,
        registeredBy: row.registered_by,
        registeredAt: row.registered_at,
        active: row.active === 1
    };
}
function mapRobloxGame(row) {
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
function mapLoaRequest(row) {
    return {
        id: row.id,
        guildId: row.guild_id,
        userId: row.user_id,
        username: row.username,
        reason: row.reason,
        durationText: row.duration_text,
        expiresAt: row.expires_at,
        status: row.status,
        approvalMessageId: row.approval_message_id,
        approvalChannelId: row.approval_channel_id,
        approvedBy: row.approved_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}
