import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import type { Attachment, Message, TextChannel } from "discord.js";
import type { AppDatabase } from "../db.js";
import { autoExecuteIngameBan, autoExecuteIngameUnban, buildCaseLogEmbed, buildExecutePunishmentButton, createCase, effectiveActionPoints, formatLoggedActionName, isIngameBanAppealAccepted, isIngameBanCase, parsePunishmentLength, resubmitJuniorReviewCase, type CaseTarget } from "./cases.js";
import type { CaseMediaLink, ModerationCase } from "../types.js";
import { formatPoints, truncate } from "../utils/format.js";
import { caseLinkComponents, getTextChannel, isAdminMember } from "../utils/discord.js";
import { getStaffTier } from "../utils/discord.js";
import { colors } from "../utils/theme.js";

type LogStage =
  | "select"
  | "discord_type"
  | "ingame_subtype"
  | "ingame_rule_result"
  | "ingame_ban_result"
  | "appeal_type"
  | "appeal_result"
  | "confirm"
  | "fields"
  | "submitting";

type LogDraft = {
  id: string;
  guildId: string;
  userId: string;
  channelId: string | null;
  stage: LogStage;
  actionName: string | null;
  actionDisplayName: string | null;
  appealType: string | null;
  appealResult: "accepted" | "denied" | null;
  ingameRuleResult: "approved" | "denied" | null;
  punishmentLength: string | null;
  targetInfo: CaseTarget;
  reason: string | null;
  evidence: string | null;
  notes: string | null;
  noAction: boolean;
  nonTicketAction: boolean;
  transcriptUrl: string | null;
  mediaLinks: CaseMediaLink[];
  mediaCaptureEnabled: boolean;
  happenedAt: string | null;
  isHeadMod: boolean;
  editCaseId: number | null;
  statusMessage: string | null;
  createdAt: number;
  updatedAt: number;
  timeout: NodeJS.Timeout | null;
  editReply: ((payload: { content: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<unknown>) | null;
};

type LogActionButton = {
  id: string;
  label: string;
  actionName: string;
  displayName: string;
};

const sessions = new Map<string, LogDraft>();
const sessionsByUser = new Map<string, string>();
const SESSION_TTL_MS = 20 * 60 * 1000;
const DRAFT_STALE_MS = 60 * 60 * 1000;
const MAX_MEDIA_LINKS = 20;

// ── Draft persistence ───────────────────────────────────────────────────────

let draftsDir = "";

type SerializedDraft = Omit<LogDraft, "timeout" | "editReply">;

export function injectDraftFromDeniedCase(record: ModerationCase) {
  const existingId = sessionsByUser.get(sessionUserKey(record.guildId, record.moderatorUserId));
  if (existingId) {
    const existing = sessions.get(existingId);
    if (existing?.timeout) clearTimeout(existing.timeout);
    sessions.delete(existingId);
  }
  const draft: LogDraft = {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    guildId: record.guildId,
    userId: record.moderatorUserId,
    channelId: null,
    stage: "fields",
    actionName: record.actionName,
    actionDisplayName: record.actionDisplayName,
    appealType: record.appealType,
    appealResult: record.appealResult,
    ingameRuleResult: null,
    punishmentLength: record.punishmentLength,
    targetInfo: {
      robloxUsername: record.robloxUsername,
      discordUsername: record.discordUsername,
      robloxId: record.robloxId,
      discordId: record.discordId
    },
    reason: record.reason,
    evidence: record.evidence,
    notes: record.notes,
    noAction: record.isNoAction,
    nonTicketAction: false,
    transcriptUrl: record.transcriptUrl,
    mediaLinks: record.mediaLinks,
    mediaCaptureEnabled: false,
    happenedAt: null,
    isHeadMod: false,
    editCaseId: record.id,
    statusMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timeout: null,
    editReply: null
  };
  sessions.set(draft.id, draft);
  sessionsByUser.set(sessionUserKey(draft.guildId, draft.userId), draft.id);
  saveDraftToDisk(draft);
}

export function initDraftPersistence(dir: string) {
  draftsDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  loadDraftsFromDisk();
}

function draftFilePath(guildId: string, userId: string) {
  return path.join(draftsDir, `${guildId}-${userId}.json`);
}

function saveDraftToDisk(draft: LogDraft) {
  if (!draftsDir) return;
  try {
    const data: SerializedDraft = {
      id: draft.id, guildId: draft.guildId, userId: draft.userId,
      channelId: draft.channelId, stage: draft.stage, actionName: draft.actionName,
      actionDisplayName: draft.actionDisplayName, appealType: draft.appealType,
      appealResult: draft.appealResult, ingameRuleResult: draft.ingameRuleResult,
      punishmentLength: draft.punishmentLength,
      targetInfo: draft.targetInfo, reason: draft.reason, evidence: draft.evidence,
      notes: draft.notes, noAction: draft.noAction, nonTicketAction: draft.nonTicketAction,
      transcriptUrl: draft.transcriptUrl, mediaLinks: draft.mediaLinks,
      mediaCaptureEnabled: draft.mediaCaptureEnabled, happenedAt: draft.happenedAt,
      isHeadMod: draft.isHeadMod, editCaseId: draft.editCaseId,
      statusMessage: null,
      createdAt: draft.createdAt, updatedAt: draft.updatedAt
    };
    fs.writeFileSync(draftFilePath(draft.guildId, draft.userId), JSON.stringify(data), "utf8");
  } catch {
    // Non-critical — ignore write errors
  }
}

function deleteDraftFromDisk(guildId: string, userId: string) {
  if (!draftsDir) return;
  try { fs.unlinkSync(draftFilePath(guildId, userId)); } catch { /* already gone */ }
}

function loadDraftsFromDisk() {
  if (!draftsDir) return;
  let files: string[];
  try { files = fs.readdirSync(draftsDir).filter((f) => f.endsWith(".json")); } catch { return; }
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(draftsDir, file), "utf8");
      const data = JSON.parse(raw) as SerializedDraft;
      if (Date.now() - data.updatedAt > DRAFT_STALE_MS) {
        fs.unlinkSync(path.join(draftsDir, file));
        continue;
      }
      // Reset updatedAt so the in-memory TTL clock starts from now, not from before the crash.
      // Without this, getDraft() immediately sees "5+ minutes old" and fires the expiry error.
      const draft: LogDraft = { ...data, updatedAt: Date.now(), statusMessage: null, timeout: null, editReply: null };
      sessions.set(draft.id, draft);
      sessionsByUser.set(sessionUserKey(draft.guildId, draft.userId), draft.id);
      // Schedule the inactivity timeout so recovered drafts don't linger in memory forever.
      touchDraft(draft);
      console.log(`Recovered log draft ${draft.id} for user ${draft.userId} in guild ${draft.guildId}`);
    } catch { /* corrupt file — skip */ }
  }
}

