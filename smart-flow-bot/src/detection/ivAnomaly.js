const config = require('../../config');
const logger = require('../utils/logger');
const database = require('../database/sqlite');

class IVAnomalyDetector {
  constructor() {
    // Track IV history per ticker
    // Key: ticker, Value: { iv: number, price: number, timestamp: number }[]
    this.ivHistory = new Map();

    // Track price history for comparison
    this.priceHistory = new Map();

    // Configuration
    this.ivSpikeThreshold = config.detection.ivSpikeThreshold || 0.10; // 10%
    this.priceChangeThreshold = config.detection.priceChangeThreshold || 0.02; // 2%
    this.historyWindow = 30; // Keep 30 data points
  }

  initialize() {
    logger.info('IV anomaly detector initialized');
  }

  // Update IV data for a ticker
  updateIV(ticker, iv, price, timestamp = Date.now()) {
    if (!this.ivHistory.has(ticker)) {
      this.ivHistory.set(ticker, []);
    }

    const history = this.ivHistory.get(ticker);
    history.push({ iv, price, timestamp });

    // Keep only recent history
    if (history.length > this.historyWindow) {
      history.shift();
    }
  }

  // Update price for a ticker (from stock trades/aggregates)
  updatePrice(ticker, price, timestamp = Date.now()) {
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, []);
    }

    const history = this.priceHistory.get(ticker);
    history.push({ price, timestamp });

    // Keep only recent history
    if (history.length > this.historyWindow) {
      history.shift();
    }
  }

  // Detect IV anomaly (IV spike without corresponding price movement)
  detectAnomaly(ticker) {
    const ivHistory = this.ivHistory.get(ticker);
    if (!ivHistory || ivHistory.length < 5) {
      return null; // Not enough data
    }

    // Get current and baseline IV
    const currentData = ivHistory[ivHistory.length - 1];
    const baselineData = ivHistory.slice(0, -1);

    // Calculate baseline IV (average of previous readings)
    const baselineIV = baselineData.reduce((sum, d) => sum + d.iv, 0) / baselineData.length;
    const currentIV = currentData.iv;

    // Calculate IV change
    const ivChange = (currentIV - baselineIV) / baselineIV;

    // Check if IV spiked
    if (ivChange < this.ivSpikeThreshold) {
      return null; // No significant IV spike
    }

    // Calculate price change
    const baselinePrice = baselineData.reduce((sum, d) => sum + d.price, 0) / baselineData.length;
    const currentPrice = currentData.price;
    const priceChange = Math.abs((currentPrice - baselinePrice) / baselinePrice);

    // Anomaly: IV spiked but price didn't move much
    if (priceChange < this.priceChangeThreshold) {
      const anomaly = {
        type: 'iv_anomaly',
        ticker,
        currentIV,
        baselineIV,
        ivChange: parseFloat((ivChange * 100).toFixed(2)), // As percentage
        currentPrice,
        baselinePrice,
        priceChange: parseFloat((priceChange * 100).toFixed(2)), // As percentage
        timestamp: currentData.timestamp,
        severity: this.getSeverity(ivChange)
      };

      // Record in database
      database.addHeatSignal(
        ticker,
        'iv_anomaly',
        0, // No premium for IV signals
        {
          ivChange: anomaly.ivChange,
          priceChange: anomaly.priceChange
        }
      );

      return anomaly;
    }

    return null;
  }

  // Get severity level
  getSeverity(ivChange) {
    if (ivChange >= 0.30) return 'extreme'; // 30%+ IV spike
    if (ivChange >= 0.20) return 'very_high'; // 20%+ IV spike
    if (ivChange >= 0.15) return 'high'; // 15%+ IV spike
    return 'moderate';
  }

  // Calculate IV from option price (Black-Scholes approximation)
  // This is a simplified version - in production you'd use a proper options library
  estimateIVFromPrice(optionPrice, spotPrice, strike, daysToExpiry, optionType, riskFreeRate = 0.05) {
    if (daysToExpiry <= 0 || optionPrice <= 0) return null;

    const t = daysToExpiry / 365;
    const intrinsicValue = optionType === 'call'
      ? Math.max(0, spotPrice - strike)
      : Math.max(0, strike - spotPrice);

    const timeValue = optionPrice - intrinsicValue;
    if (timeValue <= 0) return null;

    // Simplified IV estimation using time value
    // IV ≈ (TimeValue * √(2π)) / (S * √T)
    const sqrtT = Math.sqrt(t);
    const sqrt2Pi = Math.sqrt(2 * Math.PI);

    let iv = (timeValue * sqrt2Pi) / (spotPrice * sqrtT);

    // Clamp to reasonable range
    iv = Math.max(0.05, Math.min(5.0, iv));

    return iv;
  }

  // Process option trade and update IV
  processOptionTrade(trade, spotPrice) {
    if (!trade || !spotPrice) return null;

    const { underlyingTicker, strike, expiration, optionType, price } = trade;

    // Calculate days to expiry
    const today = new Date();
    const expiryDate = new Date(expiration);
    const daysToExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));

    if (daysToExpiry <= 0) return null;

    // Estimate IV from the trade price
    const iv = this.estimateIVFromPrice(price, spotPrice, strike, daysToExpiry, optionType);

    if (iv) {
      this.updateIV(underlyingTicker, iv, spotPrice);
      return this.detectAnomaly(underlyingTicker);
    }

    return null;
  }

  // Check if ticker has IV anomaly
  hasIVAnomaly(ticker) {
    const anomaly = this.detectAnomaly(ticker);
    return anomaly !== null;
  }

  // Get current IV for ticker
  getCurrentIV(ticker) {
    const history = this.ivHistory.get(ticker);
    if (!history || history.length === 0) return null;
    return history[history.length - 1].iv;
  }

  // Get IV summary for a ticker
  getSummary(ticker) {
    const history = this.ivHistory.get(ticker);
    if (!history || history.length === 0) {
      return {
        ticker,
        currentIV: null,
        avgIV: null,
        minIV: null,
        maxIV: null,
        dataPoints: 0
      };
    }

    const ivValues = history.map(h => h.iv);
    return {
      ticker,
      currentIV: ivValues[ivValues.length - 1],
      avgIV: ivValues.reduce((a, b) => a + b, 0) / ivValues.length,
      minIV: Math.min(...ivValues),
      maxIV: Math.max(...ivValues),
      dataPoints: history.length
    };
  }

  // Get all tickers with IV anomalies
  getAllAnomalies() {
    const anomalies = [];

    for (const ticker of this.ivHistory.keys()) {
      const anomaly = this.detectAnomaly(ticker);
      if (anomaly) {
        anomalies.push(anomaly);
      }
    }

    return anomalies.sort((a, b) => b.ivChange - a.ivChange);
  }

  // Reset tracking
  reset() {
    this.ivHistory.clear();
    this.priceHistory.clear();
    logger.info('IV tracking reset');
  }

  // Get statistics
  getStats() {
    return {
      trackedTickers: this.ivHistory.size,
      totalDataPoints: Array.from(this.ivHistory.values()).reduce((sum, h) => sum + h.length, 0)
    };
  }
}

// Export singleton instance
module.exports = new IVAnomalyDetector();
