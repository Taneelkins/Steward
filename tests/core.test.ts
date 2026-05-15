import fs from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildCommands } from "../src/commands/definitions.js";
import { AppDatabase } from "../src/db.js";
import { activeMultiplier, buildCaseLogEmbed, calculateAwardedPoints, effectiveActionPoints } from "../src/services/cases.js";
import { tierAllows } from "../src/services/access.js";
import { buildQuotaReport } from "../src/services/quota.js";
import { parseTicketToolMessage } from "../src/services/tickets.js";
import { pointsToMilli } from "../src/utils/format.js";
import { caseLinkComponents, transcriptLinkComponents } from "../src/utils/discord.js";
import { computeNextQuotaEnd, parseTime, parseWeekday } from "../src/utils/time.js";

const tempDirs: string[] = [];

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mod-ledger-test-"));
  tempDirs.push(dir);
  return new AppDatabase(path.join(dir, "test.sqlite"), "America/New_York");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("points and multiplier math", () => {
  it("stores point amounts as milli-points and applies decimal multipliers", () => {
    assert.equal(pointsToMilli(1.5), 1500);
    assert.equal(calculateAwardedPoints(2000, 1500), 3000);
  });

  it("ignores expired multipliers", () => {
    const weekday = new Date("2026-05-08T12:00:00.000Z");
    assert.equal(activeMultiplier({ multiplierMilli: 2000, multiplierEndsAt: "2000-01-01T00:00:00.000Z" }, weekday), 1000);
    assert.equal(activeMultiplier({ multiplierMilli: 1500, multiplierEndsAt: null }, weekday), 1500);
  });

  it("applies the automatic weekend multiplier", () => {
    const saturday = new Date("2026-05-09T16:00:00.000Z");
    assert.equal(activeMultiplier({ multiplierMilli: 1000, multiplierEndsAt: null, timezone: "America/New_York" }, saturday), 1500);
  });

  it("uses temporary action point overrides while active", () => {
    const action = {
      guildId: "guild-1",
      name: "ban",
      displayName: "Ban",
      basePointsMilli: 2000,
      noActionPointsMilli: 500,
      overrideBasePointsMilli: 5000,
      overrideNoActionPointsMilli: null,
      overrideEndsAt: "2026-05-09T00:00:00.000Z",
      overrideReason: "event",
      overrideCreatedBy: "admin",
      defaultStrikes: 0,
      evidenceRequired: true,
      enabled: true,
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z"
    };

    assert.equal(effectiveActionPoints(action, new Date("2026-05-08T12:00:00.000Z")).basePointsMilli, 5000);
    assert.equal(effectiveActionPoints(action, new Date("2026-05-10T12:00:00.000Z")).basePointsMilli, 2000);
  });
});

describe("command access tiers", () => {
  it("keeps public, registration, and staff tiers distinct", () => {
    assert.equal(tierAllows(null, "public"), true);
    assert.equal(tierAllows(null, "junior"), false);
    assert.equal(tierAllows("junior", "junior"), true);
    assert.equal(tierAllows("junior", "normal"), false);
    assert.equal(tierAllows("normal", "normal"), true);
    assert.equal(tierAllows("normal", "junior"), false);
    assert.equal(tierAllows("head", "junior"), true);
    assert.equal(tierAllows("head", "head"), true);
    assert.equal(tierAllows("head", "community"), false);
    assert.equal(tierAllows("community", "community"), true);
    assert.equal(tierAllows("community", "head"), false);
    assert.equal(tierAllows("community", "owner"), false);
  });
});

describe("point system command deployment", () => {
  it("removes point-specific commands and action fields when disabled", () => {
    const commands = buildCommands({ pointsEnabled: false }) as Array<{ name: string; options?: Array<{ name: string; options?: Array<{ name: string }> }> }>;
    assert.equal(commands.some((command) => command.name === "points"), false);
    assert.equal(commands.some((command) => command.name === "multiplier"), false);
    assert.equal(commands.some((command) => command.name === "modshop"), true);
    const action = commands.find((command) => command.name === "action");
    const upsert = action?.options?.find((option) => option.name === "upsert");
    assert.equal(upsert?.options?.some((option) => option.name === "points"), false);
  });

  it("exposes config options for per-action log channels and staff roles", () => {
    const commands = buildCommands() as Array<{ name: string; options?: Array<{ name: string; options?: Array<{ name: string }> }> }>;
    const config = commands.find((command) => command.name === "config");
    const channels = config?.options?.find((option) => option.name === "channels");
    const roles = config?.options?.find((option) => option.name === "roles");
    for (const option of ["logban", "logstrike", "logrestore", "logdiscord", "logticket", "staff_registration"]) {
      assert.equal(channels?.options?.some((entry) => entry.name === option), true);
    }
    for (const option of ["staff_role", "can_register_role", "community_manager_role", "head_mod_role", "senior_mod_role", "normal_mod_role", "junior_mod_role"]) {
      assert.equal(roles?.options?.some((entry) => entry.name === option), true);
    }
  });
});