const logActions: LogActionButton[] = [
  { id: "ingame", label: "Ingame", actionName: "ban", displayName: "Ingame" },
  { id: "strike", label: "Strike", actionName: "strike", displayName: "Strike" },
  { id: "restore", label: "Restore", actionName: "restore", displayName: "Restore" },
  { id: "discord", label: "Discord", actionName: "discord", displayName: "Discord" },
  { id: "other", label: "Other", actionName: "other", displayName: "Other" },
  { id: "appeal", label: "Appeal", actionName: "appeal", displayName: "Appeal" }
];

const discordSubTypes = [
  { id: "warn", label: "Warn", displayName: "Discord Warn" },
  { id: "timeout", label: "Timeout", displayName: "Discord Timeout" },
  { id: "mute", label: "Mute", displayName: "Discord Mute" },
  { id: "ban", label: "Ban", displayName: "Discord Ban" }
];

const appealTypes = [
  { id: "ban", label: "Ban", displayValue: "Ban" },
  { id: "timeout", label: "Timeout", displayValue: "Timeout" },
  { id: "warn", label: "Warn", displayValue: "Warn" },
  { id: "mute", label: "Mute", displayValue: "Mute" },
  { id: "ingame-ban", label: "Ingame Ban", displayValue: "Ingame Ban" },
  { id: "other", label: "Other", displayValue: "Other" }
];

export function resolveLogAction(value: string | null | undefined) {
  if (!value) return null;
  // Allow "ban" or "ingame" to map to the ingame action
  if (value === "ban" || value === "ingame") return logActions.find((a) => a.id === "ingame") ?? null;
  // "ticket" resolves for backwards-compat with old ticket-type logs
  if (value === "ticket") return { id: "ticket", label: "Ticket", actionName: "ticket", displayName: "Ticket" } as LogActionButton;
  return logActions.find((action) => action.id === value || action.actionName === value) ?? null;
}

export async function startInteractiveLog(interaction: ChatInputCommandInteraction, db: AppDatabase, member: GuildMember) {
  const guild = interaction.guild!;

  // Check for a recovered draft (loaded from disk after restart — has no active interaction)
  const existingDraftId = sessionsByUser.get(sessionUserKey(guild.id, member.id));
  const existingDraft = existingDraftId ? sessions.get(existingDraftId) : null;
  if (existingDraft && existingDraft.editReply === null) {
    await interaction.reply({ ...recoveryPromptPayload(existingDraft), ephemeral: true });
    // Give the recovery prompt a TTL — without this the draft lives forever in memory
    // and every subsequent /log call loops back to this same prompt.
    existingDraft.editReply = (payload) => interaction.editReply(payload);
    touchDraft(existingDraft);
    return;
  }

  await cancelPendingLogForUser(guild.id, member.id, "Previous pending log cancelled because you started a new log.");

  const config = db.getGuildConfig(guild.id);
  if (!config.interactiveLogEnabled) {
    await interaction.reply({
      content: "Interactive logging is disabled for this server. Use `/log action:` with typed fields instead.",
      ephemeral: true
    });
    return;
  }

  const tier = getStaffTier(db, member);
  const isHeadMod = tier === "head" || tier === "community" || member.permissions.has(PermissionFlagsBits.Administrator);
  const draft = createDraft(guild.id, member.id, interaction.channelId, isHeadMod);
  sessions.set(draft.id, draft);
  sessionsByUser.set(sessionUserKey(draft.guildId, draft.userId), draft.id);
  await interaction.reply({ ...previewPayload(db, draft), ephemeral: true });
  draft.editReply = (payload) => interaction.editReply(payload);
  touchDraft(draft);
}

export async function startEditLog(interaction: ChatInputCommandInteraction, db: AppDatabase, member: GuildMember, caseId: number) {
  const guild = interaction.guild!;

  const record = db.getCase(guild.id, caseId);
  if (!record) {
    await interaction.reply({ content: `Case #${caseId} not found in this server.`, ephemeral: true });
    return;
  }

  // Mods can edit their own cases; admins can edit any case
  const adminAccess = await isAdminMember(db, member);
  if (record.moderatorUserId !== member.id && !adminAccess) {
    await interaction.reply({ content: "You can only edit your own cases. Admins can edit any case.", ephemeral: true });
    return;
  }

  const tier = getStaffTier(db, member);
  const isHeadMod = tier === "head" || tier === "community" || member.permissions.has(PermissionFlagsBits.Administrator);

  await cancelPendingLogForUser(guild.id, member.id, "Previous pending log cancelled because you started a log edit.");

  const draft: LogDraft = {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    guildId: guild.id,
    userId: member.id,
    channelId: interaction.channelId,
    stage: "fields",
    actionName: record.actionName,
    actionDisplayName: record.actionDisplayName,
    appealType: record.appealType,
    appealResult: record.appealResult,
    ingameRuleResult: null,
    punishmentLength: record.punishmentLength,
    targetInfo: {
      robloxUsername: record.robloxUsername,
      discordUsername: record.discordUsername,
      robloxId: record.robloxId,
      discordId: record.discordId
    },
    reason: record.reason,
    evidence: record.evidence,
    notes: record.notes,
    noAction: record.isNoAction,
    nonTicketAction: false,
    transcriptUrl: record.transcriptUrl,
    mediaLinks: record.mediaLinks,
    mediaCaptureEnabled: false,
    happenedAt: null,
    isHeadMod,
    editCaseId: record.id,
    statusMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timeout: null,
    editReply: null
  };

  sessions.set(draft.id, draft);
  sessionsByUser.set(sessionUserKey(draft.guildId, draft.userId), draft.id);
  await interaction.reply({ ...previewPayload(db, draft), ephemeral: true });
  draft.editReply = (payload) => interaction.editReply(payload);
  touchDraft(draft);
}

export async function cancelPendingLogForUser(guildId: string, userId: string, reason: string) {
  const draftId = sessionsByUser.get(sessionUserKey(guildId, userId));
  const draft = draftId ? sessions.get(draftId) : null;
  if (!draft) return false;
  await cancelDraft(draft, reason);
  return true;
}

