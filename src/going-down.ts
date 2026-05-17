/**
 * going-down.ts — standalone script run by restart-bot.ps1 before killing the bot.
 * Logs in, calls postGoingDown, then exits cleanly.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { AppDatabase } from "./db.js";
import { readEnv } from "./env.js";
import { postGoingDown } from "./services/startupAnnouncement.js";

const env = readEnv();
const db = new AppDatabase(env.databasePath, env.defaultTimezone);
const dataDir = path.dirname(env.databasePath);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Read update notes from a temp file written by restart-bot.ps1.
// Using a file instead of argv avoids multi-line strings being truncated
// when PowerShell passes them to Node via Start-Process -ArgumentList.
const pendingNotesPath = path.join(dataDir, "pending-update-notes.txt");
let updateNotes: string | undefined;
if (fs.existsSync(pendingNotesPath)) {
  const raw = fs.readFileSync(pendingNotesPath, "utf8").trim();
  if (raw) updateNotes = raw;
  fs.unlinkSync(pendingNotesPath);
} else {
  updateNotes = process.argv[2] || undefined;
}

client.once(Events.ClientReady, async (readyClient) => {
  await postGoingDown(db, readyClient, dataDir, updateNotes);
  console.log("Going-down announcement done.");
  db.close();
  client.destroy();
  process.exit(0);
});

setTimeout(() => {
  console.warn("going-down.js timed out — writing signal without message IDs.");
  fs.writeFileSync(path.join(dataDir, "restart-signal.json"), JSON.stringify({ reason: "update", exitTime: new Date().toISOString() }), "utf8");
  db.close();
  process.exit(0);
}, 15_000);

client.login(env.discordToken).catch((err) => {
  console.warn("going-down.js login failed:", err);
  process.exit(0);
});
