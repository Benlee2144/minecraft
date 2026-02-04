const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('../../config');
const logger = require('../utils/logger');
const commands = require('./commands');
const formatters = require('./formatters');
const database = require('../database/sqlite');

class DiscordBot {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.channels = {
      highConviction: null,
      flowAlerts: null,
      botStatus: null
    };
    this.statusCallback = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      if (!config.discord.token) {
        logger.warn('Discord bot token not configured - running in console-only mode');
        resolve();
        return;
      }

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages
        ]
      });

      this.client.once(Events.ClientReady, async (client) => {
        logger.info(`Discord bot logged in as ${client.user.tag}`);
        this.isReady = true;

        // Cache channels
        await this.cacheChannels();

        // Register slash commands
        try {
          // Get first guild for testing (or use global)
          const guild = client.guilds.cache.first();
          if (guild) {
            await commands.registerCommands(client.user.id, guild.id);
          }
        } catch (err) {
          logger.error('Failed to register commands', { error: err.message });
        }

        // Set status callback for /status command
        commands.setStatusCallback(() => this.getStatus());

        resolve();
      });

      // Handle interactions (slash commands)
      this.client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        await commands.handleCommand(interaction);
      });

      // Handle errors
      this.client.on(Events.Error, (error) => {
        logger.error('Discord client error', { error: error.message });
      });

      // Login
      this.client.login(config.discord.token).catch((error) => {
        logger.error('Failed to login to Discord', { error: error.message });
        reject(error);
      });
    });
  }

  async cacheChannels() {
    try {
      if (config.discord.channels.highConviction) {
        this.channels.highConviction = await this.client.channels.fetch(config.discord.channels.highConviction);
        logger.info('Cached high-conviction channel');
      }

      if (config.discord.channels.flowAlerts) {
        this.channels.flowAlerts = await this.client.channels.fetch(config.discord.channels.flowAlerts);
        logger.info('Cached flow-alerts channel');
      }

      if (config.discord.channels.botStatus) {
        this.channels.botStatus = await this.client.channels.fetch(config.discord.channels.botStatus);
        logger.info('Cached bot-status channel');
      }
    } catch (error) {
      logger.error('Failed to cache channels', { error: error.message });
    }
  }

  // Send stock alert to appropriate channel
  async sendStockAlert(signal, heatResult) {
    if (!this.isReady) {
      // Console-only mode
      logger.flow(heatResult.ticker, heatResult.heatScore, heatResult);
      return;
    }

    try {
      // Use the type-specific formatter
      const embed = formatters.formatAlert(signal, heatResult);

      // Determine channel
      const channel = heatResult.isHighConviction
        ? this.channels.highConviction
        : this.channels.flowAlerts;

      if (channel) {
        await channel.send({ embeds: [embed] });
        logger.info(`Stock alert sent to ${heatResult.channel}`, {
          ticker: heatResult.ticker,
          signalType: signal.type,
          heatScore: heatResult.heatScore
        });
      } else {
        // Fallback to console
        logger.flow(heatResult.ticker, heatResult.heatScore, heatResult);
      }

    } catch (error) {
      logger.error('Failed to send stock alert', { error: error.message });
    }
  }

  // Legacy: Send alert to appropriate channel (for backwards compatibility)
  async sendAlert(heatResult) {
    if (!this.isReady) {
      // Console-only mode
      logger.flow(heatResult.ticker, heatResult.heatScore, heatResult);
      return;
    }

    try {
      const embed = formatters.formatFlowAlert(heatResult);

      // Determine channel
      const channel = heatResult.isHighConviction
        ? this.channels.highConviction
        : this.channels.flowAlerts;

      if (channel) {
        await channel.send({ embeds: [embed] });
        logger.info(`Alert sent to ${heatResult.channel}`, {
          ticker: heatResult.ticker,
          heatScore: heatResult.heatScore
        });
      } else {
        // Fallback to console
        logger.flow(heatResult.ticker, heatResult.heatScore, heatResult);
      }

    } catch (error) {
      logger.error('Failed to send alert', { error: error.message });
    }
  }

  // Send outcome update
  async sendOutcomeUpdate(alert, outcome) {
    if (!this.isReady) {
      logger.info('Outcome update', { alert: alert.ticker, outcome });
      return;
    }

    try {
      const embed = formatters.formatOutcomeUpdate(alert, outcome);
      const channel = alert.heat_score >= 80
        ? this.channels.highConviction
        : this.channels.flowAlerts;

      if (channel) {
        await channel.send({ embeds: [embed] });
      }
    } catch (error) {
      logger.error('Failed to send outcome update', { error: error.message });
    }
  }

  // Send startup message
  async sendStartupMessage(status) {
    if (!this.isReady || !this.channels.botStatus) {
      logger.info('Bot started', status);
      return;
    }

    try {
      const embed = formatters.formatStartupMessage(status);
      await this.channels.botStatus.send({ embeds: [embed] });
    } catch (error) {
      logger.error('Failed to send startup message', { error: error.message });
    }
  }

  // Send error to status channel
  async sendError(error, context = '') {
    if (!this.isReady || !this.channels.botStatus) {
      logger.error('Bot error', { error: error.message, context });
      return;
    }

    try {
      const embed = formatters.formatError(error, context);
      await this.channels.botStatus.send({ embeds: [embed] });
    } catch (err) {
      logger.error('Failed to send error message', { error: err.message });
    }
  }

  // Send daily summary
  async sendDailySummary(stats) {
    if (!this.isReady || !this.channels.botStatus) {
      logger.info('Daily summary', { stats });
      return;
    }

    try {
      const embed = formatters.formatDailySummary(stats);
      await this.channels.botStatus.send({ embeds: [embed] });
    } catch (error) {
      logger.error('Failed to send daily summary', { error: error.message });
    }
  }

  // Get status for /status command
  getStatus() {
    return this.statusCallback ? this.statusCallback() : {
      polygonConnected: false,
      tickersMonitored: 0,
      baselinesLoaded: 0,
      marketOpen: false
    };
  }

  // Set status callback (called from main index)
  setStatusCallback(callback) {
    this.statusCallback = callback;
  }

  // Check if a user has a ticker on their watchlist
  isOnWatchlist(userId, ticker) {
    return database.isTickerWatched(userId, ticker);
  }

  // Get all watched tickers
  getAllWatchedTickers() {
    return database.getAllWatchedTickers();
  }

  // Shutdown
  async shutdown() {
    if (this.client) {
      logger.info('Shutting down Discord bot...');
      await this.client.destroy();
      this.isReady = false;
    }
  }
}

// Export singleton instance
module.exports = new DiscordBot();
