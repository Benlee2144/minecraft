const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const config = require('../../config');
const logger = require('../utils/logger');
const database = require('../database/sqlite');
const formatters = require('./formatters');
const heatScore = require('../detection/heatScore');
const claudeChat = require('../claude/chat');
const polygonRest = require('../polygon/rest');
const earningsCalendar = require('../utils/earnings');
const keyLevels = require('../detection/keyLevels');
const spyCorrelation = require('../detection/spyCorrelation');
const sectorHeatMap = require('../detection/sectorHeatMap');
const marketHours = require('../utils/marketHours');
const paperTrading = require('../utils/paperTrading');

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
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('fetch')
          .setDescription('Auto-fetch earnings from Yahoo Finance for top tickers')
      );

    // /risk command (position size calculator)
    const riskCommand = new SlashCommandBuilder()
      .setName('risk')
      .setDescription('Calculate position size based on risk')
      .addNumberOption(option =>
        option
          .setName('account')
          .setDescription('Your account size in dollars')
          .setRequired(true)
      )
      .addNumberOption(option =>
        option
          .setName('risk_percent')
          .setDescription('Risk percentage per trade (e.g., 1 or 2)')
          .setRequired(true)
      )
      .addNumberOption(option =>
        option
          .setName('entry')
          .setDescription('Entry price')
          .setRequired(true)
      )
      .addNumberOption(option =>
        option
          .setName('stop')
          .setDescription('Stop loss price')
          .setRequired(true)
      );

    // /sectors command (sector heat map)
    const sectorsCommand = new SlashCommandBuilder()
      .setName('sectors')
      .setDescription('Show sector heat map - which sectors are hot/cold');

    // /levels command (key levels for a ticker)
    const levelsCommand = new SlashCommandBuilder()
      .setName('levels')
      .setDescription('Show key levels for a ticker')
      .addStringOption(option =>
        option
          .setName('ticker')
          .setDescription('The ticker symbol')
          .setRequired(true)
      );

    // /spy command (SPY status and market direction)
    const spyCommand = new SlashCommandBuilder()
      .setName('spy')
      .setDescription('Show current SPY status and market direction');

    // /paper command (paper trading)
    const paperCommand = new SlashCommandBuilder()
      .setName('paper')
      .setDescription('Paper trading - track hypothetical trades')
      .addSubcommand(subcommand =>
        subcommand
          .setName('active')
          .setDescription('Show all active paper trades')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('today')
          .setDescription("Show today's paper trades (open and closed)")
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('history')
          .setDescription('Show paper trading performance history')
          .addIntegerOption(option =>
            option
              .setName('days')
              .setDescription('Number of days to show (default 7)')
              .setRequired(false)
          )
      );

    // /recap command (end of day recap)
    const recapCommand = new SlashCommandBuilder()
      .setName('recap')
      .setDescription("Get today's paper trading recap and performance summary");

    // /welcome command (send channel welcome messages)
    const welcomeCommand = new SlashCommandBuilder()
      .setName('welcome')
      .setDescription('Send welcome/info messages to all channels explaining their purpose');

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
      earningsCommand,
      riskCommand,
      sectorsCommand,
      levelsCommand,
      spyCommand,
      paperCommand,
      recapCommand,
      welcomeCommand
    ];
  }

  // Register commands with Discord
  async registerCommands(clientId, guildId = null) {
    const rest = new REST({ version: '10' }).setToken(config.discord.token);

    try {
      logger.info(`Registering slash commands... (${this.commands.length} commands in array)`);

      const commandData = this.commands.map(cmd => cmd.toJSON());
      logger.info(`Command names: ${commandData.map(c => c.name).join(', ')}`);

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
        case 'risk':
          await this.handleRisk(interaction);
          break;
        case 'sectors':
          await this.handleSectors(interaction);
          break;
        case 'levels':
          await this.handleLevels(interaction);
          break;
        case 'spy':
          await this.handleSpy(interaction);
          break;
        case 'paper':
          await this.handlePaper(interaction);
          break;
        case 'recap':
          await this.handleRecap(interaction);
          break;
        case 'welcome':
          await this.handleWelcome(interaction);
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
            content: 'No upcoming earnings in the calendar this week.\nUse `/earnings fetch` to auto-fetch from Yahoo Finance, or add manually with `/earnings set TICKER YYYY-MM-DD`',
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
        embed.setFooter({ text: 'Use /earnings fetch to update from Yahoo Finance' });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        break;
      }

      case 'fetch': {
        await interaction.deferReply({ ephemeral: true });

        try {
          // Get top tickers from config
          const config = require('../../config');
          const topTickers = config.topTickers || [];

          const result = await earningsCalendar.autoFetchEarnings(topTickers);

          const { EmbedBuilder } = require('discord.js');
          const embed = new EmbedBuilder()
            .setTitle('📅 Earnings Fetch Complete')
            .setColor(0x2ECC71)
            .setTimestamp();

          embed.addFields(
            { name: '✅ Found', value: `${result.fetched} earnings dates`, inline: true },
            { name: '📊 Total Tracked', value: `${earningsCalendar.getCount()} tickers`, inline: true }
          );

          // Show upcoming
          const upcoming = earningsCalendar.getUpcomingEarnings(7);
          if (upcoming.length > 0) {
            const upcomingText = upcoming.slice(0, 10).map(e => {
              if (e.daysAway === 0) return `🔴 **${e.ticker}** - TODAY`;
              if (e.daysAway === 1) return `🟠 **${e.ticker}** - Tomorrow`;
              return `🟡 **${e.ticker}** - ${e.date}`;
            }).join('\n');

            embed.addFields({
              name: '📆 Upcoming This Week',
              value: upcomingText,
              inline: false
            });
          }

          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          logger.error('Error fetching earnings', { error: error.message });
          await interaction.editReply('Error fetching earnings data. Try again later.');
        }
        break;
      }
    }
  }

  // Handle /risk command (position size calculator)
  async handleRisk(interaction) {
    const account = interaction.options.getNumber('account');
    const riskPercent = interaction.options.getNumber('risk_percent');
    const entry = interaction.options.getNumber('entry');
    const stop = interaction.options.getNumber('stop');

    // Calculate risk per share
    const riskPerShare = Math.abs(entry - stop);
    if (riskPerShare === 0) {
      await interaction.reply({
        content: 'Entry and stop cannot be the same price.',
        ephemeral: true
      });
      return;
    }

    // Calculate position size
    const riskAmount = account * (riskPercent / 100);
    const shares = Math.floor(riskAmount / riskPerShare);
    const positionValue = shares * entry;
    const maxLoss = shares * riskPerShare;

    // Direction
    const isLong = entry > stop;
    const direction = isLong ? '🟢 LONG' : '🔴 SHORT';

    const { EmbedBuilder } = require('discord.js');
    const embed = new EmbedBuilder()
      .setTitle('📊 Position Size Calculator')
      .setColor(isLong ? 0x00FF00 : 0xFF0000)
      .addFields(
        { name: 'Direction', value: direction, inline: true },
        { name: 'Entry Price', value: `$${entry.toFixed(2)}`, inline: true },
        { name: 'Stop Loss', value: `$${stop.toFixed(2)}`, inline: true },
        { name: '📈 Position Size', value: `**${shares} shares**`, inline: true },
        { name: '💰 Position Value', value: `$${positionValue.toFixed(2)}`, inline: true },
        { name: '⚠️ Max Loss', value: `$${maxLoss.toFixed(2)} (${riskPercent}%)`, inline: true }
      )
      .addFields({
        name: '📝 Summary',
        value: `With a **$${account.toLocaleString()}** account risking **${riskPercent}%** ($${riskAmount.toFixed(2)}):\n` +
               `Buy **${shares} shares** at $${entry.toFixed(2)}\n` +
               `Stop at $${stop.toFixed(2)} (${(riskPerShare / entry * 100).toFixed(1)}% risk per share)`,
        inline: false
      })
      .setFooter({ text: 'Not financial advice - always manage your risk' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // Handle /sectors command (sector heat map)
  async handleSectors(interaction) {
    await interaction.deferReply();

    try {
      // Update sector data
      await sectorHeatMap.updateSectors();

      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder()
        .setTitle('🌡️ Sector Heat Map')
        .setColor(0x3498DB)
        .setTimestamp();

      // Get ranking
      const ranking = sectorHeatMap.getRanking();

      if (ranking.length === 0) {
        await interaction.editReply('No sector data available. Try again during market hours.');
        return;
      }

      // Format heat map
      const heatMapText = ranking.map((s, i) => {
        const bar = s.change > 0.5 ? '🟢🟢' : (s.change > 0 ? '🟢' : (s.change < -0.5 ? '🔴🔴' : (s.change < 0 ? '🔴' : '⚪')));
        const changeStr = `${s.change > 0 ? '+' : ''}${s.change.toFixed(2)}%`;
        const rank = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
        return `${rank} ${s.emoji} **${s.name}** (${s.etf}): ${bar} ${changeStr}`;
      }).join('\n');

      embed.setDescription(heatMapText);

      // Add summary
      const hot = sectorHeatMap.getHotSectors();
      const cold = sectorHeatMap.getColdSectors();

      let summary = '';
      if (hot.length > 0) {
        summary += `🔥 **Hot:** ${hot.map(s => s.name).join(', ')}\n`;
      }
      if (cold.length > 0) {
        summary += `❄️ **Cold:** ${cold.map(s => s.name).join(', ')}`;
      }

      if (summary) {
        embed.addFields({ name: 'Summary', value: summary, inline: false });
      }

      // Add trading phase
      const phase = marketHours.getTradingPhase();
      embed.setFooter({ text: `${phase.emoji} ${phase.label} | ${marketHours.formatTimeET()}` });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Error handling /sectors command', { error: error.message });
      await interaction.editReply('Error fetching sector data.');
    }
  }

  // Handle /levels command (key levels)
  async handleLevels(interaction) {
    await interaction.deferReply();

    const ticker = interaction.options.getString('ticker').toUpperCase();

    try {
      // Fetch current data
      const [snapshot, prevClose] = await Promise.all([
        polygonRest.getStockSnapshot(ticker),
        polygonRest.getPreviousClose(ticker)
      ]);

      if (!snapshot) {
        await interaction.editReply(`Could not fetch data for ${ticker}`);
        return;
      }

      // Calculate levels
      const levels = keyLevels.calculateLevels(ticker, snapshot, prevClose);

      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder()
        .setTitle(`📊 Key Levels: ${ticker}`)
        .setColor(0x9B59B6)
        .setTimestamp();

      // Current price
      embed.addFields({
        name: '💵 Current Price',
        value: `**$${levels.currentPrice?.toFixed(2) || 'N/A'}**`,
        inline: true
      });

      // Previous day levels
      const pdLevels = [];
      if (levels.pdh) pdLevels.push(`PDH: $${levels.pdh.toFixed(2)}`);
      if (levels.pdl) pdLevels.push(`PDL: $${levels.pdl.toFixed(2)}`);
      if (levels.pdc) pdLevels.push(`PDC: $${levels.pdc.toFixed(2)}`);

      if (pdLevels.length > 0) {
        embed.addFields({
          name: '📅 Previous Day',
          value: pdLevels.join('\n'),
          inline: true
        });
      }

      // VWAP
      if (levels.vwap) {
        const vwapDist = ((levels.currentPrice - levels.vwap) / levels.vwap * 100).toFixed(2);
        const vwapStatus = levels.currentPrice > levels.vwap ? '🟢 Above' : '🔴 Below';
        embed.addFields({
          name: '📈 VWAP',
          value: `$${levels.vwap.toFixed(2)}\n${vwapStatus} (${vwapDist}%)`,
          inline: true
        });
      }

      // Round numbers
      if (levels.roundLevels && levels.roundLevels.length > 0) {
        const roundsText = levels.roundLevels
          .filter(r => r.type === 'major')
          .map(r => {
            const dist = parseFloat(r.distance);
            const arrow = dist > 0 ? '↑' : '↓';
            return `$${r.price} (${arrow}${Math.abs(dist).toFixed(1)}%)`;
          })
          .join(' | ');

        embed.addFields({
          name: '🎯 Key Round Numbers',
          value: roundsText || 'None nearby',
          inline: false
        });
      }

      // Proximity alerts
      const proximity = keyLevels.getProximityInfo(ticker, levels.currentPrice);
      if (proximity && proximity.length > 0) {
        const proxText = proximity.map(p =>
          `⚠️ **${p.distance}%** ${p.direction} ${p.level} ($${p.price.toFixed(2)})`
        ).join('\n');

        embed.addFields({
          name: '🎯 Near Key Levels',
          value: proxText,
          inline: false
        });
      }

      // TradingView link
      embed.addFields({
        name: '📊 Chart',
        value: `[View on TradingView](https://www.tradingview.com/chart/?symbol=${ticker})`,
        inline: false
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Error handling /levels command', { error: error.message });
      await interaction.editReply('Error fetching key levels.');
    }
  }

  // Handle /spy command (market direction)
  async handleSpy(interaction) {
    await interaction.deferReply();

    try {
      // Update SPY data
      await spyCorrelation.updateSPY();
      const spy = spyCorrelation.getSPY();

      if (!spy.price) {
        await interaction.editReply('Could not fetch SPY data. Try again.');
        return;
      }

      const { EmbedBuilder } = require('discord.js');
      const directionEmoji = spy.direction === 'bullish' ? '🟢' : (spy.direction === 'bearish' ? '🔴' : '🟡');
      const color = spy.direction === 'bullish' ? 0x00FF00 : (spy.direction === 'bearish' ? 0xFF0000 : 0xFFFF00);

      const embed = new EmbedBuilder()
        .setTitle(`${directionEmoji} SPY Market Status`)
        .setColor(color)
        .setTimestamp();

      embed.addFields(
        { name: '💵 Price', value: `**$${spy.price.toFixed(2)}**`, inline: true },
        { name: '📊 Change', value: `${spy.changePercent > 0 ? '+' : ''}${spy.changePercent?.toFixed(2)}%`, inline: true },
        { name: '📈 Direction', value: spy.direction?.toUpperCase() || 'NEUTRAL', inline: true }
      );

      // Trend
      const trend = spyCorrelation.getSPYTrend();
      const trendEmoji = trend === 'up' ? '📈' : (trend === 'down' ? '📉' : '➡️');
      embed.addFields({
        name: `${trendEmoji} Short-term Trend`,
        value: trend.toUpperCase(),
        inline: true
      });

      // VWAP status
      if (spy.vwap) {
        const vwapStatus = spy.price > spy.vwap ? '🟢 Above VWAP' : '🔴 Below VWAP';
        embed.addFields({
          name: '📊 VWAP',
          value: `$${spy.vwap.toFixed(2)}\n${vwapStatus}`,
          inline: true
        });
      }

      // Trading phase
      const phase = marketHours.getTradingPhase();
      embed.addFields({
        name: `${phase.emoji} Trading Phase`,
        value: `**${phase.label}**\n${phase.description || ''}`,
        inline: false
      });

      // Trading recommendation
      let recommendation = '';
      if (spy.direction === 'bullish' && phase.phase === 'power_hour') {
        recommendation = '🔥 **Momentum Long** - Strong bulls + Power Hour';
      } else if (spy.direction === 'bearish' && phase.phase === 'power_hour') {
        recommendation = '🔥 **Momentum Short** - Strong bears + Power Hour';
      } else if (phase.phase === 'midday') {
        recommendation = '😴 **Caution** - Midday chop, wait for direction';
      } else if (phase.phase === 'opening_drive') {
        recommendation = '⚡ **High Vol** - Opening volatility, trade with trend';
      } else {
        recommendation = '👀 **Neutral** - Wait for clear direction';
      }

      embed.addFields({
        name: '💡 Market Bias',
        value: recommendation,
        inline: false
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Error handling /spy command', { error: error.message });
      await interaction.editReply('Error fetching SPY data.');
    }
  }

  // Handle /paper command (paper trading)
  async handlePaper(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'active': {
        const trades = paperTrading.getActiveTrades();
        const embed = formatters.formatActivePaperTrades(trades);

        if (typeof embed === 'string') {
          await interaction.reply({ content: embed, ephemeral: true });
        } else {
          await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        break;
      }

      case 'today': {
        await interaction.deferReply({ ephemeral: true });

        try {
          const trades = paperTrading.getTodayTrades();
          const { EmbedBuilder } = require('discord.js');

          if (trades.length === 0) {
            await interaction.editReply("No paper trades today yet. The bot will automatically open paper trades when it generates recommendations with confidence >= 70.");
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle(`📊 Today's Paper Trades (${trades.length})`)
            .setColor(0x3498DB)
            .setTimestamp();

          let description = '';
          for (const trade of trades.slice(0, 15)) {
            const emoji = trade.direction === 'BULLISH' ? '🟢' : '🔴';
            const statusEmoji = trade.status === 'OPEN' ? '⏳' :
                               (trade.pnl_percent > 0 ? '✅' : '❌');

            description += `${emoji} **${trade.ticker}** ${statusEmoji}\n`;
            description += `   ${trade.recommendation} | Confidence: ${trade.confidence_score}\n`;

            if (trade.status === 'CLOSED') {
              const pnl = trade.pnl_percent || 0;
              description += `   P&L: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}% | ${trade.exit_reason}\n`;
            } else {
              description += `   Entry: $${trade.entry_price.toFixed(2)} | Target: $${trade.target_price.toFixed(2)}\n`;
            }
            description += '\n';
          }

          embed.setDescription(description);

          // Summary stats
          const openCount = trades.filter(t => t.status === 'OPEN').length;
          const closedCount = trades.filter(t => t.status === 'CLOSED').length;
          const winners = trades.filter(t => t.status === 'CLOSED' && t.pnl_percent > 0).length;

          embed.setFooter({
            text: `Open: ${openCount} | Closed: ${closedCount} | Winners: ${winners}/${closedCount} | ${marketHours.formatTimeET()} ET`
          });

          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          logger.error('Error handling /paper today', { error: error.message });
          await interaction.editReply('Error fetching paper trades.');
        }
        break;
      }

      case 'history': {
        await interaction.deferReply({ ephemeral: true });

        try {
          const days = interaction.options.getInteger('days') || 7;
          const history = paperTrading.getHistoricalPerformance(days);

          if (history.length === 0) {
            await interaction.editReply("No paper trading history yet. Paper trades will be recorded when the bot runs during market hours.");
            return;
          }

          const { EmbedBuilder } = require('discord.js');
          const embed = new EmbedBuilder()
            .setTitle(`📈 Paper Trading History (${days} days)`)
            .setColor(0x9B59B6)
            .setTimestamp();

          let totalPnL = 0;
          let totalTrades = 0;
          let totalWins = 0;

          let historyText = '';
          for (const day of history) {
            const winRate = (day.winners + day.losers) > 0
              ? ((day.winners / (day.winners + day.losers)) * 100).toFixed(0)
              : 0;
            const emoji = day.total_pnl_dollars >= 0 ? '🟢' : '🔴';

            historyText += `${emoji} **${day.trade_date}**: ${day.total_trades} trades, ${winRate}% win, $${(day.total_pnl_dollars || 0).toFixed(2)}\n`;

            totalPnL += day.total_pnl_dollars || 0;
            totalTrades += day.total_trades;
            totalWins += day.winners;
          }

          embed.setDescription(historyText);

          // Overall stats
          const overallWinRate = totalTrades > 0
            ? ((totalWins / totalTrades) * 100).toFixed(1)
            : 0;

          embed.addFields({
            name: '📊 Period Summary',
            value: `Total Trades: **${totalTrades}**\n` +
                   `Win Rate: **${overallWinRate}%**\n` +
                   `Total P&L: **$${totalPnL.toFixed(2)}**`,
            inline: false
          });

          await interaction.editReply({ embeds: [embed] });
        } catch (error) {
          logger.error('Error handling /paper history', { error: error.message });
          await interaction.editReply('Error fetching paper trading history.');
        }
        break;
      }
    }
  }

  // Handle /recap command (end of day recap)
  async handleRecap(interaction) {
    await interaction.deferReply();

    try {
      const summary = paperTrading.getTodaySummary();
      const embed = formatters.formatPaperRecap(summary);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      logger.error('Error handling /recap command', { error: error.message });
      await interaction.editReply('Error generating recap.');
    }
  }

  // Handle /welcome command (send channel welcome messages)
  async handleWelcome(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      // Import bot to send welcome messages
      const discordBot = require('./bot');

      // Reset the flag so welcomes can be sent again
      discordBot.welcomesSent = false;

      // Send welcome messages to all channels
      await discordBot.sendChannelWelcomes();

      await interaction.editReply('Welcome messages have been sent to all channels! Each channel now has a pinned message explaining its purpose.');
    } catch (error) {
      logger.error('Error handling /welcome command', { error: error.message });
      await interaction.editReply('Error sending welcome messages. Make sure all channel IDs are configured correctly.');
    }
  }
}

// Export singleton instance
module.exports = new DiscordCommands();