export async function handleLogButton(db: AppDatabase, interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith("log:")) return false;
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "This button only works inside a server.", ephemeral: true });
    return true;
  }

  const [, sessionId, action, value] = interaction.customId.split(":");

  // Recovery actions bypass the normal TTL check — draft may be older than 5 min after a restart
  if (action === "recover") {
    const recoveredDraft = sessions.get(sessionId ?? "");
    if (!recoveredDraft) {
      // The draft for this specific button is gone (TTL fired or already resumed elsewhere).
      // Clean up any other stale recovery draft for this user so `/log` doesn't loop back.
      const guild2 = interaction.guild!;
      const userId2 = (interaction.member as GuildMember).id;
      const otherDraftId = sessionsByUser.get(sessionUserKey(guild2.id, userId2));
      const otherDraft = otherDraftId ? sessions.get(otherDraftId) : null;
      if (otherDraft && otherDraft.editReply === null) removeDraft(otherDraft);
      await interaction.update({ content: "That recovery draft expired. Use `/log` to start a new log.", embeds: [], components: [] });
      return true;
    }
    if (value === "dismiss") {
      removeDraft(recoveredDraft);
      await interaction.update({ content: "Draft dismissed. Use `/log` to start a new log.", embeds: [], components: [] });
      return true;
    }
    if (value === "resume") {
      // editReply was already bound to the /log command interaction in startInteractiveLog.
      // Only overwrite if it somehow wasn't set (e.g. draft was recovered by a non-/log path).
      if (!recoveredDraft.editReply) {
        recoveredDraft.editReply = (payload) => interaction.editReply(payload);
      }
      touchDraft(recoveredDraft);
      await interaction.update(previewPayload(db, recoveredDraft));
    } else {
      // "fresh" — discard old draft, start a new one
      removeDraft(recoveredDraft);
      const config = db.getGuildConfig(interaction.guild!.id);
      if (!config.interactiveLogEnabled) {
        await interaction.update({ content: "Interactive logging is disabled. Use `/log action:` instead.", embeds: [], components: [] });
        return true;
      }
      const member = interaction.member as GuildMember;
      const tier = getStaffTier(db, member);
      const isHeadMod = tier === "head" || tier === "community" || member.permissions.has(PermissionFlagsBits.Administrator);
      const newDraft = createDraft(recoveredDraft.guildId, recoveredDraft.userId, recoveredDraft.channelId, isHeadMod);
      sessions.set(newDraft.id, newDraft);
      sessionsByUser.set(sessionUserKey(newDraft.guildId, newDraft.userId), newDraft.id);
      await interaction.update(previewPayload(db, newDraft));
      newDraft.editReply = (payload) => interaction.editReply(payload);
      touchDraft(newDraft);
    }
    return true;
  }

  const draft = getDraft(sessionId, interaction);
  if (!draft) return true;

  if (action === "action") {
    const selected = resolveLogAction(value);
    if (!selected) {
      await interaction.reply({ content: "That log action is no longer available.", ephemeral: true });
      return true;
    }
    draft.actionName = selected.actionName;
    draft.actionDisplayName = null;
    draft.appealType = null;
    draft.appealResult = null;
    draft.mediaCaptureEnabled = false;

    if (value === "discord") {
      draft.stage = "discord_type";
    } else if (value === "ingame") {
      draft.stage = "ingame_subtype";
    } else if (value === "appeal") {
      draft.stage = "appeal_type";
    } else {
      draft.actionDisplayName = selected.displayName;
      draft.stage = "confirm";
    }
    await interaction.update(previewPayload(db, draft));
    return true;
  }

  if (action === "discord_type") {
    const sub = discordSubTypes.find((t) => t.id === value);
    if (!sub) return true;
    draft.actionDisplayName = sub.displayName;
    draft.stage = "confirm";
    await interaction.update(previewPayload(db, draft));
    return true;
  }

  if (action === "ingame_subtype") {
    if (value === "exploiter") {
      draft.actionName = "ban";
      draft.actionDisplayName = "Ingame Ban";
      draft.ingameRuleResult = null;
      draft.stage = "fields";
      await interaction.update(previewPayload(db, draft));
    } else if (value === "rulebreak") {
      draft.ingameRuleResult = null;
      draft.stage = "ingame_rule_result";
      await interaction.update(previewPayload(db, draft));
    }
    return true;
  }

  if (action === "ingame_rule_result") {
    if (value === "approved" || value === "denied") {
      draft.ingameRuleResult = value;
      draft.stage = "ingame_ban_result";
      await interaction.update(previewPayload(db, draft));
    }
    return true;
  }

  if (action === "ingame_ban_result") {
    const result = draft.ingameRuleResult ?? "approved";
    const resultLabel = result === "approved" ? "Approved" : "Denied";
    if (value === "yes") {
      draft.actionName = "ban";
      draft.actionDisplayName = `Rule Break Ban - ${resultLabel}`;
      draft.stage = "confirm";
    } else if (value === "no") {
      draft.actionName = "ban";
      draft.actionDisplayName = `Rule Break - ${resultLabel}`;
      draft.stage = "confirm";
    }
    await interaction.update(previewPayload(db, draft));
    return true;
  }

  if (action === "appeal_type") {
    const at = appealTypes.find((t) => t.id === value);
    if (!at) return true;
    draft.appealType = at.displayValue;
    draft.stage = "appeal_result";
    await interaction.update(previewPayload(db, draft));
    return true;
  }

  if (action === "appeal_result") {
    if (value === "accepted" || value === "denied") {
      draft.appealResult = value;
      draft.stage = "confirm";
      await interaction.update(previewPayload(db, draft));
    }
    return true;
  }

  if (action === "next") {
    if (!draft.actionName) {
      await interaction.reply({ content: "Pick a log type first.", ephemeral: true });
      return true;
    }
    draft.stage = "fields";
    await interaction.update(previewPayload(db, draft));
    return true;
  }

  if (action === "back") {
    if (draft.stage === "appeal_result") {
      draft.stage = "appeal_type";
    } else if (draft.stage === "ingame_rule_result") {
      draft.stage = "ingame_subtype";
    } else if (draft.stage === "ingame_ban_result") {
      draft.stage = "ingame_rule_result";
    } else if (draft.stage === "fields") {
      draft.stage = "confirm";
    } else {
      draft.stage = "select";
      draft.actionName = null;
      draft.actionDisplayName = null;
      draft.appealType = null;
      draft.appealResult = null;
      draft.ingameRuleResult = null;
      draft.mediaCaptureEnabled = false;
    }
    await interaction.update(previewPayload(db, draft));
    return true;
  }

  if (action === "modal") {
    if (draft.stage !== "fields") {
      await interaction.reply({ content: "Click Next before filling out log fields.", ephemeral: true });
      return true;
    }
    await interaction.showModal(buildModal(draft, value ?? "info"));
    return true;
  }

  if (action === "media") {
    if (draft.stage !== "fields") {
      await interaction.reply({ content: "Click Next before attaching media.", ephemeral: true });
      return true;
    }
    draft.mediaCaptureEnabled = true;
    await interaction.update(previewPayload(db, draft));
    return true;
  }

  if (action === "toggle_non_ticket") {
    if (draft.stage !== "fields") return true;
    draft.nonTicketAction = !draft.nonTicketAction;
    await interaction.update(previewPayload(db, draft));
    return true;
  }

  if (action === "submit") {
    if (draft.stage !== "fields") {
      await interaction.reply({ content: "Click Next and finish the log fields before submitting.", ephemeral: true });
      return true;
    }
    await submitDraft(db, interaction, draft);
    return true;
  }

  if (action === "cancel") {
    removeDraft(draft);
    await interaction.update({ content: "Log cancelled.", embeds: [], components: [] });
    return true;
  }

  return false;
}

export async function handleLogModal(db: AppDatabase, interaction: ModalSubmitInteraction) {
  if (!interaction.customId.startsWith("log:")) return false;
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "This form only works inside a server.", ephemeral: true });
    return true;
  }

  const [, sessionId, action, value] = interaction.customId.split(":");
  const draft = getDraft(sessionId, interaction);
  if (!draft) return true;
  if (action !== "save") return false;

  saveModalFields(draft, value ?? "info", interaction);
  if (interaction.isFromMessage()) {
    await interaction.update(previewPayload(db, draft));
  } else {
    await interaction.reply({ content: "Updated log draft.", ephemeral: true });
  }
  return true;
}

