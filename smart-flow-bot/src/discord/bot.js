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
      // New organized channels
      fireAlerts: null,     // High confidence signals (80+)
      flowScanner: null,    // Regular flow alerts
      paperTrades: null,    // Paper trade activity
      dailyRecap: null,     // End of day summaries
      claudeChat: null,     // Claude AI responses
      // Legacy (mapped to new)
      highConviction: null,
      flowAlerts: null,
      botStatus: null
    };
    this.statusCallback = null;
    this.welcomesSent = false;
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
      // Cache new organized channels
      if (config.discord.channels.fireAlerts) {
        this.channels.fireAlerts = await this.client.channels.fetch(config.discord.channels.fireAlerts);
        this.channels.highConviction = this.channels.fireAlerts; // Legacy mapping
        logger.info('Cached fire-alerts channel');
      }

      if (config.discord.channels.flowScanner) {
        this.channels.flowScanner = await this.client.channels.fetch(config.discord.channels.flowScanner);
        this.channels.flowAlerts = this.channels.flowScanner; // Legacy mapping
        logger.info('Cached flow-scanner channel');
      }

      if (config.discord.channels.paperTrades) {
        this.channels.paperTrades = await this.client.channels.fetch(config.discord.channels.paperTrades);
        logger.info('Cached paper-trades channel');
      }

      if (config.discord.channels.dailyRecap) {
        this.channels.dailyRecap = await this.client.channels.fetch(config.discord.channels.dailyRecap);
        this.channels.botStatus = this.channels.dailyRecap; // Legacy mapping
        logger.info('Cached daily-recap channel');
      }

      if (config.discord.channels.claudeChat) {
        this.channels.claudeChat = await this.client.channels.fetch(config.discord.channels.claudeChat);
        logger.info('Cached claude-chat channel');
      }

      logger.info('All channels cached successfully');
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

      // Route based on heat score:
      // 80+ = Fire Alerts channel (high confidence entry signals)
      // Below 80 = Flow Scanner channel (regular alerts)
      const isFireAlert = heatResult.heatScore >= 80;
      const channel = isFireAlert
        ? this.channels.fireAlerts
        : this.channels.flowScanner;

      const channelName = isFireAlert ? 'fire-alerts' : 'flow-scanner';

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

  // Send message to specific channel by name
  async sendMessage(channelName, content, options = {}) {
    if (!this.isReady) {
      logger.info(`[${channelName}] ${typeof content === 'string' ? content : 'embed'}`);
      return;
    }

    // Map channel names to actual channel objects
    const channelMap = {
      'fireAlerts': this.channels.fireAlerts,
      'fire-alerts': this.channels.fireAlerts,
      'flowScanner': this.channels.flowScanner,
      'flow-scanner': this.channels.flowScanner,
      'flowAlerts': this.channels.flowScanner,  // Legacy
      'paperTrades': this.channels.paperTrades,
      'paper-trades': this.channels.paperTrades,
      'dailyRecap': this.channels.dailyRecap,
      'daily-recap': this.channels.dailyRecap,
      'botStatus': this.channels.dailyRecap,    // Legacy
      'claudeChat': this.channels.claudeChat,
      'claude-chat': this.channels.claudeChat
    };

    const channel = channelMap[channelName];
    if (!channel) {
      logger.warn(`Channel not found: ${channelName}`);
      return;
    }

    try {
      if (typeof content === 'string') {
        await channel.send(content);
      } else if (content.embeds || content.content) {
        await channel.send(content);
      } else {
        // Assume it's an embed
        await channel.send({ embeds: [content] });
      }
    } catch (error) {
      logger.error(`Failed to send to ${channelName}`, { error: error.message });
    }
  }

  // Send paper trade notification
  async sendPaperTradeNotification(message, isClose = false) {
    await this.sendMessage('paperTrades', message);
  }

  // Send daily recap
  async sendDailyRecapEmbed(embed) {
    await this.sendMessage('dailyRecap', { embeds: [embed] });
  }

  // Send Claude chat response
  async sendClaudeResponse(message, response) {
    if (!this.isReady) return;

    try {
      // If we have a claude chat channel and the message came from elsewhere, also post there
      if (this.channels.claudeChat && message.channel.id !== this.channels.claudeChat.id) {
        // Post a summary to claude-chat channel
        await this.channels.claudeChat.send(`**Q:** ${message.content.slice(0, 200)}${message.content.length > 200 ? '...' : ''}\n**A:** ${response.slice(0, 500)}${response.length > 500 ? '...' : ''}`);
      }
    } catch (error) {
      logger.error('Failed to send to claude-chat channel', { error: error.message });
    }
  }

  // Send welcome messages to all channels explaining their purpose
  async sendChannelWelcomes() {
    if (!this.isReady || this.welcomesSent) return;

    const { EmbedBuilder } = require('discord.js');

    // Fire Alerts Channel
    if (this.channels.fireAlerts) {
      const fireEmbed = new EmbedBuilder()
        .setTitle('Welcome to Fire Alerts')
        .setColor(0xFF4500)
        .setDescription('**This is your ACTION channel for high-confidence trade signals.**')
        .addFields(
          {
            name: 'What Posts Here',
            value: '- FIRE ALERT signals (90+ confidence) - **ENTER NOW** trades\n- STRONG ENTRY signals (80+ confidence)\n- Only the highest conviction opportunities',
            inline: false
          },
          {
            name: 'How to Use',
            value: '- Pay close attention to signals here\n- These are the bot\'s best trade ideas\n- Entry price, targets, and stops are included\n- Option suggestions with expected P&L',
            inline: false
          },
          {
            name: 'Notifications',
            value: 'Recommended: Turn on ALL notifications for this channel so you never miss a fire alert!',
            inline: false
          }
        )
        .setFooter({ text: 'Smart Flow Scanner | Fire Alerts' });

      try {
        await this.channels.fireAlerts.send({ embeds: [fireEmbed] });
      } catch (e) { logger.error('Failed to send fire-alerts welcome', { error: e.message }); }
    }

    // Flow Scanner Channel
    if (this.channels.flowScanner) {
      const flowEmbed = new EmbedBuilder()
        .setTitle('Welcome to Flow Scanner')
        .setColor(0x3498DB)
        .setDescription('**Your main feed for market activity and signals.**')
        .addFields(
          {
            name: 'What Posts Here',
            value: '- Regular flow alerts (60-79 heat score)\n- Volume spikes and momentum surges\n- VWAP crosses and level breaks\n- Sector heat map updates\n- Gap alerts and relative strength signals',
            inline: false
          },
          {
            name: 'How to Use',
            value: '- Monitor for developing opportunities\n- Watch for signals that might escalate to Fire Alerts\n- Use these for market context and awareness\n- Great for watchlist ideas',
            inline: false
          }
        )
        .setFooter({ text: 'Smart Flow Scanner | Flow Scanner' });

      try {
        await this.channels.flowScanner.send({ embeds: [flowEmbed] });
      } catch (e) { logger.error('Failed to send flow-scanner welcome', { error: e.message }); }
    }

    // Paper Trades Channel
    if (this.channels.paperTrades) {
      const paperEmbed = new EmbedBuilder()
        .setTitle('Welcome to Paper Trades')
        .setColor(0x2ECC71)
        .setDescription('**Track the bot\'s hypothetical trades and performance.**')
        .addFields(
          {
            name: 'What Posts Here',
            value: '- Paper trade entries (when bot recommends a trade)\n- Trade exits (target hit, stopped out, trailing stop)\n- Proximity alerts (approaching target/stop)\n- Trailing stop updates (locking in profits)\n- Real-time P&L updates',
            inline: false
          },
          {
            name: 'Position Size',
            value: 'All paper trades use $2,000 position size with ~3.5x option leverage calculation.',
            inline: false
          },
          {
            name: 'Commands',
            value: '`/paper active` - See current open positions\n`/paper today` - Today\'s trade history\n`/paper history` - All-time performance',
            inline: false
          }
        )
        .setFooter({ text: 'Smart Flow Scanner | Paper Trades' });

      try {
        await this.channels.paperTrades.send({ embeds: [paperEmbed] });
      } catch (e) { logger.error('Failed to send paper-trades welcome', { error: e.message }); }
    }

    // Daily Recap Channel
    if (this.channels.dailyRecap) {
      const recapEmbed = new EmbedBuilder()
        .setTitle('Welcome to Daily Recap')
        .setColor(0x9B59B6)
        .setDescription('**End-of-day summaries and performance analytics.**')
        .addFields(
          {
            name: 'What Posts Here',
            value: '- End-of-day paper trading recap (win rate, P&L)\n- Daily scanner statistics\n- Bot startup/status messages\n- Performance breakdowns by confidence level\n- Best and worst trades of the day',
            inline: false
          },
          {
            name: 'When It Posts',
            value: 'Recaps post automatically at market close (4:00 PM ET).',
            inline: false
          },
          {
            name: 'Commands',
            value: '`/recap` - Get current day\'s recap\n`/stats` - View overall statistics\n`/perf` - Check signal performance',
            inline: false
          }
        )
        .setFooter({ text: 'Smart Flow Scanner | Daily Recap' });

      try {
        await this.channels.dailyRecap.send({ embeds: [recapEmbed] });
      } catch (e) { logger.error('Failed to send daily-recap welcome', { error: e.message }); }
    }

    // Claude Chat Channel
    if (this.channels.claudeChat) {
      const claudeEmbed = new EmbedBuilder()
        .setTitle('Welcome to Claude Chat')
        .setColor(0xE67E22)
        .setDescription('**Ask Claude AI questions about trading, the market, or the bot.**')
        .addFields(
          {
            name: 'What Posts Here',
            value: '- Claude AI responses to your questions\n- Trading strategy discussions\n- Technical analysis help\n- Explanations of signals and alerts',
            inline: false
          },
          {
            name: 'How to Use',
            value: '`/ask [question]` - Ask Claude anything\n`!ask [question]` - Alternative command\n`@Bot [question]` - Mention the bot\n`!clear` - Clear conversation history',
            inline: false
          },
          {
            name: 'Example Questions',
            value: '- "What does RVOL mean?"\n- "Should I trade during power hour?"\n- "Explain the heat score system"\n- "What sectors are hot today?"',
            inline: false
          }
        )
        .setFooter({ text: 'Smart Flow Scanner | Claude Chat' });

      try {
        await this.channels.claudeChat.send({ embeds: [claudeEmbed] });
      } catch (e) { logger.error('Failed to send claude-chat welcome', { error: e.message }); }
    }

    this.welcomesSent = true;
    logger.info('Channel welcome messages sent');
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
