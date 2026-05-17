/**
 * playerData.ts — session-based /data command.
 *
 * Pulls a player's full DataStore profile, displays it in an embed, and lets
 * the user queue multiple stat edits before submitting them all at once.
 * Online players receive live MessagingService edits; offline players get a
 * DataStore read-modify-write.
 */

import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { AppDatabase } from "../db.js";
import {
  lookupRobloxUser,
  readProfileStoreEntry,
  sendDataEdit,
  setNestedValue,
  writeProfileStoreEntry,
} from "./roblox.js";
import { writeAuditAndPost } from "./audit.js";

// ── Session ──────────────────────────────────────────────────────────────────

type DataSession = {
  id: string;
  guildId: string;
  userId: string;
  robloxUserId: number;
  robloxUsername: string;
  gameUniverseId: string;
  gameApiKey: string;
  /** Full DataStore envelope returned by readProfileStoreEntry */
  entry: Record<string, unknown>;
  /** Current active slot object (used for path validation and display) */
  slot: Record<string, unknown>;
  isOnline: boolean;
  /** Stat-path → parsed value, queued until Submit */
  pendingEdits: Map<string, unknown>;
  timeout: NodeJS.Timeout;
};

const sessions = new Map<string, DataSession>();

function clearSession(id: string) {
  const s = sessions.get(id);
  if (s) {
    clearTimeout(s.timeout);
    sessions.delete(id);
  }
}

// ── Embed / component builders ───────────────────────────────────────────────

// ── Dynamic data rendering ───────────────────────────────────────────────────

/** Format a leaf value for display in an embed. */
function fv(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return val.length ? val : "—";
  if (Array.isArray(val)) {
    if (val.length === 0) return "(empty)";
    // Primitive arrays → inline list
    if (val.every((v) => typeof v !== "object" || v === null)) {
      const joined = val.map((v) => fv(v)).join(", ");
      return joined.length > 80 ? joined.slice(0, 80) + "…" : joined;
    }
    return `(${val.length} items)`;
  }
  // Fallback for anything unexpected
  const s = JSON.stringify(val);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

/**
 * Render a nested object as formatted lines, up to `maxDepth` levels deep.
 * Sub-objects beyond the depth limit are shown as "(object)".
 */
function renderObject(obj: Record<string, unknown>, depth = 0, maxDepth = 2): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];

  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < maxDepth) {
      lines.push(`${indent}**${k}**`);
      lines.push(renderObject(v as Record<string, unknown>, depth + 1, maxDepth));
    } else {
      lines.push(`${indent}${k}: **${fv(v)}**`);
    }
  }

  return lines.join("\n");
}

/**
 * Walk the slot's top-level keys and build embed fields dynamically.
 * - Nested objects each become their own inline field.
 * - Top-level primitives (and arrays) are grouped into a single "Values" field.
 * Respects Discord's 25-field and 1024-char-per-field limits.
 */
function buildDynamicFields(slot: Record<string, unknown>): { name: string; value: string; inline: boolean }[] {
  const objectFields: { name: string; value: string; inline: boolean }[] = [];
  const primitiveLines: string[] = [];

  for (const [key, val] of Object.entries(slot)) {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      let rendered = renderObject(val as Record<string, unknown>);
      if (rendered.length > 1020) rendered = rendered.slice(0, 1020) + "…";
      objectFields.push({ name: key, value: rendered || "—", inline: true });
    } else {
      primitiveLines.push(`**${key}:** ${fv(val)}`);
    }
  }

  const fields: { name: string; value: string; inline: boolean }[] = [];

  // Primitives first (usually things like Level, Gold, Banned — high-value metadata)
  if (primitiveLines.length > 0) {
    let text = primitiveLines.join("\n");
    if (text.length > 1020) text = text.slice(0, 1020) + "…";
    fields.push({ name: "📋 Values", value: text, inline: false });
  }

  // Object fields after, capped at 24 total (leave one slot for Pending Edits)
  for (const f of objectFields) {
    if (fields.length >= 24) break;
    fields.push(f);
  }

  return fields;
}

