const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');

class KeyLevels {
  constructor() {
    // Store key levels per ticker
    this.levels = new Map();
    // Track which levels have been alerted (to avoid spam)
    this.alertedLevels = new Map();
  }

  // Set levels for a ticker
  setLevels(ticker, levels) {
    this.levels.set(ticker.toUpperCase(), {
      ...levels,
      updatedAt: Date.now()
    });
  }

  // Get levels for a ticker
  getLevels(ticker) {
    return this.levels.get(ticker.toUpperCase());
  }

  // Calculate key levels from snapshot data
  calculateLevels(ticker, snapshot, previousClose) {
    const levels = {
      ticker: ticker.toUpperCase(),
      // Previous Day High/Low (PDH/PDL)
      pdh: previousClose?.high || null,
      pdl: previousClose?.low || null,
      pdc: previousClose?.close || null,
      // Pre-Market High/Low (PMH/PML) - from today's open
      pmh: snapshot?.high || null,
      pml: snapshot?.low || null,
      // VWAP
      vwap: snapshot?.vwap || null,
      // Current price for reference
      currentPrice: snapshot?.price || null,
      // Round numbers near current price
      roundLevels: this.calculateRoundLevels(snapshot?.price)
    };

    this.setLevels(ticker, levels);
    return levels;
  }

  // Calculate significant round numbers near a price
  calculateRoundLevels(price) {
    if (!price) return [];

    const rounds = [];

    // Determine the significant round number intervals based on price
    let interval;
    if (price < 20) {
      interval = 1; // $1 levels for cheap stocks
    } else if (price < 50) {
      interval = 5; // $5 levels
    } else if (price < 200) {
      interval = 10; // $10 levels
    } else if (price < 500) {
      interval = 25; // $25 levels
    } else {
      interval = 50; // $50 levels for expensive stocks
    }

    // Find rounds above and below current price
    const lowerRound = Math.floor(price / interval) * interval;
    const upperRound = Math.ceil(price / interval) * interval;

    // Include 2 levels above and below
    for (let i = -2; i <= 2; i++) {
      const level = lowerRound + (i * interval);
      if (level > 0 && Math.abs(level - price) / price < 0.1) { // Within 10%
        rounds.push({
          price: level,
          distance: ((level - price) / price * 100).toFixed(2),
          type: level === lowerRound || level === upperRound ? 'major' : 'minor'
        });
      }
    }

    return rounds.sort((a, b) => a.price - b.price);
  }

  // Check if price is breaking a key level
  checkLevelBreak(ticker, currentPrice, previousPrice) {
    const levels = this.getLevels(ticker);
    if (!levels || !currentPrice || !previousPrice) return [];

    const breaks = [];
    const threshold = 0.001; // 0.1% threshold for level break

    // Check PDH break
    if (levels.pdh) {
      if (previousPrice < levels.pdh && currentPrice >= levels.pdh * (1 - threshold)) {
        breaks.push({
          type: 'pdh_break',
          level: levels.pdh,
          direction: 'up',
          label: 'Previous Day High',
          emoji: '🔺',
          significance: 'high'
        });
      }
    }

    // Check PDL break
    if (levels.pdl) {
      if (previousPrice > levels.pdl && currentPrice <= levels.pdl * (1 + threshold)) {
        breaks.push({
          type: 'pdl_break',
          level: levels.pdl,
          direction: 'down',
          label: 'Previous Day Low',
          emoji: '🔻',
          significance: 'high'
        });
      }
    }

    // Check VWAP reclaim/rejection
    if (levels.vwap) {
      if (previousPrice < levels.vwap && currentPrice >= levels.vwap) {
        breaks.push({
          type: 'vwap_reclaim',
          level: levels.vwap,
          direction: 'up',
          label: 'VWAP Reclaim',
          emoji: '📈',
          significance: 'medium'
        });
      } else if (previousPrice > levels.vwap && currentPrice <= levels.vwap) {
        breaks.push({
          type: 'vwap_rejection',
          level: levels.vwap,
          direction: 'down',
          label: 'VWAP Rejection',
          emoji: '📉',
          significance: 'medium'
        });
      }
    }

    // Check round number breaks
    for (const round of levels.roundLevels || []) {
      if (round.type === 'major') {
        if (previousPrice < round.price && currentPrice >= round.price) {
          breaks.push({
            type: 'round_break',
            level: round.price,
            direction: 'up',
            label: `$${round.price} Break`,
            emoji: '💫',
            significance: 'medium'
          });
        } else if (previousPrice > round.price && currentPrice <= round.price) {
          breaks.push({
            type: 'round_break',
            level: round.price,
            direction: 'down',
            label: `$${round.price} Break`,
            emoji: '💫',
            significance: 'medium'
          });
        }
      }
    }

    // Filter out already-alerted levels (prevent spam)
    const newBreaks = breaks.filter(b => {
      const key = `${ticker}-${b.type}-${b.level}`;
      const lastAlert = this.alertedLevels.get(key);
      if (lastAlert && Date.now() - lastAlert < 300000) { // 5 min cooldown
        return false;
      }
      this.alertedLevels.set(key, Date.now());
      return true;
    });

    return newBreaks;
  }

