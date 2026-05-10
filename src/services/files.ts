import fs from "node:fs/promises";
import path from "node:path";
import type { AppDatabase } from "../db.js";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function createBackup(db: AppDatabase, backupDir: string) {
  await fs.mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `mod-ledger-${stamp()}.sqlite`);
  const escaped = backupPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}';`);
  return backupPath;
}

export async function exportTable(db: AppDatabase, exportDir: string, guildId: string, table: "cases" | "points" | "quotas" | "tickets") {
  await fs.mkdir(exportDir, { recursive: true });
  const filePath = path.join(exportDir, `${table}-${stamp()}.json`);
  const rows = readRows(db, guildId, table);
  await fs.writeFile(filePath, JSON.stringify(rows, null, 2), "utf8");
  return { filePath, rows };
}

function readRows(db: AppDatabase, guildId: string, table: "cases" | "points" | "quotas" | "tickets") {
  switch (table) {
    case "cases":
      return db.all("SELECT * FROM moderation_cases WHERE guild_id = ? ORDER BY id ASC", guildId);
    case "points":
      return db.all("SELECT * FROM point_ledger WHERE guild_id = ? ORDER BY id ASC", guildId);
    case "quotas":
      return db.all("SELECT * FROM quota_reports WHERE guild_id = ? ORDER BY id ASC", guildId);
    case "tickets":
      return db.all("SELECT * FROM pending_ticket_logs WHERE guild_id = ? ORDER BY id ASC", guildId);
  }
}
