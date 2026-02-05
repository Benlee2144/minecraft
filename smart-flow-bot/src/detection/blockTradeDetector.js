/**
 * Block Trade & Dark Pool Detection Module
 * Identifies institutional activity:
 * - Large block trades (>10k shares or $200k+)
 * - Dark pool prints (large trades at specific prices)
 * - Sweep detection (multiple exchanges hit at once)
 * - Hidden order detection
 * - Institutional accumulation/distribution patterns
 */

const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');
const config = require('../../config');

class BlockTradeDetector {
  constructor() {
    // Block trade tracking
    this.blockTrades = new Map(); // ticker -> array of block trades
    this.maxHistory = 50;

    // Thresholds
    this.thresholds = {
      minBlockShares: 10000,         // 10k shares minimum
      minBlockValue: 200000,          // $200k minimum value
      largeBlockValue: 500000,        // $500k for "large" designation
      hugeBlockValue: 1000000,        // $1M for "huge" designation
      massiveBlockValue: 5000000,     // $5M for "massive"
      darkPoolMinValue: 100000,       // Dark pool print threshold
      accumulationWindow: 60,         // 60 minutes for accumulation pattern
      minBlocksForPattern: 3          // Minimum blocks to detect pattern
    };

    // Accumulation/Distribution tracking
    this.institutionalFlow = new Map(); // ticker -> { buys: [], sells: [] }

    // Dark pool indicators
    this.darkPoolPrints = new Map(); // ticker -> prints at round numbers
  }

  // Analyze trade for block characteristics
  analyzeBlock(ticker, trade) {
    const { price, size, timestamp, conditions } = trade;
    const value = price * size;

    // Check if it qualifies as a block trade
    if (size < this.thresholds.minBlockShares && value < this.thresholds.minBlockValue) {
      return null;
    }

    // Determine block classification
    let classification = 'BLOCK';
    let emoji = '📦';

    if (value >= this.thresholds.massiveBlockValue) {
      classification = 'MASSIVE_BLOCK';
      emoji = '🐋🐋🐋';
    } else if (value >= this.thresholds.hugeBlockValue) {
      classification = 'HUGE_BLOCK';
      emoji = '🐋🐋';
    } else if (value >= this.thresholds.largeBlockValue) {
      classification = 'LARGE_BLOCK';
      emoji = '🐋';
    }

    // Check for dark pool characteristics
    const isDarkPool = this.isDarkPoolPrint(price, conditions);

    // Determine direction (buy/sell) based on conditions
    const direction = this.inferBlockDirection(trade);

    const blockTrade = {
      ticker,
      price,
      size,
      value,
      classification,
      emoji,
      isDarkPool,
      direction,
      timestamp: timestamp || Date.now(),
      formattedValue: this.formatValue(value),
      formattedSize: this.formatSize(size)
    };

    // Store block trade
    this.storeBlockTrade(ticker, blockTrade);

    // Update institutional flow
    this.updateInstitutionalFlow(ticker, blockTrade);

    // Check for dark pool prints
    if (isDarkPool) {
      this.trackDarkPoolPrint(ticker, blockTrade);
    }

    return blockTrade;
  }

  // Check if trade has dark pool characteristics
  isDarkPoolPrint(price, conditions = []) {
    // Dark pool trades often:
    // 1. Trade at round numbers or VWAP
    // 2. Have specific condition codes
    // 3. Are larger than typical retail trades

    // Check for round price (within $0.05 of round number)
    const isRoundPrice = Math.abs(price - Math.round(price)) < 0.05;

    // Check for half dollar
    const isHalfDollar = Math.abs((price * 2) - Math.round(price * 2)) < 0.10;

    // Check trade conditions (if available)
    const darkPoolConditions = ['D', 'W', 'X']; // Common dark pool codes
    const hasDarkPoolCondition = conditions.some(c =>
      darkPoolConditions.includes(c)
    );

    return isRoundPrice || isHalfDollar || hasDarkPoolCondition;
  }

  // Infer block trade direction
  inferBlockDirection(trade) {
    const { price, conditions = [], previousClose } = trade;

    // Check trade conditions for direction hints
    if (conditions.includes('B') || conditions.includes('A')) {
      return conditions.includes('B') ? 'BUY' : 'SELL';
    }

    // Infer from price vs previous close
    if (previousClose) {
      return price > previousClose ? 'BUY' : 'SELL';
    }

    return 'UNKNOWN';
  }

