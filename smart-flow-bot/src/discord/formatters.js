const { EmbedBuilder } = require('discord.js');
const marketHours = require('../utils/marketHours');

class DiscordFormatters {

  // Format a flow alert for Discord
  formatFlowAlert(heatResult) {
    const isHighConviction = heatResult.heatScore >= 80;
    const emoji = isHighConviction ? '🔥' : '📊';
    const title = isHighConviction
      ? `HIGH CONVICTION - ${heatResult.ticker}`
      : `FLOW ALERT - ${heatResult.ticker}`;

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} **${title}** ${emoji}`)
      .setColor(isHighConviction ? 0xFF4500 : 0xFFA500) // Orange-red for high, orange for normal
      .setTimestamp();

    // Heat Score field
    embed.addFields({
      name: 'Heat Score',
      value: `**${heatResult.heatScore}/100**`,
      inline: true
    });

    // Contract field
    embed.addFields({
      name: 'Contract',
      value: heatResult.contract,
      inline: true
    });

    // Premium field
    embed.addFields({
      name: 'Premium',
      value: `$${this.formatNumber(heatResult.premium)}`,
      inline: true
    });

    // Signal breakdown
    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    embed.addFields({
      name: 'Signal Breakdown',
      value: breakdownText || 'No signals',
      inline: false
    });

    // Price info
    const otmText = heatResult.otmPercent > 0
      ? `${heatResult.otmPercent.toFixed(1)}% OTM`
      : `${Math.abs(heatResult.otmPercent).toFixed(1)}% ITM`;

    embed.addFields({
      name: 'Spot Price',
      value: `$${heatResult.spotPrice.toFixed(2)}`,
      inline: true
    });

    embed.addFields({
      name: 'Strike',
      value: `$${heatResult.strike} (${otmText})`,
      inline: true
    });

    embed.addFields({
      name: 'DTE',
      value: `${heatResult.dte} days`,
      inline: true
    });

    // Time
    embed.setFooter({ text: marketHours.formatTimeET() });

    return embed;
  }

  // Format text-based flow alert (for channels that don't support embeds well)
  formatFlowAlertText(heatResult) {
    const isHighConviction = heatResult.heatScore >= 80;
    const emoji = isHighConviction ? '🔥' : '📊';
    const title = isHighConviction ? 'HIGH CONVICTION' : 'FLOW ALERT';

    const breakdownText = heatResult.breakdown
      .map(b => `• ${b.signal} (+${b.points})`)
      .join('\n');

    const otmText = heatResult.otmPercent > 0
      ? `${heatResult.otmPercent.toFixed(1)}% OTM`
      : `${Math.abs(heatResult.otmPercent).toFixed(1)}% ITM`;

    return `${emoji} **${title} - ${heatResult.ticker}** ${emoji}
━━━━━━━━━━━━━━━━━━━━━━━━━
**Heat Score:** ${heatResult.heatScore}/100

**Signal Breakdown:**
${breakdownText}

**Contract:** ${heatResult.contract}
**Premium:** $${this.formatNumber(heatResult.premium)}
**Spot Price:** $${heatResult.spotPrice.toFixed(2)}
**Strike:** $${heatResult.strike} (${otmText})
**DTE:** ${heatResult.dte} days

**Time:** ${marketHours.formatTimeET()}
━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  // Format outcome update message
  formatOutcomeUpdate(alert, outcome) {
    const isProfit = outcome.pnlPercent > 0;
    const emoji = isProfit ? '✅' : '❌';
    const pnlText = isProfit ? '+' : '';

    const embed = new EmbedBuilder()
      .setTitle(`${emoji} Outcome Update: ${alert.ticker}`)
      .setColor(isProfit ? 0x00FF00 : 0xFF0000)
      .setTimestamp();

    embed.addFields({
      name: 'Contract',
      value: alert.contract,
      inline: true
    });

    embed.addFields({
      name: 'Entry Price',
      value: `$${outcome.entryPrice.toFixed(2)}`,
      inline: true
    });

    embed.addFields({
      name: 'Current Price',
      value: `$${outcome.currentPrice.toFixed(2)}`,
      inline: true
    });

    embed.addFields({
      name: 'P/L %',
      value: `**${pnlText}${outcome.pnlPercent.toFixed(1)}%**`,
      inline: true
    });

    embed.addFields({
      name: 'P/L $',
      value: `${pnlText}$${this.formatNumber(Math.abs(outcome.pnlDollar))}`,
      inline: true
    });

    embed.addFields({
      name: 'Time Since Alert',
      value: outcome.timeSinceAlert,
      inline: true
    });

    return embed;
  }

