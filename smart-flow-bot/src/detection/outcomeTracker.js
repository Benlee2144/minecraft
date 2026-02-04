const config = require('../../config');
const logger = require('../utils/logger');
const database = require('../database/sqlite');
const polygonRest = require('../polygon/rest');
const marketHours = require('../utils/marketHours');

class OutcomeTracker {
  constructor() {
    // Track pending alerts that need outcome updates
    // Key: alertId, Value: { alert, entryPrice, checkTimes: [] }
    this.pendingAlerts = new Map();

    // Intervals for checking outcomes (in minutes)
    this.checkIntervals = [15, 30, 60, 120, 240]; // 15min, 30min, 1hr, 2hr, 4hr

    // Timer for periodic checks
    this.checkTimer = null;
  }

  initialize() {
    // Start periodic outcome checking
    this.checkTimer = setInterval(() => this.checkOutcomes(), 60000); // Check every minute
    logger.info('Outcome tracker initialized');
  }

  // Register a new alert for tracking
  async trackAlert(alertId, heatResult, optionPrice) {
    const alert = {
      id: alertId,
      ticker: heatResult.ticker,
      contract: heatResult.contract,
      optionTicker: heatResult.optionTicker,
      underlyingTicker: heatResult.ticker,
      strike: heatResult.strike,
      expiration: heatResult.expiration,
      optionType: heatResult.optionType,
      heatScore: heatResult.heatScore,
      premium: heatResult.premium,
      spotPrice: heatResult.spotPrice,
      createdAt: Date.now()
    };

    this.pendingAlerts.set(alertId, {
      alert,
      entryPrice: optionPrice || (heatResult.premium / 100), // Estimate if not available
      entrySpotPrice: heatResult.spotPrice,
      checkTimes: this.checkIntervals.map(min => Date.now() + min * 60000),
      outcomes: []
    });

    logger.debug(`Tracking alert ${alertId} for ${heatResult.ticker}`);
  }

  // Check all pending alerts for outcomes
  async checkOutcomes() {
    if (!marketHours.isMarketOpen()) {
      return; // Only check during market hours
    }

    const now = Date.now();

    for (const [alertId, tracking] of this.pendingAlerts.entries()) {
      // Find check times that have passed
      const dueChecks = tracking.checkTimes.filter(t => t <= now);

      if (dueChecks.length > 0) {
        // Remove due check times
        tracking.checkTimes = tracking.checkTimes.filter(t => t > now);

        // Get current prices
        try {
          const outcome = await this.calculateOutcome(tracking);
          if (outcome) {
            tracking.outcomes.push(outcome);

            // Emit outcome for Discord notification
            this.onOutcome(tracking.alert, outcome);

            // Update database
            database.updateAlertOutcome(
              alertId,
              outcome.pnlPercent > 0 ? 'win' : 'loss',
              outcome.currentPrice
            );
          }
        } catch (error) {
          logger.error(`Failed to calculate outcome for alert ${alertId}`, { error: error.message });
        }

        // Remove from tracking if all checks are done
        if (tracking.checkTimes.length === 0) {
          this.pendingAlerts.delete(alertId);
          logger.debug(`Finished tracking alert ${alertId}`);
        }
      }
    }
  }

  // Calculate outcome for an alert
  async calculateOutcome(tracking) {
    const { alert, entryPrice, entrySpotPrice } = tracking;

    // Get current stock price
    const snapshot = await polygonRest.getStockSnapshot(alert.underlyingTicker);
    if (!snapshot || !snapshot.price) {
      return null;
    }

    const currentSpotPrice = snapshot.price;
    const spotPriceChange = ((currentSpotPrice - entrySpotPrice) / entrySpotPrice) * 100;

    // Estimate current option price based on spot price movement
    // This is a simplified estimation - actual option price would come from live data
    const currentPrice = this.estimateOptionPrice(
      entryPrice,
      entrySpotPrice,
      currentSpotPrice,
      alert.strike,
      alert.optionType,
      alert.expiration
    );

    // Calculate P/L
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    const pnlDollar = (currentPrice - entryPrice) * 100; // Per contract

    // Calculate time since alert
    const timeSinceMs = Date.now() - alert.createdAt;
    const timeSinceAlert = this.formatTimeSince(timeSinceMs);

    return {
      ticker: alert.ticker,
      contract: alert.contract,
      entryPrice,
      currentPrice,
      entrySpotPrice,
      currentSpotPrice,
      spotPriceChange: parseFloat(spotPriceChange.toFixed(2)),
      pnlPercent: parseFloat(pnlPercent.toFixed(2)),
      pnlDollar: parseFloat(pnlDollar.toFixed(2)),
      timeSinceAlert,
      timestamp: Date.now()
    };
  }

