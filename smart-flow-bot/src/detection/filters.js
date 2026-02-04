const config = require('../../config');
const logger = require('../utils/logger');
const marketHours = require('../utils/marketHours');
const database = require('../database/sqlite');

class SignalFilters {
  constructor() {
    this.earningsCalendar = new Map();
    this.volumeCache = new Map();
    this.openInterestCache = new Map();
  }

  // Initialize with earnings data
  initialize() {
    logger.info('Signal filters initialized');
  }

  // Main filter function - returns true if signal should be BLOCKED
  shouldFilter(signal, context = {}) {
    const reasons = [];

    // Check market hours
    if (!this.isMarketHours()) {
      reasons.push('Outside market hours');
    }

    // Check minimum stock price
    const spotPrice = context.spotPrice || 0;
    if (spotPrice < config.filters.minStockPrice) {
      reasons.push(`Stock price $${spotPrice} below minimum $${config.filters.minStockPrice}`);
    }

    // Check if ticker is in ignore list
    const ticker = signal.underlyingTicker;
    if (this.isIgnoredTicker(ticker)) {
      reasons.push(`Ticker ${ticker} is in ignore list`);
    }

    // Check earnings blackout
    if (this.isInEarningsBlackout(ticker)) {
      reasons.push(`Ticker ${ticker} is within ${config.filters.earningsBlackoutDays} days of earnings`);
    }

    // Check minimum premium
    const premium = signal.totalPremium || signal.premium || 0;
    if (premium < config.detection.minPremiumForAlert) {
      reasons.push(`Premium $${premium} below minimum $${config.detection.minPremiumForAlert}`);
    }

    // Check average daily volume
    const avgVolume = context.avgVolume || this.volumeCache.get(ticker) || 0;
    if (avgVolume > 0 && avgVolume < config.filters.minAvgDailyVolume) {
      reasons.push(`Avg daily volume ${avgVolume} below minimum ${config.filters.minAvgDailyVolume}`);
    }

    // Check open interest
    const openInterest = context.openInterest || 0;
    if (openInterest > 0 && openInterest < config.filters.minOpenInterest) {
      reasons.push(`Open interest ${openInterest} below minimum ${config.filters.minOpenInterest}`);
    }

    // Return result
    if (reasons.length > 0) {
      logger.debug(`Signal filtered for ${ticker}`, { reasons });
      return { filtered: true, reasons };
    }

    return { filtered: false, reasons: [] };
  }

  // Check if within market hours
  isMarketHours() {
    return marketHours.isMarketOpen();
  }

  // Check if ticker is in ignore list
  isIgnoredTicker(ticker) {
    return config.ignoredTickers.includes(ticker.toUpperCase());
  }

  // Check if ticker is within earnings blackout period
  isInEarningsBlackout(ticker) {
    const earningsDate = this.earningsCalendar.get(ticker.toUpperCase()) ||
                         database.getEarningsDate(ticker);

    if (!earningsDate) {
      return false; // No earnings date known, don't filter
    }

    const today = new Date(marketHours.getTodayString());
    const earnings = new Date(earningsDate);
    const daysUntilEarnings = Math.ceil((earnings - today) / (1000 * 60 * 60 * 24));

    // Filter if earnings is within blackout period (before earnings)
    // or just after (within 1 day of announcement)
    return daysUntilEarnings >= -1 && daysUntilEarnings <= config.filters.earningsBlackoutDays;
  }

  // Set earnings date for a ticker
  setEarningsDate(ticker, date) {
    this.earningsCalendar.set(ticker.toUpperCase(), date);
    database.saveEarningsDate(ticker, date);
  }

  // Set average volume for cache
  setVolumeCache(ticker, avgVolume) {
    this.volumeCache.set(ticker.toUpperCase(), avgVolume);
  }

  // Set open interest for cache
  setOpenInterestCache(optionTicker, oi) {
    this.openInterestCache.set(optionTicker, oi);
  }

  // Check if option is OTM in the desired range (5-10%)
  isInOTMRange(strike, spotPrice, optionType) {
    if (!spotPrice || spotPrice === 0) return false;

    let otmPercent;
    if (optionType === 'call') {
      otmPercent = ((strike - spotPrice) / spotPrice) * 100;
    } else {
      otmPercent = ((spotPrice - strike) / spotPrice) * 100;
    }

    // Must be OTM (positive percent) and within range
    return otmPercent >= config.detection.otmMinPercent &&
           otmPercent <= config.detection.otmMaxPercent;
  }

  // Check if option is just OTM (any amount)
  isOTM(strike, spotPrice, optionType) {
    if (!spotPrice || spotPrice === 0) return false;

    if (optionType === 'call') {
      return strike > spotPrice;
    } else {
      return strike < spotPrice;
    }
  }

  // Check if DTE is in the short-dated range
  isShortDated(expiration) {
    const dte = marketHours.calculateDTE(expiration);
    return dte >= 0 && dte <= config.detection.mediumDteMax;
  }

  // Check if DTE is in the very short-dated range (0-3)
  isVeryShortDated(expiration) {
    const dte = marketHours.calculateDTE(expiration);
    return dte >= 0 && dte <= config.detection.shortDteMax;
  }

  // Add ticker to ignore list temporarily
  addToIgnoreList(ticker, reason = 'manual') {
    if (!config.ignoredTickers.includes(ticker.toUpperCase())) {
      config.ignoredTickers.push(ticker.toUpperCase());
      logger.info(`Added ${ticker} to ignore list`, { reason });
    }
  }

  // Remove ticker from ignore list
  removeFromIgnoreList(ticker) {
    const index = config.ignoredTickers.indexOf(ticker.toUpperCase());
    if (index > -1) {
      config.ignoredTickers.splice(index, 1);
      logger.info(`Removed ${ticker} from ignore list`);
    }
  }

  // Quality score for a signal (higher = better quality)
  getQualityScore(signal, context = {}) {
    let score = 100;

    // Deduct for penny stock
    const spotPrice = context.spotPrice || 0;
    if (spotPrice < 20) score -= 20;
    else if (spotPrice < 50) score -= 10;

    // Deduct for low volume
    const avgVolume = context.avgVolume || 0;
    if (avgVolume < 1000000) score -= 15;
    else if (avgVolume < 2000000) score -= 5;

    // Deduct for low OI
    const openInterest = context.openInterest || 0;
    if (openInterest < 5000) score -= 15;
    else if (openInterest < 10000) score -= 5;

    // Deduct for near earnings (even if not in full blackout)
    const earningsDate = this.earningsCalendar.get(signal.underlyingTicker);
    if (earningsDate) {
      const today = new Date(marketHours.getTodayString());
      const earnings = new Date(earningsDate);
      const daysUntilEarnings = Math.ceil((earnings - today) / (1000 * 60 * 60 * 24));
      if (daysUntilEarnings > 0 && daysUntilEarnings <= 7) {
        score -= 10;
      }
    }

    // Bonus for being in OTM sweet spot
    if (this.isInOTMRange(signal.strike, spotPrice, signal.optionType)) {
      score += 10;
    }

    // Bonus for short-dated
    if (this.isVeryShortDated(signal.expiration)) {
      score += 10;
    }

    return Math.max(0, Math.min(100, score));
  }

  // Get filter summary
  getSummary() {
    return {
      ignoredTickers: config.ignoredTickers.length,
      trackedEarnings: this.earningsCalendar.size,
      volumeCacheSize: this.volumeCache.size,
      oiCacheSize: this.openInterestCache.size
    };
  }
}

// Export singleton instance
module.exports = new SignalFilters();
