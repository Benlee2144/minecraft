const { EmbedBuilder } = require('discord.js');
const marketHours = require('../utils/marketHours');

class DiscordFormatters {

  // Format a stock alert for Discord
  formatStockAlert(heatResult, options = {}) {
    const isHighConviction = heatResult.heatScore >= 80;
    const emoji = this.getSignalEmoji(heatResult.signalType);
    const title = isHighConviction
      ? `HIGH CONVICTION - ${heatResult.ticker}`
      : `FLOW ALERT - ${heatResult.ticker}`;

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} **${title}** ${emoji}`)
      .setColor(isHighConviction ? 0xFF4500 : 0xFFA500)
      .setTimestamp();

    // Heat Score field
    embed.addFields({
      name: '🔥 Heat Score',
      value: `**${heatResult.heatScore}/100**`,
      inline: true
    });

    // Signal Type
    embed.addFields({
      name: '📊 Signal',
      value: this.formatSignalType(heatResult.signalType),
      inline: true
    });

    // Current Price
    embed.addFields({
      name: '💵 Price',
      value: `$${heatResult.price?.toFixed(2) || 'N/A'}`,
      inline: true
    });

    // Signal description
    if (heatResult.description) {
      embed.addFields({
        name: '📝 Details',
        value: heatResult.description,
        inline: false
      });
    }

    // Signal breakdown
    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'No signals',
      inline: false
    });

    // AI Analysis (if provided)
    if (options.aiAnalysis) {
      embed.addFields({
        name: '🤖 AI Analysis',
        value: options.aiAnalysis.substring(0, 1000),
        inline: false
      });
    }

    // Earnings warning (if near earnings)
    if (options.earningsWarning) {
      embed.addFields({
        name: '⚠️ Earnings Alert',
        value: options.earningsWarning,
        inline: false
      });
    }

    // TradingView chart link
    const chartUrl = `https://www.tradingview.com/chart/?symbol=${heatResult.ticker}`;
    embed.addFields({
      name: '📊 Chart',
      value: `[View on TradingView](${chartUrl})`,
      inline: true
    });

    // Time
    embed.setFooter({ text: `${marketHours.formatTimeET()} ET | Alert ID: ${options.alertId || 'N/A'}` });