  // Estimate option price based on stock movement (simplified delta model)
  estimateOptionPrice(entryOptionPrice, entrySpotPrice, currentSpotPrice, strike, optionType, expiration) {
    const spotChange = currentSpotPrice - entrySpotPrice;

    // Calculate days to expiration
    const dte = marketHours.calculateDTE(expiration);

    // Estimate delta based on moneyness
    let delta;
    if (optionType === 'call') {
      const moneyness = (currentSpotPrice - strike) / strike;
      if (moneyness > 0.1) delta = 0.8; // Deep ITM
      else if (moneyness > 0) delta = 0.6; // Slightly ITM
      else if (moneyness > -0.05) delta = 0.5; // ATM
      else if (moneyness > -0.1) delta = 0.35; // Slightly OTM
      else delta = 0.2; // Deep OTM
    } else {
      const moneyness = (strike - currentSpotPrice) / strike;
      if (moneyness > 0.1) delta = -0.8;
      else if (moneyness > 0) delta = -0.6;
      else if (moneyness > -0.05) delta = -0.5;
      else if (moneyness > -0.1) delta = -0.35;
      else delta = -0.2;
    }

    // Adjust for time decay (theta)
    const timeDecayFactor = dte > 0 ? 1 - (0.1 / Math.sqrt(dte)) : 0.5;

    // Estimate new price
    const priceChange = spotChange * Math.abs(delta);
    let newPrice = entryOptionPrice + priceChange;

    // Apply time decay
    newPrice = newPrice * timeDecayFactor;

    // Ensure price doesn't go below intrinsic value
    const intrinsicValue = optionType === 'call'
      ? Math.max(0, currentSpotPrice - strike)
      : Math.max(0, strike - currentSpotPrice);

    newPrice = Math.max(newPrice, intrinsicValue, 0.01);

    return parseFloat(newPrice.toFixed(2));
  }

  // Format time since alert
  formatTimeSince(ms) {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m`;
    }
    return `${minutes}m`;
  }

  // Callback for outcome events (set by main module)
  onOutcome(alert, outcome) {
    // This will be overridden by the main module to send Discord notifications
    logger.info('Outcome calculated', {
      ticker: alert.ticker,
      pnl: `${outcome.pnlPercent > 0 ? '+' : ''}${outcome.pnlPercent}%`
    });
  }

  // Set outcome callback
  setOutcomeCallback(callback) {
    this.onOutcome = callback;
  }

  // Get all tracked alerts
  getTrackedAlerts() {
    return Array.from(this.pendingAlerts.entries()).map(([id, tracking]) => ({
      alertId: id,
      ticker: tracking.alert.ticker,
      contract: tracking.alert.contract,
      entryPrice: tracking.entryPrice,
      pendingChecks: tracking.checkTimes.length,
      outcomes: tracking.outcomes
    }));
  }

  // Get outcomes for today
  getTodayOutcomes() {
    const outcomes = [];

    for (const tracking of this.pendingAlerts.values()) {
      outcomes.push(...tracking.outcomes);
    }

    return outcomes;
  }

  // Get win rate for today
  getTodayWinRate() {
    const outcomes = this.getTodayOutcomes();
    if (outcomes.length === 0) return null;

    const winners = outcomes.filter(o => o.pnlPercent > 0).length;
    return {
      total: outcomes.length,
      winners,
      losers: outcomes.length - winners,
      winRate: ((winners / outcomes.length) * 100).toFixed(1),
      avgReturn: (outcomes.reduce((sum, o) => sum + o.pnlPercent, 0) / outcomes.length).toFixed(2)
    };
  }

  // Manual outcome check for a specific alert
  async checkAlertOutcome(alertId) {
    const tracking = this.pendingAlerts.get(alertId);
    if (!tracking) {
      return null;
    }

    return await this.calculateOutcome(tracking);
  }

  // Cleanup expired alerts (past expiration)
  cleanup() {
    const today = marketHours.getTodayString();

    for (const [alertId, tracking] of this.pendingAlerts.entries()) {
      if (tracking.alert.expiration < today) {
        this.pendingAlerts.delete(alertId);
        logger.debug(`Removed expired alert ${alertId}`);
      }
    }
  }

  // Shutdown
  shutdown() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }
  }
}

// Export singleton instance
module.exports = new OutcomeTracker();
