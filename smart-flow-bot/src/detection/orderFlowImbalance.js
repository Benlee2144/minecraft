/**
 * Order Flow Imbalance Detection Module
 * Tracks buying vs selling pressure:
 * - Volume imbalance (uptick vs downtick volume)
 * - Price-weighted order flow
 * - Cumulative delta estimation
 * - Absorption detection
 * - Exhaustion signals
 */

const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');

class OrderFlowImbalance {
  constructor() {
    // Track flow data per ticker
    this.flowData = new Map(); // ticker -> flow statistics
    this.maxHistoryLength = 100;

    // Cumulative delta tracking
    this.cumulativeDelta = new Map(); // ticker -> running delta

    // Flow alerts
    this.flowAlerts = [];

    // Thresholds
    this.IMBALANCE_THRESHOLD = 0.65; // 65% one-sided = significant imbalance
    this.ABSORPTION_THRESHOLD = 0.80; // 80% one-sided = absorption
    this.EXHAUSTION_VOLUME_SPIKE = 3.0; // 3x volume for exhaustion
  }

  // Update flow data for a ticker
  updateFlowData(ticker, tradeData) {
    if (!this.flowData.has(ticker)) {
      this.flowData.set(ticker, {
        history: [],
        buyVolume: 0,
        sellVolume: 0,
        totalVolume: 0,
        lastPrice: null,
        cumulativeDelta: 0
      });
    }

    const flow = this.flowData.get(ticker);
    const { price, volume, change } = tradeData;

    // Classify trade as buy or sell based on price movement
    const isBuy = change > 0 || (flow.lastPrice !== null && price > flow.lastPrice);
    const isSell = change < 0 || (flow.lastPrice !== null && price < flow.lastPrice);

    // Update volumes
    if (isBuy) {
      flow.buyVolume += volume;
      flow.cumulativeDelta += volume;
    } else if (isSell) {
      flow.sellVolume += volume;
      flow.cumulativeDelta -= volume;
    } else {
      // Neutral - split volume
      flow.buyVolume += volume / 2;
      flow.sellVolume += volume / 2;
    }

    flow.totalVolume += volume;
    flow.lastPrice = price;

    // Store in history
    flow.history.push({
      timestamp: Date.now(),
      price,
      volume,
      isBuy,
      delta: isBuy ? volume : -volume
    });

    // Trim history
    if (flow.history.length > this.maxHistoryLength) {
      flow.history.shift();
    }
  }

  // Get current imbalance for a ticker
  getImbalance(ticker) {
    const flow = this.flowData.get(ticker);
    if (!flow || flow.totalVolume === 0) {
      return null;
    }

    const buyRatio = flow.buyVolume / flow.totalVolume;
    const sellRatio = flow.sellVolume / flow.totalVolume;
    const dominantSide = buyRatio > sellRatio ? 'BUY' : 'SELL';
    const imbalanceRatio = Math.max(buyRatio, sellRatio);

    return {
      ticker,
      buyVolume: flow.buyVolume,
      sellVolume: flow.sellVolume,
      totalVolume: flow.totalVolume,
      buyRatio: (buyRatio * 100).toFixed(1),
      sellRatio: (sellRatio * 100).toFixed(1),
      dominantSide,
      imbalanceRatio: (imbalanceRatio * 100).toFixed(1),
      cumulativeDelta: flow.cumulativeDelta,
      hasSignificantImbalance: imbalanceRatio >= this.IMBALANCE_THRESHOLD,
      hasAbsorption: imbalanceRatio >= this.ABSORPTION_THRESHOLD
    };
  }