    return embed;
  }

  // Format text-based stock alert
  formatStockAlertText(heatResult) {
    const isHighConviction = heatResult.heatScore >= 80;
    const emoji = this.getSignalEmoji(heatResult.signalType);
    const title = isHighConviction ? 'HIGH CONVICTION' : 'FLOW ALERT';

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    return `${emoji} **${title} - ${heatResult.ticker}** ${emoji}
━━━━━━━━━━━━━━━━━━━━━━━━━
**Heat Score:** ${heatResult.heatScore}/100
**Signal:** ${this.formatSignalType(heatResult.signalType)}
**Price:** $${heatResult.price?.toFixed(2) || 'N/A'}

**Signal Breakdown:**
${breakdownText}

${heatResult.description ? `**Details:** ${heatResult.description}\n` : ''}
**Time:** ${marketHours.formatTimeET()} ET
━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  // Format volume spike alert
  formatVolumeAlert(signal, heatResult) {
    const embed = new EmbedBuilder()
      .setTitle(`📊 VOLUME SPIKE - ${signal.ticker}`)
      .setColor(signal.rvol >= 5 ? 0xFF0000 : 0xFFA500)
      .setTimestamp();

    embed.addFields(
      { name: '🔥 Heat Score', value: `**${heatResult.heatScore}/100**`, inline: true },
      { name: '📈 RVOL', value: `**${signal.rvol.toFixed(1)}x**`, inline: true },
      { name: '💵 Price', value: `$${signal.price?.toFixed(2) || 'N/A'}`, inline: true }
    );

    embed.addFields(
      { name: '📊 Current Volume', value: this.formatNumber(signal.currentVolume), inline: true },
      { name: '📉 Avg Volume', value: this.formatNumber(signal.avgVolume), inline: true },
      { name: '⏱️ Time Window', value: `${signal.windowMinutes || 60} min`, inline: true }
    );

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'Volume spike detected',
      inline: false
    });

    return this.finalizeAlertEmbed(embed, signal.ticker, heatResult);
  }

  // Format block trade alert
  formatBlockTradeAlert(signal, heatResult) {
    const isHuge = signal.isLargeBlock;
    const emoji = isHuge ? '🐋' : '💰';

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} BLOCK TRADE - ${signal.ticker}`)
      .setColor(isHuge ? 0xFF0000 : 0xFFA500)
      .setTimestamp();

    embed.addFields(
      { name: '🔥 Heat Score', value: `**${heatResult.heatScore}/100**`, inline: true },
      { name: '💵 Trade Value', value: `**$${this.formatNumber(signal.tradeValue)}**`, inline: true },
      { name: '📊 Price', value: `$${signal.price?.toFixed(2) || 'N/A'}`, inline: true }
    );

    embed.addFields(
      { name: '📈 Size', value: this.formatNumber(signal.size), inline: true },
      { name: '📍 Avg Size', value: this.formatNumber(signal.avgTradeSize || 0), inline: true },
      { name: '📊 Size Multiple', value: `${((signal.size / (signal.avgTradeSize || signal.size)) || 1).toFixed(1)}x`, inline: true }
    );

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'Block trade detected',
      inline: false
    });

    return this.finalizeAlertEmbed(embed, signal.ticker, heatResult);
  }

  // Format momentum surge alert
  formatMomentumAlert(signal, heatResult) {
    const direction = signal.priceChange > 0 ? '🚀' : '📉';
    const color = signal.priceChange > 0 ? 0x00FF00 : 0xFF0000;

    const embed = new EmbedBuilder()
      .setTitle(`${direction} MOMENTUM SURGE - ${signal.ticker}`)
      .setColor(color)
      .setTimestamp();

    embed.addFields(
      { name: '🔥 Heat Score', value: `**${heatResult.heatScore}/100**`, inline: true },
      { name: '📊 Price Change', value: `**${signal.priceChange > 0 ? '+' : ''}${signal.priceChange.toFixed(2)}%**`, inline: true },
      { name: '💵 Price', value: `$${signal.price?.toFixed(2) || 'N/A'}`, inline: true }
    );

    embed.addFields(
      { name: '⏱️ Time Window', value: `${signal.timeWindowSeconds || 60} seconds`, inline: true },
      { name: '📈 Velocity', value: `${((Math.abs(signal.priceChange) / (signal.timeWindowSeconds || 60)) * 60).toFixed(2)}%/min`, inline: true },
      { name: '📊 Volume', value: signal.volume ? this.formatNumber(signal.volume) : 'N/A', inline: true }
    );

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'Momentum detected',
      inline: false
    });

    return this.finalizeAlertEmbed(embed, signal.ticker, heatResult);
  }

  // Format breakout alert
  formatBreakoutAlert(signal, heatResult) {
    const direction = signal.direction === 'up' ? '🚀' : '📉';

    const embed = new EmbedBuilder()
      .setTitle(`${direction} BREAKOUT - ${signal.ticker}`)
      .setColor(signal.direction === 'up' ? 0x00FF00 : 0xFF0000)
      .setTimestamp();

    embed.addFields(
      { name: '🔥 Heat Score', value: `**${heatResult.heatScore}/100**`, inline: true },
      { name: '💵 Price', value: `$${signal.price?.toFixed(2) || 'N/A'}`, inline: true },
      { name: '📊 Level', value: `$${signal.resistance?.toFixed(2) || signal.support?.toFixed(2) || 'N/A'}`, inline: true }
    );

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'Breakout detected',
      inline: false
    });

    return this.finalizeAlertEmbed(embed, signal.ticker, heatResult);
  }

  // Format gap alert
  formatGapAlert(signal, heatResult) {
    const direction = signal.gapPercent > 0 ? '⬆️' : '⬇️';
    const color = signal.gapPercent > 0 ? 0x00FF00 : 0xFF0000;

    const embed = new EmbedBuilder()
      .setTitle(`${direction} GAP ${signal.gapPercent > 0 ? 'UP' : 'DOWN'} - ${signal.ticker}`)
      .setColor(color)
      .setTimestamp();

    embed.addFields(
      { name: '🔥 Heat Score', value: `**${heatResult.heatScore}/100**`, inline: true },
      { name: '📊 Gap %', value: `**${signal.gapPercent > 0 ? '+' : ''}${signal.gapPercent.toFixed(2)}%**`, inline: true },
      { name: '💵 Current Price', value: `$${signal.price?.toFixed(2) || 'N/A'}`, inline: true }
    );

    embed.addFields(
      { name: '📉 Previous Close', value: `$${signal.previousClose?.toFixed(2) || 'N/A'}`, inline: true },
      { name: '📈 Open Price', value: `$${signal.openPrice?.toFixed(2) || 'N/A'}`, inline: true },
      { name: '💰 Gap Size', value: `$${Math.abs(signal.gapSize || 0).toFixed(2)}`, inline: true }
    );

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'Gap detected',
      inline: false
    });

    return this.finalizeAlertEmbed(embed, signal.ticker, heatResult);
  }

  // Format VWAP cross alert
  formatVWAPAlert(signal, heatResult) {
    const direction = signal.direction === 'above' ? '🟢' : '🔴';
    const color = signal.direction === 'above' ? 0x00FF00 : 0xFF0000;

    const embed = new EmbedBuilder()
      .setTitle(`${direction} VWAP CROSS ${signal.direction.toUpperCase()} - ${signal.ticker}`)
      .setColor(color)
      .setTimestamp();

    embed.addFields(
      { name: '🔥 Heat Score', value: `**${heatResult.heatScore}/100**`, inline: true },
      { name: '💵 Price', value: `$${signal.price?.toFixed(2) || 'N/A'}`, inline: true },
      { name: '📊 VWAP', value: `$${signal.vwap?.toFixed(2) || 'N/A'}`, inline: true }
    );

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'VWAP cross detected',
      inline: false
    });

    return this.finalizeAlertEmbed(embed, signal.ticker, heatResult);
  }

  // Format relative strength alert
  formatRelativeStrengthAlert(signal, heatResult) {
    const embed = new EmbedBuilder()
      .setTitle(`💪 RELATIVE STRENGTH - ${signal.ticker}`)
      .setColor(0x9B59B6)
      .setTimestamp();

    embed.addFields(
      { name: '🔥 Heat Score', value: `**${heatResult.heatScore}/100**`, inline: true },
      { name: '📊 RS vs SPY', value: `**+${signal.relativeStrength?.toFixed(2) || 0}%**`, inline: true },
      { name: '💵 Price', value: `$${signal.price?.toFixed(2) || 'N/A'}`, inline: true }
    );

    embed.addFields(
      { name: `${signal.ticker} Change`, value: `${signal.stockChange > 0 ? '+' : ''}${signal.stockChange?.toFixed(2) || 0}%`, inline: true },
      { name: 'SPY Change', value: `${signal.spyChange > 0 ? '+' : ''}${signal.spyChange?.toFixed(2) || 0}%`, inline: true },
      { name: '📈 Outperformance', value: `${signal.relativeStrength?.toFixed(2) || 0}%`, inline: true }
    );

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'Relative strength detected',
      inline: false
    });

    return this.finalizeAlertEmbed(embed, signal.ticker, heatResult);
  }

  // Format level break alert
  formatLevelBreakAlert(signal, heatResult) {
    const direction = signal.direction === 'up' ? '🔺' : '🔻';
    const color = signal.direction === 'up' ? 0x00FF00 : 0xFF0000;

    const embed = new EmbedBuilder()
      .setTitle(`${direction} LEVEL BREAK - ${signal.ticker}`)
      .setColor(color)
      .setTimestamp();

    embed.addFields(
      { name: '🔥 Heat Score', value: `**${heatResult.heatScore}/100**`, inline: true },
      { name: '💵 Price', value: `$${signal.price?.toFixed(2) || 'N/A'}`, inline: true },
      { name: '📏 Level', value: `$${signal.level?.toFixed(2) || 'N/A'}`, inline: true }
    );

    embed.addFields({
      name: '📊 Level Type',
      value: signal.description || `${signal.levelType} break`,
      inline: false
    });

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: '📈 Signal Breakdown',
      value: breakdownText || 'Level break detected',
      inline: false
    });

    return this.finalizeAlertEmbed(embed, signal.ticker, heatResult);
  }

  // Generic format alert based on signal type
  formatAlert(signal, heatResult) {
    switch (signal.type) {
      case 'volume_spike':
        return this.formatVolumeAlert(signal, heatResult);
      case 'block_trade':
        return this.formatBlockTradeAlert(signal, heatResult);
      case 'momentum_surge':
        return this.formatMomentumAlert(signal, heatResult);
      case 'breakout':
      case 'consolidation_breakout':
        return this.formatBreakoutAlert(signal, heatResult);
      case 'gap':
        return this.formatGapAlert(signal, heatResult);
      case 'vwap_cross':
        return this.formatVWAPAlert(signal, heatResult);
      case 'relative_strength':
        return this.formatRelativeStrengthAlert(signal, heatResult);
      case 'level_break':
        return this.formatLevelBreakAlert(signal, heatResult);
      default:
        return this.formatStockAlert(heatResult);
    }
  }

  // Format hot tickers list
  formatHotTickers(tickers) {
    if (!tickers || tickers.length === 0) {
      return '📊 **No tickers currently heating up**';
    }

    const embed = new EmbedBuilder()
      .setTitle('🔥 Hot Tickers Right Now')
      .setColor(0xFF4500)
      .setTimestamp();

    let description = '';
    tickers.forEach((t, i) => {
      const emoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🔸';
      const heatBar = this.getHeatBar(t.heat);
      description += `${emoji} **${t.ticker}**\n`;
      description += `   ${heatBar} ${t.heat}/100\n`;
      description += `   Signals: ${t.signalCount} | Value: $${this.formatNumber(t.totalValue || 0)}\n\n`;
    });

    embed.setDescription(description);
    embed.setFooter({ text: `${marketHours.formatTimeET()} ET` });
    return embed;
  }

  // Format flow summary for a ticker
  formatFlowSummary(summary) {
    const embed = new EmbedBuilder()
      .setTitle(`📊 Flow Summary: ${summary.ticker}`)
      .setColor(0x3498DB)
      .setTimestamp();

    embed.addFields({
      name: 'Signals (Last 60 min)',
      value: summary.signalsLast60min?.toString() || '0',
      inline: true
    });

    embed.addFields({
      name: 'Heat Score',
      value: `${summary.currentHeat || 0}/100`,
      inline: true
    });

    embed.addFields({
      name: 'Current Price',
      value: summary.price ? `$${summary.price.toFixed(2)}` : 'N/A',
      inline: true
    });

    if (summary.recentSignals && summary.recentSignals.length > 0) {
      const signalsText = summary.recentSignals.slice(0, 5).map(s => {
        const time = new Date(s.timestamp).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        return `• ${this.formatSignalType(s.type)} - Score: ${s.heatScore} - ${time}`;
      }).join('\n');

      embed.addFields({
        name: 'Recent Signals',
        value: signalsText || 'No recent signals',
        inline: false
      });
    }

    embed.setFooter({ text: `${marketHours.formatTimeET()} ET` });
    return embed;
  }

  // Format today's stats
  formatStats(stats) {
    const embed = new EmbedBuilder()
      .setTitle("📈 Today's Stock Scanner Stats")
      .setColor(0x9B59B6)
      .setTimestamp();

    embed.addFields({
      name: 'Total Alerts',
      value: stats.total_alerts?.toString() || '0',
      inline: true
    });

    embed.addFields({
      name: 'High Conviction',
      value: stats.high_conviction?.toString() || '0',
      inline: true
    });

    embed.addFields({
      name: 'Standard Alerts',
      value: stats.standard_alerts?.toString() || '0',
      inline: true
    });

    embed.addFields({
      name: 'Avg Heat Score',
      value: stats.avg_heat_score ? stats.avg_heat_score.toFixed(1) : 'N/A',
      inline: true
    });

    embed.addFields({
      name: 'Total Volume Tracked',
      value: `${this.formatNumber(stats.total_volume || 0)}`,
      inline: true
    });

    embed.addFields({
      name: 'Unique Tickers',
      value: stats.unique_tickers?.toString() || '0',
      inline: true
    });

    if (stats.topTickers && stats.topTickers.length > 0) {
      const topText = stats.topTickers.map(t =>
        `• ${t.ticker}: ${t.alert_count} alerts (max score: ${t.max_score})`
      ).join('\n');

      embed.addFields({
        name: 'Top Tickers Today',
        value: topText,
        inline: false
      });
    }

    // Signal type breakdown
    if (stats.signalBreakdown) {
      const breakdownText = Object.entries(stats.signalBreakdown)
        .map(([type, count]) => `• ${this.formatSignalType(type)}: ${count}`)
        .join('\n');

      embed.addFields({
        name: 'Signal Types',
        value: breakdownText || 'No breakdown available',
        inline: false
      });
    }

    embed.setFooter({ text: `${marketHours.formatTimeET()} ET` });
    return embed;
  }

  // Format watchlist
  formatWatchlist(tickers) {
    if (!tickers || tickers.length === 0) {
      return '📋 **Your watchlist is empty**\nUse `/watchlist add TICKER` to add tickers.';
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Your Watchlist')
      .setColor(0x2ECC71)
      .setDescription(tickers.map(t => `• ${t}`).join('\n'));

    return embed;
  }

  // Format startup message
  formatStartupMessage(status) {
    const embed = new EmbedBuilder()
      .setTitle('🚀 Smart Stock Scanner Online')
      .setColor(0x00FF00)
      .setTimestamp();

    embed.addFields({
      name: 'Status',
      value: '✅ Connected',
      inline: true
    });

    embed.addFields({
      name: 'Polygon API',
      value: status.polygonConnected ? '✅ Connected' : '❌ Disconnected',
      inline: true
    });

    embed.addFields({
      name: 'Data Mode',
      value: status.dataSource || 'REST API (Polling)',
      inline: true
    });

    embed.addFields({
      name: 'Tickers Monitored',
      value: status.tickersMonitored?.toString() || '0',
      inline: true
    });

    embed.addFields({
      name: 'Volume Baselines',
      value: status.baselinesLoaded?.toString() || '0',
      inline: true
    });

    embed.addFields({
      name: 'Market Status',
      value: status.marketOpen ? '🟢 Open' : '🔴 Closed',
      inline: true
    });

    // Show polling interval if using REST API
    if (status.pollInterval) {
      embed.addFields({
        name: 'Poll Interval',
        value: status.pollInterval,
        inline: true
      });
    }

    // Detection features
    embed.addFields({
      name: '📊 Active Detectors',
      value: [
        '• Volume Spikes (RVOL)',
        '• Momentum Surges',
        '• VWAP Crosses',
        '• Gap Detection',
        '• New Highs/Lows',
        '• Key Level Breaks (PDH/PDL)',
        '• Top Gainers/Losers'
      ].join('\n'),
      inline: true
    });

    // Pro features
    embed.addFields({
      name: '⚡ Pro Features',
      value: [
        '• SPY Correlation Filter',
        '• Sector Heat Map',
        '• Trading Phase Bonuses',
        '• Power Hour/Opening Drive',
        '• Relative Strength Detection'
      ].join('\n'),
      inline: true
    });

    // Trading phase
    const phase = marketHours.getTradingPhase();
    if (status.marketOpen && phase.phase !== 'closed') {
      embed.addFields({
        name: '⏰ Current Phase',
        value: `${phase.emoji} ${phase.label}\n${phase.description || ''}`,
        inline: false
      });
    }

    embed.setFooter({ text: `${marketHours.formatTimeET()} ET` });
    return embed;
  }

  // Format error message
  formatError(error, context = '') {
    const embed = new EmbedBuilder()
      .setTitle('⚠️ Bot Error')
      .setColor(0xFF0000)
      .setTimestamp();

    embed.addFields({
      name: 'Error',
      value: error.message || 'Unknown error',
      inline: false
    });

    if (context) {
      embed.addFields({
        name: 'Context',
        value: context,
        inline: false
      });
    }

    return embed;
  }

  // Format daily summary
  formatDailySummary(stats) {
    const embed = new EmbedBuilder()
      .setTitle("📊 Daily Stock Scanner Summary")
      .setColor(0x9B59B6)
      .setTimestamp();

    // Alert stats
    embed.addFields({
      name: '🔔 Alerts Today',
      value: `**${stats.total_alerts || 0}** total alerts\n🔴 High Conviction: **${stats.high_conviction || 0}**\n🟡 Standard: **${stats.standard_alerts || 0}**`,
      inline: true
    });

    // Unique tickers
    embed.addFields({
      name: '📈 Coverage',
      value: `**${stats.unique_tickers || 0}** unique tickers\nAvg Heat: **${(stats.avg_heat_score || 0).toFixed(0)}**/100`,
      inline: true
    });

    // Top tickers by alert count
    if (stats.topTickers && stats.topTickers.length > 0) {
      const topText = stats.topTickers.slice(0, 5).map((t, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
        return `${medal} **${t.ticker}**: ${t.alert_count} alerts (${t.max_score} heat)`;
      }).join('\n');

      embed.addFields({
        name: '🏆 Most Active Tickers',
        value: topText,
        inline: false
      });
    }

    // Signal breakdown
    if (stats.signalBreakdown && Object.keys(stats.signalBreakdown).length > 0) {
      const breakdown = Object.entries(stats.signalBreakdown)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => `• ${this.formatSignalType(type)}: **${count}**`)
        .join('\n');

      embed.addFields({
        name: '📊 Signal Types',
        value: breakdown || 'N/A',
        inline: true
      });
    }

    // Total volume
    if (stats.total_volume) {
      embed.addFields({
        name: '💰 Volume Tracked',
        value: `$${this.formatNumber(stats.total_volume)}`,
        inline: true
      });
    }

    // Add tips for tomorrow
    embed.addFields({
      name: '💡 Tip',
      value: 'Use `/perf` to see how today\'s alerts performed. Add tickers with `/watchlist add` to get alerts at lower thresholds.',
      inline: false
    });

    embed.setFooter({ text: `Market Close - ${marketHours.formatTimeET()} ET | See you tomorrow!` });
    return embed;
  }

  // Helper: Add final fields to alert embed (chart, earnings, footer)
  finalizeAlertEmbed(embed, ticker, heatResult = {}) {
    // Add trade recommendation if present
    if (heatResult.recommendation) {
      const rec = heatResult.recommendation;
      const recEmbed = this.formatRecommendationField(rec);
      embed.addFields({
        name: `${rec.recommendation.emoji} Bot's Trade Idea`,
        value: recEmbed,
        inline: false
      });
    }

    // Add market context (SPY + Sector) on one line
    const contextParts = [];

    // SPY context
    if (heatResult.spyContext?.available) {
      const spy = heatResult.spyContext;
      contextParts.push(`SPY: ${spy.emoji} ${spy.change > 0 ? '+' : ''}${spy.change}%`);
    }

    // Sector context
    if (heatResult.sectorContext) {
      const sec = heatResult.sectorContext;
      const rankText = sec.isLeader ? '🔥' : sec.isLaggard ? '❄️' : '';
      contextParts.push(`${sec.emoji} ${sec.name}: ${sec.change > 0 ? '+' : ''}${sec.change}% ${rankText}`);
    }

    if (contextParts.length > 0) {
      embed.addFields({
        name: '🌍 Market Context',
        value: contextParts.join(' | '),
        inline: false
      });
    }

    // Key levels
    if (heatResult.keyLevels) {
      embed.addFields({
        name: '📏 Key Levels',
        value: heatResult.keyLevels,
        inline: false
      });
    }

    // SPY warning if moving against market
    if (heatResult.spyWarning) {
      embed.addFields({
        name: '⚠️ Market Warning',
        value: heatResult.spyWarning,
        inline: false
      });
    }

    // Trading phase bonus/penalty
    if (heatResult.breakdown?.tradingPhase) {
      const bonus = heatResult.breakdown.timeBonus;
      const bonusText = bonus > 0 ? `+${bonus}` : bonus;
      embed.addFields({
        name: '⏰ Trading Phase',
        value: `${heatResult.breakdown.tradingPhase} (${bonusText} heat)`,
        inline: true
      });
    }

    // Add earnings warning if present
    if (heatResult.earningsWarning) {
      embed.addFields({
        name: '📅 Earnings Alert',
        value: heatResult.earningsWarning,
        inline: false
      });
    }

    // Add TradingView chart link
    const chartUrl = `https://www.tradingview.com/chart/?symbol=${ticker}`;
    embed.addFields({
      name: '📊 Chart',
      value: `[View on TradingView](${chartUrl})`,
      inline: true
    });

    // Set footer with time
    embed.setFooter({ text: `${marketHours.formatTimeET()} ET` });

    return embed;
  }

  // Format trade recommendation for embed field
  formatRecommendationField(rec) {
    const lines = [];

    // Action line
    lines.push(`**${rec.recommendation.action}** (${rec.confidenceScore}/100 confidence)`);

    // Option suggestion
    if (rec.optionSuggestion) {
      lines.push(`Option: **${rec.optionSuggestion.strike} ${rec.optionSuggestion.type}** exp ${rec.optionSuggestion.expiration}`);
    }

    // Targets
    lines.push(`Entry: $${rec.targets.entry.toFixed(2)} → Target: $${rec.targets.target.toFixed(2)} | Stop: $${rec.targets.stopLoss.toFixed(2)}`);
    lines.push(`Risk/Reward: **${rec.targets.riskReward}:1**`);

    // Supporting factors (short form)
    if (rec.factors.length > 0) {
      lines.push(`✓ ${rec.factors.slice(0, 3).join(' | ')}`);
    }

    // Warnings (short form)
    if (rec.warnings.length > 0) {
      lines.push(`⚠️ ${rec.warnings.slice(0, 2).join(' | ')}`);
    }

    // Bot's opinion
    lines.push(`*${rec.recommendation.message}*`);

    return lines.join('\n');
  }

  // Format paper trade recap embed
  formatPaperRecap(summary) {
    if (!summary || summary.total_trades === 0) {
      const embed = new EmbedBuilder()
        .setTitle('📊 Paper Trading Daily Recap')
        .setColor(0x808080)
        .setDescription('No paper trades today.')
        .setTimestamp();
      return embed;
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 Paper Trading Daily Recap')
      .setColor(summary.total_pnl_dollars >= 0 ? 0x00FF00 : 0xFF0000)
      .setTimestamp();

    // Overall stats
    const closedCount = (summary.winners || 0) + (summary.losers || 0);

    embed.addFields({
      name: '📈 Performance',
      value: [
        `Total Trades: **${summary.total_trades}** (${summary.open_trades || 0} still open)`,
        `Win Rate: **${summary.winRate}%** (${summary.winners}W / ${summary.losers}L)`,
        `Avg P&L: **${(summary.avg_pnl_percent || 0).toFixed(2)}%**`,
        `Total P&L: **$${(summary.total_pnl_dollars || 0).toFixed(2)}** (based on $1000/trade)`
      ].join('\n'),
      inline: false
    });

    // Exit stats
    embed.addFields({
      name: '🎯 Trade Exits',
      value: `Targets Hit: **${summary.targets_hit || 0}** | Stops Hit: **${summary.stops_hit || 0}**`,
      inline: true
    });

    embed.addFields({
      name: '📊 Avg Confidence',
      value: `**${(summary.avg_confidence || 0).toFixed(0)}/100**`,
      inline: true
    });

    // By confidence level
    if (summary.byConfidence && summary.byConfidence.length > 0) {
      const confText = summary.byConfidence.map(conf => {
        const winRate = conf.count > 0 ? ((conf.winners / conf.count) * 100).toFixed(0) : 0;
        return `${conf.confidence_level}: ${conf.count} trades, ${winRate}% win, ${(conf.avg_pnl || 0).toFixed(2)}% avg`;
      }).join('\n');

      embed.addFields({
        name: '🎚️ By Confidence Level',
        value: confText,
        inline: false
      });
    }

    // Best/worst trades
    if (summary.bestTrade || summary.worstTrade) {
      const tradeText = [];
      if (summary.bestTrade) {
        tradeText.push(`🏆 Best: **${summary.bestTrade.ticker}** +${(summary.bestTrade.pnl_percent || 0).toFixed(2)}%`);
      }
      if (summary.worstTrade) {
        tradeText.push(`📉 Worst: **${summary.worstTrade.ticker}** ${(summary.worstTrade.pnl_percent || 0).toFixed(2)}%`);
      }
      embed.addFields({
        name: '🏅 Notable Trades',
        value: tradeText.join('\n'),
        inline: false
      });
    }

    // Insight
    let insight = '';
    if (parseFloat(summary.winRate) >= 60) {
      insight = '✅ Strong day! The recommendation system is working well.';
    } else if (parseFloat(summary.winRate) >= 50) {
      insight = '📊 Decent performance. Continue monitoring signal quality.';
    } else if (closedCount > 0) {
      insight = '⚠️ Challenging day. Consider reviewing which factors led to losses.';
    }

    if (insight) {
      embed.addFields({
        name: '💡 Insight',
        value: insight,
        inline: false
      });
    }

    embed.setFooter({ text: `Market Close - ${marketHours.formatTimeET()} ET` });
    return embed;
  }

  // Format active paper trades
  formatActivePaperTrades(trades) {
    if (!trades || trades.length === 0) {
      return '📋 No active paper trades.';
    }

    const embed = new EmbedBuilder()
      .setTitle(`📈 Active Paper Trades (${trades.length})`)
      .setColor(0x3498DB)
      .setTimestamp();

    let description = '';
    for (const trade of trades.slice(0, 10)) {
      const emoji = trade.direction === 'BULLISH' ? '🟢' : '🔴';
      description += `${emoji} **${trade.ticker}** ${trade.direction}\n`;
      description += `Entry: $${trade.entry_price.toFixed(2)} | Target: $${trade.target_price.toFixed(2)} | Stop: $${trade.stop_price.toFixed(2)}\n`;
      if (trade.option_type) {
        description += `Option: ${trade.option_strike} ${trade.option_type}\n`;
      }
      description += `Confidence: ${trade.confidence_score}/100\n\n`;
    }

    embed.setDescription(description);
    embed.setFooter({ text: `${marketHours.formatTimeET()} ET` });
    return embed;
  }

  // Helper: Format large numbers
  formatNumber(num) {
    if (num >= 1000000000) {
      return (num / 1000000000).toFixed(2) + 'B';
    } else if (num >= 1000000) {
      return (num / 1000000).toFixed(2) + 'M';
    } else if (num >= 1000) {
      return (num / 1000).toFixed(0) + 'k';
    }
    return num?.toFixed(0) || '0';
  }

  // Helper: Get heat bar visual
  getHeatBar(heat) {
    const filled = Math.round(heat / 10);
    const empty = 10 - filled;
    const color = heat >= 80 ? '🟥' : heat >= 60 ? '🟧' : heat >= 40 ? '🟨' : '🟩';
    return color.repeat(filled) + '⬜'.repeat(empty);
  }

  // Helper: Get signal emoji
  getSignalEmoji(type) {
    const emojis = {
      'volume_spike': '📊',
      'block_trade': '🐋',
      'momentum_surge': '🚀',
      'breakout': '💥',
      'consolidation_breakout': '💥',
      'gap': '⬆️',
      'vwap_cross': '📈',
      'new_high': '🏔️',
      'new_low': '🕳️',
      'relative_strength': '💪',
      'level_break': '📏'
    };
    return emojis[type] || '📊';
  }

  // Helper: Format signal type for display
  formatSignalType(type) {
    const names = {
      'volume_spike': 'Volume Spike',
      'block_trade': 'Block Trade',
      'momentum_surge': 'Momentum Surge',
      'breakout': 'Breakout',
      'consolidation_breakout': 'Consolidation Breakout',
      'gap': 'Gap',
      'vwap_cross': 'VWAP Cross',
      'new_high': 'New High',
      'new_low': 'New Low',
      'relative_strength': 'Relative Strength',
      'level_break': 'Level Break'
    };
    return names[type] || type;
  }

  // Legacy method for backwards compatibility
  formatFlowAlert(heatResult) {
    return this.formatStockAlert(heatResult);
  }

  formatFlowAlertText(heatResult) {
    return this.formatStockAlertText(heatResult);
  }
}

// Export singleton instance
module.exports = new DiscordFormatters();
