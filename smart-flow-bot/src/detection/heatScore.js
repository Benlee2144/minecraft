const config = require('../../config');
const logger = require('../utils/logger');
const marketHours = require('../utils/marketHours');
const database = require('../database/sqlite');
const volumeSpike = require('./volumeSpike');
const sweepDetector = require('./sweepDetector');
const ivAnomaly = require('./ivAnomaly');

class HeatScoreCalculator {
  constructor() {
    this.points = config.points;
  }

  // Calculate heat score for a signal/sweep
  calculate(signal, context = {}) {
    const breakdown = [];
    let totalScore = 0;

    const {
      spotPrice = 0,
      hasVolumeSpike = false,
      volumeMultiple = 0,
      ivAnomaly: hasIVAnomaly = false,
      ivChange = 0
    } = context;

    // 1. Volume spike points (+15)
    if (hasVolumeSpike && volumeMultiple >= config.detection.volumeSpikeMultiplier) {
      totalScore += this.points.volume3x;
      breakdown.push({
        signal: `${volumeMultiple.toFixed(1)}x average volume spike`,
        points: this.points.volume3x
      });
    }

    // 2. Sweep at ASK (+20)
    if (signal.type === 'sweep' && signal.isAtAsk) {
      totalScore += this.points.sweepAtAsk;
      breakdown.push({
        signal: `${signal.isBullish ? 'Bullish' : 'Bearish'} sweep bought at ASK`,
        points: this.points.sweepAtAsk
      });
    }

    // 3. Premium size points
    const premium = signal.totalPremium || signal.premium || 0;
    if (premium >= config.detection.hugePremiumThreshold) {
      // $1M+ gets +25
      totalScore += this.points.premium1M;
      breakdown.push({
        signal: `$${this.formatPremium(premium)} premium (> $1M)`,
        points: this.points.premium1M
      });
    } else if (premium >= config.detection.largePremiumThreshold) {
      // $500k+ gets +15
      totalScore += this.points.premium500k;
      breakdown.push({
        signal: `$${this.formatPremium(premium)} premium (> $500k)`,
        points: this.points.premium500k
      });
    }

    // 4. DTE points
    const dte = marketHours.calculateDTE(signal.expiration);
    if (dte >= 0 && dte <= config.detection.shortDteMax) {
      // 0-3 DTE gets +10
      totalScore += this.points.dte0to3;
      breakdown.push({
        signal: `${dte} DTE expiration (0-3 days)`,
        points: this.points.dte0to3
      });
    } else if (dte > config.detection.shortDteMax && dte <= config.detection.mediumDteMax) {
      // 4-7 DTE gets +5
      totalScore += this.points.dte4to7;
      breakdown.push({
        signal: `${dte} DTE expiration (4-7 days)`,
        points: this.points.dte4to7
      });
    }

    // 5. Multiple sweeps in same direction within 30 min (+20)
    const ticker = signal.underlyingTicker;
    const sweepCount = sweepDetector.getSweepCount(ticker, config.detection.multipleSweepWindowMinutes);
    if (sweepCount >= 2) {
      totalScore += this.points.multipleSweeps30min;
      breakdown.push({
        signal: `${sweepCount} sweeps in last 30 min`,
        points: this.points.multipleSweeps30min
      });
    }

    // 6. IV spike without price movement (+15)
    if (hasIVAnomaly && ivChange >= config.detection.ivSpikeThreshold * 100) {
      totalScore += this.points.ivSpikeNoPrice;
      breakdown.push({
        signal: `IV up ${ivChange.toFixed(1)}% with flat price`,
        points: this.points.ivSpikeNoPrice
      });
    }

    // 7. Repeat activity (+25)
    const signalCount = database.getSignalCount(ticker, config.detection.repeatWindowMinutes);
    if (signalCount >= 2) {
      totalScore += this.points.repeatActivity;
      breakdown.push({
        signal: `${signalCount} signals on ${ticker} in last hour`,
        points: this.points.repeatActivity
      });
    }

    // Calculate OTM percentage for additional context
    const otmPercent = this.calculateOTMPercent(signal.strike, spotPrice, signal.optionType);

    return {
      heatScore: Math.min(100, totalScore), // Cap at 100
      rawScore: totalScore,
      breakdown,
      ticker,
      contract: this.formatContract(signal),
      premium,
      strike: signal.strike,
      spotPrice,
      expiration: signal.expiration,
      optionType: signal.optionType,
      dte,
      otmPercent,
      isHighConviction: totalScore >= config.heatScore.highConvictionThreshold,
      meetsThreshold: totalScore >= config.heatScore.alertThreshold,
      channel: totalScore >= config.heatScore.highConvictionThreshold
        ? 'high-conviction'
        : 'flow-alerts'
    };
  }

