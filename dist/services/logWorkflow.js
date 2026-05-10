import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { buildCaseLogEmbed, createCase, effectiveActionPoints, formatLoggedActionName } from "./cases.js";
import { formatPoints, truncate } from "../utils/format.js";
import { caseLinkComponents } from "../utils/discord.js";
const sessions = new Map();
const sessionsByUser = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_MEDIA_LINKS = 20;
const logActions = [
    { id: "ban", label: "Ban", actionName: "ban", displayName: "Ban" },
    { id: "strike", label: "Strike", actionName: "strike", displayName: "Strike" },
    { id: "restore", label: "Restore", actionName: "restore", displayName: "Restore" },
    { id: "discord", label: "Discord", actionName: "discord", displayName: "Discord" },
    { id: "ticket", label: "Ticket", actionName: "ticket", displayName: "Ticket" },
    { id: "other", label: "Other", actionName: "other", displayName: "Other" }
];
export function resolveLogAction(value) {
    return logActions.find((action) => action.id === value || action.actionName === value) ?? null;
}
export async function startInteractiveLog(interaction, db, member) {
    const config = db.getGuildConfig(interaction.guild.id);
    await cancelPendingLogForUser(interaction.guild.id, member.id, "Previous pending log cancelled because you started a new log.");
    if (!config.interactiveLogEnabled) {
        await interaction.reply({
            content: "Interactive logging is disabled for this server. Use `/log action:` with typed fields instead.",
            ephemeral: true
        });
        return;
    }
    const draft = createDraft(interaction.guild.id, member.id, interaction.channelId);
    sessions.set(draft.id, draft);
    sessionsByUser.set(sessionUserKey(draft.guildId, draft.userId), draft.id);
    await interaction.reply({
        ...previewPayload(db, draft),
        ephemeral: true
    });
    draft.editReply = (payload) => interaction.editReply(payload);
    touchDraft(draft);
}
export async function cancelPendingLogForUser(guildId, userId, reason) {
    const draftId = sessionsByUser.get(sessionUserKey(guildId, userId));
    const draft = draftId ? sessions.get(draftId) : null;
    if (!draft)
        return false;
    await cancelDraft(draft, reason);
    return true;
}
export async function handleLogButton(db, interaction) {
    if (!interaction.customId.startsWith("log:"))
        return false;
    if (!interaction.guild || !interaction.member) {
        await interaction.reply({ content: "This button only works inside a server.", ephemeral: true });
        return true;
    }
    const [, sessionId, action, value] = interaction.customId.split(":");
    const draft = getDraft(sessionId, interaction);
    if (!draft)
        return true;
    if (action === "action") {
        const selected = resolveLogAction(value);
        if (!selected) {
            await interaction.reply({ content: "That log action is no longer available.", ephemeral: true });
            return true;
        }
        draft.actionName = selected.actionName;
        draft.actionDisplayName = selected.displayName;
        draft.stage = "confirm";
        draft.mediaCaptureEnabled = false;
        await interaction.update(previewPayload(db, draft));
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
        draft.stage = "select";
        draft.mediaCaptureEnabled = false;
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
export async function handleLogModal(db, interaction) {
    if (!interaction.customId.startsWith("log:"))
        return false;
    if (!interaction.guild || !interaction.member) {
        await interaction.reply({ content: "This form only works inside a server.", ephemeral: true });
        return true;
    }
    const [, sessionId, action, value] = interaction.customId.split(":");
    const draft = getDraft(sessionId, interaction);
    if (!draft)
        return true;
    if (action !== "save")
        return false;
    saveModalFields(draft, value ?? "info", interaction);
    if (interaction.isFromMessage()) {
        await interaction.update(previewPayload(db, draft));
    }
    else {
        await interaction.reply({ content: "Updated log draft.", ephemeral: true });
    }
    return true;
}
export async function handleLogMediaMessage(db, message) {
    if (!message.guild || message.author.bot || message.attachments.size === 0)
        return false;
    const draftId = sessionsByUser.get(sessionUserKey(message.guild.id, message.author.id));
    const draft = draftId ? sessions.get(draftId) : null;
    if (!draft || !draft.mediaCaptureEnabled || draft.channelId !== message.channelId)
        return false;
    if (draft.stage !== "fields")
        return false;
    if (Date.now() - draft.updatedAt > SESSION_TTL_MS) {
        await cancelDraft(draft, "Log automatically cancelled after 5 minutes of inactivity.");
        return false;
    }
    const added = addMediaLinks(draft, message);
    if (added === 0)
        return false;
    touchDraft(draft);
    if (draft.editReply) {
        await draft.editReply(previewPayload(db, draft)).catch(() => null);
    }
    return true;
}
function createDraft(guildId, userId, channelId) {
    return {
        id: randomUUID().replace(/-/g, "").slice(0, 12),
        guildId,
        userId,
        channelId,
        stage: "select",
        actionName: null,
        actionDisplayName: null,
        targetInfo: {},
        reason: null,
        evidence: null,
        notes: null,
        noAction: false,
        ticketId: null,
        transcriptUrl: null,
        mediaLinks: [],
        mediaCaptureEnabled: false,
        happenedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        timeout: null,
        editReply: null
    };
}
function getDraft(sessionId, interaction) {
    const draft = sessionId ? sessions.get(sessionId) : null;
    if (!draft) {
        void interaction.reply({ content: "That log draft expired. Run `/log` again.", ephemeral: true }).catch(() => null);
        return null;
    }
    if (Date.now() - draft.updatedAt > SESSION_TTL_MS) {
        void cancelDraft(draft, "Log automatically cancelled after 5 minutes of inactivity.").catch(() => null);
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
function previewPayload(db, draft) {
    const mediaLine = draft.stage === "fields"
        ? draft.mediaCaptureEnabled
            ? `Attach Media is on. Send image, video, or file evidence in this channel before Submit. Captured: ${draft.mediaLinks.length}/${MAX_MEDIA_LINKS}.`
            : "Use Attach Media to collect uploaded evidence as clickable message links."
        : null;
    const description = draft.stage === "select"
        ? "Step 1: choose the type of moderation log to create."
        : draft.stage === "confirm"
            ? "Step 2: confirm this log type, then continue or cancel."
            : "Step 3: fill the required fields, review the preview, then submit.";
    const fields = draft.stage === "fields"
        ? [
            { name: "Action", value: draft.actionName ? formatActionLine(db, draft) : "Pick an action with the buttons below.", inline: false },
            { name: "Target", value: truncate(formatDraftTarget(draft.targetInfo), 1000), inline: false },
            { name: "Information", value: truncate(formatDraftInformation(draft), 1000), inline: false }
        ]
        : [
            { name: "Action", value: draft.actionName ? formatActionLine(db, draft) : "No log type selected yet.", inline: false }
        ];
    const embed = new EmbedBuilder()
        .setTitle(draft.actionName ? `LOG PREVIEW ${formatLoggedActionName(draft.actionDisplayName ?? draft.actionName)}` : "Log Preview")
        .setColor(0x5865f2)
        .setDescription(description)
        .addFields(fields)
        .setFooter({ text: "Only one pending log can be active per user. Inactive drafts expire after 5 minutes." });
    return {
        content: [
            draft.stage === "select"
                ? "Choose a log type to begin."
                : draft.stage === "confirm"
                    ? "Log type selected. Press Next to fill the log fields, or Cancel to stop."
                    : "Build the log, review the preview, then press Submit.",
            mediaLine
        ].filter(Boolean).join("\n"),
        embeds: [embed],
        components: draftComponents(draft, false, db)
    };
}
function draftComponents(draft, disabled = false, db) {
    if (draft.stage === "select")
        return selectComponents(draft, disabled);
    if (draft.stage === "confirm")
        return confirmComponents(draft, disabled);
    const targetComplete = hasTarget(draft.targetInfo);
    const evidenceRequired = isEvidenceRequired(draft, db);
    const evidenceComplete = hasEvidence(draft);
    const actionTypeRequired = draft.actionName === "discord";
    const actionTypeComplete = Boolean(draft.actionDisplayName && draft.actionDisplayName.toLowerCase() !== "discord");
    return [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`log:${draft.id}:modal:target`).setLabel("Target").setStyle(requiredStyle(targetComplete)).setDisabled(disabled), new ButtonBuilder().setCustomId(`log:${draft.id}:modal:evidence`).setLabel("Evidence").setStyle(requiredStyle(evidenceComplete, evidenceRequired)).setDisabled(disabled), new ButtonBuilder().setCustomId(`log:${draft.id}:modal:info`).setLabel("Info").setStyle(ButtonStyle.Primary).setDisabled(disabled), new ButtonBuilder().setCustomId(`log:${draft.id}:modal:details`).setLabel("Details").setStyle(ButtonStyle.Secondary).setDisabled(disabled), ...(actionTypeRequired
            ? [new ButtonBuilder().setCustomId(`log:${draft.id}:modal:action`).setLabel("Action Type").setStyle(requiredStyle(actionTypeComplete, true)).setDisabled(disabled)]
            : [])),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`log:${draft.id}:media`).setLabel(draft.mediaCaptureEnabled ? "Attach Media On" : "Attach Media").setStyle(draft.mediaCaptureEnabled ? ButtonStyle.Success : ButtonStyle.Primary).setDisabled(disabled), new ButtonBuilder().setCustomId(`log:${draft.id}:submit`).setLabel("Submit").setStyle(ButtonStyle.Success).setDisabled(disabled), new ButtonBuilder().setCustomId(`log:${draft.id}:back`).setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(disabled), new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled))
    ];
}
function selectComponents(draft, disabled = false) {
    return [
        new ActionRowBuilder().addComponents(...logActions.slice(0, 5).map((action) => new ButtonBuilder()
            .setCustomId(`log:${draft.id}:action:${action.id}`)
            .setLabel(action.label)
            .setStyle(actionButtonStyle(action.id))
            .setDisabled(disabled))),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`log:${draft.id}:action:other`).setLabel("Other").setStyle(actionButtonStyle("other")).setDisabled(disabled))
    ];
}
function confirmComponents(draft, disabled = false) {
    return [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`log:${draft.id}:next`).setLabel("Next").setStyle(ButtonStyle.Primary).setDisabled(disabled), new ButtonBuilder().setCustomId(`log:${draft.id}:cancel`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled))
    ];
}
function buildModal(draft, modalType) {
    if (modalType === "target") {
        return new ModalBuilder()
            .setCustomId(`log:${draft.id}:save:target`)
            .setTitle("Log Target")
            .addComponents(textRow("roblox_user", "RobloxUser", draft.targetInfo.robloxUsername, false), textRow("roblox_id", "RobloxID", draft.targetInfo.robloxId, false), textRow("discord_user", "DiscordUser mention/name", draft.targetInfo.discordUsername, false), textRow("discord_id", "DiscordID", draft.targetInfo.discordId, false));
    }
    if (modalType === "details") {
        return new ModalBuilder()
            .setCustomId(`log:${draft.id}:save:details`)
            .setTitle("Log Details")
            .addComponents(textRow("ticket_id", "Ticket ID", draft.ticketId, false), textRow("transcript_link", "TranscriptLink", draft.transcriptUrl, false), textRow("happened_at", "Happened At", draft.happenedAt, false), textRow("no_action", "No Action? yes/no", draft.noAction ? "yes" : "no", false));
    }
    if (modalType === "action") {
        return new ModalBuilder()
            .setCustomId(`log:${draft.id}:save:action`)
            .setTitle("Action Type")
            .addComponents(textRow("action_type", "Action Type", draft.actionDisplayName, true));
    }
    if (modalType === "evidence") {
        return buildEvidenceModal(draft);
    }
    return new ModalBuilder()
        .setCustomId(`log:${draft.id}:save:info`)
        .setTitle("Log Information")
        .addComponents(textRow("reason", "Reason", draft.reason, false, TextInputStyle.Paragraph), textRow("notes", "Notes", draft.notes, false, TextInputStyle.Paragraph));
}
function textRow(customId, label, value, required = false, style = TextInputStyle.Short) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required);
    if (value)
        input.setValue(value.slice(0, style === TextInputStyle.Paragraph ? 4000 : 400));
    return new ActionRowBuilder().addComponents(input);
}
function saveModalFields(draft, modalType, interaction) {
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
        draft.ticketId = clean(interaction.fields.getTextInputValue("ticket_id"));
        draft.transcriptUrl = clean(interaction.fields.getTextInputValue("transcript_link"));
        draft.happenedAt = clean(interaction.fields.getTextInputValue("happened_at"));
        draft.noAction = /^(y(es)?|true|1)$/i.test(clean(interaction.fields.getTextInputValue("no_action")) ?? "");
        return;
    }
    if (modalType === "action") {
        draft.actionDisplayName = clean(interaction.fields.getTextInputValue("action_type"));
        if (!draft.actionName)
            draft.actionName = "other";
        return;
    }
    if (modalType === "evidence") {
        draft.evidence = clean(interaction.fields.getTextInputValue("evidence"));
        return;
    }
    draft.reason = clean(interaction.fields.getTextInputValue("reason"));
    draft.notes = clean(interaction.fields.getTextInputValue("notes"));
}
async function submitDraft(db, interaction, draft) {
    const missing = missingRequiredFields(db, draft);
    if (missing.length > 0) {
        await interaction.reply({ content: `Finish the required fields before submitting: ${missing.join(", ")}.`, ephemeral: true });
        return;
    }
    const actionName = draft.actionName;
    const evidence = draft.evidence
        ?? (draft.mediaLinks.length > 0 ? `Media evidence: ${draft.mediaLinks.map((link) => link.label).join(", ")}` : null)
        ?? (draft.transcriptUrl ? "See transcript." : null);
    const record = await createCase(db, {
        guild: interaction.guild,
        targetInfo: draft.targetInfo,
        moderator: interaction.member,
        actionName,
        actionDisplayName: draft.actionDisplayName,
        reason: draft.reason ?? "No reason provided.",
        evidence,
        notes: draft.notes,
        noAction: draft.noAction,
        ticketId: draft.ticketId,
        transcriptUrl: draft.transcriptUrl,
        mediaLinks: draft.mediaLinks,
        happenedAt: draft.happenedAt
    });
    removeDraft(draft);
    const pointsEnabled = db.getGuildConfig(draft.guildId).pointsEnabled;
    await interaction.update({
        content: pointsEnabled ? `Submitted case #${record.id} for ${formatPoints(record.awardedPointsMilli)} points.` : `Submitted case #${record.id}.`,
        embeds: [buildCaseLogEmbed(record, { showPoints: pointsEnabled })],
        components: caseLinkComponents(record.transcriptUrl, record.mediaLinks)
    });
}
function formatActionLine(db, draft) {
    if (!draft.actionName)
        return "None";
    const action = db.getAction(draft.guildId, draft.actionName);
    if (!action)
        return `${draft.actionDisplayName ?? draft.actionName} (preset missing)`;
    if (!db.getGuildConfig(draft.guildId).pointsEnabled)
        return `${draft.actionDisplayName ?? action.displayName}`;
    const points = effectiveActionPoints(action);
    const amount = draft.noAction ? points.noActionPointsMilli : points.basePointsMilli;
    const override = points.overrideActive ? ` temporary override${points.overrideEndsAt ? ` until ${points.overrideEndsAt}` : ""}` : "";
    return `${draft.actionDisplayName ?? action.displayName} - ${formatPoints(amount)} points${override}`;
}
function formatDraftTarget(target) {
    const lines = [
        target.robloxUsername ? `RobloxUser: ${target.robloxUsername}` : null,
        target.robloxId ? `RobloxID: ${target.robloxId}` : null,
        target.discordUsername ? `DiscordUser: ${target.discordUsername}` : null,
        target.discordId ? `DiscordID: ${target.discordId}` : null
    ].filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : "No target set yet.";
}
function formatDraftInformation(draft) {
    return [
        `Reason: ${draft.reason ?? "None"}`,
        `Evidence: ${draft.evidence ?? "None"}`,
        draft.mediaLinks.length > 0 ? `Media: ${draft.mediaLinks.map((link) => link.label).join(", ")}` : null,
        `Notes: ${draft.notes ?? "None"}`,
        `No Action: ${draft.noAction ? "Yes" : "No"}`,
        draft.ticketId ? `Ticket ID: ${draft.ticketId}` : null,
        draft.transcriptUrl ? "Transcript: will show as a button" : null,
        draft.happenedAt ? `Happened At: ${draft.happenedAt}` : null
    ].filter(Boolean).join("\n");
}
function clean(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, 500) : null;
}
function extractDiscordId(value) {
    return value?.match(/\d{15,25}/)?.[0] ?? null;
}
function buildEvidenceModal(draft) {
    return new ModalBuilder()
        .setCustomId(`log:${draft.id}:save:evidence`)
        .setTitle("Log Evidence")
        .addComponents(textRow("evidence", "Evidence", draft.evidence, false, TextInputStyle.Paragraph));
}
function hasTarget(target) {
    return Boolean(target.robloxUsername || target.robloxId || target.discordUsername || target.discordId);
}
function hasEvidence(draft) {
    return Boolean(draft.evidence || draft.transcriptUrl || draft.mediaLinks.length > 0);
}
function isEvidenceRequired(draft, db) {
    const configured = draft.actionName && db ? db.getAction(draft.guildId, draft.actionName) : null;
    if (configured)
        return configured.evidenceRequired;
    return draft.actionName === "ban" || draft.actionName === "strike" || draft.actionName === "restore" || draft.actionName === "discord";
}
function requiredStyle(complete, required = true) {
    return required && !complete ? ButtonStyle.Danger : ButtonStyle.Success;
}
function actionButtonStyle(actionId) {
    if (actionId === "ban" || actionId === "strike")
        return ButtonStyle.Danger;
    if (actionId === "restore")
        return ButtonStyle.Success;
    if (actionId === "discord" || actionId === "ticket")
        return ButtonStyle.Primary;
    return ButtonStyle.Secondary;
}
function missingRequiredFields(db, draft) {
    const missing = [];
    if (!draft.actionName)
        missing.push("Action");
    if (!hasTarget(draft.targetInfo))
        missing.push("Target");
    if (draft.actionName === "discord" && (!draft.actionDisplayName || draft.actionDisplayName.toLowerCase() === "discord")) {
        missing.push("Action Type");
    }
    const action = draft.actionName ? db.getAction(draft.guildId, draft.actionName) : null;
    if ((action?.evidenceRequired ?? isEvidenceRequired(draft, db)) && !hasEvidence(draft)) {
        missing.push("Evidence");
    }
    return missing;
}
function addMediaLinks(draft, message) {
    let added = 0;
    for (const attachment of message.attachments.values()) {
        if (draft.mediaLinks.length >= MAX_MEDIA_LINKS)
            break;
        const kind = classifyAttachment(attachment);
        const label = nextMediaLabel(draft, kind);
        draft.mediaLinks.push({ label, kind, url: message.url });
        added += 1;
    }
    return added;
}
function classifyAttachment(attachment) {
    const contentType = attachment.contentType?.toLowerCase() ?? "";
    const name = attachment.name.toLowerCase();
    if (contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name))
        return "image";
    if (contentType.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(name))
        return "video";
    return "file";
}
function nextMediaLabel(draft, kind) {
    const prefix = kind === "image" ? "Image" : kind === "video" ? "Video" : "File";
    const count = draft.mediaLinks.filter((link) => link.kind === kind).length + 1;
    return `${prefix} ${count}`;
}
function touchDraft(draft) {
    draft.updatedAt = Date.now();
    if (draft.timeout)
        clearTimeout(draft.timeout);
    draft.timeout = setTimeout(() => {
        void cancelDraft(draft, "Log automatically cancelled after 5 minutes of inactivity.").catch(() => null);
    }, SESSION_TTL_MS);
}
async function cancelDraft(draft, reason) {
    removeDraft(draft);
    if (!draft.editReply)
        return;
    const embed = new EmbedBuilder()
        .setTitle("Log Cancelled")
        .setColor(0x95a5a6)
        .setDescription(reason);
    await draft.editReply({
        content: reason,
        embeds: [embed],
        components: draftComponents(draft, true)
    }).catch(() => null);
}
function removeDraft(draft) {
    if (draft.timeout)
        clearTimeout(draft.timeout);
    draft.timeout = null;
    sessions.delete(draft.id);
    const key = sessionUserKey(draft.guildId, draft.userId);
    if (sessionsByUser.get(key) === draft.id)
        sessionsByUser.delete(key);
}
function sessionUserKey(guildId, userId) {
    return `${guildId}:${userId}`;
}