  // Analyze flow for patterns
  analyzeFlow(ticker) {
    const flow = this.flowData.get(ticker);
    if (!flow || flow.history.length < 20) {
      return null;
    }

    const analysis = {
      ticker,
      patterns: [],
      signals: []
    };

    // Calculate recent imbalance (last 20 trades)
    const recent = flow.history.slice(-20);
    const recentBuys = recent.filter(t => t.isBuy);
    const recentSells = recent.filter(t => !t.isBuy);

    const recentBuyVol = recentBuys.reduce((s, t) => s + t.volume, 0);
    const recentSellVol = recentSells.reduce((s, t) => s + t.volume, 0);
    const recentTotal = recentBuyVol + recentSellVol;

    if (recentTotal === 0) return null;

    const recentBuyRatio = recentBuyVol / recentTotal;
    const recentSellRatio = recentSellVol / recentTotal;

    // Pattern 1: Strong Buying Pressure
    if (recentBuyRatio >= this.IMBALANCE_THRESHOLD) {
      analysis.patterns.push({
        type: 'BUYING_PRESSURE',
        strength: ((recentBuyRatio - 0.5) * 200).toFixed(0),
        description: `${(recentBuyRatio * 100).toFixed(0)}% buy volume in recent trades`
      });

      analysis.signals.push({
        type: 'BULLISH_FLOW',
        emoji: '🟢',
        message: `Strong buying pressure detected (${(recentBuyRatio * 100).toFixed(0)}% buys)`
      });
    }

    // Pattern 2: Strong Selling Pressure
    if (recentSellRatio >= this.IMBALANCE_THRESHOLD) {
      analysis.patterns.push({
        type: 'SELLING_PRESSURE',
        strength: ((recentSellRatio - 0.5) * 200).toFixed(0),
        description: `${(recentSellRatio * 100).toFixed(0)}% sell volume in recent trades`
      });

      analysis.signals.push({
        type: 'BEARISH_FLOW',
        emoji: '🔴',
        message: `Strong selling pressure detected (${(recentSellRatio * 100).toFixed(0)}% sells)`
      });
    }

    // Pattern 3: Absorption (one-sided but price not moving much)
    const firstPrice = recent[0].price;
    const lastPrice = recent[recent.length - 1].price;
    const priceChange = Math.abs((lastPrice - firstPrice) / firstPrice) * 100;

    if (Math.max(recentBuyRatio, recentSellRatio) >= this.ABSORPTION_THRESHOLD && priceChange < 0.5) {
      const absorbingSide = recentBuyRatio > recentSellRatio ? 'BUYERS' : 'SELLERS';
      analysis.patterns.push({
        type: 'ABSORPTION',
        side: absorbingSide,
        description: `${absorbingSide} absorbing selling/buying pressure`
      });

      analysis.signals.push({
        type: 'ABSORPTION',
        emoji: '🛡️',
        message: `${absorbingSide} absorbing pressure - potential reversal setup`
      });
    }

    // Pattern 4: Exhaustion (high volume with minimal price progress)
    const avgVolume = flow.history.slice(-50).reduce((s, t) => s + t.volume, 0) / 50;
    const recentAvgVol = recentTotal / recent.length;

    if (recentAvgVol > avgVolume * this.EXHAUSTION_VOLUME_SPIKE && priceChange < 1.0) {
      analysis.patterns.push({
        type: 'EXHAUSTION',
        volumeSpike: (recentAvgVol / avgVolume).toFixed(1),
        description: `${(recentAvgVol / avgVolume).toFixed(1)}x volume with minimal price movement`
      });

      analysis.signals.push({
        type: 'EXHAUSTION',
        emoji: '⚠️',
        message: 'Potential exhaustion - high volume but price stalling'
      });
    }

    // Pattern 5: Delta divergence (cumulative delta vs price)
    const deltaDirection = flow.cumulativeDelta > 0 ? 'POSITIVE' : 'NEGATIVE';
    const priceDirection = lastPrice > firstPrice ? 'UP' : 'DOWN';

    if ((deltaDirection === 'POSITIVE' && priceDirection === 'DOWN') ||
        (deltaDirection === 'NEGATIVE' && priceDirection === 'UP')) {
      analysis.patterns.push({
        type: 'DELTA_DIVERGENCE',
        description: `Cumulative delta ${deltaDirection} but price moving ${priceDirection}`
      });

      analysis.signals.push({
        type: 'DIVERGENCE',
        emoji: '🔀',
        message: `Delta divergence: ${deltaDirection} delta but price ${priceDirection}`
      });
    }

    return analysis;
  }

