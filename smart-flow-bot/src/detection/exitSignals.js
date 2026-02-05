/**
 * Exit Signals Module
 * Detects when to exit open positions based on:
 * - Momentum reversal
 * - Volume fade
 * - SPY divergence
 * - Time-based exits
 */

const logger = require('../utils/logger');
const spyCorrelation = require('./spyCorrelation');
const marketHours = require('../utils/marketHours');

class ExitSignals {
  constructor() {
    this.priceHistory = new Map(); // ticker -> array of {price, volume, timestamp}
    this.maxHistoryLength = 20;    // Keep last 20 data points
  }

  // Update price history for a ticker
  updatePriceHistory(ticker, price, volume) {
    if (!this.priceHistory.has(ticker)) {
      this.priceHistory.set(ticker, []);
    }

    const history = this.priceHistory.get(ticker);
    history.push({
      price,
      volume,
      timestamp: Date.now()
    });

    // Keep only recent history
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  // Check for exit signals on an open trade
  checkExitSignals(trade, currentPrice, currentVolume) {
    const signals = [];
    const ticker = trade.ticker;
    const entryPrice = trade.entry_price;
    const direction = trade.direction;
    const targetPrice = trade.target_price;
    const stopPrice = trade.stop_price;

    // Update history
    this.updatePriceHistory(ticker, currentPrice, currentVolume);

    // Get price history
    const history = this.priceHistory.get(ticker) || [];
    if (history.length < 5) return signals; // Need at least 5 data points

    // Calculate current P&L
    const pnlPercent = direction === 'BULLISH'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;

    // 1. Momentum Reversal Detection
    const momentumSignal = this.checkMomentumReversal(history, direction, pnlPercent);
    if (momentumSignal) {
      signals.push(momentumSignal);
    }

    // 2. Volume Fade Detection
    const volumeFadeSignal = this.checkVolumeFade(history, pnlPercent);
    if (volumeFadeSignal) {
      signals.push(volumeFadeSignal);
    }

    // 3. SPY Divergence (position moving against SPY)
    const spySignal = this.checkSPYDivergence(direction, pnlPercent);
    if (spySignal) {
      signals.push(spySignal);
    }

    // 4. Time-based Exit (position open too long during chop)
    const timeSignal = this.checkTimeBasedExit(trade, pnlPercent);
    if (timeSignal) {
      signals.push(timeSignal);
    }

    // 5. Partial Profit Taking
    const partialSignal = this.checkPartialProfitTaking(trade, currentPrice, pnlPercent);
    if (partialSignal) {
      signals.push(partialSignal);
    }

    // 6. Target Approaching (last chance to take profits)
    const approachingSignal = this.checkTargetApproaching(trade, currentPrice, direction);
    if (approachingSignal) {
      signals.push(approachingSignal);
    }

    return signals;
  }

  // Check for momentum reversal
  checkMomentumReversal(history, direction, pnlPercent) {
    if (history.length < 5) return null;

    // Get last 5 prices
    const recentPrices = history.slice(-5).map(h => h.price);

    // Check for lower highs (bullish) or higher lows (bearish)
    if (direction === 'BULLISH') {
      // Check for 3 consecutive lower prices
      let lowerCount = 0;
      for (let i = 1; i < recentPrices.length; i++) {
        if (recentPrices[i] < recentPrices[i - 1]) {
          lowerCount++;
        }
      }

      if (lowerCount >= 3 && pnlPercent > 0.5) {
        return {
          type: 'MOMENTUM_REVERSAL',
          severity: 'warning',
          message: 'Momentum fading - 3 consecutive lower prices',
          action: 'CONSIDER_EXIT',
          emoji: '⚠️'
        };
      }
    } else {
      // Bearish - check for higher prices
      let higherCount = 0;
      for (let i = 1; i < recentPrices.length; i++) {
        if (recentPrices[i] > recentPrices[i - 1]) {
          higherCount++;
        }
      }

      if (higherCount >= 3 && pnlPercent > 0.5) {
        return {
          type: 'MOMENTUM_REVERSAL',
          severity: 'warning',
          message: 'Momentum reversing - 3 consecutive higher prices',
          action: 'CONSIDER_EXIT',
          emoji: '⚠️'
        };
      }
    }

    return null;
  }

  // Check for volume fade
  checkVolumeFade(history, pnlPercent) {
    if (history.length < 5) return null;

    // Get last 5 volumes
    const recentVolumes = history.slice(-5).map(h => h.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const latestVolume = recentVolumes[recentVolumes.length - 1];

    // Volume dropped to less than 50% of average
    if (latestVolume < avgVolume * 0.5 && pnlPercent > 1.0) {
      return {
        type: 'VOLUME_FADE',
        severity: 'info',
        message: 'Volume fading - momentum may stall',
        action: 'WATCH_CLOSELY',
        emoji: '📉'
      };
    }

    return null;
  }

  // Check for SPY divergence
  checkSPYDivergence(direction, pnlPercent) {
    const spy = spyCorrelation.getSPY();
    if (!spy.price) return null;

    const spyDirection = spy.direction; // 'bullish', 'bearish', 'neutral'

    // Position is profitable but SPY moved against us
    if (pnlPercent > 0.5) {
      if (direction === 'BULLISH' && spyDirection === 'bearish') {
        return {
          type: 'SPY_DIVERGENCE',
          severity: 'warning',
          message: 'SPY turned bearish - long position at risk',
          action: 'TIGHTEN_STOP',
          emoji: '🐻'
        };
      } else if (direction === 'BEARISH' && spyDirection === 'bullish') {
        return {
          type: 'SPY_DIVERGENCE',
          severity: 'warning',
          message: 'SPY turned bullish - short position at risk',
          action: 'TIGHTEN_STOP',
          emoji: '🐂'
        };
      }
    }

    return null;
  }

  // Check for time-based exit during midday chop
  checkTimeBasedExit(trade, pnlPercent) {
    const phase = marketHours.getTradingPhase();
    const entryTime = new Date(trade.entry_time || trade.created_at);
    const now = new Date();
    const minutesHeld = (now - entryTime) / 60000;

    // During midday (11:30-2:00), if position held > 30 min with small P&L
    if (phase.phase === 'midday' && minutesHeld > 30 && Math.abs(pnlPercent) < 0.5) {
      return {
        type: 'TIME_EXIT',
        severity: 'info',
        message: `Held ${Math.round(minutesHeld)} min during midday chop with minimal movement`,
        action: 'CONSIDER_FLAT',
        emoji: '⏰'
      };
    }

    // Any position held > 2 hours with small P&L
    if (minutesHeld > 120 && Math.abs(pnlPercent) < 1.0) {
      return {
        type: 'TIME_EXIT',
        severity: 'info',
        message: `Position held ${Math.round(minutesHeld)} min - consider closing`,
        action: 'CONSIDER_FLAT',
        emoji: '⏰'
      };
    }

    return null;
  }

  // Check for partial profit taking opportunity
  checkPartialProfitTaking(trade, currentPrice, pnlPercent) {
    // If we're up 2%+ on stock (7%+ on option), suggest partial
    if (pnlPercent >= 2.0 && !trade.partial_taken) {
      return {
        type: 'PARTIAL_PROFIT',
        severity: 'positive',
        message: `Up ${pnlPercent.toFixed(1)}% - consider taking partial profits`,
        action: 'TAKE_PARTIAL',
        emoji: '💰'
      };
    }

    return null;
  }

  // Check if approaching target
  checkTargetApproaching(trade, currentPrice, direction) {
    const targetPrice = trade.target_price;
    if (!targetPrice) return null;

    const distanceToTarget = direction === 'BULLISH'
      ? ((targetPrice - currentPrice) / currentPrice) * 100
      : ((currentPrice - targetPrice) / currentPrice) * 100;

    // Within 0.3% of target
    if (distanceToTarget <= 0.3 && distanceToTarget > 0) {
      return {
        type: 'TARGET_APPROACHING',
        severity: 'positive',
        message: `Only ${distanceToTarget.toFixed(2)}% from target - consider closing`,
        action: 'CLOSE_NOW',
        emoji: '🎯'
      };
    }

    return null;
  }

  // Format exit signal for Discord
  formatExitSignal(trade, signal) {
    const emoji = signal.emoji || '⚠️';
    const ticker = trade.ticker;

    return `${emoji} **EXIT SIGNAL** - ${ticker}\n` +
           `━━━━━━━━━━━━━━━━━━━━━━\n` +
           `**Type:** ${signal.type.replace(/_/g, ' ')}\n` +
           `**Message:** ${signal.message}\n` +
           `**Suggested Action:** ${signal.action.replace(/_/g, ' ')}\n` +
           `**Trade ID:** #${trade.id}`;
  }

  // Clear history for a ticker
  clearHistory(ticker) {
    this.priceHistory.delete(ticker);
  }

  // Clear all history
  clearAllHistory() {
    this.priceHistory.clear();
  }
}

module.exports = new ExitSignals();
