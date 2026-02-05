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
        '• Top Gainers/Losers'
      ].join('\n'),
      inline: false
    });

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
    // Add earnings warning if present
    if (heatResult.earningsWarning) {
      embed.addFields({
        name: '⚠️ Earnings Alert',
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
      'relative_strength': '💪'
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
      'relative_strength': 'Relative Strength'
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