  // Get flow score adjustment for heat score
  getFlowScoreAdjustment(ticker, signalDirection) {
    const imbalance = this.getImbalance(ticker);
    if (!imbalance) return { adjustment: 0, reason: null };

    let adjustment = 0;
    let reason = null;

    // Flow confirmation
    const flowDirection = imbalance.dominantSide === 'BUY' ? 'BULLISH' : 'BEARISH';

    if (imbalance.hasSignificantImbalance) {
      if (flowDirection === signalDirection) {
        // Flow confirms signal
        adjustment = 10;
        reason = `Order flow confirms ${signalDirection} bias (${imbalance.imbalanceRatio}% ${imbalance.dominantSide.toLowerCase()})`;
      } else {
        // Flow contradicts signal
        adjustment = -5;
        reason = `Order flow contradicts signal (${imbalance.imbalanceRatio}% ${imbalance.dominantSide.toLowerCase()})`;
      }
    }

    // Extra bonus for absorption
    if (imbalance.hasAbsorption) {
      adjustment += 5;
      reason = (reason ? reason + '; ' : '') + 'Strong absorption detected';
    }

    return { adjustment, reason, imbalance };
  }

  // Format flow summary for Discord
  formatFlowSummary(ticker) {
    const imbalance = this.getImbalance(ticker);
    const analysis = this.analyzeFlow(ticker);

    if (!imbalance) {
      return 'Insufficient order flow data';
    }

    let summary = '';

    // Imbalance bar
    const buyBar = '🟢'.repeat(Math.round(parseFloat(imbalance.buyRatio) / 20));
    const sellBar = '🔴'.repeat(Math.round(parseFloat(imbalance.sellRatio) / 20));

    summary += `**Order Flow: ${ticker}**\n`;
    summary += `Buy ${imbalance.buyRatio}% ${buyBar}\n`;
    summary += `Sell ${imbalance.sellRatio}% ${sellBar}\n`;
    summary += `\n`;

    // Cumulative delta
    const deltaEmoji = imbalance.cumulativeDelta > 0 ? '📈' : '📉';
    summary += `${deltaEmoji} Cumulative Delta: ${imbalance.cumulativeDelta > 0 ? '+' : ''}${this.formatVolume(imbalance.cumulativeDelta)}\n`;

    // Patterns detected
    if (analysis && analysis.signals.length > 0) {
      summary += '\n**Patterns:**\n';
      for (const signal of analysis.signals) {
        summary += `${signal.emoji} ${signal.message}\n`;
      }
    }

    return summary;
  }

  // Format flow embed for Discord
  formatFlowEmbed(ticker) {
    const { EmbedBuilder } = require('discord.js');
    const imbalance = this.getImbalance(ticker);
    const analysis = this.analyzeFlow(ticker);

    const embed = new EmbedBuilder()
      .setTitle(`📊 Order Flow: ${ticker}`)
      .setColor(imbalance?.dominantSide === 'BUY' ? 0x00FF00 : 0xFF0000)
      .setTimestamp();

    if (!imbalance) {
      embed.setDescription('Insufficient order flow data. Check back later.');
      return embed;
    }

    // Create visual bar
    const buyBlocks = Math.round(parseFloat(imbalance.buyRatio) / 10);
    const sellBlocks = Math.round(parseFloat(imbalance.sellRatio) / 10);
    const buyBar = '█'.repeat(buyBlocks) + '░'.repeat(10 - buyBlocks);
    const sellBar = '█'.repeat(sellBlocks) + '░'.repeat(10 - sellBlocks);

    let description = `**Buy Volume:** ${this.formatVolume(imbalance.buyVolume)}\n`;
    description += `\`${buyBar}\` ${imbalance.buyRatio}%\n\n`;
    description += `**Sell Volume:** ${this.formatVolume(imbalance.sellVolume)}\n`;
    description += `\`${sellBar}\` ${imbalance.sellRatio}%\n\n`;

    // Dominant side
    const dominantEmoji = imbalance.dominantSide === 'BUY' ? '🟢' : '🔴';
    description += `${dominantEmoji} **Dominant Side:** ${imbalance.dominantSide} (${imbalance.imbalanceRatio}%)\n`;

    // Cumulative delta
    const deltaEmoji = imbalance.cumulativeDelta > 0 ? '📈' : '📉';
    description += `${deltaEmoji} **Cumulative Delta:** ${imbalance.cumulativeDelta > 0 ? '+' : ''}${this.formatVolume(imbalance.cumulativeDelta)}`;

    embed.setDescription(description);

    // Add patterns if detected
    if (analysis && analysis.patterns.length > 0) {
      const patternText = analysis.signals.map(s =>
        `${s.emoji} ${s.message}`
      ).join('\n');

      embed.addFields({
        name: '🔍 Detected Patterns',
        value: patternText,
        inline: false
      });
    }

    // Trading bias
    const bias = this.getTradingBias(imbalance);
    embed.addFields({
      name: '🎯 Trading Bias',
      value: bias,
      inline: false
    });

    return embed;
  }