export async function handleLogMediaMessage(db: AppDatabase, message: Message) {
  if (!message.guild || message.author.bot || message.attachments.size === 0) return false;
  const draftId = sessionsByUser.get(sessionUserKey(message.guild.id, message.author.id));
  const draft = draftId ? sessions.get(draftId) : null;
  if (!draft || !draft.mediaCaptureEnabled || draft.channelId !== message.channelId) return false;
  if (draft.stage !== "fields") return false;
  if (Date.now() - draft.updatedAt > SESSION_TTL_MS) {
    await cancelDraft(draft, "Log automatically cancelled after 20 minutes of inactivity.");
    return false;
  }

  const prevCount = draft.mediaLinks.length;
  const added = addMediaLinks(draft, message);
  if (added === 0) return false;
  touchDraft(draft);

  // Show initial capture feedback immediately
  if (draft.editReply) {
    await draft.editReply(previewPayload(db, draft)).catch(() => null);
  }

  // Immediately archive newly-added links while Discord CDN URLs are still fresh.
  // This prevents the "linking original messages instead of archive" bug caused by
  // CDN URL expiry when archiving is deferred to submit time.
  const config = db.getGuildConfig(draft.guildId);
  if (config.evidenceArchiveChannelId) {
    const linksToArchive = draft.mediaLinks.slice(prevCount).filter((l) => l.sourceUrl);
    if (linksToArchive.length > 0) {
      const archiveChannel = await getTextChannel(message.guild, config.evidenceArchiveChannelId);
      if (archiveChannel) {
        for (let i = 0; i < linksToArchive.length; i++) {
          const link = linksToArchive[i];
          const draftIdx = draft.mediaLinks.indexOf(link);
          if (draftIdx === -1) continue;

          draft.statusMessage = `⏳ Archiving ${i + 1}/${linksToArchive.length}...`;
          if (draft.editReply) await draft.editReply(previewPayload(db, draft)).catch(() => null);

          try {
            const response = await fetch(link.sourceUrl!);
            if (response.ok) {
              const buffer = Buffer.from(await response.arrayBuffer());
              const ext = extFromUrl(link.sourceUrl!);
              const builder = new AttachmentBuilder(buffer, { name: `evidence${ext}` });
              const archiveMsg = await (archiveChannel as TextChannel).send({ files: [builder] });
              // Set url to archived message; clear sourceUrl so submit-time archiving skips it
              draft.mediaLinks[draftIdx] = { label: link.label, kind: link.kind, url: archiveMsg.url, sourceUrl: null };
            }
          } catch {
            // Archive failed — original message URL is kept as fallback
          }
        }
      }
    }
    draft.statusMessage = null;
  }

  if (draft.editReply) {
    await draft.editReply(previewPayload(db, draft)).catch(() => null);
  }
  return true;
}

function createDraft(guildId: string, userId: string, channelId: string | null, isHeadMod: boolean): LogDraft {
  return {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    guildId,
    userId,
    channelId,
    stage: "select",
    actionName: null,
    actionDisplayName: null,
    appealType: null,
    appealResult: null,
    ingameRuleResult: null,
    punishmentLength: null,
    targetInfo: {},
    reason: null,
    evidence: null,
    notes: null,
    noAction: false,
    nonTicketAction: false,
    transcriptUrl: null,
    mediaLinks: [],
    mediaCaptureEnabled: false,
    happenedAt: null,
    isHeadMod,
    editCaseId: null,
    statusMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timeout: null,
    editReply: null
  };
}

function getDraft(sessionId: string | undefined, interaction: ButtonInteraction | ModalSubmitInteraction) {
  const draft = sessionId ? sessions.get(sessionId) : null;
  if (!draft) {
    void interaction.reply({ content: "That log draft expired. Run `/log` again.", ephemeral: true }).catch(() => null);
    return null;
  }
  if (Date.now() - draft.updatedAt > SESSION_TTL_MS) {
    void cancelDraft(draft, "Log automatically cancelled after 20 minutes of inactivity.").catch(() => null);
    void interaction.reply({ content: "That log draft expired. Run `/log` again.", ephemeral: true }).catch(() => null);
    return null;
  }
  if (interaction.guild?.id !== draft.guildId || interaction.user.id !== draft.userId) {
    void interaction.reply({ content: "Only the person who started this log can edit it.", ephemeral: true }).catch(() => null);
    return null;
  }
  touchDraft(draft);
  return draft;
}

function stageDescription(draft: LogDraft): string {
  switch (draft.stage) {
    case "select": return "Step 1: choose the type of moderation log to create.";
    case "discord_type": return "Step 2: choose the Discord action type.";
    case "ingame_subtype": return "Step 2: what kind of ingame action?";
    case "ingame_rule_result": return "Step 3: what was the outcome of the rule break report?";
    case "ingame_ban_result": return `Step 4: did the rule break result in a ban? (Report: ${draft.ingameRuleResult ?? "approved"})`;
    case "appeal_type": return "Step 2: choose what the appeal is for.";
    case "appeal_result": return `Step 3: choose the appeal result for **${draft.appealType ?? "Appeal"}**.`;
    case "confirm": {
      const parts: string[] = [];
      if (draft.appealType) parts.push(`Appeal Type: ${draft.appealType}`);
      if (draft.appealResult) parts.push(`Result: ${draft.appealResult === "accepted" ? "Accepted" : "Denied"}`);
      const extra = parts.length > 0 ? `\n${parts.join(" | ")}` : "";
      return `Log type confirmed. Press Next to fill fields or Cancel to stop.${extra}`;
    }
    default: return "Step: fill the required fields, review the preview, then submit.";
  }
}