function buildDataEmbed(session: DataSession): EmbedBuilder {
  const { slot, robloxUsername, isOnline, pendingEdits } = session;

  const embed = new EmbedBuilder()
    .setTitle(`📊 Player Data — ${robloxUsername}`)
    .setColor(0x5865f2)
    .setFooter({
      text: isOnline
        ? "🟢 Online — edits will be applied live"
        : "🔴 Offline — edits will save to DataStore",
    });

  const dataFields = buildDynamicFields(slot);
  if (dataFields.length === 0) {
    embed.setDescription("*(No data found in this slot)*");
  } else {
    embed.addFields(dataFields);
  }

  if (pendingEdits.size > 0) {
    const lines = Array.from(pendingEdits.entries())
      .map(([path, val]) => `\`${path}\` → \`${String(val)}\``)
      .join("\n");
    embed.addFields({ name: `📝 Pending Edits (${pendingEdits.size})`, value: lines });
  }

  return embed;
}

function buildDataButtons(session: DataSession): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`data_edit:${session.id}`)
        .setLabel("Edit Stat")
        .setEmoji("✏️")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`data_submit:${session.id}`)
        .setLabel("Submit")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
        .setDisabled(session.pendingEdits.size === 0),
      new ButtonBuilder()
        .setCustomId(`data_cancel:${session.id}`)
        .setLabel("Cancel")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── Command handler ──────────────────────────────────────────────────────────

export async function handleDataCommand(
  interaction: ChatInputCommandInteraction,
  db: AppDatabase,
  game: { universeId: string; apiKey: string }
) {
  const username = interaction.options.getString("roblox_user", true).trim();

  await interaction.deferReply({ ephemeral: true });

  // ── Look up Roblox user ───────────────────────────────────────────────────
  const robloxUser = await lookupRobloxUser(username);
  if (!robloxUser) {
    await interaction.editReply(
      `❌ Roblox user \`${username}\` not found. Check the spelling and try again.`
    );
    return;
  }

  // ── Read DataStore entry ──────────────────────────────────────────────────
  const readResult = await readProfileStoreEntry({
    universeId: game.universeId,
    apiKey:     game.apiKey,
    userId:     robloxUser.id,
  });

  if (!readResult.success) {
    if (readResult.notFound) {
      await interaction.editReply(
        `❌ **${robloxUser.name}** has no saved data (they may have never joined the game).`
      );
      return;
    }
    // Build a diagnostic error message so the user knows exactly what failed
    const status   = readResult.httpStatus ?? "?";
    const body     = readResult.rawBody ?? readResult.error;
    const universe = readResult.universeId ?? game.universeId;
    const store    = readResult.datastoreName ?? "Verdict01";
    await interaction.editReply(
      `❌ DataStore read failed (**HTTP ${status}**)\n` +
      `\`\`\`${body.slice(0, 300)}\`\`\`` +
      `**What to check in Roblox Creator Hub → API Keys:**\n` +
      `1. Under **Data Store** permissions, make sure both **"Read Entries"** and **"Update Entries"** are ticked.\n` +
      `2. Under each of those permissions, your universe (\`${universe}\`) must be listed — the permission type alone isn't enough, you also have to add the specific universe.\n` +
      `3. The DataStore name used is \`${store}\` — make sure it matches what your game passes to \`ProfileStore.New()\`.\n` +
      `-# See the bot console log for the full API response.`
    );
    return;
  }

  const entry    = readResult.data as Record<string, unknown>;
  const metaData = entry.MetaData as Record<string, unknown> | undefined;
  const isOnline = !!metaData?.ActiveSession;

  // ── Extract current slot ──────────────────────────────────────────────────
  const profileData = entry.Data as Record<string, unknown> | undefined;
  if (!profileData || !Array.isArray(profileData.Slots)) {
    await interaction.editReply(`❌ Unexpected DataStore format — could not parse player data.`);
    return;
  }

  const slotIndex = (typeof profileData.Current_Slot === "number" ? profileData.Current_Slot : 1) - 1;
  const slots     = profileData.Slots as Array<Record<string, unknown>>;
  const slot      = slots[slotIndex];
  if (!slot) {
    await interaction.editReply(`❌ Could not find the current slot in player data.`);
    return;
  }

  // ── Create session ────────────────────────────────────────────────────────
  const sessionId = randomUUID();
  const session: DataSession = {
    id:             sessionId,
    guildId:        interaction.guildId!,
    userId:         interaction.user.id,
    robloxUserId:   robloxUser.id,
    robloxUsername: robloxUser.name,
    gameUniverseId: game.universeId,
    gameApiKey:     game.apiKey,
    entry,
    slot,
    isOnline,
    pendingEdits:   new Map(),
    timeout:        setTimeout(() => sessions.delete(sessionId), 15 * 60 * 1000),
  };
  sessions.set(sessionId, session);

  await interaction.editReply({
    embeds:     [buildDataEmbed(session)],
    components: buildDataButtons(session),
  });
}

