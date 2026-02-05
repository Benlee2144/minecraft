/**
 * Pre-Market Scanner
 * Runs from 9:00 AM - 9:30 AM ET to identify:
 * - Gap ups/downs from previous close
 * - Pre-market volume leaders
 * - Key levels to watch at open
 */

const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');
const config = require('../../config');

class PreMarketScanner {
  constructor() {
    this.gapAlerts = [];
    this.volumeLeaders = [];
    this.lastScanTime = null;
    this.scanInterval = null;
    this.isRunning = false;

    // Thresholds
    this.minGapPercent = 2.0;      // Minimum 2% gap to alert
    this.largeGapPercent = 5.0;    // Large gap threshold
    this.extremeGapPercent = 10.0; // Extreme gap threshold
    this.minPreMarketVolume = 50000; // Minimum pre-market volume
  }

  // Check if it's pre-market time (9:00 AM - 9:30 AM ET)
  isPreMarketTime() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hours = et.getHours();
    const minutes = et.getMinutes();

    // 9:00 AM to 9:30 AM ET
    if (hours === 9 && minutes < 30) {
      return true;
    }
    return false;
  }

  // Get time until pre-market starts
  getTimeUntilPreMarket() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

    // Set target to 9:00 AM ET today
    const target = new Date(et);
    target.setHours(9, 0, 0, 0);

    // If past 9:00 AM, set to tomorrow
    if (et >= target) {
      target.setDate(target.getDate() + 1);
    }

    return target - et;
  }

  // Scan for gaps and pre-market movers
  async scan() {
    if (!this.isPreMarketTime()) {
      return null;
    }

    logger.info('Running pre-market scan...');
    this.gapAlerts = [];
    this.volumeLeaders = [];

    try {
      const results = {
        gaps: [],
        volumeLeaders: [],
        timestamp: new Date().toISOString()
      };

      // Scan top tickers for gaps
      for (const ticker of config.topTickers.slice(0, 50)) {
        try {
          const [snapshot, prevClose] = await Promise.all([
            polygonRest.getStockSnapshot(ticker),
            polygonRest.getPreviousClose(ticker)
          ]);

          if (!snapshot || !prevClose) continue;

          const currentPrice = snapshot.price || snapshot.lastTrade?.p;
          const previousClose = prevClose.close;

          if (!currentPrice || !previousClose) continue;

          // Calculate gap
          const gapPercent = ((currentPrice - previousClose) / previousClose) * 100;
          const absGap = Math.abs(gapPercent);

          // Check for significant gap
          if (absGap >= this.minGapPercent) {
            const gapType = gapPercent > 0 ? 'GAP_UP' : 'GAP_DOWN';
            const severity = absGap >= this.extremeGapPercent ? 'EXTREME' :
                            absGap >= this.largeGapPercent ? 'LARGE' : 'MODERATE';

            results.gaps.push({
              ticker,
              gapPercent: gapPercent.toFixed(2),
              gapType,
              severity,
              currentPrice,
              previousClose,
              preMarketVolume: snapshot.todayVolume || 0,
              high: snapshot.high,
              low: snapshot.low,
              vwap: snapshot.vwap
            });
          }

          // Track volume leaders
          if (snapshot.todayVolume >= this.minPreMarketVolume) {
            results.volumeLeaders.push({
              ticker,
              volume: snapshot.todayVolume,
              price: currentPrice,
              changePercent: gapPercent.toFixed(2)
            });
          }

          // Rate limiting
          await this.sleep(100);
        } catch (err) {
          // Skip individual ticker errors
        }
      }

      // Sort gaps by absolute value
      results.gaps.sort((a, b) => Math.abs(parseFloat(b.gapPercent)) - Math.abs(parseFloat(a.gapPercent)));

      // Sort volume leaders
      results.volumeLeaders.sort((a, b) => b.volume - a.volume);

      // Keep top 10 of each
      results.gaps = results.gaps.slice(0, 10);
      results.volumeLeaders = results.volumeLeaders.slice(0, 10);

      this.gapAlerts = results.gaps;
      this.volumeLeaders = results.volumeLeaders;
      this.lastScanTime = new Date();

      logger.info(`Pre-market scan complete: ${results.gaps.length} gaps, ${results.volumeLeaders.length} volume leaders`);

      return results;
    } catch (error) {
      logger.error('Pre-market scan failed', { error: error.message });
      return null;
    }
  }

  // Format gap alerts for Discord
  formatGapAlerts() {
    if (this.gapAlerts.length === 0) {
      return null;
    }

    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setTitle('🌅 Pre-Market Gap Scanner')
      .setColor(0xFFA500)
      .setTimestamp();

    let description = '';

    for (const gap of this.gapAlerts) {
      const emoji = gap.gapType === 'GAP_UP' ? '🟢' : '🔴';
      const arrow = gap.gapType === 'GAP_UP' ? '↑' : '↓';
      const severityEmoji = gap.severity === 'EXTREME' ? '🔥🔥🔥' :
                           gap.severity === 'LARGE' ? '🔥' : '';

      description += `${emoji} **${gap.ticker}** ${severityEmoji}\n`;
      description += `   ${arrow} ${gap.gapPercent}% gap | $${gap.currentPrice.toFixed(2)} (prev: $${gap.previousClose.toFixed(2)})\n`;
      if (gap.preMarketVolume > 0) {
        description += `   Vol: ${(gap.preMarketVolume / 1000).toFixed(0)}K\n`;
      }
      description += '\n';
    }

    embed.setDescription(description);

    // Add summary
    const gapUps = this.gapAlerts.filter(g => g.gapType === 'GAP_UP').length;
    const gapDowns = this.gapAlerts.filter(g => g.gapType === 'GAP_DOWN').length;

    embed.addFields({
      name: '📊 Summary',
      value: `Gap Ups: ${gapUps} | Gap Downs: ${gapDowns}`,
      inline: false
    });

    embed.setFooter({ text: 'Pre-Market Scanner | 9:00-9:30 AM ET' });

    return embed;
  }

  // Format volume leaders for Discord
  formatVolumeLeaders() {
    if (this.volumeLeaders.length === 0) {
      return null;
    }

    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setTitle('📊 Pre-Market Volume Leaders')
      .setColor(0x3498DB)
      .setTimestamp();

    let description = '';

    for (let i = 0; i < Math.min(this.volumeLeaders.length, 10); i++) {
      const leader = this.volumeLeaders[i];
      const emoji = parseFloat(leader.changePercent) >= 0 ? '🟢' : '🔴';
      const rank = i + 1;

      description += `**${rank}.** ${emoji} **${leader.ticker}** - ${(leader.volume / 1000).toFixed(0)}K shares\n`;
      description += `    $${leader.price.toFixed(2)} (${leader.changePercent}%)\n\n`;
    }

    embed.setDescription(description);
    embed.setFooter({ text: 'Pre-Market Volume | Updated every 5 min' });

    return embed;
  }

  // Get watchlist for open
  getOpeningWatchlist() {
    const watchlist = [];

    // Add extreme gaps
    for (const gap of this.gapAlerts) {
      if (gap.severity === 'EXTREME' || gap.severity === 'LARGE') {
        watchlist.push({
          ticker: gap.ticker,
          reason: `${gap.gapPercent}% gap ${gap.gapType === 'GAP_UP' ? 'up' : 'down'}`,
          price: gap.currentPrice,
          levels: {
            previousClose: gap.previousClose,
            preMarketHigh: gap.high,
            preMarketLow: gap.low,
            vwap: gap.vwap
          }
        });
      }
    }

    // Add top volume leaders not already in list
    for (const leader of this.volumeLeaders.slice(0, 5)) {
      if (!watchlist.find(w => w.ticker === leader.ticker)) {
        watchlist.push({
          ticker: leader.ticker,
          reason: `High pre-market volume (${(leader.volume / 1000).toFixed(0)}K)`,
          price: leader.price
        });
      }
    }

    return watchlist;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new PreMarketScanner();