function previewPayload(db: AppDatabase, draft: LogDraft) {
  const mediaLine = draft.stage === "fields"
    ? draft.statusMessage
      ? draft.statusMessage
      : draft.mediaCaptureEnabled
        ? `Attach Media is on. Send image, video, or file evidence in this channel before Submit. Captured: ${draft.mediaLinks.length}/${MAX_MEDIA_LINKS}.`
        : "Use Attach Media to collect uploaded evidence as clickable message links."
    : null;

  const fields = draft.stage === "fields"
    ? [
        { name: "Action", value: draft.actionName ? formatActionLine(db, draft) : "Pick an action with the buttons below.", inline: false },
        { name: "Target", value: truncate(formatDraftTarget(draft.targetInfo), 1000), inline: false },
        { name: "Information", value: truncate(formatDraftInformation(draft), 1000), inline: false }
      ]
    : [
        { name: "Action", value: draft.actionName ? formatActionLine(db, draft) : "No log type selected yet.", inline: false }
      ];

  const embedTitle = (() => {
    if (draft.stage === "appeal_result" || (draft.actionName === "appeal" && draft.appealType)) {
      const resultLabel = draft.appealResult
        ? draft.appealResult === "accepted" ? " — Approved" : " — Denied"
        : "";
      return `APPEAL PREVIEW: ${draft.appealType ?? "Appeal"}${resultLabel}`;
    }
    return draft.actionName
      ? `LOG PREVIEW ${formatLoggedActionName(draft.actionDisplayName ?? draft.actionName)}`
      : "Log Preview";
  })();

  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setColor(colors.voidPurple)
    .setDescription(stageDescription(draft))
    .addFields(fields)
    .setFooter({ text: "Only one pending log can be active per user. Inactive drafts expire after 20 minutes." });

  return {
    content: [
      draft.stage === "select"
        ? "Choose a log type to begin."
        : draft.stage === "confirm"
          ? "Log type selected. Press Next to fill the log fields, or Cancel to stop."
          : draft.stage === "fields"
            ? "Build the log, review the preview, then press Submit."
            : "Select an option to continue.",
      mediaLine
    ].filter(Boolean).join("\n"),
    embeds: [embed],
    components: draftComponents(draft, false, db)
  };
}

function draftComponents(draft: LogDraft, disabled = false, db?: AppDatabase) {
  switch (draft.stage) {
    case "select": return selectComponents(draft, disabled);
    case "discord_type": return discordTypeComponents(draft, disabled);
    case "ingame_subtype": return ingameSubtypeComponents(draft, disabled);
    case "ingame_rule_result": return ingameRuleResultComponents(draft, disabled);
    case "ingame_ban_result": return ingameBanResultComponents(draft, disabled);
    case "appeal_type": return appealTypeComponents(draft, disabled);
    case "appeal_result": return appealResultComponents(draft, disabled);
    case "confirm": return confirmComponents(draft, disabled);
    default: return fieldsComponents(draft, disabled, db);
  }
}

function selectComponents(draft: LogDraft, disabled = false) {
  const visible = logActions.filter((action) => {
    if (action.id === "strike") return draft.isHeadMod;
    return true;
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < visible.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...visible.slice(i, i + 5).map((action) =>
          new ButtonBuilder()
            .setCustomId(`log:${draft.id}:action:${action.id}`)
            .setLabel(action.label)
            .setStyle(actionButtonStyle(action.id))
            .setDisabled(disabled)
        )
      )
    );
  }
  return rows;
}

function discordTypeComponents(draft: LogDraft, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...discordSubTypes.map((sub) =>
        new ButtonBuilder()
          .setCustomId(`log:${draft.id}:discord_type:${sub.id}`)
          .setLabel(sub.label)
          .setStyle(discordSubTypeStyle(sub.id))
          .setDisabled(disabled)
      )
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

function ingameSubtypeComponents(draft: LogDraft, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:ingame_subtype:exploiter`).setLabel("Exploiter").setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:ingame_subtype:rulebreak`).setLabel("Rule Break").setStyle(ButtonStyle.Primary).setDisabled(disabled)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

function ingameRuleResultComponents(draft: LogDraft, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:ingame_rule_result:approved`).setLabel("Approved").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:ingame_rule_result:denied`).setLabel("Denied").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

function ingameBanResultComponents(draft: LogDraft, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:ingame_ban_result:yes`).setLabel("Yes — Resulted in a Ban").setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:ingame_ban_result:no`).setLabel("No — No Ban").setStyle(ButtonStyle.Secondary).setDisabled(disabled)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

function appealTypeComponents(draft: LogDraft, disabled = false) {
  const firstFive = appealTypes.slice(0, 5);
  const lastOne = appealTypes[5];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...firstFive.map((at) =>
        new ButtonBuilder()
          .setCustomId(`log:${draft.id}:appeal_type:${at.id}`)
          .setLabel(at.label)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      )
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...(lastOne
        ? [new ButtonBuilder().setCustomId(`log:${draft.id}:appeal_type:${lastOne.id}`).setLabel(lastOne.label).setStyle(ButtonStyle.Secondary).setDisabled(disabled)]
        : []),
      new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

function appealResultComponents(draft: LogDraft, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`log:${draft.id}:appeal_result:accepted`)
        .setLabel("Accepted")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`log:${draft.id}:appeal_result:denied`)
        .setLabel("Denied")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

const TRANSCRIPT_REQUIRED_ACTIONS = new Set(["ticket", "discord", "discord-ban", "ban"]);

function confirmComponents(draft: LogDraft, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:next`).setLabel("Next").setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

function fieldsComponents(draft: LogDraft, disabled = false, db?: AppDatabase) {
  const targetComplete = hasTarget(draft.targetInfo);
  const evidenceComplete = hasEvidence(draft);
  const appealRequired = draft.actionName === "appeal";
  const appealComplete = Boolean(draft.appealResult);

  const row1Buttons = [
    new ButtonBuilder().setCustomId(`log:${draft.id}:modal:target`).setLabel("Target").setStyle(requiredStyle(targetComplete)).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`log:${draft.id}:modal:evidence`).setLabel("Evidence").setStyle(evidenceComplete ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`log:${draft.id}:modal:info`).setLabel("Info").setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`log:${draft.id}:modal:details`).setLabel("Details").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ...(appealRequired
      ? [new ButtonBuilder().setCustomId(`log:${draft.id}:modal:appeal_info`).setLabel("Appeal Info").setStyle(requiredStyle(appealComplete, true)).setDisabled(disabled)]
      : [])
  ];

  const needsTranscript = draft.actionName !== null && TRANSCRIPT_REQUIRED_ACTIONS.has(draft.actionName);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(...row1Buttons),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:media`).setLabel(draft.mediaCaptureEnabled ? "Attach Media On" : "Attach Media").setStyle(draft.mediaCaptureEnabled ? ButtonStyle.Success : ButtonStyle.Primary).setDisabled(disabled),
      ...(needsTranscript
        ? [new ButtonBuilder().setCustomId(`log:${draft.id}:toggle_non_ticket`).setLabel(draft.nonTicketAction ? "Non Ticket Action On" : "Non Ticket Action").setStyle(draft.nonTicketAction ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled)]
        : []),
      new ButtonBuilder().setCustomId(`log:${draft.id}:submit`).setLabel("Submit").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    )
  ];
}