describe("database defaults", () => {
  it("creates guild defaults and action presets", () => {
    const db = makeDb();
    db.ensureGuild("guild-1");
    const actions = db.listActions("guild-1");
    assert.ok(actions.map((action) => action.name).includes("warning"));
    assert.equal(db.getGuildConfig("guild-1").quotaRequiredLogs, 0);
    assert.equal(db.getGuildConfig("guild-1").pointsEnabled, true);
    db.close();
  });

  it("claims each evidence archive source attachment only once", () => {
    const db = makeDb();
    db.ensureGuild("guild-1");
    const values = {
      guildId: "guild-1",
      sourceAttachmentKey: "attachment:guild-1:message-1:attachment-1",
      sourceMessageUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
      moderatorUserId: "mod-1"
    };

    assert.equal(db.claimEvidenceArchive(values), true);
    assert.equal(db.claimEvidenceArchive(values), false);

    db.completeEvidenceArchive(values.guildId, values.sourceAttachmentKey, "https://discord.com/channels/guild-1/archive/message-2");
    assert.equal(
      db.getEvidenceArchiveBySourceKey(values.guildId, values.sourceAttachmentKey)?.archivedMessageUrl,
      "https://discord.com/channels/guild-1/archive/message-2"
    );
    db.close();
  });
});

describe("case embeds", () => {
  it("shows flexible target fields and hides long transcript URLs behind a button", () => {
    const embed = buildCaseLogEmbed({
      id: 1,
      guildId: "guild-1",
      targetUserId: "roblox:12345",
      targetUsername: "RobloxUser Builderman | RobloxID 12345",
      robloxUsername: "Builderman",
      discordUsername: null,
      robloxId: "12345",
      discordId: "222222222222222222",
      moderatorUserId: "mod-1",
      moderatorUsername: "mod#0000",
      actionName: "ban",
      actionDisplayName: "Ban",
      reason: "rule break",
      evidence: "clip",
      notes: null,
      basePointsMilli: 1000,
      multiplierMilli: 1000,
      awardedPointsMilli: 1000,
      strikes: 0,
      status: "active",
      flags: "",
      isLate: false,
      isNoAction: false,
      ticketId: null,
      transcriptUrl: "https://example.com/transcript",
      mediaLinks: [{ label: "Image 1", url: "https://discord.com/channels/guild/channel/message", kind: "image" }],
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z",
      voidedAt: null,
      voidReason: null
    });
    const data = embed.toJSON();
    const fields = JSON.stringify(data.fields);
    assert.match(fields, /RobloxUser: Builderman/);
    assert.ok(fields.includes("Open with the Transcript button below."));
    assert.ok(fields.includes("Media: Image 1"));
    assert.ok(!fields.includes("https://example.com/transcript"));
    assert.ok(JSON.stringify(transcriptLinkComponents("https://example.com/transcript")).includes("\"label\":\"Transcript\""));
    assert.ok(JSON.stringify(caseLinkComponents("https://example.com/transcript", [{ label: "Image 1", url: "https://discord.com/channels/guild/channel/message" }])).includes("\"label\":\"Image 1\""));
  });

  it("can hide point fields from case embeds", () => {
    const embed = buildCaseLogEmbed({
      id: 2,
      guildId: "guild-1",
      targetUserId: "discord:222222222222222222",
      targetUsername: "DiscordID 222222222222222222",
      robloxUsername: null,
      discordUsername: null,
      robloxId: null,
      discordId: "222222222222222222",
      moderatorUserId: "mod-1",
      moderatorUsername: "mod#0000",
      actionName: "discord",
      actionDisplayName: "timeout",
      reason: "rule break",
      evidence: "clip",
      notes: null,
      basePointsMilli: 1000,
      multiplierMilli: 1000,
      awardedPointsMilli: 1000,
      strikes: 0,
      status: "active",
      flags: "",
      isLate: false,
      isNoAction: false,
      ticketId: null,
      transcriptUrl: null,
      mediaLinks: [],
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z",
      voidedAt: null,
      voidReason: null
    }, { showPoints: false });

    assert.ok(!JSON.stringify(embed.toJSON().fields).includes("Points"));
    assert.ok(!JSON.stringify(embed.toJSON().fields).includes("Multiplier"));
  });

  it("uses custom Discord action types in the log title", () => {
    const embed = buildCaseLogEmbed({
      id: 2,
      guildId: "guild-1",
      targetUserId: "discord:222222222222222222",
      targetUsername: "DiscordID 222222222222222222",
      robloxUsername: null,
      discordUsername: null,
      robloxId: null,
      discordId: "222222222222222222",
      moderatorUserId: "mod-1",
      moderatorUsername: "mod#0000",
      actionName: "discord",
      actionDisplayName: "timeout",
      reason: "rule break",
      evidence: "clip",
      notes: null,
      basePointsMilli: 1000,
      multiplierMilli: 1000,
      awardedPointsMilli: 1000,
      strikes: 0,
      status: "active",
      flags: "",
      isLate: false,
      isNoAction: false,
      ticketId: null,
      transcriptUrl: null,
      mediaLinks: [],
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z",
      voidedAt: null,
      voidReason: null
    });

    assert.equal(embed.toJSON().title, "LOGGED TIMEOUT");
  });
});

