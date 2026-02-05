/**
 * Squeeze Detection Module
 * Detects when a stock is in a "squeeze" - low volatility consolidation
 * before potential breakout. Based on:
 * - Narrowing price range (Bollinger Band squeeze)
 * - Declining volume (coiling)
 * - Tightening ATR (Average True Range)
 */

const logger = require('../utils/logger');

class SqueezeDetection {
  constructor() {
    this.priceHistory = new Map(); // ticker -> array of {high, low, close, volume}
    this.squeezeAlerts = new Map(); // ticker -> squeeze info
    this.maxHistoryLength = 20; // Need 20 bars for analysis
  }

  // Update price history for a ticker
  updatePriceHistory(ticker, high, low, close, volume) {
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, []);
    }

    const history = this.priceHistory.get(ticker);
    history.push({
      high,
      low,
      close,
      volume,
      timestamp: Date.now()
    });

    // Keep only recent history
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  // Detect squeeze for a ticker
  detectSqueeze(ticker) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 15) {
      return null;
    }

    // Calculate key metrics
    const rangeSqueeze = this.calculateRangeSqueeze(history);
    const volumeSqueeze = this.calculateVolumeSqueeze(history);
    const volatilitySqueeze = this.calculateVolatilitySqueeze(history);

    // Combine signals
    const squeezeScore = this.calculateSqueezeScore(rangeSqueeze, volumeSqueeze, volatilitySqueeze);

    if (squeezeScore >= 70) {
      const squeeze = {
        ticker,
        squeezeScore,
        rangeSqueeze,
        volumeSqueeze,
        volatilitySqueeze,
        direction: this.predictBreakoutDirection(history),
        timestamp: Date.now()
      };

      this.squeezeAlerts.set(ticker, squeeze);
      return squeeze;
    }

    return null;
  }

  // Calculate range squeeze (tightening high-low range)
  calculateRangeSqueeze(history) {
    const recentBars = history.slice(-5);
    const olderBars = history.slice(-15, -5);

    // Recent average range
    const recentAvgRange = recentBars.reduce((sum, bar) => {
      return sum + ((bar.high - bar.low) / bar.close) * 100;
    }, 0) / recentBars.length;

    // Older average range
    const olderAvgRange = olderBars.reduce((sum, bar) => {
      return sum + ((bar.high - bar.low) / bar.close) * 100;
    }, 0) / olderBars.length;

    // If recent range is significantly smaller, we have a squeeze
    const rangeRatio = recentAvgRange / olderAvgRange;

    return {
      recentRange: recentAvgRange.toFixed(2),
      olderRange: olderAvgRange.toFixed(2),
      ratio: rangeRatio.toFixed(2),
      isSqueeze: rangeRatio < 0.6 // Range decreased by 40%+
    };
  }

  // Calculate volume squeeze (declining volume)
  calculateVolumeSqueeze(history) {
    const recentBars = history.slice(-5);
    const olderBars = history.slice(-15, -5);

    const recentAvgVol = recentBars.reduce((sum, bar) => sum + bar.volume, 0) / recentBars.length;
    const olderAvgVol = olderBars.reduce((sum, bar) => sum + bar.volume, 0) / olderBars.length;

    const volumeRatio = recentAvgVol / olderAvgVol;

    return {
      recentVolume: recentAvgVol,
      olderVolume: olderAvgVol,
      ratio: volumeRatio.toFixed(2),
      isSqueeze: volumeRatio < 0.7 // Volume decreased by 30%+
    };
  }

  // Calculate volatility squeeze using ATR-like measure
  calculateVolatilitySqueeze(history) {
    const recentBars = history.slice(-5);
    const olderBars = history.slice(-15, -5);

    // Simple ATR calculation
    const calcATR = (bars) => {
      return bars.reduce((sum, bar, i) => {
        const tr = bar.high - bar.low;
        return sum + tr;
      }, 0) / bars.length;
    };

    const recentATR = calcATR(recentBars);
    const olderATR = calcATR(olderBars);
    const currentPrice = recentBars[recentBars.length - 1].close;

    const atrRatio = recentATR / olderATR;
    const atrPercent = (recentATR / currentPrice) * 100;

    return {
      recentATR: recentATR.toFixed(2),
      olderATR: olderATR.toFixed(2),
      atrPercent: atrPercent.toFixed(2),
      ratio: atrRatio.toFixed(2),
      isSqueeze: atrRatio < 0.65 // ATR decreased by 35%+
    };
  }

  // Calculate overall squeeze score
  calculateSqueezeScore(rangeSqueeze, volumeSqueeze, volatilitySqueeze) {
    let score = 0;

    // Range component (0-35 points)
    if (rangeSqueeze.isSqueeze) {
      score += 25;
      const ratio = parseFloat(rangeSqueeze.ratio);
      if (ratio < 0.4) score += 10; // Very tight range
    }

    // Volume component (0-30 points)
    if (volumeSqueeze.isSqueeze) {
      score += 20;
      const ratio = parseFloat(volumeSqueeze.ratio);
      if (ratio < 0.5) score += 10; // Very low volume
    }

    // Volatility component (0-35 points)
    if (volatilitySqueeze.isSqueeze) {
      score += 25;
      const ratio = parseFloat(volatilitySqueeze.ratio);
      if (ratio < 0.5) score += 10; // Very low volatility
    }

    return score;
  }

  // Predict likely breakout direction based on trend
  predictBreakoutDirection(history) {
    const closes = history.slice(-10).map(h => h.close);
    const firstHalf = closes.slice(0, 5);
    const secondHalf = closes.slice(5);

    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    // Slight bias based on recent trend
    if (secondAvg > firstAvg * 1.005) {
      return 'BULLISH';
    } else if (secondAvg < firstAvg * 0.995) {
      return 'BEARISH';
    }
    return 'NEUTRAL';
  }

  // Format squeeze alert for Discord
  formatSqueezeAlert(squeeze) {
    const emoji = squeeze.squeezeScore >= 85 ? '🔥🔥' : '🔥';
    const directionEmoji = squeeze.direction === 'BULLISH' ? '📈' :
                          squeeze.direction === 'BEARISH' ? '📉' : '➡️';

    let message = `${emoji} **SQUEEZE DETECTED** - ${squeeze.ticker}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `**Squeeze Score:** ${squeeze.squeezeScore}/100\n`;
    message += `**Likely Direction:** ${directionEmoji} ${squeeze.direction}\n\n`;

    message += `**📊 Analysis:**\n`;
    message += `• Range: ${squeeze.rangeSqueeze.isSqueeze ? '✅' : '❌'} `;
    message += `(${squeeze.rangeSqueeze.recentRange}% vs ${squeeze.rangeSqueeze.olderRange}%)\n`;
    message += `• Volume: ${squeeze.volumeSqueeze.isSqueeze ? '✅' : '❌'} `;
    message += `(${parseFloat(squeeze.volumeSqueeze.ratio) * 100}% of normal)\n`;
    message += `• Volatility: ${squeeze.volatilitySqueeze.isSqueeze ? '✅' : '❌'} `;
    message += `(ATR: ${squeeze.volatilitySqueeze.atrPercent}%)\n\n`;

    message += `**💡 Action:** Watch for breakout with volume confirmation`;

    return message;
  }

  // Get all active squeezes
  getActiveSqueezes() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    // Filter out old alerts
    const active = [];
    for (const [ticker, squeeze] of this.squeezeAlerts) {
      if (now - squeeze.timestamp < oneHour) {
        active.push(squeeze);
      }
    }

    return active.sort((a, b) => b.squeezeScore - a.squeezeScore);
  }

  // Clear history for a ticker
  clearHistory(ticker) {
    this.priceHistory.delete(ticker);
    this.squeezeAlerts.delete(ticker);
  }
}

module.exports = new SqueezeDetection();