function buildModal(draft: LogDraft, modalType: string) {
  if (modalType === "target") {
    return new ModalBuilder()
      .setCustomId(`log:${draft.id}:save:target`)
      .setTitle("Log Target")
      .addComponents(
        textRow("roblox_user", "RobloxUser", draft.targetInfo.robloxUsername, false),
        textRow("roblox_id", "RobloxID", draft.targetInfo.robloxId, false),
        textRow("discord_user", "DiscordUser mention/name", draft.targetInfo.discordUsername, false),
        textRow("discord_id", "DiscordID", draft.targetInfo.discordId, false)
      );
  }

  if (modalType === "details") {
    return new ModalBuilder()
      .setCustomId(`log:${draft.id}:save:details`)
      .setTitle("Log Details")
      .addComponents(
        textRow("transcript_link", "Transcript Link", draft.transcriptUrl, false),
        textRow("punishment_length", "Punishment Length", draft.punishmentLength, false),
        textRow("happened_at", "Happened At", draft.happenedAt, false),
        textRow("no_action", "No Action? yes/no", draft.noAction ? "yes" : "no", false)
      );
  }

  if (modalType === "appeal_info") {
    return new ModalBuilder()
      .setCustomId(`log:${draft.id}:save:appeal_info`)
      .setTitle("Appeal Information")
      .addComponents(
        textRow("appeal_type", "Appeal Type (e.g. Ban, Timeout, Warn)", draft.appealType, false),
        textRow("appeal_result", "Result: accepted or denied", draft.appealResult ?? "", false)
      );
  }

  if (modalType === "evidence") {
    return new ModalBuilder()
      .setCustomId(`log:${draft.id}:save:evidence`)
      .setTitle("Log Evidence")
      .addComponents(textRow("evidence", "Evidence", draft.evidence, false, TextInputStyle.Paragraph));
  }

  return new ModalBuilder()
    .setCustomId(`log:${draft.id}:save:info`)
    .setTitle("Log Information")
    .addComponents(
      textRow("reason", "Reason", draft.reason, false, TextInputStyle.Paragraph),
      textRow("notes", "Notes", draft.notes, false, TextInputStyle.Paragraph)
    );
}

function textRow(customId: string, label: string, value?: string | null, required = false, style = TextInputStyle.Short) {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style)
    .setRequired(required);
  if (value) input.setValue(value.slice(0, style === TextInputStyle.Paragraph ? 4000 : 400));
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function saveModalFields(draft: LogDraft, modalType: string, interaction: ModalSubmitInteraction) {
  if (modalType === "target") {
    const discordUser = clean(interaction.fields.getTextInputValue("discord_user"));
    const discordId = clean(interaction.fields.getTextInputValue("discord_id")) ?? extractDiscordId(discordUser);
    draft.targetInfo = {
      robloxUsername: clean(interaction.fields.getTextInputValue("roblox_user")),
      robloxId: clean(interaction.fields.getTextInputValue("roblox_id")),
      discordUsername: discordUser && discordUser !== discordId ? discordUser : null,
      discordId
    };
    return;
  }

  if (modalType === "details") {
    draft.transcriptUrl = clean(interaction.fields.getTextInputValue("transcript_link"));
    draft.punishmentLength = clean(interaction.fields.getTextInputValue("punishment_length"));
    draft.happenedAt = clean(interaction.fields.getTextInputValue("happened_at"));
    draft.noAction = /^(y(es)?|true|1)$/i.test(clean(interaction.fields.getTextInputValue("no_action")) ?? "");
    return;
  }

  if (modalType === "appeal_info") {
    const rawType = clean(interaction.fields.getTextInputValue("appeal_type"));
    const rawResult = clean(interaction.fields.getTextInputValue("appeal_result"))?.toLowerCase() ?? "";
    if (rawType) draft.appealType = rawType;
    if (rawResult === "accepted" || rawResult === "denied") draft.appealResult = rawResult;
    return;
  }

  if (modalType === "evidence") {
    draft.evidence = clean(interaction.fields.getTextInputValue("evidence"));
    return;
  }

  draft.reason = clean(interaction.fields.getTextInputValue("reason"));
  draft.notes = clean(interaction.fields.getTextInputValue("notes"));
}

async function submitDraft(db: AppDatabase, interaction: ButtonInteraction, draft: LogDraft) {
  draft.stage = "submitting";

  const missing = missingRequiredFields(db, draft);
  if (missing.length > 0) {
    draft.stage = "fields";
    await interaction.reply({ content: `Finish the required fields before submitting: ${missing.join(", ")}.`, ephemeral: true });
    return;
  }

  if (draft.editCaseId) {
    await resubmitEditedDraft(db, interaction, draft);
    return;
  }

  // Acknowledge the interaction immediately — Discord requires a response within 3 seconds.
  // All the async work (archiving, case creation, channel posts) happens after deferUpdate.
  await interaction.deferUpdate();

  try {
    const actionName = draft.actionName!;
    const evidence = draft.evidence
      ?? (draft.mediaLinks.length > 0 ? `Media evidence: ${draft.mediaLinks.map((link) => link.label).join(", ")}` : null)
      ?? (draft.transcriptUrl ? "See transcript." : null);

    const config = db.getGuildConfig(draft.guildId);
    const archivedLinks = config.evidenceArchiveChannelId && draft.mediaLinks.length > 0
      ? await archiveMediaLinks(interaction.guild!, config.evidenceArchiveChannelId, draft.mediaLinks, interaction.user.id)
      : draft.mediaLinks;

    const record = await createCase(db, {
      guild: interaction.guild!,
      targetInfo: draft.targetInfo,
      moderator: interaction.member as GuildMember,
      actionName,
      actionDisplayName: draft.actionDisplayName,
      reason: draft.reason ?? "No reason provided.",
      evidence,
      notes: draft.notes,
      noAction: draft.noAction,
      transcriptUrl: draft.transcriptUrl,
      mediaLinks: archivedLinks,
      appealType: draft.appealType,
      appealResult: draft.appealResult,
      punishmentLength: draft.punishmentLength,
      happenedAt: draft.happenedAt
    });

    removeDraft(draft);

    // Auto-execute ingame ban/unban for cases that don't require approval or junior review
    if (record.juniorReviewStatus !== "pending" && record.approvalStatus !== "pending") {
      if (isIngameBanCase(record)) {
        autoExecuteIngameBan(db, interaction.guild!, record.id).catch((err) => console.error("[logWorkflow] autoExecuteIngameBan:", err));
      } else if (isIngameBanAppealAccepted(record)) {
        autoExecuteIngameUnban(db, interaction.guild!, record.id).catch((err) => console.error("[logWorkflow] autoExecuteIngameUnban:", err));
      }
    }

    const config2 = db.getGuildConfig(draft.guildId);
    const executeRow = buildExecutePunishmentButton(record, config2);
    const linkRows = caseLinkComponents(record.transcriptUrl, record.mediaLinks);
    await interaction.editReply({
      content: config2.pointsEnabled ? `Submitted case #${record.id} for ${formatPoints(record.awardedPointsMilli)} points.` : `Submitted case #${record.id}.`,
      embeds: [buildCaseLogEmbed(record, { showPoints: config2.pointsEnabled })],
      components: [...(executeRow ? [executeRow] : []), ...linkRows]
    });
  } catch (err) {
    draft.stage = "fields";
    await interaction.followUp({
      content: `Failed to submit log: ${err instanceof Error ? err.message : "Unknown error. Please try again."}`,
      ephemeral: true
    });
  }
}

