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
import { handleChatInputCommand, handleRobloxButton, handleRobloxModal, handleAutoPunishButton } from "./commands/handlers.js";
import { handleCrossServerButton } from "./services/crossServer.js";
import { handleLoaButton } from "./services/loa.js";
import { handleSetupPanelButton, handleSetupPanelModal } from "./services/setupPanel.js";
import { runStartupRecovery, startScheduler } from "./scheduler.js";
import { handlePotentialTranscript } from "./services/tickets.js";
import { handleLogButton, handleLogMediaMessage, handleLogModal, injectDraftFromDeniedCase, initDraftPersistence } from "./services/logWorkflow.js";
import { handleHelpButton } from "./services/helpMenu.js";
import { handleApprovalButton, handleExecutePunishment, handleFixPunishmentButton, handleFixPunishmentModal, handleJuniorReviewButton, handleJuniorReviewModal, handleTranscriptButton } from "./services/cases.js";
import { handleDataButton, handleDataModal } from "./services/playerData.js";
import { postStartupAnnouncement, saveShoutsChannels } from "./services/startupAnnouncement.js";
import { handlePrefixCommand } from "./services/prefixCommands.js";

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

// True once the ClientReady handler has finished — gates GuildCreate deploys
// so we don't re-deploy to every existing guild on every startup.
let botReady = false;

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  if (env.registerCommandsOnStartup) {
    await deployCommands(db);
  }
  await runStartupRecovery(db, readyClient);
  await postStartupAnnouncement(db, readyClient, path.dirname(env.databasePath));
  saveShoutsChannels(db, readyClient, path.dirname(env.databasePath));
  startScheduler(db, readyClient, env.schedulerIntervalSeconds);
  console.log("Startup recovery finished. Scheduler is running.");
  botReady = true;
});

client.on(Events.GuildCreate, async (guild) => {
  // Skip guilds that Discord sends during the initial ready burst
  if (!botReady) return;
  const pointsEnabled = db.getGuildConfig(guild.id).pointsEnabled;
  await deployCommandsForGuild(env.discordToken, env.discordClientId, guild.id, { pointsEnabled }).catch((error) => {
    console.error(`Could not register commands for new guild ${guild.id}:`, error);
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
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

    const transcriptHandled = await handleTranscriptButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      return true;
    });
    if (transcriptHandled) return;

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

    const approvalHandled = await handleApprovalButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (approvalHandled) return;

    const juniorReviewHandled = await handleJuniorReviewButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (juniorReviewHandled) return;

    const execHandled = await handleExecutePunishment(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (execHandled) return;

    const fixPunishHandled = await handleFixPunishmentButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (fixPunishHandled) return;

    const dataHandled = await handleDataButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (dataHandled) return;

    const crossServerHandled = await handleCrossServerButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (crossServerHandled) return;

    const robloxHandled = await handleRobloxButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (robloxHandled) return;

    const autopunishHandled = await handleAutoPunishButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (autopunishHandled) return;

    const loaHandled = await handleLoaButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (loaHandled) return;

    const setupPanelHandled = await handleSetupPanelButton(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (setupPanelHandled) return;
  }

  if (interaction.isModalSubmit()) {
    const setupPanelModalHandled = await handleSetupPanelModal(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      return true;
    });
    if (setupPanelModalHandled) return;

    const juniorModalResult = await handleJuniorReviewModal(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      return false as const;
    });
    if (juniorModalResult !== false) {
      if (juniorModalResult) injectDraftFromDeniedCase(juniorModalResult);
      return;
    }

    const robloxModalHandled = await handleRobloxModal(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      return true;
    });
    if (robloxModalHandled) return;

    const fixPunishModalHandled = await handleFixPunishmentModal(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (fixPunishModalHandled) return;

    const dataModalHandled = await handleDataModal(db, interaction).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(`Error: ${message}`).catch(() => null);
      } else {
        await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
      }
      return true;
    });
    if (dataModalHandled) return;

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
  await handleChatInputCommand(interaction, { db, env }).catch(async (error) => {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(`Error: ${message}`).catch(() => null);
    } else {
      await interaction.reply({ content: `Error: ${message}`, ephemeral: true }).catch(() => null);
    }
  });
});

client.on(Events.MessageCreate, async (message) => {
  await handlePrefixCommand(db, message).catch((error) => {
    console.error("Prefix command handling failed:", error);
  });
  await handleLogMediaMessage(db, message).catch((error) => {
    console.error("Log media handling failed:", error);
  });
  await handlePotentialTranscript(db, message).catch((error) => {
    console.error("Ticket transcript handling failed:", error);
  });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", (code) => console.log(`[exit] Process exiting with code ${code}`));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
client.on("error", (err) => console.error("[client error]", err));
client.on("shardDisconnect", (event, id) => console.log(`[shardDisconnect] shard ${id} close code ${event.code}`));

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
