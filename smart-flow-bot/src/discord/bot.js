const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('../../config');
const logger = require('../utils/logger');
const commands = require('./commands');
const formatters = require('./formatters');
const database = require('../database/sqlite');
const claudeChat = require('../claude/chat');

class DiscordBot {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.channels = {
      fireAlerts: null,      // 90+ FIRE, 80+ STRONG BUY
      flowScanner: null,     // 60-79 regular alerts
      paperTrades: null,     // Paper trading updates
      dailyRecap: null,      // EOD summaries
      claudeChat: null       // Claude AI responses
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
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent  // Required for reading message content
        ]
      });

      // Initialize Claude chat service
      claudeChat.initialize();

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

      // Handle messages (for Claude chat)
      this.client.on(Events.MessageCreate, async (message) => {
        await this.handleMessage(message);
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
      // Cache all 5 channels
      if (config.discord.channels.fireAlerts) {
        this.channels.fireAlerts = await this.client.channels.fetch(config.discord.channels.fireAlerts);
        logger.info('Cached fire-alerts channel (80+ signals)');
      }

      if (config.discord.channels.flowScanner) {
        this.channels.flowScanner = await this.client.channels.fetch(config.discord.channels.flowScanner);
        logger.info('Cached flow-scanner channel (60-79 signals)');
      }

      if (config.discord.channels.paperTrades) {
        this.channels.paperTrades = await this.client.channels.fetch(config.discord.channels.paperTrades);
        logger.info('Cached paper-trades channel');
      }

      if (config.discord.channels.dailyRecap) {
        this.channels.dailyRecap = await this.client.channels.fetch(config.discord.channels.dailyRecap);
        logger.info('Cached daily-recap channel');
      }

      if (config.discord.channels.claudeChat) {
        this.channels.claudeChat = await this.client.channels.fetch(config.discord.channels.claudeChat);
        logger.info('Cached claude-chat channel');
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

      // Determine channel based on heat score
      // 80+ goes to fire-alerts, 60-79 goes to flow-scanner
      const channel = heatResult.heatScore >= 80
        ? this.channels.fireAlerts
        : this.channels.flowScanner;

      const channelName = heatResult.heatScore >= 80 ? 'fire-alerts' : 'flow-scanner';

      if (channel) {
        await channel.send({ embeds: [embed] });
        logger.info(`Stock alert sent to ${channelName}`, {
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

      // Determine channel based on heat score
      const channel = heatResult.heatScore >= 80
        ? this.channels.fireAlerts
        : this.channels.flowScanner;

      if (channel) {
        await channel.send({ embeds: [embed] });
        logger.info(`Alert sent to ${heatResult.heatScore >= 80 ? 'fire-alerts' : 'flow-scanner'}`, {
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

  // Send outcome update (goes to paper-trades channel)
  async sendOutcomeUpdate(alert, outcome) {
    if (!this.isReady) {
      logger.info('Outcome update', { alert: alert.ticker, outcome });
      return;
    }

    try {
      const embed = formatters.formatOutcomeUpdate(alert, outcome);
      // Outcome updates go to paper-trades channel
      const channel = this.channels.paperTrades;

      if (channel) {
        await channel.send({ embeds: [embed] });
      }
    } catch (error) {
      logger.error('Failed to send outcome update', { error: error.message });
    }
  }

  // Send startup message (to flow-scanner channel)
  async sendStartupMessage(status) {
    if (!this.isReady || !this.channels.flowScanner) {
      logger.info('Bot started', status);
      return;
    }

    try {
      const embed = formatters.formatStartupMessage(status);
      await this.channels.flowScanner.send({ embeds: [embed] });
    } catch (error) {
      logger.error('Failed to send startup message', { error: error.message });
    }
  }

  // Send error to flow-scanner channel
  async sendError(error, context = '') {
    if (!this.isReady || !this.channels.flowScanner) {
      logger.error('Bot error', { error: error.message, context });
      return;
    }

    try {
      const embed = formatters.formatError(error, context);
      await this.channels.flowScanner.send({ embeds: [embed] });
    } catch (err) {
      logger.error('Failed to send error message', { error: err.message });
    }
  }

  // Send daily summary (to daily-recap channel)
  async sendDailySummary(stats) {
    if (!this.isReady || !this.channels.dailyRecap) {
      logger.info('Daily summary', { stats });
      return;
    }

    try {
      const embed = formatters.formatDailySummary(stats);
      await this.channels.dailyRecap.send({ embeds: [embed] });
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

  // Handle incoming messages for Claude chat
  async handleMessage(message) {
    // Ignore messages from bots
    if (message.author.bot) return;

    // Check if Claude chat is enabled
    if (!claudeChat.isEnabled()) return;

    // Check if the bot was mentioned or message starts with !ask
    const botMentioned = message.mentions.has(this.client.user);
    const askCommand = message.content.toLowerCase().startsWith('!ask ');
    const clearCommand = message.content.toLowerCase() === '!clear';

    if (!botMentioned && !askCommand && !clearCommand) return;

    // Handle clear command
    if (clearCommand) {
      claudeChat.clearHistory(message.author.id);
      await message.reply('Conversation history cleared!');
      return;
    }

    // Extract the actual question
    let question = message.content;
    if (botMentioned) {
      // Remove the mention from the message
      question = question.replace(/<@!?\d+>/g, '').trim();
    } else if (askCommand) {
      // Remove the !ask prefix
      question = question.slice(5).trim();
    }

    // Ignore empty questions
    if (!question) {
      await message.reply('What would you like to ask? Try: `!ask what is RVOL?`');
      return;
    }

    // Show typing indicator
    await message.channel.sendTyping();

    try {
      // Get recent alerts for context
      const recentAlerts = database.getTodayAlerts().slice(0, 5);
      const marketStatus = this.statusCallback ? this.statusCallback().marketStatus : null;

      // Send to Claude
      const result = await claudeChat.chat(message.author.id, question, {
        recentAlerts,
        marketStatus
      });

      if (result.success) {
        // Split response if too long for Discord
        const response = result.response;
        if (response.length <= 2000) {
          await message.reply(response);
        } else {
          // Split into chunks
          const chunks = response.match(/[\s\S]{1,1900}/g) || [];
          for (const chunk of chunks) {
            await message.reply(chunk);
          }
        }
      } else {
        await message.reply(`Sorry, I couldn't process that: ${result.error}`);
      }
    } catch (error) {
      logger.error('Error handling Claude chat message', { error: error.message });
      await message.reply('Sorry, something went wrong. Please try again.');
    }
  }

  // Check if a user has a ticker on their watchlist
  isOnWatchlist(userId, ticker) {
    return database.isTickerWatched(userId, ticker);
  }

  // Get all watched tickers
  getAllWatchedTickers() {
    return database.getAllWatchedTickers();
  }

  // Send paper trade update
  async sendPaperTradeUpdate(embed) {
    if (!this.isReady || !this.channels.paperTrades) {
      logger.info('Paper trade update (no channel)');
      return;
    }

    try {
      await this.channels.paperTrades.send({ embeds: [embed] });
    } catch (error) {
      logger.error('Failed to send paper trade update', { error: error.message });
    }
  }

  // Get channel descriptions for /rooms command
  getChannelDescriptions() {
    return config.discord.channelDescriptions;
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