describe("quota reports", () => {
  it("counts active logged actions against roster snapshots", () => {
    const db = makeDb();
    const start = "2026-05-01T00:00:00.000Z";
    const end = "2026-05-08T00:00:00.000Z";
    db.ensureGuild("guild-1");
    db.run(
      "INSERT INTO quota_roster_snapshots (guild_id, period_start, period_end, user_id, role_id, required_logs, grace_logs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "guild-1",
      start,
      end,
      "mod-1",
      "role-1",
      2,
      0,
      start
    );
    for (const id of [1, 2]) {
      db.run(
        `INSERT INTO moderation_cases (
          id, guild_id, target_user_id, target_username, moderator_user_id, moderator_username,
          action_name, reason, base_points_milli, multiplier_milli, awarded_points_milli,
          strikes, flags, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?)`,
        id,
        "guild-1",
        "target",
        "target#0000",
        "mod-1",
        "mod#0000",
        "warning",
        "reason",
        1000,
        1000,
        1000,
        "2026-05-02T00:00:00.000Z",
        "2026-05-02T00:00:00.000Z"
      );
    }
    const report = buildQuotaReport(db, "guild-1", start, end);
    assert.deepEqual(
      {
        userId: report.statuses[0]?.userId,
        loggedActions: report.statuses[0]?.loggedActions,
        status: report.statuses[0]?.status
      },
      { userId: "mod-1", loggedActions: 2, status: "met" }
    );
    db.close();
  });
});

describe("ticket transcript parsing", () => {
  it("extracts opener, type, and transcript link without claim checks", () => {
    const message = {
      id: "message-1",
      url: "https://discord.com/channels/guild/channel/message-1",
      content: "",
      channel: { isTextBased: () => true, name: "ticket-support-123" },
      attachments: {
        map: (fn: (attachment: { name: string; url: string }) => string) =>
          [{ name: "transcript.html", url: "https://example.com/transcript.html" }].map(fn),
        first: () => ({ name: "transcript.html", url: "https://example.com/transcript.html" })
      },
      embeds: [
        {
          title: "Ticket Transcript",
          description: "Ticket ID: support-123",
          footer: { text: "" },
          fields: [
            { name: "Opened By", value: "<@111111111111111111>" },
            { name: "Claimed By", value: "<@222222222222222222>" },
            { name: "Type", value: "Support" }
          ]
        }
      ]
    };

    const parsed = parseTicketToolMessage(message as never);
    assert.equal(parsed.openerUserId, "111111111111111111");
    assert.equal(parsed.ticketType, "support");
    assert.equal(parsed.transcriptUrl, "https://example.com/transcript.html");
  });
});

describe("time helpers", () => {
  it("parses quota schedule inputs", () => {
    assert.equal(parseWeekday("Sunday"), 0);
    assert.deepEqual(parseTime("21:30"), { hour: 21, minute: 30 });
  });

  it("computes a future quota end", () => {
    const next = computeNextQuotaEnd({
      timeZone: "America/New_York",
      checkDay: 0,
      checkHour: 21,
      checkMinute: 0,
      frequencyDays: 7,
      from: new Date("2026-05-07T12:00:00.000Z")
    });
    assert.ok(next.getTime() > new Date("2026-05-07T12:00:00.000Z").getTime());
  });
});
