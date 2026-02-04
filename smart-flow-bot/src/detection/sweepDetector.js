const config = require('../../config');
const logger = require('../utils/logger');
const parser = require('../polygon/parser');
const database = require('../database/sqlite');

class SweepDetector {
  constructor() {
    // Buffer to collect trades for sweep detection
    // Key: underlyingTicker, Value: array of recent trades
    this.tradeBuffer = new Map();

    // Track last quotes for bid/ask determination
    this.lastQuotes = new Map();

    // Recent sweeps detected (for deduplication)
    this.recentSweeps = new Map();

    // Configuration
    this.bufferTimeMs = config.detection.sweepTimeWindowMs || 500;
    this.minPremium = config.detection.minSweepPremium || 100000;

    // Cleanup interval
    this.cleanupInterval = null;
  }

  initialize() {
    // Start cleanup interval to prevent memory buildup
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    logger.info('Sweep detector initialized');
  }

  // Update last quote for a ticker
  updateQuote(quote) {
    const key = quote.optionTicker || quote.ticker;
    this.lastQuotes.set(key, {
      bidPrice: quote.bidPrice,
      askPrice: quote.askPrice,
      timestamp: quote.timestamp
    });
  }

  // Process incoming option trade
  processTrade(trade) {
    if (trade.type !== 'option_trade') return null;

    const { underlyingTicker, optionTicker } = trade;

    // Get or create buffer for this underlying
    if (!this.tradeBuffer.has(underlyingTicker)) {
      this.tradeBuffer.set(underlyingTicker, []);
    }

    const buffer = this.tradeBuffer.get(underlyingTicker);

    // Determine if trade was at bid or ask
    const lastQuote = this.lastQuotes.get(optionTicker);
    const tradeSide = parser.determineTradeSide(trade, lastQuote);

    // Add trade to buffer with side info
    const enrichedTrade = {
      ...trade,
      tradeSide,
      bidPrice: lastQuote?.bidPrice,
      askPrice: lastQuote?.askPrice
    };

    buffer.push(enrichedTrade);

    // Check for sweeps
    const sweep = this.detectSweep(underlyingTicker, buffer);

    return sweep;
  }

  // Detect sweep patterns in trade buffer
  detectSweep(underlyingTicker, trades) {
    if (trades.length < 2) return null;

    const now = Date.now();

    // Filter to recent trades within the time window
    // Polygon timestamps are in nanoseconds, convert to ms
    const recentTrades = trades.filter(t => {
      const tradeTimeMs = t.timestamp / 1000000;
      return (now - tradeTimeMs) < this.bufferTimeMs * 2; // Slightly larger window for detection
    });

    if (recentTrades.length < 2) return null;

    // Group trades by option contract and direction
    const groups = this.groupTradesByContract(recentTrades);

    // Analyze each group for sweep patterns
    for (const [contractKey, contractTrades] of Object.entries(groups)) {
      const sweep = this.analyzeSweepGroup(contractTrades);
      if (sweep) {
        // Check for deduplication
        const sweepKey = `${contractKey}-${Math.floor(now / 10000)}`; // 10 second window
        if (!this.recentSweeps.has(sweepKey)) {
          this.recentSweeps.set(sweepKey, now);

          // Record in database
          database.addHeatSignal(
            sweep.underlyingTicker,
            'sweep',
            sweep.totalPremium,
            {
              contract: sweep.optionTicker,
              exchanges: sweep.exchangeCount,
              side: sweep.tradeSide
            }
          );

          return sweep;
        }
      }
    }

    return null;
  }

  // Group trades by contract
  groupTradesByContract(trades) {
    const groups = {};

    for (const trade of trades) {
      const key = trade.optionTicker;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(trade);
    }

    return groups;
  }

  // Analyze a group of trades for sweep pattern
  analyzeSweepGroup(trades) {
    if (trades.length < 2) return null;

    // Sort by timestamp
    const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

    // Find trades within sweep time window
    const sweepTrades = [];
    let startIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      // Convert nanoseconds to milliseconds
      const timeDiff = (sorted[i].timestamp - sorted[startIdx].timestamp) / 1000000;

      if (timeDiff <= this.bufferTimeMs) {
        sweepTrades.push(sorted[i]);
      } else {
        // Analyze current group if it's a sweep
        const result = this.evaluateSweep(sweepTrades);
        if (result) return result;

        // Start new group
        sweepTrades.length = 0;
        sweepTrades.push(sorted[i]);
        startIdx = i;
      }
    }

