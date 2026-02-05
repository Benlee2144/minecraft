/**
 * VWAP Tracker - Professional Day Trading Strategy
 *
 * VWAP (Volume Weighted Average Price) is the #1 indicator used by pro day traders.
 * - Price above VWAP = bullish bias (buy calls)
 * - Price below VWAP = bearish bias (buy puts)
 * - VWAP breakouts with volume = strong entry signals
 * - VWAP pullbacks = high probability entries
 *
 * Sources:
 * - https://www.warriortrading.com/vwap/
 * - https://www.luxalgo.com/blog/vwap-entry-strategies-for-day-traders/
 */

const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');

class VWAPTracker {
  constructor() {
    // Store VWAP data for each ticker
    this.vwapData = new Map();

    // Store previous day levels
    this.previousDayLevels = new Map();

    // Store premarket levels
    this.premarketLevels = new Map();

    // Cache duration (refresh every 2 minutes)
    this.cacheDuration = 2 * 60 * 1000;
  }

  /**
   * Calculate VWAP from intraday bars
   */
  calculateVWAP(bars) {
    if (!bars || bars.length === 0) return null;

    let cumulativeTPV = 0; // Total Price * Volume
    let cumulativeVolume = 0;

    const vwapPoints = [];

    for (const bar of bars) {
      const typicalPrice = (bar.h + bar.l + bar.c) / 3;
      const tpv = typicalPrice * bar.v;

      cumulativeTPV += tpv;
      cumulativeVolume += bar.v;

      const vwap = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice;
      vwapPoints.push({
        time: bar.t,
        vwap,
        price: bar.c,
        volume: bar.v
      });
    }

    if (vwapPoints.length === 0) return null;

    const latest = vwapPoints[vwapPoints.length - 1];
    const currentPrice = latest.price;
    const currentVWAP = latest.vwap;

    // Calculate standard deviation for VWAP bands
    let sumSquaredDiff = 0;
    for (const point of vwapPoints) {
      sumSquaredDiff += Math.pow(point.price - point.vwap, 2);
    }
    const stdDev = Math.sqrt(sumSquaredDiff / vwapPoints.length);

    return {
      vwap: currentVWAP,
      price: currentPrice,
      upperBand1: currentVWAP + stdDev,
      lowerBand1: currentVWAP - stdDev,
      upperBand2: currentVWAP + (2 * stdDev),
      lowerBand2: currentVWAP - (2 * stdDev),
      priceVsVWAP: ((currentPrice - currentVWAP) / currentVWAP) * 100,
      isAboveVWAP: currentPrice > currentVWAP,
      distanceFromVWAP: Math.abs(currentPrice - currentVWAP),
      distancePercent: Math.abs(((currentPrice - currentVWAP) / currentVWAP) * 100)
    };
  }

  /**
   * Get VWAP analysis for a ticker
   */
  async getVWAPAnalysis(ticker) {
    try {
      // Check cache
      const cached = this.vwapData.get(ticker);
      if (cached && Date.now() - cached.timestamp < this.cacheDuration) {
        return cached.data;
      }

      // Fetch today's intraday bars (5-minute)
      const bars = await polygonRest.getIntradayBars(ticker, 5, 1);

      if (!bars || bars.length < 5) {
        return null;
      }

      const vwapAnalysis = this.calculateVWAP(bars);

      if (vwapAnalysis) {
        // Detect VWAP signals
        vwapAnalysis.signals = this.detectVWAPSignals(bars, vwapAnalysis);

        // Cache it
        this.vwapData.set(ticker, {
          timestamp: Date.now(),
          data: vwapAnalysis
        });
      }

      return vwapAnalysis;
    } catch (error) {
      logger.debug(`VWAP analysis error for ${ticker}: ${error.message}`);
      return null;
    }
  }

