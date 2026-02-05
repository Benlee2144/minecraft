const logger = require('../utils/logger');
const marketHours = require('../utils/marketHours');
const earnings = require('../utils/earnings');
const spyCorrelation = require('./spyCorrelation');
const sectorHeatMap = require('./sectorHeatMap');
const keyLevels = require('./keyLevels');

class TradeRecommendation {
  constructor() {
    // Confidence thresholds
    this.STRONG_BUY = 85;
    this.BUY = 70;
    this.LEAN_BULLISH = 55;
    this.NEUTRAL = 45;
    this.LEAN_BEARISH = 35;
    this.SELL = 25;

    // Default option parameters
    this.defaultDTE = 7;  // 7 days to expiration
    this.defaultOTMPercent = 0.03; // 3% out of the money
  }

  // Main entry point - analyze all data and generate recommendation
  generateRecommendation(signalData) {
    const {
      ticker,
      price,
      heatScore,
      signalType,
      volumeMultiplier,
      priceChange,
      signalBreakdown
    } = signalData;

    // Start with base score from heat score
    let confidenceScore = heatScore;
    const factors = [];
    const warnings = [];

    // 1. Market phase adjustment
    const phase = marketHours.getTradingPhase();
    if (phase.phase === 'opening_drive') {
      confidenceScore += 5;
      factors.push('Opening drive momentum');
    } else if (phase.phase === 'power_hour') {
      confidenceScore += 5;
      factors.push('Power hour volume');
    } else if (phase.phase === 'midday') {
      confidenceScore -= 10;
      warnings.push('Midday chop - higher false signal risk');
    }

    // 2. SPY alignment check
    const spyAlignment = spyCorrelation.isAlignedWithSpy(
      priceChange > 0 ? 'bullish' : 'bearish'
    );
    if (spyAlignment.aligned) {
      confidenceScore += 10;
      factors.push(`SPY aligned (${spyCorrelation.getDirection()})`);
    } else if (spyAlignment.contrary) {
      confidenceScore -= 5;
      warnings.push(`Moving against SPY trend`);
    }

    // 3. Sector strength
    const sector = sectorHeatMap.getSectorForTicker(ticker);
    if (sector) {
      const sectorStrength = sectorHeatMap.getSectorStrength(sector);
      if (sectorStrength) {
        if (sectorStrength.isHot && priceChange > 0) {
          confidenceScore += 8;
          factors.push(`Strong sector (${sector} ${sectorStrength.change > 0 ? '+' : ''}${sectorStrength.change.toFixed(2)}%)`);
        } else if (sectorStrength.isCold && priceChange < 0) {
          confidenceScore += 5;
          factors.push(`Weak sector confirms (${sector})`);
        } else if (sectorStrength.isCold && priceChange > 0) {
          warnings.push(`Against weak sector trend`);
          confidenceScore -= 5;
        }
      }
    }

    // 4. Key levels analysis
    const levelContext = keyLevels.getContext(ticker, price);
    if (levelContext.nearLevel) {
      if (levelContext.levelType === 'support' && priceChange > 0) {
        confidenceScore += 7;
        factors.push(`Bouncing off ${levelContext.levelName}`);
      } else if (levelContext.levelType === 'resistance' && priceChange > 0) {
        if (levelContext.breaking) {
          confidenceScore += 10;
          factors.push(`Breaking ${levelContext.levelName}`);
        } else {
          warnings.push(`Near resistance at ${levelContext.levelName}`);
        }
      }
    }

    // 5. Earnings proximity check
    const earningsWarning = earnings.getEarningsWarning(ticker);
    if (earningsWarning) {
      const upcoming = earnings.hasUpcomingEarnings(ticker);
      if (upcoming && upcoming.daysAway <= 1) {
        confidenceScore -= 15;
        warnings.push('Earnings imminent - extreme risk');
      } else if (upcoming && upcoming.daysAway <= 3) {
        confidenceScore -= 8;
        warnings.push(`Earnings in ${upcoming.daysAway} days`);
      }
    }

    // 6. Volume confirmation
    if (volumeMultiplier >= 5) {
      confidenceScore += 10;
      factors.push(`Extreme volume (${volumeMultiplier.toFixed(1)}x)`);
    } else if (volumeMultiplier >= 3) {
      confidenceScore += 5;
      factors.push(`Strong volume (${volumeMultiplier.toFixed(1)}x)`);
    }

    // 7. Signal type bonus
    if (signalType === 'BREAKOUT') {
      confidenceScore += 5;
      factors.push('Breakout pattern');
    } else if (signalType === 'BLOCK_TRADE') {
      confidenceScore += 7;
      factors.push('Institutional block trade');
    }

    // Cap confidence at 100
    confidenceScore = Math.min(100, Math.max(0, confidenceScore));

    // Determine direction
    const isBullish = priceChange > 0;

    // Generate recommendation
    const recommendation = this.getRecommendation(confidenceScore, isBullish, warnings.length);

    // Calculate option strike suggestion
    const optionSuggestion = this.suggestOption(price, isBullish, confidenceScore);

    // Calculate targets and stops
    const { target, stopLoss } = this.calculateTargets(price, isBullish, confidenceScore);

    return {
      ticker,
      recommendation,
      confidenceScore,
      direction: isBullish ? 'BULLISH' : 'BEARISH',
      factors,
      warnings,
      optionSuggestion,
      targets: {
        entry: price,
        target,
        stopLoss,
        riskReward: ((target - price) / (price - stopLoss)).toFixed(2)
      },
      timestamp: new Date().toISOString()
    };
  }

