/**
 * Slash-command "please gate" — randomly requires mods to say "please"
 * before Steward executes a cross-server command.
 *
 * Usage in a command handler:
 *   if (await slashPleaseGate(interaction, async (send) => { ...logic...; await send("✅ Done"); })) return;
 *   await interaction.deferReply({ ephemeral: true });
 *   ...normal execution...
 */

import type { ChatInputCommandInteraction, Message } from "discord.js";
import type { AppDatabase } from "../db.js";

const GATE_CHANCE = 0.35;

const PLEASE_DEMANDS = [
  "Beg me to do it, mongrel. Say **please**.",
  "You dare command me without so much as a **please**? How uncouth.",
  "I don't move for free. Say **please** and perhaps I'll consider it.",
  "**Please**, worm. One word and I shall comply.",
  "You expect me to simply obey? Say **please**, if you can manage it.",
  "The word you're looking for is **please**. Use it.",
  "I'm waiting. **Please** — it's not difficult.",
  "Manners first, orders second. Say **please**.",
  "How quaint — you believe I'm at your beck and call. **Please**, and I might play along."
];

const PLEASE_GRANTED = [
  "...Fine. Since you asked so nicely.",
  "There we go. Was that so hard?",
  "Barely sufficient, but I'll allow it.",
  "Good. Don't forget it next time.",
  "At long last. Proceeding.",
  "Civility. How refreshing. Continuing.",
  "Your manners improve marginally. Executing."
];

type SendFn = (text: string) => Promise<void>;
type GatedExec = (send: SendFn) => Promise<void>;

type PendingEntry = {
  exec: GatedExec;
  timeout: ReturnType<typeof setTimeout>;
  channelId: string;
  guildId: string;
};

const pending = new Map<string, PendingEntry>();

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Apply the please gate to a slash command.
 * Returns true if the gate triggered (caller should return without executing).
 * Returns false if no gate — caller should proceed with normal execution.
 * Pass funBehaviorEnabled=false to skip the gate entirely.
 */
export async function slashPleaseGate(
  interaction: ChatInputCommandInteraction,
  execute: GatedExec,
  funBehaviorEnabled = true
): Promise<boolean> {
  if (!funBehaviorEnabled) return false;
  if (Math.random() >= GATE_CHANCE) return false;

  const demand = pick(PLEASE_DEMANDS);
  await interaction.reply({ content: `<@${interaction.user.id}> ${demand}` }).catch(() => null);

  const existing = pending.get(interaction.user.id);
  if (existing) clearTimeout(existing.timeout);

  const timeout = setTimeout(() => {
    pending.delete(interaction.user.id);
  }, 60_000);

  pending.set(interaction.user.id, {
    exec: execute,
    timeout,
    channelId: interaction.channelId,
    guildId: interaction.guildId ?? ""
  });

  return true;
}

/**
 * Call this from MessageCreate. Returns true if the message resolved a pending gate
 * (so you can skip further processing if desired).
 */
export async function checkSlashPlease(db: AppDatabase, message: Message): Promise<boolean> {
  if (message.author.bot) return false;
  const entry = pending.get(message.author.id);
  if (!entry) return false;
  if (!/\bplease\b/i.test(message.content)) return false;
  if (message.channelId !== entry.channelId) return false;

  // If fun behavior was disabled after the gate was set, cancel silently
  if (entry.guildId && !db.getGuildConfig(entry.guildId).funBehaviorEnabled) {
    pending.delete(message.author.id);
    clearTimeout(entry.timeout);
    return false;
  }

  pending.delete(message.author.id);
  clearTimeout(entry.timeout);

  const granted = pick(PLEASE_GRANTED);
  await message.reply(granted).catch(() => null);

  const ch = message.channel;
  const send: SendFn = async (text) => {
    if ("send" in ch) await (ch as import("discord.js").TextChannel).send(text).catch(() => null);
  };

  await entry.exec(send);
  return true;
}
