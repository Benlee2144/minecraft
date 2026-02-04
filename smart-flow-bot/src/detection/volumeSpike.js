const config = require('../../config');
const logger = require('../utils/logger');
const marketHours = require('../utils/marketHours');
const database = require('../database/sqlite');

class VolumeSpikeDetector {
  constructor() {
    // In-memory tracking of today's volume per ticker
    this.todayVolume = new Map();
    this.volumeBaselines = new Map();
    this.lastUpdate = new Map();
  }

  // Initialize with volume baselines from database
  initialize() {
    const baselines = database.getAllVolumeBaselines();
    for (const { ticker, avg_daily_volume } of baselines) {
      this.volumeBaselines.set(ticker, avg_daily_volume);
    }
    logger.info(`Loaded ${this.volumeBaselines.size} volume baselines`);
  }

  // Set volume baseline for a ticker
  setBaseline(ticker, avgVolume) {
    this.volumeBaselines.set(ticker, avgVolume);
    database.saveVolumeBaseline(ticker, avgVolume);
  }

  // Update current day's volume from aggregate data
  updateVolume(ticker, volume) {
    const current = this.todayVolume.get(ticker) || 0;
    this.todayVolume.set(ticker, current + volume);
    this.lastUpdate.set(ticker, Date.now());
  }

  // Set absolute volume (from snapshot)
  setVolume(ticker, volume) {
    this.todayVolume.set(ticker, volume);
    this.lastUpdate.set(ticker, Date.now());
  }

  // Get current volume for ticker
  getCurrentVolume(ticker) {
    return this.todayVolume.get(ticker) || 0;
  }

  // Get baseline volume for ticker
  getBaseline(ticker) {
    return this.volumeBaselines.get(ticker) || 0;
  }

  // Calculate expected volume at current time of day
  getExpectedVolumeAtTime(ticker) {
    const baseline = this.getBaseline(ticker);
    if (!baseline) return 0;

    const minutesSinceOpen = marketHours.getMinutesSinceOpen();
    if (minutesSinceOpen < 0) return baseline;

    // Market is open 390 minutes (9:30 - 4:00)
    const totalMinutes = 390;
    const dayProgress = Math.min(minutesSinceOpen / totalMinutes, 1);

    // Volume is not linear - more volume at open and close
    // Use a U-shaped curve approximation
    const volumeMultiplier = this.getVolumeDistribution(dayProgress);

    return baseline * volumeMultiplier;
  }

  // Approximate volume distribution throughout the day
  // Returns what percentage of daily volume should have occurred by this point
  getVolumeDistribution(dayProgress) {
    // First 30 min: ~15% of volume
    // Middle of day: ~50% of volume
    // Last 30 min: ~15% of volume

    if (dayProgress <= 0.077) { // First 30 min
      return dayProgress * 2; // Higher rate
    } else if (dayProgress >= 0.923) { // Last 30 min
      return 0.85 + (dayProgress - 0.923) * 2;
    } else {
      // Middle of day - linear progression for the bulk
      return 0.15 + (dayProgress - 0.077) * 0.7 / 0.846;
    }
  }

  // Detect volume spike
  detectSpike(ticker) {
    const currentVolume = this.getCurrentVolume(ticker);
    const expectedVolume = this.getExpectedVolumeAtTime(ticker);

    if (expectedVolume === 0) {
      return null;
    }

    const volumeMultiple = currentVolume / expectedVolume;
    const threshold = config.detection.volumeSpikeMultiplier;

    if (volumeMultiple >= threshold) {
      return {
        ticker,
        currentVolume,
        expectedVolume,
        volumeMultiple: parseFloat(volumeMultiple.toFixed(2)),
        isSpike: true,
        severity: this.getSeverity(volumeMultiple)
      };
    }

    return null;
  }

  // Get severity level based on volume multiple
  getSeverity(volumeMultiple) {
    if (volumeMultiple >= 10) return 'extreme';
    if (volumeMultiple >= 5) return 'very_high';
    if (volumeMultiple >= 3) return 'high';
    return 'moderate';
  }

  // Check if we're in the opening window (first 60 minutes)
  isInOpeningWindow() {
    return marketHours.isInOpeningWindow(config.detection.volumeWindowMinutes);
  }

  // Get all tickers with volume spikes
  getAllSpikes() {
    const spikes = [];

    for (const ticker of this.todayVolume.keys()) {
      const spike = this.detectSpike(ticker);
      if (spike) {
        spikes.push(spike);
      }
    }

    return spikes.sort((a, b) => b.volumeMultiple - a.volumeMultiple);
  }

  // Reset daily tracking (call at market open)
  resetDaily() {
    this.todayVolume.clear();
    this.lastUpdate.clear();
    logger.info('Volume tracking reset for new trading day');
  }

  // Get summary for a ticker
  getSummary(ticker) {
    const currentVolume = this.getCurrentVolume(ticker);
    const baseline = this.getBaseline(ticker);
    const expectedVolume = this.getExpectedVolumeAtTime(ticker);
    const spike = this.detectSpike(ticker);

    return {
      ticker,
      currentVolume,
      baseline,
      expectedVolume,
      percentOfExpected: expectedVolume > 0 ?
        parseFloat(((currentVolume / expectedVolume) * 100).toFixed(1)) : 0,
      percentOfDaily: baseline > 0 ?
        parseFloat(((currentVolume / baseline) * 100).toFixed(1)) : 0,
      isSpike: spike?.isSpike || false,
      spikeMultiple: spike?.volumeMultiple || null
    };
  }
}

// Export singleton instance
module.exports = new VolumeSpikeDetector();