  // Get recommendation text based on confidence
  getRecommendation(score, isBullish, warningCount) {
    // Reduce confidence if many warnings
    const adjustedScore = score - (warningCount * 5);

    if (adjustedScore >= this.STRONG_BUY) {
      return {
        action: isBullish ? 'STRONG BUY CALLS' : 'STRONG BUY PUTS',
        emoji: '🔥',
        confidence: 'HIGH',
        message: isBullish
          ? 'Multiple bullish signals aligning - high conviction entry'
          : 'Multiple bearish signals aligning - high conviction entry'
      };
    } else if (adjustedScore >= this.BUY) {
      return {
        action: isBullish ? 'BUY CALLS' : 'BUY PUTS',
        emoji: '✅',
        confidence: 'MEDIUM-HIGH',
        message: isBullish
          ? 'Bullish setup with good confirmation'
          : 'Bearish setup with good confirmation'
      };
    } else if (adjustedScore >= this.LEAN_BULLISH) {
      return {
        action: isBullish ? 'LEAN BULLISH' : 'LEAN BEARISH',
        emoji: '🔸',
        confidence: 'MEDIUM',
        message: 'Setup developing - wait for more confirmation or use smaller size'
      };
    } else if (adjustedScore >= this.NEUTRAL) {
      return {
        action: 'WATCH',
        emoji: '👀',
        confidence: 'LOW',
        message: 'Mixed signals - not a clear trade setup'
      };
    } else {
      return {
        action: 'AVOID',
        emoji: '⚠️',
        confidence: 'VERY LOW',
        message: 'Conflicting signals or high risk - avoid this trade'
      };
    }
  }

  // Suggest option parameters
  suggestOption(price, isBullish, confidence) {
    // Higher confidence = can go slightly more OTM for better leverage
    let otmPercent = this.defaultOTMPercent;
    let dte = this.defaultDTE;

    if (confidence >= 85) {
      otmPercent = 0.04; // 4% OTM for high confidence
      dte = 5;
    } else if (confidence >= 70) {
      otmPercent = 0.03; // 3% OTM
      dte = 7;
    } else {
      otmPercent = 0.02; // 2% OTM for lower confidence (more conservative)
      dte = 10;
    }

    const strike = isBullish
      ? Math.ceil((price * (1 + otmPercent)) / 0.5) * 0.5  // Round up to nearest 0.50
      : Math.floor((price * (1 - otmPercent)) / 0.5) * 0.5; // Round down

    const optionType = isBullish ? 'CALL' : 'PUT';

    // Calculate suggested expiration
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + dte);
    // Skip to Friday if needed
    while (expDate.getDay() !== 5) {
      expDate.setDate(expDate.getDate() + 1);
    }
    const expStr = expDate.toISOString().split('T')[0];