// ── Button handler ───────────────────────────────────────────────────────────

export async function handleDataButton(
  db: AppDatabase,
  interaction: ButtonInteraction
): Promise<boolean> {
  const { customId } = interaction;

  // ── Edit Stat button ──────────────────────────────────────────────────────
  if (customId.startsWith("data_edit:")) {
    const sessionId = customId.slice("data_edit:".length);
    const session   = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({ content: "❌ Session expired — use `/data` again.", ephemeral: true });
      return true;
    }
    if (session.userId !== interaction.user.id) {
      await interaction.reply({ content: "❌ This is not your session.", ephemeral: true });
      return true;
    }

    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(`data_stat_modal:${sessionId}`)
        .setTitle("Edit Player Stat")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("stat_path")
              .setLabel("Stat path  (e.g. Stats.Elo, Player.Clan)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(100)
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("stat_value")
              .setLabel("New value  (number, true/false, or text)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(200)
          ),
        )
    );
    return true;
  }

  // ── Submit button ─────────────────────────────────────────────────────────
  if (customId.startsWith("data_submit:")) {
    const sessionId = customId.slice("data_submit:".length);
    const session   = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({ content: "❌ Session expired.", ephemeral: true });
      return true;
    }
    if (session.userId !== interaction.user.id) {
      await interaction.reply({ content: "❌ This is not your session.", ephemeral: true });
      return true;
    }
    if (session.pendingEdits.size === 0) {
      await interaction.reply({ content: "No edits to submit yet.", ephemeral: true });
      return true;
    }

    await interaction.deferUpdate();

    const guild        = interaction.guild!;
    const summaryLines: string[] = [];

    if (session.isOnline) {
      // Player is currently online — push via MessagingService
      for (const [path, val] of session.pendingEdits) {
        await sendDataEdit(session.gameUniverseId, session.gameApiKey, session.robloxUserId, path, val);
        summaryLines.push(`\`${path}\` → \`${String(val)}\``);
      }
      await writeAuditAndPost(db, guild, interaction.user.id, "data.edit", {
        robloxUserId:   String(session.robloxUserId),
        robloxUsername: session.robloxUsername,
        edits:          Object.fromEntries(
          Array.from(session.pendingEdits.entries()).map(([k, v]) => [k, String(v)])
        ),
        method: "live (player online)",
      });

    } else {
      // Player is offline — re-read DataStore, apply all edits, write back
      const fresh = await readProfileStoreEntry({
        universeId: session.gameUniverseId,
        apiKey:     session.gameApiKey,
        userId:     session.robloxUserId,
      });

      if (!fresh.success) {
        await interaction.editReply({
          embeds:     [new EmbedBuilder().setColor(0xff0000).setDescription(`❌ Re-read failed: ${fresh.error}`)],
          components: buildDataButtons(session),
        });
        return true;
      }

      const freshEntry = fresh.data as Record<string, unknown>;
      const freshMeta  = freshEntry.MetaData as Record<string, unknown> | undefined;

      if (freshMeta?.ActiveSession) {
        // Player came online while session was open — switch to live edits
        session.isOnline = true;
        for (const [path, val] of session.pendingEdits) {
          await sendDataEdit(session.gameUniverseId, session.gameApiKey, session.robloxUserId, path, val);
          summaryLines.push(`\`${path}\` → \`${String(val)}\` *(live — player came online)*`);
        }
      } else {
        const freshProfile = freshEntry.Data as Record<string, unknown> | undefined;
        const freshSlots   = Array.isArray(freshProfile?.Slots)
          ? (freshProfile!.Slots as Array<Record<string, unknown>>)
          : [];
        const freshSlotIdx = (typeof freshProfile?.Current_Slot === "number"
          ? freshProfile!.Current_Slot
          : 1) - 1;
        const freshSlot = freshSlots[freshSlotIdx];

        if (!freshSlot) {
          await interaction.editReply({
            embeds:     [new EmbedBuilder().setColor(0xff0000).setDescription("❌ Could not locate slot in fresh data.")],
            components: [],
          });
          clearSession(sessionId);
          return true;
        }

        for (const [path, val] of session.pendingEdits) {
          const ok = setNestedValue(freshSlot, path, val);
          summaryLines.push(
            ok
              ? `\`${path}\` → \`${String(val)}\``
              : `\`${path}\` → ❌ invalid path (skipped)`
          );
        }

        const writeResult = await writeProfileStoreEntry({
          universeId: session.gameUniverseId,
          apiKey:     session.gameApiKey,
          userId:     session.robloxUserId,
          entry:      freshEntry,
        });

        if (!writeResult.success) {
          await interaction.editReply({
            embeds:     [new EmbedBuilder().setColor(0xff0000).setDescription(`❌ Save failed: ${writeResult.error}`)],
            components: buildDataButtons(session),
          });
          return true;
        }
      }

      await writeAuditAndPost(db, guild, interaction.user.id, "data.edit", {
        robloxUserId:   String(session.robloxUserId),
        robloxUsername: session.robloxUsername,
        edits:          Object.fromEntries(
          Array.from(session.pendingEdits.entries()).map(([k, v]) => [k, String(v)])
        ),
        method: session.isOnline ? "live (player came online)" : "datastore (player offline)",
      });
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`✅ Changes Saved — ${session.robloxUsername}`)
          .setColor(0x57f287)
          .setDescription(summaryLines.join("\n"))
          .setFooter({
            text: session.isOnline
              ? "Applied live (player was online)"
              : "Saved to DataStore (player was offline)",
          })
          .setTimestamp(),
      ],
      components: [],
    });
    clearSession(sessionId);
    return true;
  }

  // ── Cancel button ─────────────────────────────────────────────────────────
  if (customId.startsWith("data_cancel:")) {
    const sessionId = customId.slice("data_cancel:".length);
    const session   = sessions.get(sessionId);
    if (!session) {
      await interaction.update({ content: "Session already closed.", embeds: [], components: [] });
      return true;
    }
    if (session.userId !== interaction.user.id) {
      await interaction.reply({ content: "❌ This is not your session.", ephemeral: true });
      return true;
    }
    clearSession(sessionId);
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setDescription("❌ Data session cancelled — no changes were made."),
      ],
      components: [],
    });
    return true;
  }

  return false;
}

