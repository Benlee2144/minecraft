const config = require('../../config');
const logger = require('../utils/logger');
const database = require('../database/sqlite');

class StockSignalDetector {
  constructor() {
    // Price/Volume tracking per ticker
    this.tickerData = new Map();

    // VWAP tracking
    this.vwapData = new Map();

    // Pre-market gaps
    this.preMarketData = new Map();

    // Recent signals for deduplication
    this.recentSignals = new Map();

    // Sector tracking (for relative strength)
    this.sectorETFs = {
      'XLK': 'Technology',
      'XLF': 'Financials',
      'XLE': 'Energy',
      'XLV': 'Healthcare',
      'XLI': 'Industrials',
      'XLP': 'Consumer Staples',
      'XLY': 'Consumer Discretionary',
      'XLB': 'Materials',
      'XLU': 'Utilities',
      'XLRE': 'Real Estate'
    };

    // Market reference (SPY)
    this.marketData = { price: 0, change: 0, volume: 0 };

    // Cleanup interval
    this.cleanupInterval = null;
  }

  initialize() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    logger.info('Advanced stock signal detector initialized');
  }

  // Get or create ticker data structure
  getTickerData(ticker) {
    if (!this.tickerData.has(ticker)) {
      this.tickerData.set(ticker, {
        trades: [],
        prices: [],
        volumes: [],
        highs: [],
        lows: [],
        opens: [],
        vwapNumerator: 0,
        vwapDenominator: 0,
        dayHigh: 0,
        dayLow: Infinity,
        prevClose: 0,
        avgVolume: 0,
        atr: 0,
        lastPrice: 0,
        lastUpdate: 0
      });
    }
    return this.tickerData.get(ticker);
  }

  // Process incoming stock trade
  processTrade(trade) {
    const { ticker, price, size, timestamp } = trade;
    const data = this.getTickerData(ticker);
    const tradeValue = price * size;

    // Update ticker data
    data.lastPrice = price;
    data.lastUpdate = timestamp;
    data.trades.push({ price, size, value: tradeValue, timestamp });

    // Update day high/low
    if (price > data.dayHigh) data.dayHigh = price;
    if (price < data.dayLow) data.dayLow = price;

    // Update VWAP
    data.vwapNumerator += price * size;
    data.vwapDenominator += size;

    // Keep last 1000 trades
    if (data.trades.length > 1000) data.trades.shift();

    // Update market reference if SPY
    if (ticker === 'SPY') {
      this.marketData.price = price;
    }

    // Run all detectors
    const signals = [];

    // 1. Block trade detection
    const blockSignal = this.detectBlockTrade(ticker, price, size, tradeValue, timestamp, data);
    if (blockSignal) signals.push(blockSignal);

    // 2. Momentum surge detection
    const momentumSignal = this.detectMomentumSurge(ticker, price, timestamp, data);
    if (momentumSignal) signals.push(momentumSignal);

    // 3. VWAP cross detection
    const vwapSignal = this.detectVWAPCross(ticker, price, timestamp, data);
    if (vwapSignal) signals.push(vwapSignal);

    // 4. New high/low detection
    const highLowSignal = this.detectNewHighLow(ticker, price, timestamp, data);
    if (highLowSignal) signals.push(highLowSignal);

    // Return first signal (most important)
    return signals.length > 0 ? signals[0] : null;
  }

  // Process aggregate data (minute bars)
  processAggregate(agg) {
    const { ticker, open, high, low, close, volume, vwap } = agg;
    const data = this.getTickerData(ticker);

    // Store OHLCV data
    data.prices.push(close);
    data.volumes.push(volume);
    data.highs.push(high);
    data.lows.push(low);
    data.opens.push(open);
    data.lastPrice = close;
    data.lastUpdate = Date.now();

    // Update day high/low
    if (high > data.dayHigh) data.dayHigh = high;
    if (low < data.dayLow) data.dayLow = low;

    // Keep last 390 bars (full trading day)
    const maxBars = 390;
    if (data.prices.length > maxBars) {
      data.prices.shift();
      data.volumes.shift();
      data.highs.shift();
      data.lows.shift();
      data.opens.shift();
    }

    // Update market reference if SPY
    if (ticker === 'SPY') {
      this.marketData.price = close;
      this.marketData.volume = volume;
    }

    // Run aggregate-based detectors
    const signals = [];

    // 1. Volume spike detection
    const volumeSignal = this.detectVolumeSpike(ticker, volume, close, data);
    if (volumeSignal) signals.push(volumeSignal);

    // 2. Breakout detection
    const breakoutSignal = this.detectBreakout(ticker, high, close, data);
    if (breakoutSignal) signals.push(breakoutSignal);

    // 3. Gap detection (if early in session)
    const gapSignal = this.detectGap(ticker, open, data);
    if (gapSignal) signals.push(gapSignal);

    // 4. Relative strength vs market
    const rsSignal = this.detectRelativeStrength(ticker, close, data);
    if (rsSignal) signals.push(rsSignal);

    // 5. Consolidation breakout
    const consolSignal = this.detectConsolidationBreakout(ticker, high, low, close, data);
    if (consolSignal) signals.push(consolSignal);

    return signals.length > 0 ? signals[0] : null;
  }

  // ========== SIGNAL DETECTORS ==========

  // Detect large block trades
  detectBlockTrade(ticker, price, size, tradeValue, timestamp, data) {
    const minBlock = config.detection.minBlockValue || 500000;
    const largeBlock = config.detection.largeBlockValue || 1000000;

    if (tradeValue < minBlock) return null;
    if (this.isDuplicateSignal(`block-${ticker}`, 10000)) return null;

    const isLargeBlock = tradeValue >= largeBlock;

    const signal = {
      type: 'block_trade',
      ticker,
      price,
      size,
      tradeValue,
      isLargeBlock,
      timestamp,
      description: `💰 $${this.formatValue(tradeValue)} block trade`,
      severity: isLargeBlock ? 'high' : 'medium'
    };

    database.addHeatSignal(ticker, 'block_trade', tradeValue, { price, size, isLarge: isLargeBlock });
    logger.info(`Block trade: ${ticker}`, { value: this.formatValue(tradeValue) });

    return signal;
  }

  // Detect momentum surges
  detectMomentumSurge(ticker, currentPrice, timestamp, data) {
    if (data.prices.length < 5) return null;

    // Check 1-minute and 5-minute momentum
    const price1MinAgo = data.prices[data.prices.length - 2] || currentPrice;
    const price5MinAgo = data.prices[data.prices.length - 6] || currentPrice;

    const change1Min = (currentPrice - price1MinAgo) / price1MinAgo;
    const change5Min = (currentPrice - price5MinAgo) / price5MinAgo;

    const threshold1Min = 0.01; // 1% in 1 minute
    const threshold5Min = 0.025; // 2.5% in 5 minutes

    if (Math.abs(change1Min) < threshold1Min && Math.abs(change5Min) < threshold5Min) return null;
    if (this.isDuplicateSignal(`momentum-${ticker}`, 60000)) return null;

    const direction = change1Min > 0 ? 'up' : 'down';
    const changePercent = Math.max(Math.abs(change1Min), Math.abs(change5Min)) * 100;

    const signal = {
      type: 'momentum_surge',
      ticker,
      price: currentPrice,
      priceChange: parseFloat(changePercent.toFixed(2)),
      direction,
      timestamp,
      description: `${direction === 'up' ? '🚀' : '📉'} ${changePercent.toFixed(1)}% momentum surge`,
      severity: changePercent > 3 ? 'high' : 'medium'
    };

    database.addHeatSignal(ticker, 'momentum', 0, { priceChange: signal.priceChange, direction });
    logger.info(`Momentum surge: ${ticker} ${direction} ${changePercent.toFixed(1)}%`);

    return signal;
  }

  // Detect volume spikes (RVOL)
  detectVolumeSpike(ticker, currentVolume, price, data) {
    if (data.volumes.length < 20) return null;

    // Calculate average volume (excluding current)
    const recentVolumes = data.volumes.slice(-20, -1);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

    if (avgVolume === 0) return null;

    const rvol = currentVolume / avgVolume;
    const threshold = config.detection.volumeSpikeMultiplier || 3.0;
    const extremeThreshold = config.detection.volumeExtremeMultiplier || 5.0;

    if (rvol < threshold) return null;
    if (this.isDuplicateSignal(`volume-${ticker}`, 60000)) return null;

    const isExtreme = rvol >= extremeThreshold;

    const signal = {
      type: 'volume_spike',
      ticker,
      price,
      rvol: parseFloat(rvol.toFixed(1)),
      currentVolume,
      avgVolume: Math.round(avgVolume),
      isExtreme,
      timestamp: Date.now(),
      description: `📊 ${rvol.toFixed(1)}x relative volume spike`,
      severity: isExtreme ? 'high' : 'medium'
    };

    database.addHeatSignal(ticker, 'volume_spike', currentVolume, { rvol: signal.rvol, isExtreme });
    logger.info(`Volume spike: ${ticker} ${rvol.toFixed(1)}x RVOL`);

    return signal;
  }

  // Detect VWAP crosses
  detectVWAPCross(ticker, price, timestamp, data) {
    if (data.vwapDenominator === 0) return null;

    const vwap = data.vwapNumerator / data.vwapDenominator;
    const prevPrice = data.prices[data.prices.length - 2];

    if (!prevPrice) return null;

    // Check for cross
    const crossedAbove = prevPrice < vwap && price > vwap;
    const crossedBelow = prevPrice > vwap && price < vwap;

    if (!crossedAbove && !crossedBelow) return null;
    if (this.isDuplicateSignal(`vwap-${ticker}`, 300000)) return null; // 5 min cooldown

    const signal = {
      type: 'vwap_cross',
      ticker,
      price,
      vwap: parseFloat(vwap.toFixed(2)),
      direction: crossedAbove ? 'above' : 'below',
      timestamp,
      description: `📈 VWAP cross ${crossedAbove ? 'above' : 'below'} at $${vwap.toFixed(2)}`,
      severity: 'medium'
    };

    database.addHeatSignal(ticker, 'vwap_cross', 0, { vwap: signal.vwap, direction: signal.direction });
    logger.info(`VWAP cross: ${ticker} crossed ${signal.direction}`);

    return signal;
  }

  // Detect new intraday highs/lows
  detectNewHighLow(ticker, price, timestamp, data) {
    if (data.prices.length < 30) return null; // Need some history

    const prevHigh = data.dayHigh;
    const prevLow = data.dayLow;

    // Check if this is a new high/low by comparing to previous values
    const isNewHigh = price >= prevHigh && data.prices.length > 60; // After first hour
    const isNewLow = price <= prevLow && data.prices.length > 60;

    if (!isNewHigh && !isNewLow) return null;
    if (this.isDuplicateSignal(`highlow-${ticker}`, 300000)) return null;

    const signal = {
      type: isNewHigh ? 'new_high' : 'new_low',
      ticker,
      price,
      timestamp,
      description: isNewHigh ? `🔝 New intraday HIGH at $${price.toFixed(2)}` : `🔻 New intraday LOW at $${price.toFixed(2)}`,
      severity: 'medium'
    };

    database.addHeatSignal(ticker, isNewHigh ? 'new_high' : 'new_low', 0, { price });
    logger.info(`New ${isNewHigh ? 'high' : 'low'}: ${ticker} at $${price.toFixed(2)}`);

    return signal;
  }

  // Detect breakouts above resistance
  detectBreakout(ticker, high, close, data) {
    if (data.highs.length < 20) return null;

    // Find resistance (highest high in last 20 bars, excluding last 2)
    const lookbackHighs = data.highs.slice(-22, -2);
    if (lookbackHighs.length < 10) return null;

    const resistance = Math.max(...lookbackHighs);
    const buffer = resistance * 0.002; // 0.2% buffer

    if (close <= resistance + buffer) return null;
    if (this.isDuplicateSignal(`breakout-${ticker}`, 300000)) return null;

    const breakoutPercent = ((close - resistance) / resistance) * 100;

    const signal = {
      type: 'breakout',
      ticker,
      price: close,
      resistance: parseFloat(resistance.toFixed(2)),
      breakoutPercent: parseFloat(breakoutPercent.toFixed(2)),
      timestamp: Date.now(),
      description: `🔥 BREAKOUT above $${resistance.toFixed(2)} resistance`,
      severity: 'high'
    };

    database.addHeatSignal(ticker, 'breakout', 0, { resistance: signal.resistance, breakoutPercent: signal.breakoutPercent });
    logger.info(`Breakout: ${ticker} above $${resistance.toFixed(2)}`);

    return signal;
  }

  // Detect gap up/down at market open
  detectGap(ticker, open, data) {
    if (data.prevClose === 0 || data.prices.length > 5) return null; // Only first 5 minutes

    const gapPercent = ((open - data.prevClose) / data.prevClose) * 100;
    const minGap = 2; // 2% minimum gap

    if (Math.abs(gapPercent) < minGap) return null;
    if (this.isDuplicateSignal(`gap-${ticker}`, 3600000)) return null; // Once per day

    const direction = gapPercent > 0 ? 'up' : 'down';

    const signal = {
      type: 'gap',
      ticker,
      price: open,
      prevClose: data.prevClose,
      gapPercent: parseFloat(gapPercent.toFixed(2)),
      direction,
      timestamp: Date.now(),
      description: `${direction === 'up' ? '⬆️' : '⬇️'} ${Math.abs(gapPercent).toFixed(1)}% gap ${direction}`,
      severity: Math.abs(gapPercent) > 5 ? 'high' : 'medium'
    };

    database.addHeatSignal(ticker, 'gap', 0, { gapPercent: signal.gapPercent, direction });
    logger.info(`Gap ${direction}: ${ticker} ${gapPercent.toFixed(1)}%`);

    return signal;
  }

  // Detect relative strength vs SPY
  detectRelativeStrength(ticker, price, data) {
    if (ticker === 'SPY' || this.marketData.price === 0) return null;
    if (data.prices.length < 30) return null;

    // Calculate ticker's change vs SPY's change over last 30 minutes
    const tickerChange = (price - data.prices[data.prices.length - 30]) / data.prices[data.prices.length - 30];
    const spyData = this.tickerData.get('SPY');

    if (!spyData || spyData.prices.length < 30) return null;

    const spyChange = (spyData.lastPrice - spyData.prices[spyData.prices.length - 30]) / spyData.prices[spyData.prices.length - 30];

    // Relative strength = ticker outperforming SPY significantly
    const relativeStrength = tickerChange - spyChange;

    if (Math.abs(relativeStrength) < 0.02) return null; // 2% relative difference
    if (this.isDuplicateSignal(`rs-${ticker}`, 600000)) return null;

    const isOutperforming = relativeStrength > 0;

    const signal = {
      type: 'relative_strength',
      ticker,
      price,
      tickerChange: parseFloat((tickerChange * 100).toFixed(2)),
      spyChange: parseFloat((spyChange * 100).toFixed(2)),
      relativeStrength: parseFloat((relativeStrength * 100).toFixed(2)),
      isOutperforming,
      timestamp: Date.now(),
      description: `💪 ${isOutperforming ? 'Outperforming' : 'Underperforming'} SPY by ${Math.abs(relativeStrength * 100).toFixed(1)}%`,
      severity: Math.abs(relativeStrength) > 0.03 ? 'high' : 'medium'
    };

    database.addHeatSignal(ticker, 'relative_strength', 0, { relativeStrength: signal.relativeStrength });

    return signal;
  }

  // Detect consolidation breakout (tight range breakout)
  detectConsolidationBreakout(ticker, high, low, close, data) {
    if (data.highs.length < 10) return null;

    // Check for tight consolidation in last 10 bars
    const recentHighs = data.highs.slice(-10);
    const recentLows = data.lows.slice(-10);

    const rangeHigh = Math.max(...recentHighs);
    const rangeLow = Math.min(...recentLows);
    const rangePercent = ((rangeHigh - rangeLow) / rangeLow) * 100;

    // Consolidation = range less than 1.5%
    if (rangePercent > 1.5) return null;

    // Breakout = current bar breaks out of range
    const breakoutUp = close > rangeHigh * 1.002;
    const breakoutDown = close < rangeLow * 0.998;

    if (!breakoutUp && !breakoutDown) return null;
    if (this.isDuplicateSignal(`consol-${ticker}`, 600000)) return null;

    const signal = {
      type: 'consolidation_breakout',
      ticker,
      price: close,
      rangeHigh: parseFloat(rangeHigh.toFixed(2)),
      rangeLow: parseFloat(rangeLow.toFixed(2)),
      direction: breakoutUp ? 'up' : 'down',
      timestamp: Date.now(),
      description: `📦 Consolidation breakout ${breakoutUp ? 'UP' : 'DOWN'}`,
      severity: 'high'
    };

    database.addHeatSignal(ticker, 'consolidation_breakout', 0, { direction: signal.direction });
    logger.info(`Consolidation breakout: ${ticker} ${signal.direction}`);

    return signal;
  }

  // ========== UTILITIES ==========

  // Check for duplicate signals
  isDuplicateSignal(key, cooldownMs) {
    const now = Date.now();
    const lastSignal = this.recentSignals.get(key);

    if (lastSignal && (now - lastSignal) < cooldownMs) {
      return true;
    }

    this.recentSignals.set(key, now);
    return false;
  }

  // Set previous close for gap detection
  setPrevClose(ticker, prevClose) {
    const data = this.getTickerData(ticker);
    data.prevClose = prevClose;
  }

  // Set average volume for RVOL calculation
  setAvgVolume(ticker, avgVolume) {
    const data = this.getTickerData(ticker);
    data.avgVolume = avgVolume;
  }

  // Get signal count for a ticker
  getSignalCount(ticker, minutes = 60) {
    return database.getSignalCount(ticker, minutes);
  }

  // Format large values
  formatValue(value) {
    if (value >= 1000000) return (value / 1000000).toFixed(2) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(0) + 'k';
    return value.toFixed(0);
  }

  // Cleanup old data
  cleanup() {
    const now = Date.now();
    const maxAge = 300000;

    for (const [key, timestamp] of this.recentSignals.entries()) {
      if (now - timestamp > maxAge) {
        this.recentSignals.delete(key);
      }
    }
  }

  // Reset daily data (call at market open)
  resetDaily() {
    for (const [ticker, data] of this.tickerData.entries()) {
      data.dayHigh = 0;
      data.dayLow = Infinity;
      data.vwapNumerator = 0;
      data.vwapDenominator = 0;
      data.trades = [];
    }
    this.recentSignals.clear();
    logger.info('Daily stock data reset');
  }

  // Get statistics
  getStats() {
    return {
      trackedTickers: this.tickerData.size,
      recentSignals: this.recentSignals.size
    };
  }

  // Shutdown
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

module.exports = new StockSignalDetector();