    return {
      type: optionType,
      strike,
      expiration: expStr,
      dte,
      description: `${strike} ${optionType} ${expStr}`
    };
  }

  // Calculate profit targets and stop loss
  calculateTargets(price, isBullish, confidence) {
    // Higher confidence = wider targets
    let targetPercent, stopPercent;

    if (confidence >= 85) {
      targetPercent = 0.03;  // 3% target
      stopPercent = 0.015;   // 1.5% stop (2:1 ratio)
    } else if (confidence >= 70) {
      targetPercent = 0.025; // 2.5% target
      stopPercent = 0.015;   // 1.5% stop
    } else {
      targetPercent = 0.02;  // 2% target
      stopPercent = 0.015;   // 1.5% stop (tighter for lower confidence)
    }

    if (isBullish) {
      return {
        target: Number((price * (1 + targetPercent)).toFixed(2)),
        stopLoss: Number((price * (1 - stopPercent)).toFixed(2))
      };
    } else {
      return {
        target: Number((price * (1 - targetPercent)).toFixed(2)),
        stopLoss: Number((price * (1 + stopPercent)).toFixed(2))
      };
    }
  }

  // Format recommendation for Discord
  formatForDiscord(rec) {
    const lines = [];

    // Header
    lines.push(`\n**${rec.recommendation.emoji} ${rec.recommendation.action}** | Confidence: ${rec.confidenceScore}/100 (${rec.recommendation.confidence})`);

    // Option suggestion
    if (rec.optionSuggestion) {
      lines.push(`**Option:** ${rec.optionSuggestion.description}`);
    }

    // Targets
    lines.push(`**Entry:** $${rec.targets.entry.toFixed(2)} | **Target:** $${rec.targets.target.toFixed(2)} | **Stop:** $${rec.targets.stopLoss.toFixed(2)}`);
    lines.push(`**Risk/Reward:** ${rec.targets.riskReward}:1`);

    // Supporting factors
    if (rec.factors.length > 0) {
      lines.push(`**Bullish Factors:** ${rec.factors.join(', ')}`);
    }

    // Warnings
    if (rec.warnings.length > 0) {
      lines.push(`**Caution:** ${rec.warnings.join(' | ')}`);
    }

    // Bot's opinion
    lines.push(`\n*${rec.recommendation.message}*`);

    return lines.join('\n');
  }

  // Quick analysis without full recommendation
  quickAnalysis(ticker, price, priceChange) {
    const factors = [];
    const warnings = [];
    let score = 50; // Start neutral

    // SPY check
    const spyDir = spyCorrelation.getDirection();
    const isBullish = priceChange > 0;
    if ((spyDir === 'bullish' && isBullish) || (spyDir === 'bearish' && !isBullish)) {
      score += 10;
      factors.push('SPY aligned');
    }

    // Sector check
    const sector = sectorHeatMap.getSectorForTicker(ticker);
    if (sector) {
      const heat = sectorHeatMap.getSectorStrength(sector);
      if (heat && heat.isHot && isBullish) {
        score += 5;
        factors.push('Hot sector');
      }
    }

    // Earnings check
    if (earnings.hasUpcomingEarnings(ticker, 3)) {
      score -= 10;
      warnings.push('Near earnings');
    }

    // Market phase
    const phase = marketHours.getTradingPhase();
    if (phase.phase === 'midday') {
      warnings.push('Midday chop');
    }

    return {
      ticker,
      score,
      factors,
      warnings,
      tradeable: score >= 60 && warnings.length < 2
    };
  }
}

// Export singleton
module.exports = new TradeRecommendation();