  /**
   * Detect VWAP-based trading signals
   */
  detectVWAPSignals(bars, vwapData) {
    const signals = [];

    if (bars.length < 3) return signals;

    const recent = bars.slice(-5);
    const lastBar = recent[recent.length - 1];
    const prevBar = recent[recent.length - 2];

    // Calculate recent VWAP for comparison
    const recentVWAPs = this.getRecentVWAPs(bars);

    // 1. VWAP Breakout - Price crosses above VWAP with volume
    if (prevBar.c < recentVWAPs.prev && lastBar.c > vwapData.vwap) {
      const avgVolume = recent.reduce((sum, b) => sum + b.v, 0) / recent.length;
      if (lastBar.v > avgVolume * 1.5) {
        signals.push({
          type: 'VWAP_BREAKOUT_LONG',
          strength: 'STRONG',
          description: 'Price broke above VWAP with volume confirmation',
          points: 25
        });
      }
    }

    // 2. VWAP Breakdown - Price crosses below VWAP with volume
    if (prevBar.c > recentVWAPs.prev && lastBar.c < vwapData.vwap) {
      const avgVolume = recent.reduce((sum, b) => sum + b.v, 0) / recent.length;
      if (lastBar.v > avgVolume * 1.5) {
        signals.push({
          type: 'VWAP_BREAKOUT_SHORT',
          strength: 'STRONG',
          description: 'Price broke below VWAP with volume confirmation',
          points: 25
        });
      }
    }

    // 3. VWAP Pullback Long - Price pulls back to VWAP from above and holds
    if (vwapData.isAboveVWAP && vwapData.distancePercent < 0.3) {
      // Price is just above VWAP (within 0.3%)
      const wasHigher = recent.slice(0, -1).some(b =>
        ((b.c - vwapData.vwap) / vwapData.vwap) * 100 > 0.5
      );
      if (wasHigher) {
        signals.push({
          type: 'VWAP_PULLBACK_LONG',
          strength: 'MEDIUM',
          description: 'Price pulled back to VWAP support - potential bounce',
          points: 20
        });
      }
    }

    // 4. VWAP Pullback Short - Price pulls back to VWAP from below and rejects
    if (!vwapData.isAboveVWAP && vwapData.distancePercent < 0.3) {
      const wasLower = recent.slice(0, -1).some(b =>
        ((vwapData.vwap - b.c) / vwapData.vwap) * 100 > 0.5
      );
      if (wasLower) {
        signals.push({
          type: 'VWAP_PULLBACK_SHORT',
          strength: 'MEDIUM',
          description: 'Price pulled back to VWAP resistance - potential rejection',
          points: 20
        });
      }
    }

    // 5. Extended from VWAP - Mean reversion warning
    if (vwapData.distancePercent > 1.5) {
      signals.push({
        type: 'EXTENDED_FROM_VWAP',
        strength: 'WARNING',
        description: `Price extended ${vwapData.distancePercent.toFixed(1)}% from VWAP - mean reversion risk`,
        points: -10
      });
    }

    // 6. Holding VWAP - Trend confirmation
    const allAbove = recent.every(b => b.c > vwapData.vwap);
    const allBelow = recent.every(b => b.c < vwapData.vwap);

    if (allAbove) {
      signals.push({
        type: 'HOLDING_ABOVE_VWAP',
        strength: 'BULLISH',
        description: 'Price consistently holding above VWAP - bullish bias',
        points: 15
      });
    } else if (allBelow) {
      signals.push({
        type: 'HOLDING_BELOW_VWAP',
        strength: 'BEARISH',
        description: 'Price consistently holding below VWAP - bearish bias',
        points: 15
      });
    }

    return signals;
  }

  /**
   * Get recent VWAP values for comparison
   */
  getRecentVWAPs(bars) {
    if (bars.length < 2) return { current: 0, prev: 0 };

    // Calculate VWAP up to previous bar
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    for (let i = 0; i < bars.length - 1; i++) {
      const bar = bars[i];
      const typicalPrice = (bar.h + bar.l + bar.c) / 3;
      cumulativeTPV += typicalPrice * bar.v;
      cumulativeVolume += bar.v;
    }

    const prevVWAP = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;

    // Add last bar for current VWAP
    const lastBar = bars[bars.length - 1];
    const lastTP = (lastBar.h + lastBar.l + lastBar.c) / 3;
    cumulativeTPV += lastTP * lastBar.v;
    cumulativeVolume += lastBar.v;

    const currentVWAP = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : 0;

    return { current: currentVWAP, prev: prevVWAP };
  }

