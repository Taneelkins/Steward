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
          staff_registration_channel_id TEXT,
          registration_role_id TEXT,
          ticket_transcript_channel_id TEXT,
        ticket_alert_channel_id TEXT,
        owner_user_id TEXT,
        ticket_tool_bot_id TEXT,
        evidence_archive_channel_id TEXT,
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

      CREATE INDEX IF NOT EXISTS idx_cases_guild_created ON moderation_cases (guild_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cases_mod_created ON moderation_cases (guild_id, moderator_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_cases_target_created ON moderation_cases (guild_id, target_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ledger_mod ON point_ledger (guild_id, moderator_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pending_due ON pending_ticket_logs (guild_id, status, due_at);
    `);
        this.ensureColumn("guild_configs", "staff_registration_channel_id", "TEXT");
        this.ensureColumn("guild_configs", "registration_role_id", "TEXT");
        this.ensureColumn("guild_configs", "interactive_log_enabled", "INTEGER NOT NULL DEFAULT 1");
        this.ensureColumn("guild_configs", "points_enabled", "INTEGER NOT NULL DEFAULT 1");
        this.ensureColumn("guild_configs", "evidence_archive_channel_id", "TEXT");
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
        this.ensureColumn("pending_ticket_logs", "closed_channel_id", "TEXT");
        this.ensureColumn("staff_roles", "role_key", "TEXT");
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
        staffRegistrationChannelId: row.staff_registration_channel_id,
        registrationRoleId: row.registration_role_id,
        ticketTranscriptChannelId: row.ticket_transcript_channel_id,
        ticketAlertChannelId: row.ticket_alert_channel_id,
        ownerUserId: row.owner_user_id,
        ticketToolBotId: row.ticket_tool_bot_id,
        evidenceArchiveChannelId: row.evidence_archive_channel_id,
        juniorEscalationRoleIds: parseStringList(row.junior_escalation_role_ids_json),
        juniorEscalationUserIds: parseStringList(row.junior_escalation_user_ids_json),
        juniorOtherEscalationRoleIds: parseStringList(row.junior_other_escalation_role_ids_json),
        juniorOtherEscalationUserIds: parseStringList(row.junior_other_escalation_user_ids_json),
        interactiveLogEnabled: row.interactive_log_enabled !== 0,
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
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        voidedAt: row.voided_at,
        voidReason: row.void_reason
    };
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
