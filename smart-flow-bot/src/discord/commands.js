const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const config = require('../../config');
const logger = require('../utils/logger');
const database = require('../database/sqlite');
const formatters = require('./formatters');
const heatScore = require('../detection/heatScore');
const claudeChat = require('../claude/chat');
const polygonRest = require('../polygon/rest');
const earningsCalendar = require('../utils/earnings');

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

    // /ask command (Claude AI)
    const askCommand = new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask Claude AI a trading question')
      .addStringOption(option =>
        option
          .setName('question')
          .setDescription('Your question about trading, stocks, or market mechanics')
          .setRequired(true)
      );

    // /clear command (clear Claude conversation)
    const clearCommand = new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Clear your conversation history with Claude');

    // /idea command (AI trade thesis)
    const ideaCommand = new SlashCommandBuilder()
      .setName('idea')
      .setDescription('Get AI-generated trade thesis for a ticker')
      .addStringOption(option =>
        option
          .setName('ticker')
          .setDescription('The ticker symbol to analyze')
          .setRequired(true)
      );

    // /perf command (performance stats)
    const perfCommand = new SlashCommandBuilder()
      .setName('perf')
      .setDescription('Show alert performance statistics and win rates');

    // /earnings command
    const earningsCommand = new SlashCommandBuilder()
      .setName('earnings')
      .setDescription('Check upcoming earnings for watched tickers')
      .addSubcommand(subcommand =>
        subcommand
          .setName('check')
          .setDescription('Check if a ticker has upcoming earnings')
          .addStringOption(option =>
            option
              .setName('ticker')
              .setDescription('The ticker symbol')
              .setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('set')
          .setDescription('Set earnings date for a ticker')
          .addStringOption(option =>
            option
              .setName('ticker')
              .setDescription('The ticker symbol')
              .setRequired(true)
          )
          .addStringOption(option =>
            option
              .setName('date')
              .setDescription('Earnings date (YYYY-MM-DD)')
              .setRequired(true)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('upcoming')
          .setDescription('Show all upcoming earnings this week')
      );

    this.commands = [
      watchlistCommand,
      flowCommand,
      hotCommand,
      statsCommand,
      statusCommand,
      askCommand,
      clearCommand,
      ideaCommand,
      perfCommand,
      earningsCommand
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
        case 'ask':
          await this.handleAsk(interaction);
          break;
        case 'clear':
          await this.handleClear(interaction);
          break;
        case 'idea':
          await this.handleIdea(interaction);
          break;
        case 'perf':
          await this.handlePerf(interaction);
          break;
        case 'earnings':
          await this.handleEarnings(interaction);
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

  // Handle /ask command (Claude AI)
  async handleAsk(interaction) {
    if (!claudeChat.isEnabled()) {
      await interaction.reply({
        content: 'Claude CLI not found. To enable:\n```\nnpm install -g @anthropic-ai/claude-code\nclaude /login\n```\nThen restart the bot.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    const question = interaction.options.getString('question');
    const userId = interaction.user.id;

    try {
      // Get context for Claude
      const recentAlerts = database.getTodayAlerts().slice(0, 5);
      const marketStatus = this.getStatusCallback ? this.getStatusCallback().marketStatus : null;

      // Send to Claude
      const result = await claudeChat.chat(userId, question, {
        recentAlerts,
        marketStatus
      });

      if (result.success) {
        // Split response if too long
        const response = result.response;
        if (response.length <= 2000) {
          await interaction.editReply(response);
        } else {
          // Split and send multiple messages
          const chunks = response.match(/[\s\S]{1,1900}/g) || [];
          await interaction.editReply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(chunks[i]);
          }
        }
      } else {
        await interaction.editReply(`Sorry, I couldn't process that: ${result.error}`);
      }
    } catch (error) {
      logger.error('Error handling /ask command', { error: error.message });
      await interaction.editReply('Sorry, something went wrong. Please try again.');
    }
  }

  // Handle /clear command
  async handleClear(interaction) {
    const userId = interaction.user.id;
    claudeChat.clearHistory(userId);
    await interaction.reply({
      content: 'Your conversation history with Claude has been cleared.',
      ephemeral: true
    });
  }

  // Handle /idea command (AI trade thesis)
  async handleIdea(interaction) {
    if (!claudeChat.isEnabled()) {
      await interaction.reply({
        content: 'Claude CLI not available for trade ideas.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    const ticker = interaction.options.getString('ticker').toUpperCase();

    try {
      // Get recent signals for this ticker
      const flowSummary = database.getFlowSummary(ticker);

      // Fetch real-time price from Polygon
      let currentPrice = flowSummary.price;
      if (!currentPrice) {
        const snapshot = await polygonRest.getStockSnapshot(ticker);
        currentPrice = snapshot?.price || snapshot?.lastTradePrice;
      }

      // Generate trade idea
      const idea = await claudeChat.generateTradeIdea(
        ticker,
        currentPrice || 'unknown',
        flowSummary.recentSignals || []
      );

      if (idea) {
        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
          .setTitle(`💡 Trade Idea: ${ticker}`)
          .setColor(0x9B59B6)
          .setDescription(idea)
          .addFields(
            {
              name: '💵 Current Price',
              value: currentPrice ? `$${currentPrice.toFixed(2)}` : 'N/A',
              inline: true
            },
            {
              name: '📊 Chart',
              value: `[View on TradingView](https://www.tradingview.com/chart/?symbol=${ticker})`,
              inline: true
            }
          )
          .setFooter({ text: 'AI-generated thesis - not financial advice' })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply('Could not generate trade idea. Try again later.');
      }
    } catch (error) {
      logger.error('Error handling /idea command', { error: error.message });
      await interaction.editReply('Error generating trade idea.');
    }
  }

  // Handle /perf command (performance stats)
  async handlePerf(interaction) {
    await interaction.deferReply();

    try {
      const stats = database.getPerformanceStats();
      const { EmbedBuilder } = require('discord.js');

      const embed = new EmbedBuilder()
        .setTitle('📊 Alert Performance Stats')
        .setColor(0x3498DB)
        .setTimestamp();

      // Overall stats
      const totalTracked = stats.total_alerts || 0;
      const winRate15 = totalTracked > 0
        ? ((stats.winners_15min / totalTracked) * 100).toFixed(1)
        : 'N/A';
      const winRate1hr = totalTracked > 0
        ? ((stats.winners_1hr / totalTracked) * 100).toFixed(1)
        : 'N/A';

      embed.addFields(
        { name: 'Total Tracked', value: totalTracked.toString(), inline: true },
        { name: '15min Win Rate', value: `${winRate15}%`, inline: true },
        { name: '1hr Win Rate', value: `${winRate1hr}%`, inline: true }
      );

      // Average moves
      embed.addFields(
        { name: 'Avg 5min', value: `${(stats.avg_5min || 0).toFixed(2)}%`, inline: true },
        { name: 'Avg 15min', value: `${(stats.avg_15min || 0).toFixed(2)}%`, inline: true },
        { name: 'Avg 1hr', value: `${(stats.avg_1hr || 0).toFixed(2)}%`, inline: true }
      );

      // By signal type
      if (stats.bySignalType && stats.bySignalType.length > 0) {
        const signalText = stats.bySignalType.slice(0, 5).map(s => {
          const wr = s.total > 0 ? ((s.winners / s.total) * 100).toFixed(0) : 0;
          return `• ${formatters.formatSignalType(s.signal_type)}: ${wr}% win (${s.total} alerts)`;
        }).join('\n');

        embed.addFields({
          name: 'Performance by Signal Type',
          value: signalText || 'No data yet',
          inline: false
        });
      }

      // By heat score
      if (stats.byHeatScore && stats.byHeatScore.length > 0) {
        const heatText = stats.byHeatScore.map(h => {
          const wr = h.total > 0 ? ((h.winners / h.total) * 100).toFixed(0) : 0;
          return `• ${h.heat_range}: ${wr}% win (${h.total} alerts)`;
        }).join('\n');

        embed.addFields({
          name: 'Performance by Heat Score',
          value: heatText || 'No data yet',
          inline: false
        });
      }

      embed.setFooter({ text: 'Performance tracking requires market hours data' });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Error handling /perf command', { error: error.message });
      await interaction.editReply('Error fetching performance stats.');
    }
  }

  // Handle /earnings command
  async handleEarnings(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'check': {
        const ticker = interaction.options.getString('ticker').toUpperCase();
        const warning = earningsCalendar.getEarningsWarning(ticker);

        if (warning) {
          await interaction.reply({ content: `**${ticker}**: ${warning}`, ephemeral: true });
        } else {
          await interaction.reply({
            content: `**${ticker}**: No upcoming earnings in the calendar.\nUse \`/earnings set ${ticker} YYYY-MM-DD\` to add it.`,
            ephemeral: true
          });
        }
        break;
      }

      case 'set': {
        const ticker = interaction.options.getString('ticker').toUpperCase();
        const date = interaction.options.getString('date');

        // Validate date format
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          await interaction.reply({
            content: 'Invalid date format. Use YYYY-MM-DD (e.g., 2026-02-15)',
            ephemeral: true
          });
          return;
        }

        earningsCalendar.setEarningsDate(ticker, date);
        await interaction.reply({
          content: `✅ Set earnings date for **${ticker}**: ${date}`,
          ephemeral: true
        });
        break;
      }

      case 'upcoming': {
        const upcoming = earningsCalendar.getUpcomingEarnings(7);

        if (upcoming.length === 0) {
          await interaction.reply({
            content: 'No upcoming earnings in the calendar this week.\nAdd earnings dates with `/earnings set TICKER YYYY-MM-DD`',
            ephemeral: true
          });
          return;
        }

        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
          .setTitle('📅 Upcoming Earnings')
          .setColor(0xF39C12)
          .setTimestamp();

        const earningsText = upcoming.map(e => {
          if (e.daysAway === 0) return `🔴 **${e.ticker}** - TODAY`;
          if (e.daysAway === 1) return `🟠 **${e.ticker}** - Tomorrow (${e.date})`;
          return `🟡 **${e.ticker}** - ${e.date} (${e.daysAway} days)`;
        }).join('\n');

        embed.setDescription(earningsText);
        embed.setFooter({ text: 'Add more with /earnings set TICKER YYYY-MM-DD' });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        break;
      }
    }
  }
}

// Export singleton instance
module.exports = new DiscordCommands();