async function resubmitEditedDraft(db: AppDatabase, interaction: ButtonInteraction, draft: LogDraft) {
  const caseId = draft.editCaseId!;
  const missing = missingRequiredFields(db, draft);
  if (missing.length > 0) {
    await interaction.reply({ content: `Finish the required fields before resubmitting: ${missing.join(", ")}.`, ephemeral: true });
    return;
  }

  // Acknowledge immediately — archiving + DB work can exceed 3 seconds
  await interaction.deferUpdate();

  try {
    const evidence = draft.evidence
      ?? (draft.mediaLinks.length > 0 ? `Media evidence: ${draft.mediaLinks.map((l) => l.label).join(", ")}` : null)
      ?? (draft.transcriptUrl ? "See transcript." : null);

    const config = db.getGuildConfig(draft.guildId);
    const archivedLinks = config.evidenceArchiveChannelId && draft.mediaLinks.some((l) => l.sourceUrl)
      ? await archiveMediaLinks(interaction.guild!, config.evidenceArchiveChannelId, draft.mediaLinks, interaction.user.id)
      : draft.mediaLinks;

    const timestamp = new Date().toISOString();
    db.run(
      `UPDATE moderation_cases SET
        reason = ?, evidence = ?, notes = ?, transcript_url = ?,
        media_links_json = ?, punishment_length = ?, is_no_action = ?,
        appeal_type = ?, appeal_result = ?,
        roblox_username = ?, roblox_id = ?, discord_username = ?, discord_id = ?,
        junior_review_status = 'pending', updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      draft.reason ?? "No reason provided.", evidence, draft.notes ?? null,
      draft.transcriptUrl ?? null,
      archivedLinks.length > 0 ? JSON.stringify(archivedLinks) : null,
      draft.punishmentLength ?? null, draft.noAction ? 1 : 0,
      draft.appealType ?? null, draft.appealResult ?? null,
      draft.targetInfo.robloxUsername ?? null, draft.targetInfo.robloxId ?? null,
      draft.targetInfo.discordUsername ?? null, draft.targetInfo.discordId ?? null,
      timestamp, draft.guildId, caseId
    );

    const updatedRecord = db.getCase(draft.guildId, caseId);
    if (!updatedRecord) {
      await interaction.followUp({ content: "Failed to update case.", ephemeral: true });
      return;
    }

    // Update the original log channel message with fresh embed + execute button
    const executeRow = buildExecutePunishmentButton(updatedRecord, config);
    const linkRows = caseLinkComponents(updatedRecord.transcriptUrl, updatedRecord.mediaLinks);
    if (updatedRecord.logChannelId && updatedRecord.logMessageId) {
      const logChannel = await getTextChannel(interaction.guild!, updatedRecord.logChannelId);
      const logMsg = await logChannel?.messages.fetch(updatedRecord.logMessageId).catch(() => null);
      if (logMsg) {
        await logMsg.edit({
          embeds: [buildCaseLogEmbed(updatedRecord, { showPoints: config.pointsEnabled })],
          components: [...(executeRow ? [executeRow] : []), ...linkRows]
        }).catch(() => null);
      }
    }

    await resubmitJuniorReviewCase(db, interaction.guild!, updatedRecord, interaction.member as GuildMember);
    removeDraft(draft);
    await interaction.editReply({
      content: `Case #${caseId} updated.`,
      embeds: [buildCaseLogEmbed(updatedRecord, { showPoints: config.pointsEnabled })],
      components: [...(executeRow ? [executeRow] : []), ...linkRows]
    });
  } catch (err) {
    draft.stage = "fields";
    await interaction.followUp({
      content: `Failed to update case: ${err instanceof Error ? err.message : "Unknown error. Please try again."}`,
      ephemeral: true
    });
  }
}