  // Get proximity to key levels (for display)
  getProximityInfo(ticker, currentPrice) {
    const levels = this.getLevels(ticker);
    if (!levels || !currentPrice) return null;

    const proximity = [];

    // Check distance to each level
    if (levels.pdh) {
      const dist = ((levels.pdh - currentPrice) / currentPrice * 100);
      if (Math.abs(dist) < 3) { // Within 3%
        proximity.push({
          level: 'PDH',
          price: levels.pdh,
          distance: dist.toFixed(2),
          direction: dist > 0 ? 'above' : 'below'
        });
      }
    }

    if (levels.pdl) {
      const dist = ((levels.pdl - currentPrice) / currentPrice * 100);
      if (Math.abs(dist) < 3) {
        proximity.push({
          level: 'PDL',
          price: levels.pdl,
          distance: dist.toFixed(2),
          direction: dist > 0 ? 'above' : 'below'
        });
      }
    }

    if (levels.vwap) {
      const dist = ((levels.vwap - currentPrice) / currentPrice * 100);
      if (Math.abs(dist) < 2) {
        proximity.push({
          level: 'VWAP',
          price: levels.vwap,
          distance: dist.toFixed(2),
          direction: dist > 0 ? 'above' : 'below'
        });
      }
    }

    return proximity;
  }

  // Get context for trade recommendation (support/resistance analysis)
  getContext(ticker, price) {
    const levels = this.getLevels(ticker);
    if (!levels || !price) return null;

    const context = {
      nearLevel: false,
      levelType: null,
      levelName: null,
      levelPrice: null,
      distancePercent: null,
      breaking: false
    };

    // Check PDH (resistance)
    if (levels.pdh) {
      const dist = ((price - levels.pdh) / levels.pdh) * 100;
      if (Math.abs(dist) < 2) {
        context.nearLevel = true;
        context.levelType = 'resistance';
        context.levelName = 'PDH';
        context.levelPrice = levels.pdh;
        context.distancePercent = dist;
        context.breaking = dist > 0;
      }
    }

    // Check PDL (support)
    if (levels.pdl && !context.nearLevel) {
      const dist = ((price - levels.pdl) / levels.pdl) * 100;
      if (Math.abs(dist) < 2) {
        context.nearLevel = true;
        context.levelType = 'support';
        context.levelName = 'PDL';
        context.levelPrice = levels.pdl;
        context.distancePercent = dist;
        context.breaking = dist < 0;
      }
    }

    // Check VWAP
    if (levels.vwap && !context.nearLevel) {
      const dist = ((price - levels.vwap) / levels.vwap) * 100;
      if (Math.abs(dist) < 1.5) {
        context.nearLevel = true;
        context.levelType = price > levels.vwap ? 'support' : 'resistance';
        context.levelName = 'VWAP';
        context.levelPrice = levels.vwap;
        context.distancePercent = dist;
        context.breaking = false;
      }
    }

    return context.nearLevel ? context : null;
  }

  // Format levels for display in alerts
  formatLevelsForAlert(ticker) {
    const levels = this.getLevels(ticker);
    if (!levels) return null;

    const lines = [];
    if (levels.pdh) lines.push(`PDH: $${levels.pdh.toFixed(2)}`);
    if (levels.pdl) lines.push(`PDL: $${levels.pdl.toFixed(2)}`);
    if (levels.vwap) lines.push(`VWAP: $${levels.vwap.toFixed(2)}`);

    return lines.length > 0 ? lines.join(' | ') : null;
  }

  // Clean old alerted levels
  cleanOldAlerts() {
    const now = Date.now();
    for (const [key, time] of this.alertedLevels) {
      if (now - time > 3600000) { // 1 hour
        this.alertedLevels.delete(key);
      }
    }
  }
}

// Export singleton
module.exports = new KeyLevels();
