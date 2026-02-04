const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const config = require('../../config');
const logger = require('../utils/logger');
const database = require('../database/sqlite');
const formatters = require('./formatters');
const heatScore = require('../detection/heatScore');

class DiscordCommands {
  constructor() {
    this.commands = [];
    this.buildCommands();
  }

  buildCommands() {
    // /watchlist command
    const watchlistCommand = new SlashCommandBuilder()
      .setName('watchlist')
      .setDescription('Manage your personal watchlist')
      .addSubcommand(subcommand =>
        subcommand
          .setName('add')
          .setDescription('Add a ticker to your watchlist')
          .addStringOption(option =>
            option
              .setName('ticker')
              .setDescription('The ticker symbol to add')
              .setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('remove')
          .setDescription('Remove a ticker from your watchlist')
          .addStringOption(option =>
            option
              .setName('ticker')
              .setDescription('The ticker symbol to remove')
              .setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('show')
          .setDescription('Show your current watchlist')
      );

    // /flow command
    const flowCommand = new SlashCommandBuilder()
      .setName('flow')
      .setDescription('Get current flow summary for a ticker')
      .addStringOption(option =>
        option
          .setName('ticker')
          .setDescription('The ticker symbol to check')
          .setRequired(true)
      );

    // /hot command
    const hotCommand = new SlashCommandBuilder()
      .setName('hot')
      .setDescription('Show top 5 heating up tickers right now');

    // /stats command
    const statsCommand = new SlashCommandBuilder()
      .setName('stats')
      .setDescription("Show today's alerts and statistics");

    // /status command
    const statusCommand = new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show bot connection status');

    this.commands = [
      watchlistCommand,
      flowCommand,
      hotCommand,
      statsCommand,
      statusCommand
    ];
  }

  // Register commands with Discord
  async registerCommands(clientId, guildId = null) {
    const rest = new REST({ version: '10' }).setToken(config.discord.token);

    try {
      logger.info('Registering slash commands...');

      const commandData = this.commands.map(cmd => cmd.toJSON());

      if (guildId) {
        // Register for specific guild (faster, for testing)
        await rest.put(
          Routes.applicationGuildCommands(clientId, guildId),
          { body: commandData }
        );
        logger.info(`Registered ${commandData.length} commands for guild ${guildId}`);
      } else {
        // Register globally (takes up to an hour to propagate)
        await rest.put(
          Routes.applicationCommands(clientId),
          { body: commandData }
        );
        logger.info(`Registered ${commandData.length} global commands`);
      }
    } catch (error) {
      logger.error('Failed to register commands', { error: error.message });
      throw error;
    }
  }

  // Handle incoming command interactions
  async handleCommand(interaction) {
    const { commandName } = interaction;

    try {
      switch (commandName) {
        case 'watchlist':
          await this.handleWatchlist(interaction);
          break;
        case 'flow':
          await this.handleFlow(interaction);
          break;
        case 'hot':
          await this.handleHot(interaction);
          break;
        case 'stats':
          await this.handleStats(interaction);
          break;
        case 'status':
          await this.handleStatus(interaction);
          break;
        default:
          await interaction.reply({ content: 'Unknown command', ephemeral: true });
      }
    } catch (error) {
      logger.error(`Error handling command ${commandName}`, { error: error.message });

      const errorMessage = 'An error occurred while processing your command.';
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, ephemeral: true });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }

  // Handle /watchlist command
  async handleWatchlist(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    switch (subcommand) {
      case 'add': {
        const ticker = interaction.options.getString('ticker').toUpperCase();

        // Validate ticker format
        if (!/^[A-Z]{1,5}$/.test(ticker)) {
          await interaction.reply({
            content: `Invalid ticker format: ${ticker}`,
            ephemeral: true
          });
          return;
        }

        database.addToWatchlist(userId, ticker);
        await interaction.reply({
          content: `✅ Added **${ticker}** to your watchlist. You'll receive alerts at a lower threshold (50+).`,
          ephemeral: true
        });
        break;
      }

      case 'remove': {
        const ticker = interaction.options.getString('ticker').toUpperCase();
        const result = database.removeFromWatchlist(userId, ticker);

        if (result.changes > 0) {
          await interaction.reply({
            content: `✅ Removed **${ticker}** from your watchlist.`,
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content: `**${ticker}** was not in your watchlist.`,
            ephemeral: true
          });
        }
        break;
      }

      case 'show': {
        const watchlist = database.getWatchlist(userId);
        const embed = formatters.formatWatchlist(watchlist);
        await interaction.reply({ embeds: typeof embed === 'string' ? [] : [embed], content: typeof embed === 'string' ? embed : undefined, ephemeral: true });
        break;
      }
    }
  }

  // Handle /flow command
  async handleFlow(interaction) {
    await interaction.deferReply();

    const ticker = interaction.options.getString('ticker').toUpperCase();
    const summary = database.getFlowSummary(ticker);
    const embed = formatters.formatFlowSummary(summary);

    await interaction.editReply({ embeds: [embed] });
  }

  // Handle /hot command
  async handleHot(interaction) {
    await interaction.deferReply();

    const hotTickers = heatScore.getHeatRanking(5);
    const embed = formatters.formatHotTickers(hotTickers);

    if (typeof embed === 'string') {
      await interaction.editReply({ content: embed });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
  }

  // Handle /stats command
  async handleStats(interaction) {
    await interaction.deferReply();

    const stats = database.getTodayStats();
    const embed = formatters.formatStats(stats);

    await interaction.editReply({ embeds: [embed] });
  }

  // Handle /status command
  async handleStatus(interaction) {
    // This will be populated by the bot module
    const status = this.getStatusCallback ? this.getStatusCallback() : {
      polygonConnected: false,
      tickersMonitored: 0,
      baselinesLoaded: 0,
      marketOpen: false
    };

    const embed = formatters.formatStartupMessage(status);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // Set callback for status
  setStatusCallback(callback) {
    this.getStatusCallback = callback;
  }
}

// Export singleton instance
module.exports = new DiscordCommands();