// ── Modal handler ────────────────────────────────────────────────────────────

function parseDataValue(raw: string): unknown {
  const trimmed = raw.trim();
  const lower   = trimmed.toLowerCase();
  if (lower === "true")  return true;
  if (lower === "false") return false;
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== "") return num;
  return trimmed;
}

export async function handleDataModal(
  db: AppDatabase,
  interaction: ModalSubmitInteraction
): Promise<boolean> {
  const { customId } = interaction;

  if (!customId.startsWith("data_stat_modal:")) return false;

  const sessionId = customId.slice("data_stat_modal:".length);
  const session   = sessions.get(sessionId);
  if (!session) {
    await interaction.reply({ content: "❌ Session expired — use `/data` again.", ephemeral: true });
    return true;
  }
  if (session.userId !== interaction.user.id) {
    await interaction.reply({ content: "❌ This is not your session.", ephemeral: true });
    return true;
  }

  const statPath = interaction.fields.getTextInputValue("stat_path").trim();
  const rawValue = interaction.fields.getTextInputValue("stat_value");
  const value    = parseDataValue(rawValue);

  // Validate path against a deep-clone so we never corrupt the stored slot
  const testSlot = JSON.parse(JSON.stringify(session.slot)) as Record<string, unknown>;
  if (!setNestedValue(testSlot, statPath, value)) {
    await interaction.reply({
      content:
        `❌ Stat path \`${statPath}\` is invalid — an intermediate key doesn't exist.\n` +
        `-# Examples: \`Stats.Elo\`, \`Player.Clan\`, \`Player.Appearance.EyeColor\`, \`LastHealth\`, \`Banned\``,
      ephemeral: true,
    });
    return true;
  }

  session.pendingEdits.set(statPath, value);

  // Update the original ephemeral reply to show the new pending edit
  await interaction.deferUpdate();
  await interaction.editReply({
    embeds:     [buildDataEmbed(session)],
    components: buildDataButtons(session),
  });

  return true;
}