  /**
   * Get previous day's key levels (high, low, close)
   */
  async getPreviousDayLevels(ticker) {
    try {
      const cached = this.previousDayLevels.get(ticker);
      if (cached && Date.now() - cached.timestamp < 60 * 60 * 1000) { // 1 hour cache
        return cached.data;
      }

      const dailyBars = await polygonRest.getDailyBars(ticker, 2);

      if (!dailyBars || dailyBars.length < 2) {
        return null;
      }

      // Previous day is second to last (last is today)
      const prevDay = dailyBars[dailyBars.length - 2];

      const levels = {
        previousHigh: prevDay.h,
        previousLow: prevDay.l,
        previousClose: prevDay.c,
        previousOpen: prevDay.o,
        previousRange: prevDay.h - prevDay.l,
        previousMidpoint: (prevDay.h + prevDay.l) / 2
      };

      this.previousDayLevels.set(ticker, {
        timestamp: Date.now(),
        data: levels
      });

      return levels;
    } catch (error) {
      logger.debug(`Previous day levels error for ${ticker}: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if price is at a key level
   */
  async checkKeyLevels(ticker, currentPrice) {
    const prevLevels = await this.getPreviousDayLevels(ticker);
    const vwapData = await this.getVWAPAnalysis(ticker);

    const keyLevelSignals = [];
    const tolerance = 0.002; // 0.2% tolerance for "at level"

    if (prevLevels) {
      // Check previous day high
      if (Math.abs(currentPrice - prevLevels.previousHigh) / prevLevels.previousHigh < tolerance) {
        keyLevelSignals.push({
          type: 'AT_PREV_DAY_HIGH',
          level: prevLevels.previousHigh,
          description: 'Testing previous day high - key resistance',
          bullishBreak: true
        });
      }

      // Check previous day low
      if (Math.abs(currentPrice - prevLevels.previousLow) / prevLevels.previousLow < tolerance) {
        keyLevelSignals.push({
          type: 'AT_PREV_DAY_LOW',
          level: prevLevels.previousLow,
          description: 'Testing previous day low - key support',
          bullishBreak: false
        });
      }

      // Breaking above previous high
      if (currentPrice > prevLevels.previousHigh * 1.002) {
        keyLevelSignals.push({
          type: 'BREAK_PREV_HIGH',
          level: prevLevels.previousHigh,
          description: 'Breaking above previous day high - BULLISH breakout',
          points: 20
        });
      }

      // Breaking below previous low
      if (currentPrice < prevLevels.previousLow * 0.998) {
        keyLevelSignals.push({
          type: 'BREAK_PREV_LOW',
          level: prevLevels.previousLow,
          description: 'Breaking below previous day low - BEARISH breakdown',
          points: 20
        });
      }
    }

    return {
      previousDayLevels: prevLevels,
      vwapData,
      keyLevelSignals
    };
  }

  /**
   * Get complete pro trader analysis
   */
  async getProTraderAnalysis(ticker, currentPrice) {
    const [vwapData, keyLevels] = await Promise.all([
      this.getVWAPAnalysis(ticker),
      this.checkKeyLevels(ticker, currentPrice)
    ]);

    let totalPoints = 0;
    const allSignals = [];

    // Add VWAP signals
    if (vwapData && vwapData.signals) {
      for (const signal of vwapData.signals) {
        totalPoints += signal.points || 0;
        allSignals.push(signal);
      }
    }

    // Add key level signals
    if (keyLevels.keyLevelSignals) {
      for (const signal of keyLevels.keyLevelSignals) {
        totalPoints += signal.points || 0;
        allSignals.push(signal);
      }
    }

    // Determine bias
    let bias = 'NEUTRAL';
    if (vwapData) {
      if (vwapData.isAboveVWAP) {
        bias = 'BULLISH';
      } else {
        bias = 'BEARISH';
      }
    }

    return {
      ticker,
      currentPrice,
      vwap: vwapData,
      keyLevels: keyLevels.previousDayLevels,
      signals: allSignals,
      bonusPoints: totalPoints,
      bias,
      recommendation: this.getTradeRecommendation(vwapData, allSignals, bias)
    };
  }

  /**
   * Get trade recommendation based on VWAP analysis
   */
  getTradeRecommendation(vwapData, signals, bias) {
    if (!vwapData) return null;

    const hasBreakout = signals.some(s => s.type.includes('BREAKOUT'));
    const hasPullback = signals.some(s => s.type.includes('PULLBACK'));
    const isExtended = signals.some(s => s.type === 'EXTENDED_FROM_VWAP');

    if (hasBreakout && !isExtended) {
      return {
        setup: 'VWAP_BREAKOUT',
        direction: bias,
        entry: 'Enter on breakout confirmation',
        stop: `Stop below VWAP at $${vwapData.vwap.toFixed(2)}`,
        target: bias === 'BULLISH' ? vwapData.upperBand1 : vwapData.lowerBand1,
        confidence: 'HIGH'
      };
    }

    if (hasPullback && !isExtended) {
      return {
        setup: 'VWAP_PULLBACK',
        direction: bias,
        entry: 'Enter on VWAP bounce/rejection',
        stop: `Stop ${bias === 'BULLISH' ? 'below' : 'above'} VWAP at $${vwapData.vwap.toFixed(2)}`,
        target: bias === 'BULLISH' ? vwapData.upperBand1 : vwapData.lowerBand1,
        confidence: 'MEDIUM'
      };
    }

    if (isExtended) {
      return {
        setup: 'EXTENDED',
        direction: bias === 'BULLISH' ? 'BEARISH' : 'BULLISH', // Fade
        entry: 'Wait for mean reversion or skip',
        warning: 'Price extended from VWAP - high risk entry',
        confidence: 'LOW'
      };
    }

    return null;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.vwapData.clear();
    this.previousDayLevels.clear();
    this.premarketLevels.clear();
  }
}

module.exports = new VWAPTracker();
