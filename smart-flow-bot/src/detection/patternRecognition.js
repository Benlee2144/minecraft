/**
 * Pattern Recognition Module
 * Detects common chart patterns for day trading:
 * - Breakout/Breakdown
 * - Double Bottom/Top
 * - Higher Highs & Higher Lows (uptrend)
 * - Lower Highs & Lower Lows (downtrend)
 * - VWAP reclaim/rejection
 */

const logger = require('../utils/logger');

class PatternRecognition {
  constructor() {
    this.priceHistory = new Map(); // ticker -> array of {high, low, close, volume, vwap}
    this.patternAlerts = new Map(); // ticker -> recent patterns
    this.maxHistoryLength = 30;
    this.alertCooldown = new Map(); // ticker:pattern -> last alert time
    this.COOLDOWN_MS = 30 * 60 * 1000; // 30 minute cooldown per pattern type
  }

  // Update price history
  updatePriceHistory(ticker, high, low, close, volume, vwap = null) {
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, []);
    }

    const history = this.priceHistory.get(ticker);
    history.push({
      high,
      low,
      close,
      volume,
      vwap,
      timestamp: Date.now()
    });

    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  // Detect all patterns for a ticker
  detectPatterns(ticker, currentPrice, currentVolume) {
    const history = this.priceHistory.get(ticker);
    if (!history || history.length < 10) {
      return [];
    }

    const patterns = [];

    // Check each pattern type
    const breakout = this.checkBreakout(ticker, history, currentPrice, currentVolume);
    if (breakout) patterns.push(breakout);

    const breakdown = this.checkBreakdown(ticker, history, currentPrice, currentVolume);
    if (breakdown) patterns.push(breakdown);

    const doubleBottom = this.checkDoubleBottom(ticker, history, currentPrice);
    if (doubleBottom) patterns.push(doubleBottom);

    const doubleTop = this.checkDoubleTop(ticker, history, currentPrice);
    if (doubleTop) patterns.push(doubleTop);

    const trend = this.checkTrend(ticker, history);
    if (trend) patterns.push(trend);

    const vwapPattern = this.checkVWAPPattern(ticker, history, currentPrice);
    if (vwapPattern) patterns.push(vwapPattern);

    return patterns;
  }

  // Check for breakout above resistance
  checkBreakout(ticker, history, currentPrice, currentVolume) {
    if (!this.shouldAlert(ticker, 'BREAKOUT')) return null;

    // Find recent high (resistance)
    const recentBars = history.slice(-15);
    const resistance = Math.max(...recentBars.slice(0, -3).map(b => b.high));
    const avgVolume = recentBars.reduce((s, b) => s + b.volume, 0) / recentBars.length;

    // Breakout criteria: price above resistance with volume
    if (currentPrice > resistance * 1.002 && currentVolume > avgVolume * 1.5) {
      this.setAlertCooldown(ticker, 'BREAKOUT');
      return {
        type: 'BREAKOUT',
        ticker,
        direction: 'BULLISH',
        price: currentPrice,
        level: resistance,
        volumeMultiple: (currentVolume / avgVolume).toFixed(1),
        confidence: this.calculatePatternConfidence(currentPrice, resistance, currentVolume, avgVolume),
        message: `Breaking above resistance $${resistance.toFixed(2)} with ${(currentVolume / avgVolume).toFixed(1)}x volume`,
        emoji: '🚀'
      };
    }

    return null;
  }

  // Check for breakdown below support
  checkBreakdown(ticker, history, currentPrice, currentVolume) {
    if (!this.shouldAlert(ticker, 'BREAKDOWN')) return null;

    const recentBars = history.slice(-15);
    const support = Math.min(...recentBars.slice(0, -3).map(b => b.low));
    const avgVolume = recentBars.reduce((s, b) => s + b.volume, 0) / recentBars.length;

    if (currentPrice < support * 0.998 && currentVolume > avgVolume * 1.5) {
      this.setAlertCooldown(ticker, 'BREAKDOWN');
      return {
        type: 'BREAKDOWN',
        ticker,
        direction: 'BEARISH',
        price: currentPrice,
        level: support,
        volumeMultiple: (currentVolume / avgVolume).toFixed(1),
        confidence: this.calculatePatternConfidence(support, currentPrice, currentVolume, avgVolume),
        message: `Breaking below support $${support.toFixed(2)} with ${(currentVolume / avgVolume).toFixed(1)}x volume`,
        emoji: '💥'
      };
    }

    return null;
  }

  // Check for double bottom pattern
  checkDoubleBottom(ticker, history, currentPrice) {
    if (!this.shouldAlert(ticker, 'DOUBLE_BOTTOM')) return null;
    if (history.length < 15) return null;

    const lows = history.map(b => b.low);
    const closes = history.map(b => b.close);

    // Find two similar lows with a bounce in between
    let firstLowIdx = -1;
    let secondLowIdx = -1;
    let firstLow = Infinity;

    // Find first low in older half
    for (let i = 0; i < Math.floor(lows.length / 2); i++) {
      if (lows[i] < firstLow) {
        firstLow = lows[i];
        firstLowIdx = i;
      }
    }

    // Find second low in newer half that's within 1% of first
    for (let i = Math.floor(lows.length / 2); i < lows.length - 2; i++) {
      if (Math.abs(lows[i] - firstLow) / firstLow < 0.01) {
        secondLowIdx = i;
        break;
      }
    }

    if (firstLowIdx >= 0 && secondLowIdx > firstLowIdx + 3) {
      // Check for bounce between lows
      const middleBars = closes.slice(firstLowIdx + 1, secondLowIdx);
      const maxBetween = Math.max(...middleBars);
      const bouncePercent = ((maxBetween - firstLow) / firstLow) * 100;

      // Need at least 1.5% bounce
      if (bouncePercent > 1.5 && currentPrice > lows[secondLowIdx] * 1.005) {
        this.setAlertCooldown(ticker, 'DOUBLE_BOTTOM');
        return {
          type: 'DOUBLE_BOTTOM',
          ticker,
          direction: 'BULLISH',
          price: currentPrice,
          level: firstLow,
          bouncePercent: bouncePercent.toFixed(1),
          confidence: Math.min(85, 60 + bouncePercent * 3),
          message: `Double bottom at $${firstLow.toFixed(2)} with ${bouncePercent.toFixed(1)}% bounce`,
          emoji: '📈'
        };
      }
    }

    return null;
  }

  // Check for double top pattern
  checkDoubleTop(ticker, history, currentPrice) {
    if (!this.shouldAlert(ticker, 'DOUBLE_TOP')) return null;
    if (history.length < 15) return null;

    const highs = history.map(b => b.high);
    const closes = history.map(b => b.close);

    let firstHighIdx = -1;
    let secondHighIdx = -1;
    let firstHigh = 0;

    // Find first high in older half
    for (let i = 0; i < Math.floor(highs.length / 2); i++) {
      if (highs[i] > firstHigh) {
        firstHigh = highs[i];
        firstHighIdx = i;
      }
    }

    // Find second high in newer half
    for (let i = Math.floor(highs.length / 2); i < highs.length - 2; i++) {
      if (Math.abs(highs[i] - firstHigh) / firstHigh < 0.01) {
        secondHighIdx = i;
        break;
      }
    }

    if (firstHighIdx >= 0 && secondHighIdx > firstHighIdx + 3) {
      const middleBars = closes.slice(firstHighIdx + 1, secondHighIdx);
      const minBetween = Math.min(...middleBars);
      const dropPercent = ((firstHigh - minBetween) / firstHigh) * 100;

      if (dropPercent > 1.5 && currentPrice < highs[secondHighIdx] * 0.995) {
        this.setAlertCooldown(ticker, 'DOUBLE_TOP');
        return {
          type: 'DOUBLE_TOP',
          ticker,
          direction: 'BEARISH',
          price: currentPrice,
          level: firstHigh,
          dropPercent: dropPercent.toFixed(1),
          confidence: Math.min(85, 60 + dropPercent * 3),
          message: `Double top at $${firstHigh.toFixed(2)} with ${dropPercent.toFixed(1)}% drop between`,
          emoji: '📉'
        };
      }
    }

    return null;
  }

  // Check for trend (higher highs/lows or lower highs/lows)
  checkTrend(ticker, history) {
    if (!this.shouldAlert(ticker, 'TREND')) return null;
    if (history.length < 12) return null;

    const recentBars = history.slice(-8);
    const highs = recentBars.map(b => b.high);
    const lows = recentBars.map(b => b.low);

    // Check for higher highs and higher lows
    let higherHighs = 0;
    let higherLows = 0;
    let lowerHighs = 0;
    let lowerLows = 0;

    for (let i = 2; i < highs.length; i += 2) {
      if (highs[i] > highs[i - 2]) higherHighs++;
      if (lows[i] > lows[i - 2]) higherLows++;
      if (highs[i] < highs[i - 2]) lowerHighs++;
      if (lows[i] < lows[i - 2]) lowerLows++;
    }

    if (higherHighs >= 2 && higherLows >= 2) {
      this.setAlertCooldown(ticker, 'TREND');
      return {
        type: 'UPTREND',
        ticker,
        direction: 'BULLISH',
        price: recentBars[recentBars.length - 1].close,
        higherHighs,
        higherLows,
        confidence: 65 + (higherHighs + higherLows) * 5,
        message: `Uptrend forming: ${higherHighs} higher highs, ${higherLows} higher lows`,
        emoji: '📈'
      };
    }

    if (lowerHighs >= 2 && lowerLows >= 2) {
      this.setAlertCooldown(ticker, 'TREND');
      return {
        type: 'DOWNTREND',
        ticker,
        direction: 'BEARISH',
        price: recentBars[recentBars.length - 1].close,
        lowerHighs,
        lowerLows,
        confidence: 65 + (lowerHighs + lowerLows) * 5,
        message: `Downtrend forming: ${lowerHighs} lower highs, ${lowerLows} lower lows`,
        emoji: '📉'
      };
    }

    return null;
  }

  // Check for VWAP reclaim or rejection
  checkVWAPPattern(ticker, history, currentPrice) {
    if (!this.shouldAlert(ticker, 'VWAP')) return null;

    const recentBars = history.slice(-5);
    const vwaps = recentBars.map(b => b.vwap).filter(v => v);

    if (vwaps.length < 3) return null;

    const currentVWAP = vwaps[vwaps.length - 1];
    const closes = recentBars.map(b => b.close);

    // Check for VWAP reclaim (was below, now above)
    const wasBelow = closes.slice(0, -2).some(c => c < currentVWAP * 0.998);
    const nowAbove = currentPrice > currentVWAP * 1.002;

    if (wasBelow && nowAbove) {
      this.setAlertCooldown(ticker, 'VWAP');
      return {
        type: 'VWAP_RECLAIM',
        ticker,
        direction: 'BULLISH',
        price: currentPrice,
        vwap: currentVWAP,
        confidence: 70,
        message: `Reclaimed VWAP at $${currentVWAP.toFixed(2)}`,
        emoji: '💪'
      };
    }

    // Check for VWAP rejection (was above, rejected at VWAP)
    const wasAbove = closes.slice(0, -2).some(c => c > currentVWAP * 1.002);
    const nowBelow = currentPrice < currentVWAP * 0.998;

    if (wasAbove && nowBelow) {
      this.setAlertCooldown(ticker, 'VWAP');
      return {
        type: 'VWAP_REJECTION',
        ticker,
        direction: 'BEARISH',
        price: currentPrice,
        vwap: currentVWAP,
        confidence: 70,
        message: `Rejected at VWAP $${currentVWAP.toFixed(2)}`,
        emoji: '🚫'
      };
    }

    return null;
  }

  // Calculate pattern confidence
  calculatePatternConfidence(level1, level2, volume, avgVolume) {
    let confidence = 60;

    // Volume adds confidence
    const volMultiple = volume / avgVolume;
    if (volMultiple > 2) confidence += 15;
    else if (volMultiple > 1.5) confidence += 10;

    // Clear level break adds confidence
    const breakPercent = Math.abs((level1 - level2) / level2) * 100;
    if (breakPercent > 0.5) confidence += 10;
    if (breakPercent > 1) confidence += 5;

    return Math.min(95, confidence);
  }

  // Check if we should alert (cooldown check)
  shouldAlert(ticker, patternType) {
    const key = `${ticker}:${patternType}`;
    const lastAlert = this.alertCooldown.get(key);

    if (!lastAlert) return true;
    return Date.now() - lastAlert > this.COOLDOWN_MS;
  }

  // Set cooldown after alerting
  setAlertCooldown(ticker, patternType) {
    const key = `${ticker}:${patternType}`;
    this.alertCooldown.set(key, Date.now());
  }

  // Format pattern alert for Discord
  formatPatternAlert(pattern) {
    let message = `${pattern.emoji} **${pattern.type.replace(/_/g, ' ')}** - ${pattern.ticker}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `**Direction:** ${pattern.direction}\n`;
    message += `**Price:** $${pattern.price.toFixed(2)}\n`;
    message += `**Confidence:** ${pattern.confidence}%\n`;
    message += `**Signal:** ${pattern.message}`;

    return message;
  }

  // Clear data for ticker
  clearHistory(ticker) {
    this.priceHistory.delete(ticker);
    this.patternAlerts.delete(ticker);
  }
}

module.exports = new PatternRecognition();