async function archiveMediaLinks(
  guild: Parameters<typeof getTextChannel>[0],
  archiveChannelId: string,
  links: CaseMediaLink[],
  _moderatorId: string
): Promise<CaseMediaLink[]> {
  const archiveChannel = await getTextChannel(guild, archiveChannelId);
  if (!archiveChannel) return links;

  const archived: CaseMediaLink[] = [];
  for (const link of links) {
    if (!link.sourceUrl) {
      archived.push(link);
      continue;
    }
    try {
      const response = await fetch(link.sourceUrl);
      if (!response.ok) {
        archived.push(link);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = extFromUrl(link.sourceUrl);
      const attachment = new AttachmentBuilder(buffer, { name: `evidence${ext}` });
      const msg = await (archiveChannel as TextChannel).send({ files: [attachment] });
      // Clear sourceUrl after successful archive — marks it as "already archived" so
      // future calls (e.g. via /logedit) don't attempt to re-fetch an expired CDN URL.
      archived.push({ label: link.label, kind: link.kind, url: msg.url, sourceUrl: null });
    } catch {
      archived.push(link);
    }
  }
  return archived;
}

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = /(\.[a-z0-9]{2,5})$/i.exec(pathname);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function formatActionLine(db: AppDatabase, draft: LogDraft) {
  if (!draft.actionName) return "None";
  const action = db.getAction(draft.guildId, draft.actionName);
  if (!action) return `${draft.actionDisplayName ?? draft.actionName} (preset missing)`;
  if (!db.getGuildConfig(draft.guildId).pointsEnabled) return `${draft.actionDisplayName ?? action.displayName}`;
  const points = effectiveActionPoints(action);
  const amount = draft.noAction ? points.noActionPointsMilli : points.basePointsMilli;
  const override = points.overrideActive ? ` temporary override${points.overrideEndsAt ? ` until ${points.overrideEndsAt}` : ""}` : "";
  return `${draft.actionDisplayName ?? action.displayName} - ${formatPoints(amount)} points${override}`;
}

function formatDraftTarget(target: CaseTarget) {
  const lines = [
    target.robloxUsername ? `RobloxUser: ${target.robloxUsername}` : null,
    target.robloxId ? `RobloxID: ${target.robloxId}` : null,
    target.discordUsername ? `DiscordUser: ${target.discordUsername}` : null,
    target.discordId ? `DiscordID: ${target.discordId}` : null
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : "No target set yet.";
}

function formatDraftInformation(draft: LogDraft) {
  return [
    `Reason: ${draft.reason ?? "None"}`,
    `Evidence: ${draft.evidence ?? "None"}`,
    draft.mediaLinks.length > 0 ? `Media: ${draft.mediaLinks.map((link) => link.label).join(", ")}` : null,
    `Notes: ${draft.notes ?? "None"}`,
    `No Action: ${draft.noAction ? "Yes" : "No"}`,
    draft.transcriptUrl ? "Transcript: will show as a button" : null,
    draft.punishmentLength ? `Punishment Length: ${draft.punishmentLength}` : null,
    draft.happenedAt ? `Happened At: ${draft.happenedAt}` : null,
    draft.appealType ? `Appeal Type: ${draft.appealType}` : null,
    draft.appealResult ? `Appeal Result: ${draft.appealResult === "accepted" ? "Accepted" : "Denied"}` : null
  ].filter(Boolean).join("\n");
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function extractDiscordId(value: string | null | undefined) {
  return value?.match(/\d{15,25}/)?.[0] ?? null;
}

function hasTarget(target: CaseTarget) {
  return Boolean(target.robloxUsername || target.robloxId || target.discordUsername || target.discordId);
}

function hasEvidence(draft: LogDraft) {
  return Boolean(draft.evidence || draft.transcriptUrl || draft.mediaLinks.length > 0);
}

function isEvidenceRequired(draft: LogDraft, db?: AppDatabase) {
  const configured = draft.actionName && db ? db.getAction(draft.guildId, draft.actionName) : null;
  if (configured) return configured.evidenceRequired;
  return draft.actionName === "ban" || draft.actionName === "strike" || draft.actionName === "restore" || draft.actionName === "discord";
}

function requiredStyle(complete: boolean, required = true) {
  return required && !complete ? ButtonStyle.Danger : ButtonStyle.Success;
}

function actionButtonStyle(actionId: string) {
  if (actionId === "ingame" || actionId === "strike") return ButtonStyle.Danger;
  if (actionId === "restore") return ButtonStyle.Success;
  if (actionId === "discord" || actionId === "ticket" || actionId === "appeal") return ButtonStyle.Primary;
  return ButtonStyle.Secondary;
}

function discordSubTypeStyle(id: string) {
  if (id === "ban") return ButtonStyle.Danger;
  if (id === "timeout" || id === "mute") return ButtonStyle.Primary;
  return ButtonStyle.Secondary;
}

function missingRequiredFields(db: AppDatabase, draft: LogDraft) {
  const missing: string[] = [];
  if (!draft.actionName) missing.push("Action");
  if (!hasTarget(draft.targetInfo)) missing.push("Target");
  if (draft.actionName === "appeal" && !draft.appealResult) missing.push("Appeal Result");
  if (draft.actionName && TRANSCRIPT_REQUIRED_ACTIONS.has(draft.actionName) && !draft.transcriptUrl && !draft.nonTicketAction) missing.push("Transcript Link");
  return missing;
}

function addMediaLinks(draft: LogDraft, message: Message) {
  let added = 0;
  const alreadyHasProofForMessage = draft.mediaLinks.some((l) => l.sourceUrl === null && l.url === message.url);
  // Dedup: track CDN URLs already captured (prevents double-sends on duplicate message events)
  const existingSourceUrls = new Set(draft.mediaLinks.map((l) => l.sourceUrl).filter(Boolean));
  for (const attachment of message.attachments.values()) {
    if (draft.mediaLinks.length >= MAX_MEDIA_LINKS) break;
    if (existingSourceUrls.has(attachment.url)) continue; // already captured
    const kind = classifyAttachment(attachment);
    const label = nextMediaLabel(draft, kind);
    // Store the original attachment URL as sourceUrl; archiving updates url + clears sourceUrl
    draft.mediaLinks.push({ label, kind, url: message.url, sourceUrl: attachment.url });
    existingSourceUrls.add(attachment.url);
    added += 1;
  }
  // Add a permanent "Proof" jump-link to the original upload message.
  // sourceUrl is null so archiveMediaLinks skips it and the URL stays permanent.
  if (added > 0 && !alreadyHasProofForMessage) {
    const proofCount = draft.mediaLinks.filter((l) => l.sourceUrl === null).length + 1;
    const label = proofCount === 1 ? "Proof" : `Proof ${proofCount}`;
    draft.mediaLinks.push({ label, kind: "file", url: message.url, sourceUrl: null });
  }
  return added;
}

function classifyAttachment(attachment: Attachment): CaseMediaLink["kind"] {
  const contentType = attachment.contentType?.toLowerCase() ?? "";
  const name = attachment.name.toLowerCase();
  if (contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return "image";
  if (contentType.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(name)) return "video";
  return "file";
}

function nextMediaLabel(draft: LogDraft, kind: CaseMediaLink["kind"]) {
  const prefix = kind === "image" ? "Image" : kind === "video" ? "Video" : "File";
  const count = draft.mediaLinks.filter((link) => link.kind === kind).length + 1;
  return `${prefix} ${count}`;
}

function recoveryPromptPayload(draft: LogDraft) {
  const actionLabel = draft.actionDisplayName ?? draft.actionName ?? "Not selected";
  const targetLabel = draft.targetInfo.robloxUsername ?? draft.targetInfo.discordUsername ?? "Not set";

  if (draft.editCaseId) {
    const embed = new EmbedBuilder()
      .setTitle("✏️ Denied Log Ready to Edit")
      .setColor(0xe74c3c)
      .setDescription(
        `Your log (Case #${draft.editCaseId}) was denied. Your previous details are pre-loaded — edit what needs fixing and resubmit.\n\n` +
        `**Action:** ${actionLabel}\n` +
        `**Target:** ${targetLabel}`
      );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`log:${draft.id}:recover:resume`).setLabel("Edit & Resubmit").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`log:${draft.id}:recover:fresh`).setLabel("Start Fresh Instead").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`log:${draft.id}:recover:dismiss`).setLabel("Dismiss").setStyle(ButtonStyle.Danger)
    );
    return { content: "", embeds: [embed], components: [row] };
  }

  const ageMins = Math.round((Date.now() - draft.updatedAt) / 60_000);
  const embed = new EmbedBuilder()
    .setTitle("⚠️ Unfinished Log Recovered")
    .setColor(colors.voidPurple)
    .setDescription(
      `The bot restarted while you had a log in progress (${ageMins} minute${ageMins !== 1 ? "s" : ""} ago).\n\n` +
      `**Action:** ${actionLabel}\n` +
      `**Stage:** ${draft.stage}\n` +
      `**Target:** ${targetLabel}`
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`log:${draft.id}:recover:resume`).setLabel("Resume Log").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`log:${draft.id}:recover:fresh`).setLabel("Start Fresh").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`log:${draft.id}:recover:dismiss`).setLabel("Dismiss").setStyle(ButtonStyle.Danger)
  );
  return { content: "", embeds: [embed], components: [row] };
}

function touchDraft(draft: LogDraft) {
  draft.updatedAt = Date.now();
  saveDraftToDisk(draft);
  if (draft.timeout) clearTimeout(draft.timeout);
  draft.timeout = setTimeout(() => {
    void cancelDraft(draft, "Log automatically cancelled after 20 minutes of inactivity.").catch(() => null);
  }, SESSION_TTL_MS);
}

async function cancelDraft(draft: LogDraft, reason: string) {
  removeDraft(draft);
  if (!draft.editReply) return;
  const embed = new EmbedBuilder()
    .setTitle("Log Cancelled")
    .setColor(colors.charcoal)
    .setDescription(reason);
  await draft.editReply({
    content: reason,
    embeds: [embed],
    components: draftComponents(draft, true)
  }).catch(() => null);
}

function removeDraft(draft: LogDraft) {
  if (draft.timeout) clearTimeout(draft.timeout);
  draft.timeout = null;
  sessions.delete(draft.id);
  const key = sessionUserKey(draft.guildId, draft.userId);
  if (sessionsByUser.get(key) === draft.id) sessionsByUser.delete(key);
  deleteDraftFromDisk(draft.guildId, draft.userId);
}

function sessionUserKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}
