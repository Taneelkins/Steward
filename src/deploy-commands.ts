import { REST, Routes } from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRuntimeEnv, readEnv } from "./env.js";
import { buildCommands } from "./commands/definitions.js";
import { AppDatabase } from "./db.js";

export async function deployCommands(db?: AppDatabase) {
  const env = readEnv();
  assertRuntimeEnv(env);
  const rest = new REST({ version: "10" }).setToken(env.discordToken);
  const ownedDb = db ?? new AppDatabase(env.databasePath, env.defaultTimezone);

  try {
    await clearGlobalCommands(rest, env.discordClientId);

    const guilds = await rest.get(Routes.userGuilds()).catch(() => []) as Array<{ id: string }>;
    for (const guild of guilds) {
      const pointsEnabled = ownedDb.getGuildConfig(guild.id).pointsEnabled;
      await deployCommandsForGuild(env.discordToken, env.discordClientId, guild.id, { pointsEnabled });
    }
  } finally {
    if (!db) ownedDb.close();
  }
}

async function clearGlobalCommands(rest: REST, clientId: string) {
  await rest.put(Routes.applicationCommands(clientId), { body: [] });
  console.log("Cleared global commands so Discord does not show duplicate global and server commands.");
}

export async function deployCommandsForGuild(token: string, clientId: string, guildId: string, options: { pointsEnabled?: boolean } = {}) {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = buildCommands(options);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log(`Registered ${commands.length} guild commands for ${guildId}.`);
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return entrypoint ? path.resolve(entrypoint) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  deployCommands().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