  // Store block trade in history
  storeBlockTrade(ticker, blockTrade) {
    if (!this.blockTrades.has(ticker)) {
      this.blockTrades.set(ticker, []);
    }

    const trades = this.blockTrades.get(ticker);
    trades.push(blockTrade);

    // Trim history
    if (trades.length > this.maxHistory) {
      trades.shift();
    }
  }

  // Update institutional flow tracking
  updateInstitutionalFlow(ticker, blockTrade) {
    if (!this.institutionalFlow.has(ticker)) {
      this.institutionalFlow.set(ticker, {
        buys: [],
        sells: [],
        netFlow: 0,
        lastUpdate: Date.now()
      });
    }

    const flow = this.institutionalFlow.get(ticker);

    if (blockTrade.direction === 'BUY') {
      flow.buys.push(blockTrade);
      flow.netFlow += blockTrade.value;
    } else if (blockTrade.direction === 'SELL') {
      flow.sells.push(blockTrade);
      flow.netFlow -= blockTrade.value;
    }

    flow.lastUpdate = Date.now();
  }

  // Track dark pool prints at specific prices
  trackDarkPoolPrint(ticker, blockTrade) {
    if (!this.darkPoolPrints.has(ticker)) {
      this.darkPoolPrints.set(ticker, []);
    }

    const prints = this.darkPoolPrints.get(ticker);
    prints.push({
      price: blockTrade.price,
      value: blockTrade.value,
      timestamp: blockTrade.timestamp
    });

    // Keep last 20 prints
    if (prints.length > 20) {
      prints.shift();
    }
  }

  // Detect block trades from REST data (snapshot)
  async detectFromSnapshot(ticker) {
    try {
      const snapshot = await polygonRest.getStockSnapshot(ticker);
      if (!snapshot) return [];

      const detectedBlocks = [];

      // Check if volume suggests institutional activity
      const avgVolume = snapshot.prevDayVolume || 1;
      const todayVolume = snapshot.todayVolume || 0;
      const volumeRatio = todayVolume / avgVolume;

      // High volume can indicate block activity
      if (volumeRatio > 2.0) {
        // Estimate potential block trades based on volume
        const estimatedBlockVolume = todayVolume * 0.1; // Assume 10% could be blocks
        const estimatedValue = estimatedBlockVolume * snapshot.price;

        if (estimatedValue >= this.thresholds.minBlockValue) {
          detectedBlocks.push({
            ticker,
            type: 'ESTIMATED_BLOCK_ACTIVITY',
            volumeRatio: volumeRatio.toFixed(1),
            estimatedValue: this.formatValue(estimatedValue),
            message: `High volume (${volumeRatio.toFixed(1)}x) suggests institutional activity`
          });
        }
      }

      // Check for unusual price levels (potential dark pool prints)
      if (snapshot.price) {
        const isRoundNumber = Math.abs(snapshot.price - Math.round(snapshot.price)) < 0.05;
        const isHalf = Math.abs((snapshot.price % 1) - 0.5) < 0.05;

        if (isRoundNumber || isHalf) {
          detectedBlocks.push({
            ticker,
            type: 'POTENTIAL_DARK_POOL_LEVEL',
            price: snapshot.price.toFixed(2),
            message: `Price at round number $${snapshot.price.toFixed(2)} - potential dark pool activity`
          });
        }
      }

      return detectedBlocks;
    } catch (error) {
      logger.error(`Error detecting blocks for ${ticker}`, { error: error.message });
      return [];
    }
  }