  // Format outcome update as text
  formatOutcomeUpdateText(alert, outcome) {
    const isProfit = outcome.pnlPercent > 0;
    const emoji = isProfit ? '✅' : '❌';
    const pnlText = isProfit ? '+' : '';

    return `${emoji} **Outcome Update: ${alert.ticker}**
━━━━━━━━━━━━━━━━━━
**Contract:** ${alert.contract}
**Entry Price:** $${outcome.entryPrice.toFixed(2)}
**Current Price:** $${outcome.currentPrice.toFixed(2)}
**P/L:** ${pnlText}${outcome.pnlPercent.toFixed(1)}% (${pnlText}$${this.formatNumber(Math.abs(outcome.pnlDollar))})
**Time Since Alert:** ${outcome.timeSinceAlert}`;
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
      const statusEmoji = this.getStatusEmoji(t.status);
      description += `${emoji} **${t.ticker}** ${statusEmoji}\n`;
      description += `   Heat: ${t.heat}/100 | Signals: ${t.signalCount} | Premium: $${this.formatNumber(t.totalPremium)}\n\n`;
    });

    embed.setDescription(description);
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
      value: summary.signalsLast60min.toString(),
      inline: true
    });

    embed.addFields({
      name: 'Sweeps (Last 30 min)',
      value: summary.sweepsLast30min.toString(),
      inline: true
    });

    if (summary.recentAlerts && summary.recentAlerts.length > 0) {
      const alertsText = summary.recentAlerts.slice(0, 5).map(a => {
        const time = new Date(a.created_at).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        return `• ${a.contract} - Score: ${a.heat_score} - ${time}`;
      }).join('\n');

      embed.addFields({
        name: 'Recent Alerts (Last 24h)',
        value: alertsText || 'No recent alerts',
        inline: false
      });
    }

    return embed;
  }

  // Format today's stats
  formatStats(stats) {
    const embed = new EmbedBuilder()
      .setTitle("📈 Today's Flow Scanner Stats")
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
      name: 'Total Premium',
      value: `$${this.formatNumber(stats.total_premium || 0)}`,
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
      .setTitle('🚀 Smart Flow Scanner Online')
      .setColor(0x00FF00)
      .setTimestamp();

    embed.addFields({
      name: 'Status',
      value: '✅ Connected',
      inline: true
    });

    embed.addFields({
      name: 'Polygon WebSocket',
      value: status.polygonConnected ? '✅ Connected' : '❌ Disconnected',
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

  // Helper: Format large numbers
  formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(2) + 'M';
    } else if (num >= 1000) {
      return (num / 1000).toFixed(0) + 'k';
    }
    return num.toFixed(0);
  }

  // Helper: Get status emoji
  getStatusEmoji(status) {
    const emojis = {
      'on_fire': '🔥',
      'hot': '🌡️',
      'warming': '♨️',
      'tepid': '😐',
      'cold': '❄️'
    };
    return emojis[status] || '📊';
  }

  // Format daily summary
  formatDailySummary(stats, outcomes) {
    const embed = new EmbedBuilder()
      .setTitle("📊 Daily Flow Summary")
      .setColor(0x9B59B6)
      .setTimestamp();

    // Alert stats
    embed.addFields({
      name: 'Alerts Today',
      value: `Total: ${stats.total_alerts || 0}\nHigh Conviction: ${stats.high_conviction || 0}`,
      inline: true
    });

    // Win rate if we have outcome data
    if (outcomes && outcomes.length > 0) {
      const winners = outcomes.filter(o => o.pnlPercent > 0).length;
      const winRate = ((winners / outcomes.length) * 100).toFixed(1);
      const avgReturn = outcomes.reduce((sum, o) => sum + o.pnlPercent, 0) / outcomes.length;

      embed.addFields({
        name: 'Performance',
        value: `Win Rate: ${winRate}%\nAvg Return: ${avgReturn > 0 ? '+' : ''}${avgReturn.toFixed(1)}%`,
        inline: true
      });

      // Best and worst trades
      const sorted = [...outcomes].sort((a, b) => b.pnlPercent - a.pnlPercent);
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];

      embed.addFields({
        name: 'Best Trade',
        value: best ? `${best.ticker}: +${best.pnlPercent.toFixed(1)}%` : 'N/A',
        inline: true
      });

      embed.addFields({
        name: 'Worst Trade',
        value: worst ? `${worst.ticker}: ${worst.pnlPercent.toFixed(1)}%` : 'N/A',
        inline: true
      });
    }

    return embed;
  }
}

// Export singleton instance
module.exports = new DiscordFormatters();
