const config = require('../../config');
const logger = require('../utils/logger');
const database = require('../database/sqlite');

class StockHeatScore {
  constructor() {
    this.points = config.points;
  }

  // Calculate heat score for a stock signal
  calculate(signal, context = {}) {
    const breakdown = [];
    let totalScore = 0;

    const {
      hasVolumeSpike = false,
      volumeMultiple = 0,
      priceChange = 0
    } = context;

    // Score based on signal type
    switch (signal.type) {
      case 'volume_spike':
        if (signal.rvol >= 5) {
          totalScore += this.points.volume5x || 30;
          breakdown.push({ signal: `${signal.rvol}x RVOL (extreme)`, points: this.points.volume5x || 30 });
        } else if (signal.rvol >= 3) {
          totalScore += this.points.volume3x || 20;
          breakdown.push({ signal: `${signal.rvol}x RVOL spike`, points: this.points.volume3x || 20 });
        }
        break;

      case 'block_trade':
        if (signal.isLargeBlock) {
          totalScore += this.points.hugeBlockTrade || 30;
          breakdown.push({ signal: `$${this.formatValue(signal.tradeValue)} block (huge)`, points: this.points.hugeBlockTrade || 30 });
        } else {
          totalScore += this.points.largeBlockTrade || 20;
          breakdown.push({ signal: `$${this.formatValue(signal.tradeValue)} block trade`, points: this.points.largeBlockTrade || 20 });
        }
        break;

      case 'momentum_surge':
        if (Math.abs(signal.priceChange) >= 5) {
          totalScore += this.points.priceUp5Pct || 25;
          breakdown.push({ signal: `${signal.priceChange}% momentum (strong)`, points: this.points.priceUp5Pct || 25 });
        } else if (Math.abs(signal.priceChange) >= 2) {
          totalScore += this.points.priceUp2Pct || 15;
          breakdown.push({ signal: `${signal.priceChange}% momentum`, points: this.points.priceUp2Pct || 15 });
        }
        break;

      case 'breakout':
        totalScore += this.points.breakoutPattern || 20;
        breakdown.push({ signal: `Breakout above $${signal.resistance}`, points: this.points.breakoutPattern || 20 });
        break;

      case 'consolidation_breakout':
        totalScore += this.points.breakoutPattern || 20;
        breakdown.push({ signal: `Consolidation breakout ${signal.direction}`, points: this.points.breakoutPattern || 20 });
        break;

      case 'gap':
        if (Math.abs(signal.gapPercent) >= 5) {
          totalScore += 25;
          breakdown.push({ signal: `${signal.gapPercent}% gap (large)`, points: 25 });
        } else {
          totalScore += 15;
          breakdown.push({ signal: `${signal.gapPercent}% gap`, points: 15 });
        }
        break;

      case 'vwap_cross':
        totalScore += 15;
        breakdown.push({ signal: `VWAP cross ${signal.direction}`, points: 15 });
        break;

      case 'new_high':
        totalScore += 15;
        breakdown.push({ signal: `New intraday high`, points: 15 });
        break;

      case 'new_low':
        totalScore += 10;
        breakdown.push({ signal: `New intraday low`, points: 10 });
        break;

      case 'relative_strength':
        if (signal.isOutperforming) {
          totalScore += 20;
          breakdown.push({ signal: `Outperforming SPY by ${signal.relativeStrength}%`, points: 20 });
        }
        break;
    }

    // Additional context-based scoring
    if (hasVolumeSpike && signal.type !== 'volume_spike') {
      if (volumeMultiple >= 5) {
        totalScore += 20;
        breakdown.push({ signal: `Confirmed by ${volumeMultiple}x volume`, points: 20 });
      } else if (volumeMultiple >= 3) {
        totalScore += 15;
        breakdown.push({ signal: `Confirmed by ${volumeMultiple}x volume`, points: 15 });
      }
    }

    // Repeat activity bonus
    const signalCount = database.getSignalCount(signal.ticker, 60);
    if (signalCount >= 3) {
      totalScore += this.points.repeatActivity || 25;
      breakdown.push({ signal: `${signalCount} signals in last hour`, points: this.points.repeatActivity || 25 });
    } else if (signalCount >= 2) {
      totalScore += 15;
      breakdown.push({ signal: `${signalCount} signals in last hour`, points: 15 });
    }

    // Cap at 100
    const heatScore = Math.min(100, totalScore);

    return {
      heatScore,
      rawScore: totalScore,
      breakdown,
      ticker: signal.ticker,
      signalType: signal.type,
      price: signal.price,
      description: signal.description,
      severity: signal.severity,
      isHighConviction: heatScore >= config.heatScore.highConvictionThreshold,
      meetsThreshold: heatScore >= config.heatScore.alertThreshold,
      channel: heatScore >= config.heatScore.highConvictionThreshold
        ? 'high-conviction'
        : 'flow-alerts'
    };
  }

  // Format value
  formatValue(value) {
    if (value >= 1000000) return (value / 1000000).toFixed(2) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(0) + 'k';
    return value.toFixed(0);
  }

  // Get heat ranking for tickers
  getHeatRanking(limit = 10) {
    const hotTickers = database.getHotTickers(limit);
    return hotTickers.map(t => ({
      ticker: t.ticker,
      signalCount: t.signal_count,
      totalValue: t.total_premium,
      heat: Math.min(100, t.signal_count * 20)
    }));
  }
}

module.exports = new StockHeatScore();