  // Calculate OTM percentage
  calculateOTMPercent(strike, spotPrice, optionType) {
    if (!spotPrice || spotPrice === 0) return 0;

    if (optionType === 'call') {
      return parseFloat(((strike - spotPrice) / spotPrice * 100).toFixed(1));
    } else {
      return parseFloat(((spotPrice - strike) / spotPrice * 100).toFixed(1));
    }
  }

  // Format premium for display
  formatPremium(premium) {
    if (premium >= 1000000) {
      return (premium / 1000000).toFixed(2) + 'M';
    } else if (premium >= 1000) {
      return (premium / 1000).toFixed(0) + 'k';
    }
    return premium.toFixed(0);
  }

  // Format contract name for display
  formatContract(signal) {
    const date = new Date(signal.expiration);
    const monthDay = date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
    const typeStr = signal.optionType === 'call' ? 'Call' : 'Put';
    return `${signal.underlyingTicker} ${monthDay} $${signal.strike} ${typeStr}`;
  }

  // Check if a score meets the minimum threshold
  meetsThreshold(score, isWatchlist = false) {
    const threshold = isWatchlist
      ? config.heatScore.watchlistThreshold
      : config.heatScore.alertThreshold;
    return score >= threshold;
  }

  // Get channel for score
  getChannel(score) {
    if (score >= config.heatScore.highConvictionThreshold) {
      return 'high-conviction';
    } else if (score >= config.heatScore.alertThreshold) {
      return 'flow-alerts';
    }
    return null;
  }

  // Calculate aggregate heat for a ticker based on recent activity
  calculateTickerHeat(ticker) {
    const signals = database.getRecentSignals(ticker, 60);
    if (signals.length === 0) {
      return { ticker, heat: 0, signalCount: 0, status: 'cold' };
    }

    // Base score on signal count
    let heat = signals.length * 15;

    // Add premium weight
    const totalPremium = signals.reduce((sum, s) => sum + s.premium, 0);
    if (totalPremium >= 5000000) heat += 30;
    else if (totalPremium >= 2000000) heat += 20;
    else if (totalPremium >= 1000000) heat += 10;

    // Check for multiple signal types
    const signalTypes = new Set(signals.map(s => s.signal_type));
    if (signalTypes.size >= 2) heat += 10;

    // Cap at 100
    heat = Math.min(100, heat);

    let status = 'cold';
    if (heat >= 80) status = 'on_fire';
    else if (heat >= 60) status = 'hot';
    else if (heat >= 40) status = 'warming';
    else if (heat >= 20) status = 'tepid';

    return {
      ticker,
      heat,
      signalCount: signals.length,
      totalPremium,
      signalTypes: Array.from(signalTypes),
      status
    };
  }

  // Get heat ranking for all tracked tickers
  getHeatRanking(limit = 10) {
    const hotTickers = database.getHotTickers(limit);

    return hotTickers.map(t => ({
      ticker: t.ticker,
      signalCount: t.signal_count,
      totalPremium: t.total_premium,
      ...this.calculateTickerHeat(t.ticker)
    }));
  }
}

// Export singleton instance
module.exports = new HeatScoreCalculator();
