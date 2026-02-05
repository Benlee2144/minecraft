const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');

class SPYCorrelation {
  constructor() {
    this.spyData = {
      price: null,
      open: null,
      change: null,
      changePercent: null,
      direction: null, // 'bullish', 'bearish', 'neutral'
      lastUpdate: null
    };

    // Track recent SPY price points for trend
    this.spyPriceHistory = [];
    this.maxHistoryLength = 20;
  }

  // Update SPY data
  async updateSPY() {
    try {
      const snapshot = await polygonRest.getStockSnapshot('SPY');
      if (snapshot) {
        this.spyData = {
          price: snapshot.price,
          open: snapshot.open,
          change: snapshot.todayChange,
          changePercent: snapshot.todayChangePercent,
          direction: this.calculateDirection(snapshot.todayChangePercent),
          vwap: snapshot.vwap,
          lastUpdate: Date.now()
        };

        // Track price history
        this.spyPriceHistory.push({
          price: snapshot.price,
          time: Date.now()
        });

        // Keep history limited
        if (this.spyPriceHistory.length > this.maxHistoryLength) {
          this.spyPriceHistory.shift();
        }

        return this.spyData;
      }
    } catch (error) {
      logger.error('Failed to update SPY data', { error: error.message });
    }
    return null;
  }

  // Calculate market direction
  calculateDirection(changePercent) {
    if (changePercent > 0.3) return 'bullish';
    if (changePercent < -0.3) return 'bearish';
    return 'neutral';
  }

  // Get current SPY data
  getSPY() {
    return this.spyData;
  }

  // Check if data is fresh (within 2 minutes)
  isDataFresh() {
    return this.spyData.lastUpdate && (Date.now() - this.spyData.lastUpdate < 120000);
  }

  // Calculate SPY trend (5-period momentum)
  getSPYTrend() {
    if (this.spyPriceHistory.length < 5) return 'unknown';

    const recent = this.spyPriceHistory.slice(-5);
    const firstPrice = recent[0].price;
    const lastPrice = recent[recent.length - 1].price;
    const change = ((lastPrice - firstPrice) / firstPrice) * 100;

    if (change > 0.1) return 'up';
    if (change < -0.1) return 'down';
    return 'flat';
  }

  // Check if a stock's move aligns with SPY
  checkAlignment(stockChangePercent, stockDirection) {
    if (!this.isDataFresh()) return { aligned: true, reason: 'SPY data stale' };

    const spyDirection = this.spyData.direction;
    const spyChange = this.spyData.changePercent || 0;

    // Determine stock direction
    const stockDir = stockChangePercent > 0.3 ? 'bullish' : (stockChangePercent < -0.3 ? 'bearish' : 'neutral');

    // Check alignment
    if (spyDirection === 'neutral') {
      return { aligned: true, reason: 'SPY neutral - all signals valid' };
    }

    if (stockDir === spyDirection) {
      return {
        aligned: true,
        reason: `Aligned with SPY (${spyDirection})`,
        confidence: 'high',
        spyChange: spyChange.toFixed(2)
      };
    }

    // Stock moving opposite to SPY - could be relative strength or fakeout
    if (stockDir !== 'neutral' && stockDir !== spyDirection) {
      const relativeStrength = Math.abs(stockChangePercent) - Math.abs(spyChange);

      if (relativeStrength > 2) {
        // Strong relative strength - valid signal
        return {
          aligned: true,
          reason: `Relative strength vs SPY (+${relativeStrength.toFixed(1)}%)`,
          confidence: 'high',
          type: 'relative_strength',
          spyChange: spyChange.toFixed(2)
        };
      }

      // Weak counter-move - lower confidence
      return {
        aligned: false,
        reason: `Against SPY trend (${spyDirection})`,
        confidence: 'low',
        spyChange: spyChange.toFixed(2),
        warning: '⚠️ Moving against market'
      };
    }

    return { aligned: true, reason: 'Neutral' };
  }

  // Get SPY context for alerts
  getSPYContext() {
    if (!this.isDataFresh()) {
      return { available: false };
    }

    return {
      available: true,
      price: this.spyData.price,
      change: this.spyData.changePercent?.toFixed(2),
      direction: this.spyData.direction,
      trend: this.getSPYTrend(),
      emoji: this.spyData.direction === 'bullish' ? '🟢' :
             this.spyData.direction === 'bearish' ? '🔴' : '🟡'
    };
  }

  // Format for display in alerts
  formatForAlert() {
    const ctx = this.getSPYContext();
    if (!ctx.available) return null;

    return `SPY: ${ctx.emoji} $${ctx.price?.toFixed(2)} (${ctx.change > 0 ? '+' : ''}${ctx.change}%)`;
  }

  // Calculate beta-adjusted expected move
  calculateExpectedMove(beta, spyChangePercent) {
    return beta * spyChangePercent;
  }

  // Check if stock is outperforming/underperforming vs expected
  checkPerformance(stockChange, expectedBeta = 1.0) {
    if (!this.isDataFresh()) return null;

    const spyChange = this.spyData.changePercent || 0;
    const expected = this.calculateExpectedMove(expectedBeta, spyChange);
    const actual = stockChange;
    const diff = actual - expected;

    return {
      expected: expected.toFixed(2),
      actual: actual.toFixed(2),
      difference: diff.toFixed(2),
      outperforming: diff > 0,
      significant: Math.abs(diff) > 1.5 // More than 1.5% difference
    };
  }
}

// Export singleton
module.exports = new SPYCorrelation();