    // Check final group
    return this.evaluateSweep(sweepTrades);
  }

  // Evaluate if a group of trades qualifies as a sweep
  evaluateSweep(trades) {
    if (trades.length < 2) return null;

    // Count unique exchanges
    const exchanges = new Set(trades.map(t => t.exchange));
    if (exchanges.size < 2) return null; // Must hit at least 2 exchanges

    // Calculate totals
    const totalPremium = trades.reduce((sum, t) => sum + t.premium, 0);
    const totalContracts = trades.reduce((sum, t) => sum + t.size, 0);

    // Check minimum premium threshold
    if (totalPremium < this.minPremium) return null;

    // Determine dominant side (at ask = bullish, at bid = bearish)
    const atAskCount = trades.filter(t => t.tradeSide === 'ask' || t.tradeSide === 'above_mid').length;
    const atBidCount = trades.filter(t => t.tradeSide === 'bid' || t.tradeSide === 'below_mid').length;
    const isAtAsk = atAskCount > atBidCount;
    const isBullish = (trades[0].optionType === 'call' && isAtAsk) ||
                      (trades[0].optionType === 'put' && !isAtAsk);

    // Get average price
    const avgPrice = trades.reduce((sum, t) => sum + t.price, 0) / trades.length;

    // Get first trade info for contract details
    const firstTrade = trades[0];

    return {
      type: 'sweep',
      underlyingTicker: firstTrade.underlyingTicker,
      optionTicker: firstTrade.optionTicker,
      optionType: firstTrade.optionType,
      strike: firstTrade.strike,
      expiration: firstTrade.expiration,
      totalPremium,
      totalContracts,
      avgPrice,
      exchangeCount: exchanges.size,
      exchanges: Array.from(exchanges),
      tradeCount: trades.length,
      tradeSide: isAtAsk ? 'ask' : 'bid',
      isBullish,
      isAtAsk,
      timestamp: trades[0].timestamp,
      trades // Include individual trades for analysis
    };
  }

  // Get sweep count for a ticker in last N minutes
  getSweepCount(ticker, minutes = 30) {
    return database.getSweepCount(ticker, minutes);
  }

  // Check if there are multiple sweeps in same direction
  hasMultipleSweepsSameDirection(ticker, direction, minutes = 30) {
    const signals = database.getRecentSignals(ticker, minutes);
    const sweeps = signals.filter(s => {
      if (s.signal_type !== 'sweep') return false;
      try {
        const details = JSON.parse(s.details);
        return (direction === 'bullish' && details.side === 'ask') ||
               (direction === 'bearish' && details.side === 'bid');
      } catch {
        return false;
      }
    });
    return sweeps.length >= 2;
  }

  // Cleanup old data
  cleanup() {
    const now = Date.now();
    const maxAge = 60000; // 1 minute

    // Clean trade buffers
    for (const [ticker, trades] of this.tradeBuffer.entries()) {
      const recentTrades = trades.filter(t => {
        const tradeTimeMs = t.timestamp / 1000000;
        return (now - tradeTimeMs) < maxAge;
      });

      if (recentTrades.length === 0) {
        this.tradeBuffer.delete(ticker);
      } else {
        this.tradeBuffer.set(ticker, recentTrades);
      }
    }

    // Clean recent sweeps (older than 30 seconds)
    for (const [key, timestamp] of this.recentSweeps.entries()) {
      if (now - timestamp > 30000) {
        this.recentSweeps.delete(key);
      }
    }

    // Clean old quotes (older than 5 minutes)
    for (const [key, quote] of this.lastQuotes.entries()) {
      if (now - (quote.timestamp / 1000000) > 300000) {
        this.lastQuotes.delete(key);
      }
    }
  }

  // Get statistics
  getStats() {
    return {
      activeBuffers: this.tradeBuffer.size,
      trackedQuotes: this.lastQuotes.size,
      recentSweeps: this.recentSweeps.size
    };
  }

  // Shutdown
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Export singleton instance
module.exports = new SweepDetector();
