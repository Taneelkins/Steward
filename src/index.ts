import path from "node:path";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials
} from "discord.js";
import { AppDatabase } from "./db.js";
import { assertRuntimeEnv, readEnv } from "./env.js";
import { deployCommands, deployCommandsForGuild } from "./deploy-commands.js";
import { handleChatInputCommand } from "./commands/handlers.js";
import { runStartupRecovery, startScheduler } from "./scheduler.js";
import { handleTicketButton, handlePotentialTranscript } from "./services/tickets.js";
import { handleLogButton, handleLogMediaMessage, handleLogModal, initDraftPersistence } from "./services/logWorkflow.js";
import { handleHelpButton } from "./services/helpMenu.js";

const env = readEnv();
assertRuntimeEnv(env);

initDraftPersistence(path.join(path.dirname(env.databasePath), "drafts"));

const db = new AppDatabase(env.databasePath, env.defaultTimezone);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  if (env.registerCommandsOnStartup) {
    await deployCommands(db);
  }
  await runStartupRecovery(db, readyClient);
  startScheduler(db, readyClient, env.schedulerIntervalSeconds);
  console.log("Startup recovery finished. Scheduler is running.");
});

client.on(Events.GuildCreate, async (guild) => {
  const pointsEnabled = db.getGuildConfig(guild.id).pointsEnabled;
  await deployCommandsForGuild(env.discordToken, env.discordClientId, guild.id, { pointsEnabled }).catch((error) => {
    console.error(`Could not register commands for new guild ${guild.id}:`, error);
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const handled = await handleTicketButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (handled) return;

    const helpHandled = await handleHelpButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (helpHandled) return;

    const logHandled = await handleLogButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (logHandled) return;
  }

  if (interaction.isModalSubmit()) {
    const handled = await handleLogModal(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (handled) return;
  }

  if (!interaction.isChatInputCommand()) return;
  await handleChatInputCommand(interaction, { db, env });
});

client.on(Events.MessageCreate, async (message) => {
  await handleLogMediaMessage(db, message).catch((error) => {
    console.error("Log media handling failed:", error);
  });
  await handlePotentialTranscript(db, message).catch((error) => {
    console.error("Ticket transcript handling failed:", error);
  });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("Shutting down...");
  client.destroy();
  db.close();
  process.exit(0);
}

client.login(env.discordToken).catch((error) => {
  console.error(error);
  db.close();
  process.exitCode = 1;
});