  // Detect accumulation pattern
  detectAccumulationPattern(ticker) {
    const flow = this.institutionalFlow.get(ticker);
    if (!flow) return null;

    const recentBuys = flow.buys.filter(b =>
      Date.now() - b.timestamp < this.thresholds.accumulationWindow * 60 * 1000
    );

    const recentSells = flow.sells.filter(s =>
      Date.now() - s.timestamp < this.thresholds.accumulationWindow * 60 * 1000
    );

    const buyVolume = recentBuys.reduce((s, b) => s + b.value, 0);
    const sellVolume = recentSells.reduce((s, b) => s + b.value, 0);

    // Need minimum blocks to detect pattern
    if (recentBuys.length + recentSells.length < this.thresholds.minBlocksForPattern) {
      return null;
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return null;

    const buyRatio = buyVolume / totalVolume;
    const sellRatio = sellVolume / totalVolume;

    // Detect accumulation (heavy buying)
    if (buyRatio > 0.7 && recentBuys.length >= 2) {
      return {
        type: 'ACCUMULATION',
        ticker,
        emoji: '🟢',
        direction: 'BULLISH',
        buyVolume: this.formatValue(buyVolume),
        sellVolume: this.formatValue(sellVolume),
        buyRatio: (buyRatio * 100).toFixed(0),
        blockCount: recentBuys.length,
        message: `Institutional accumulation detected - ${recentBuys.length} buy blocks totaling ${this.formatValue(buyVolume)}`,
        confidence: Math.min(95, 60 + (buyRatio * 30))
      };
    }

    // Detect distribution (heavy selling)
    if (sellRatio > 0.7 && recentSells.length >= 2) {
      return {
        type: 'DISTRIBUTION',
        ticker,
        emoji: '🔴',
        direction: 'BEARISH',
        buyVolume: this.formatValue(buyVolume),
        sellVolume: this.formatValue(sellVolume),
        sellRatio: (sellRatio * 100).toFixed(0),
        blockCount: recentSells.length,
        message: `Institutional distribution detected - ${recentSells.length} sell blocks totaling ${this.formatValue(sellVolume)}`,
        confidence: Math.min(95, 60 + (sellRatio * 30))
      };
    }

    return null;
  }

  // Get dark pool level analysis
  getDarkPoolLevels(ticker) {
    const prints = this.darkPoolPrints.get(ticker);
    if (!prints || prints.length < 2) return null;

    // Group prints by price level
    const priceLevels = new Map();
    for (const print of prints) {
      const roundedPrice = Math.round(print.price * 2) / 2; // Round to nearest $0.50
      if (!priceLevels.has(roundedPrice)) {
        priceLevels.set(roundedPrice, { count: 0, totalValue: 0 });
      }
      const level = priceLevels.get(roundedPrice);
      level.count++;
      level.totalValue += print.value;
    }

    // Find significant levels (multiple prints)
    const significantLevels = Array.from(priceLevels.entries())
      .filter(([_, data]) => data.count >= 2)
      .map(([price, data]) => ({
        price,
        count: data.count,
        totalValue: data.totalValue,
        formattedValue: this.formatValue(data.totalValue)
      }))
      .sort((a, b) => b.totalValue - a.totalValue);

    if (significantLevels.length === 0) return null;

    return {
      ticker,
      levels: significantLevels,
      strongestLevel: significantLevels[0],
      message: `${significantLevels.length} dark pool levels identified`
    };
  }

  // Get block score adjustment for heat score
  getBlockScoreAdjustment(ticker) {
    const trades = this.blockTrades.get(ticker);
    const pattern = this.detectAccumulationPattern(ticker);

    let adjustment = 0;
    let reason = null;

    // Recent block trades add points
    if (trades && trades.length > 0) {
      const recentBlocks = trades.filter(t =>
        Date.now() - t.timestamp < 30 * 60 * 1000 // Last 30 minutes
      );

      if (recentBlocks.length > 0) {
        const totalValue = recentBlocks.reduce((s, t) => s + t.value, 0);

        if (totalValue >= this.thresholds.hugeBlockValue) {
          adjustment = 15;
          reason = `Huge block activity: ${this.formatValue(totalValue)} in ${recentBlocks.length} blocks`;
        } else if (totalValue >= this.thresholds.largeBlockValue) {
          adjustment = 10;
          reason = `Large block activity: ${this.formatValue(totalValue)}`;
        } else {
          adjustment = 5;
          reason = `Block trade detected: ${this.formatValue(totalValue)}`;
        }
      }
    }

    // Accumulation/Distribution pattern adds more
    if (pattern) {
      if (pattern.type === 'ACCUMULATION') {
        adjustment += 10;
        reason = (reason ? reason + '; ' : '') + pattern.message;
      } else if (pattern.type === 'DISTRIBUTION') {
        adjustment -= 5; // Slight negative for distribution (unless shorting)
        reason = (reason ? reason + '; ' : '') + pattern.message;
      }
    }

    return { adjustment, reason, pattern };
  }

  // Format block trade for Discord
  formatBlockAlert(block) {
    let message = `${block.emoji} **${block.classification}** - ${block.ticker}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `💰 **Value:** ${block.formattedValue}\n`;
    message += `📊 **Size:** ${block.formattedSize} shares\n`;
    message += `💵 **Price:** $${block.price.toFixed(2)}\n`;

    if (block.isDarkPool) {
      message += `🌑 **Dark Pool Print**\n`;
    }

    if (block.direction !== 'UNKNOWN') {
      const dirEmoji = block.direction === 'BUY' ? '🟢' : '🔴';
      message += `${dirEmoji} **Direction:** ${block.direction}\n`;
    }

    return message;
  }

  // Format block trade embed for Discord
  formatBlockEmbed(ticker) {
    const { EmbedBuilder } = require('discord.js');
    const trades = this.blockTrades.get(ticker);
    const pattern = this.detectAccumulationPattern(ticker);
    const darkPoolLevels = this.getDarkPoolLevels(ticker);

    const embed = new EmbedBuilder()
      .setTitle(`🐋 Block Trade Analysis: ${ticker}`)
      .setColor(0x4169E1)
      .setTimestamp();

    if (!trades || trades.length === 0) {
      embed.setDescription('No block trades detected for this ticker.');
      return embed;
    }

    // Summary
    const totalValue = trades.reduce((s, t) => s + t.value, 0);
    const totalShares = trades.reduce((s, t) => s + t.size, 0);

    let description = `**Total Blocks:** ${trades.length}\n`;
    description += `**Total Value:** ${this.formatValue(totalValue)}\n`;
    description += `**Total Shares:** ${this.formatSize(totalShares)}\n\n`;

    // Recent blocks
    description += '**Recent Blocks:**\n';
    for (const block of trades.slice(-5).reverse()) {
      description += `${block.emoji} ${block.formattedValue} @ $${block.price.toFixed(2)}`;
      if (block.isDarkPool) description += ' 🌑';
      description += '\n';
    }

    embed.setDescription(description);

    // Pattern detection
    if (pattern) {
      embed.addFields({
        name: `${pattern.emoji} ${pattern.type} Pattern`,
        value: pattern.message + `\nConfidence: ${pattern.confidence.toFixed(0)}%`,
        inline: false
      });
    }

    // Dark pool levels
    if (darkPoolLevels && darkPoolLevels.levels.length > 0) {
      const levelText = darkPoolLevels.levels.slice(0, 3).map(l =>
        `$${l.price.toFixed(2)}: ${l.count} prints (${l.formattedValue})`
      ).join('\n');

      embed.addFields({
        name: '🌑 Dark Pool Levels',
        value: levelText,
        inline: false
      });
    }

    // Institutional flow
    const flow = this.institutionalFlow.get(ticker);
    if (flow) {
      const flowDirection = flow.netFlow > 0 ? '🟢 NET BUYING' : '🔴 NET SELLING';
      embed.addFields({
        name: '📊 Institutional Flow',
        value: `${flowDirection}\nNet: ${this.formatValue(Math.abs(flow.netFlow))}`,
        inline: true
      });
    }

    return embed;
  }

  // Format value
  formatValue(value) {
    if (value >= 1000000) return '$' + (value / 1000000).toFixed(2) + 'M';
    if (value >= 1000) return '$' + (value / 1000).toFixed(0) + 'K';
    return '$' + value.toFixed(0);
  }

  // Format size
  formatSize(size) {
    if (size >= 1000000) return (size / 1000000).toFixed(2) + 'M';
    if (size >= 1000) return (size / 1000).toFixed(1) + 'K';
    return size.toString();
  }

  // Clear data for new day
  clearDayData() {
    this.blockTrades.clear();
    this.institutionalFlow.clear();
    this.darkPoolPrints.clear();
    logger.info('Block trade data cleared for new trading day');
  }

  // Get summary statistics
  getSummary() {
    const tickers = Array.from(this.blockTrades.keys());
    let totalBlocks = 0;
    let totalValue = 0;

    for (const ticker of tickers) {
      const trades = this.blockTrades.get(ticker);
      totalBlocks += trades.length;
      totalValue += trades.reduce((s, t) => s + t.value, 0);
    }

    return {
      tickersWithBlocks: tickers.length,
      totalBlocks,
      totalValue: this.formatValue(totalValue),
      topTickers: tickers.map(t => ({
        ticker: t,
        blockCount: this.blockTrades.get(t).length,
        value: this.formatValue(this.blockTrades.get(t).reduce((s, b) => s + b.value, 0))
      })).sort((a, b) => b.blockCount - a.blockCount).slice(0, 5)
    };
  }
}

module.exports = new BlockTradeDetector();
