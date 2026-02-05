/**
 * After-Hours Scanner Module
 * Monitors after-hours trading (4:00 PM - 8:00 PM ET) for:
 * - Significant price gaps from market close
 * - Earnings reactions
 * - News-driven moves
 * - Sets up next-day gap plays
 */

const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');
const config = require('../../config');

class AfterHoursScanner {
  constructor() {
    this.closeingPrices = new Map(); // ticker -> closing price
    this.afterHoursAlerts = [];
    this.lastScanTime = null;

    // Thresholds
    this.minGapPercent = 2.0;     // Minimum 2% move to alert
    this.largeGapPercent = 5.0;   // Large move threshold
    this.extremeGapPercent = 10.0; // Extreme move (likely earnings)
  }

  // Check if it's after-hours time (4:00 PM - 8:00 PM ET)
  isAfterHoursTime() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hours = et.getHours();

    // 4:00 PM to 8:00 PM ET (16:00 - 20:00)
    return hours >= 16 && hours < 20;
  }

  // Store closing prices at market close
  storeClosingPrices(priceData) {
    for (const [ticker, price] of Object.entries(priceData)) {
      this.closeingPrices.set(ticker, {
        price,
        timestamp: Date.now()
      });
    }
    logger.info(`Stored closing prices for ${this.closeingPrices.size} tickers`);
  }

  // Scan for after-hours movers
  async scan() {
    if (!this.isAfterHoursTime()) {
      return null;
    }

    logger.info('Running after-hours scan...');
    this.afterHoursAlerts = [];

    try {
      const results = {
        movers: [],
        timestamp: new Date().toISOString()
      };

      // Scan top tickers for after-hours moves
      for (const ticker of config.topTickers.slice(0, 50)) {
        try {
          const closingData = this.closeingPrices.get(ticker);
          if (!closingData) continue;

          const snapshot = await polygonRest.getStockSnapshot(ticker);
          if (!snapshot || !snapshot.price) continue;

          const afterHoursPrice = snapshot.price;
          const closingPrice = closingData.price;

          // Calculate gap from close
          const gapPercent = ((afterHoursPrice - closingPrice) / closingPrice) * 100;
          const absGap = Math.abs(gapPercent);

          if (absGap >= this.minGapPercent) {
            const moveType = gapPercent > 0 ? 'UP' : 'DOWN';
            const severity = absGap >= this.extremeGapPercent ? 'EXTREME' :
                            absGap >= this.largeGapPercent ? 'LARGE' : 'MODERATE';

            results.movers.push({
              ticker,
              gapPercent: gapPercent.toFixed(2),
              moveType,
              severity,
              closingPrice,
              afterHoursPrice,
              dollarMove: (afterHoursPrice - closingPrice).toFixed(2),
              volume: snapshot.todayVolume || 0
            });
          }

          // Rate limiting
          await this.sleep(100);
        } catch (err) {
          // Skip individual ticker errors
        }
      }

      // Sort by absolute gap
      results.movers.sort((a, b) => Math.abs(parseFloat(b.gapPercent)) - Math.abs(parseFloat(a.gapPercent)));

      // Keep top 15
      results.movers = results.movers.slice(0, 15);

      this.afterHoursAlerts = results.movers;
      this.lastScanTime = new Date();

      logger.info(`After-hours scan complete: ${results.movers.length} significant movers`);

      return results;
    } catch (error) {
      logger.error('After-hours scan failed', { error: error.message });
      return null;
    }
  }

  // Format after-hours alerts for Discord
  formatAfterHoursAlerts() {
    if (this.afterHoursAlerts.length === 0) {
      return null;
    }

    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setTitle('🌙 After-Hours Movers')
      .setColor(0x9B59B6) // Purple for night
      .setTimestamp();

    let description = '';

    for (const mover of this.afterHoursAlerts) {
      const emoji = mover.moveType === 'UP' ? '🟢' : '🔴';
      const arrow = mover.moveType === 'UP' ? '↑' : '↓';
      const severityEmoji = mover.severity === 'EXTREME' ? '🔥🔥🔥' :
                           mover.severity === 'LARGE' ? '🔥' : '';

      description += `${emoji} **${mover.ticker}** ${severityEmoji}\n`;
      description += `   ${arrow} ${mover.gapPercent}% ($${mover.dollarMove})\n`;
      description += `   Close: $${mover.closingPrice.toFixed(2)} → AH: $${mover.afterHoursPrice.toFixed(2)}\n`;
      description += '\n';
    }

    embed.setDescription(description);

    // Add summary
    const ups = this.afterHoursAlerts.filter(m => m.moveType === 'UP').length;
    const downs = this.afterHoursAlerts.filter(m => m.moveType === 'DOWN').length;

    embed.addFields({
      name: '📊 Summary',
      value: `Up: ${ups} | Down: ${downs}`,
      inline: false
    });

    embed.setFooter({ text: 'After-Hours Scanner | 4:00-8:00 PM ET' });

    return embed;
  }

  // Get gap play setups for next day
  getNextDaySetups() {
    const setups = [];

    for (const mover of this.afterHoursAlerts) {
      const absGap = Math.abs(parseFloat(mover.gapPercent));

      if (absGap >= 3.0) {
        // Large gaps often have continuation OR mean reversion
        const setup = {
          ticker: mover.ticker,
          gapDirection: mover.moveType,
          gapSize: mover.gapPercent,

          // Continuation play
          continuation: {
            direction: mover.moveType === 'UP' ? 'BULLISH' : 'BEARISH',
            entry: mover.moveType === 'UP'
              ? `Above $${(mover.afterHoursPrice * 1.005).toFixed(2)}`
              : `Below $${(mover.afterHoursPrice * 0.995).toFixed(2)}`,
            thesis: absGap >= 5 ? 'Large gap often continues in first 30 min' : 'Gap continuation play'
          },

          // Mean reversion play (gap fill)
          gapFill: {
            direction: mover.moveType === 'UP' ? 'BEARISH' : 'BULLISH',
            target: mover.closingPrice,
            thesis: 'Watch for gap fill if opening drive fails'
          },

          // Key levels
          levels: {
            previousClose: mover.closingPrice,
            afterHoursHigh: mover.moveType === 'UP' ? mover.afterHoursPrice : null,
            afterHoursLow: mover.moveType === 'DOWN' ? mover.afterHoursPrice : null
          }
        };

        setups.push(setup);
      }
    }

    return setups;
  }

  // Format next-day setups for Discord
  formatNextDaySetups() {
    const setups = this.getNextDaySetups();
    if (setups.length === 0) {
      return null;
    }

    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setTitle('📋 Next-Day Gap Play Setups')
      .setColor(0x3498DB)
      .setTimestamp();

    let description = '';

    for (const setup of setups.slice(0, 5)) {
      const emoji = setup.gapDirection === 'UP' ? '🟢' : '🔴';

      description += `${emoji} **${setup.ticker}** - ${setup.gapSize}% gap ${setup.gapDirection.toLowerCase()}\n`;
      description += `\n`;

      // Continuation
      description += `📈 **Continuation Play:**\n`;
      description += `   Entry: ${setup.continuation.entry}\n`;
      description += `   Direction: ${setup.continuation.direction}\n`;
      description += `\n`;

      // Gap fill
      description += `📉 **Gap Fill Watch:**\n`;
      description += `   Target: $${setup.gapFill.target.toFixed(2)} (prev close)\n`;
      description += `\n`;
      description += '─'.repeat(30) + '\n';
    }

    embed.setDescription(description);
    embed.setFooter({ text: 'Monitor at open for entries' });

    return embed;
  }

  // Clear closing prices (call at start of new day)
  clearClosingPrices() {
    this.closeingPrices.clear();
    this.afterHoursAlerts = [];
    logger.info('Cleared closing prices for new trading day');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new AfterHoursScanner();
