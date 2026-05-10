import "dotenv/config";
import path from "node:path";
function boolFromEnv(value, fallback = false) {
    if (!value)
        return fallback;
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
export function readEnv() {
    const cwd = process.cwd();
    const discordToken = process.env.DISCORD_TOKEN ?? "";
    const discordClientId = process.env.DISCORD_CLIENT_ID ?? "";
    return {
        discordToken,
        discordClientId,
        registerCommandsOnStartup: boolFromEnv(process.env.REGISTER_COMMANDS_ON_STARTUP, true),
        databasePath: path.resolve(cwd, process.env.DATABASE_PATH ?? "./data/mod-ledger.sqlite"),
        backupDir: path.resolve(cwd, process.env.BACKUP_DIR ?? "./backups"),
        exportDir: path.resolve(cwd, process.env.EXPORT_DIR ?? "./exports"),
        defaultTimezone: process.env.DEFAULT_TIMEZONE ?? "America/New_York",
        schedulerIntervalSeconds: Number(process.env.SCHEDULER_INTERVAL_SECONDS ?? 60)
    };
}
export function assertRuntimeEnv(env) {
    const missing = [];
    if (!env.discordToken)
        missing.push("DISCORD_TOKEN");
    if (!env.discordClientId)
        missing.push("DISCORD_CLIENT_ID");
    if (missing.length > 0) {
        throw new Error(`Missing required environment values: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`);
    }
}