  // Get trading bias based on flow
  getTradingBias(imbalance) {
    if (!imbalance) return 'Neutral - insufficient data';

    const ratio = parseFloat(imbalance.imbalanceRatio);

    if (ratio >= 80) {
      return imbalance.dominantSide === 'BUY'
        ? '🟢 **Strong Bullish** - Heavy buying pressure, look for continuation'
        : '🔴 **Strong Bearish** - Heavy selling pressure, watch for breakdown';
    }
    if (ratio >= 65) {
      return imbalance.dominantSide === 'BUY'
        ? '🟢 **Bullish** - Buyers in control'
        : '🔴 **Bearish** - Sellers in control';
    }
    if (ratio >= 55) {
      return imbalance.dominantSide === 'BUY'
        ? '🟡 **Slight Bullish** - Marginal buying edge'
        : '🟡 **Slight Bearish** - Marginal selling edge';
    }

    return '⚪ **Neutral** - Balanced order flow, wait for direction';
  }

  // Format volume
  formatVolume(vol) {
    const absVol = Math.abs(vol);
    if (absVol >= 1000000) return (vol / 1000000).toFixed(2) + 'M';
    if (absVol >= 1000) return (vol / 1000).toFixed(1) + 'K';
    return vol.toFixed(0);
  }

  // Clear flow data for a ticker
  clearFlowData(ticker) {
    this.flowData.delete(ticker);
  }

  // Clear all flow data (end of day)
  clearAllFlowData() {
    this.flowData.clear();
    this.cumulativeDelta.clear();
    this.flowAlerts = [];
    logger.info('Order flow data cleared for new trading day');
  }

  // Simulate flow data from REST snapshot (when websocket not available)
  async updateFromSnapshot(ticker) {
    try {
      const snapshot = await polygonRest.getStockSnapshot(ticker);
      if (!snapshot) return null;

      // Simulate flow based on price change
      const change = snapshot.todayChangePercent || 0;
      const volume = snapshot.todayVolume || 0;

      // Estimate buy/sell split based on price direction
      // This is a simplification - real flow needs tick-by-tick data
      let buyRatio = 0.5;
      if (change > 0) {
        buyRatio = 0.5 + (Math.min(change, 5) * 0.05); // Up to 75% buy on +5%
      } else if (change < 0) {
        buyRatio = 0.5 + (Math.max(change, -5) * 0.05); // Down to 25% buy on -5%
      }

      const buyVolume = volume * buyRatio;
      const sellVolume = volume * (1 - buyRatio);

      this.flowData.set(ticker, {
        history: [],
        buyVolume,
        sellVolume,
        totalVolume: volume,
        lastPrice: snapshot.price,
        cumulativeDelta: buyVolume - sellVolume
      });

      return this.getImbalance(ticker);
    } catch (error) {
      logger.error(`Error updating flow from snapshot for ${ticker}`, { error: error.message });
      return null;
    }
  }
}

module.exports = new OrderFlowImbalance();
