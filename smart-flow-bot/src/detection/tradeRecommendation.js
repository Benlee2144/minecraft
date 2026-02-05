const logger = require('../utils/logger');
const marketHours = require('../utils/marketHours');
const earnings = require('../utils/earnings');
const spyCorrelation = require('./spyCorrelation');
const sectorHeatMap = require('./sectorHeatMap');
const keyLevels = require('./keyLevels');

class TradeRecommendation {
  constructor() {
    // Confidence thresholds - aggressive for day trading
    this.FIRE_ALERT = 90;      // 🔥🔥🔥 ENTER NOW
    this.STRONG_BUY = 80;      // 🔥 STRONG ENTRY
    this.BUY = 70;             // ✅ GOOD ENTRY
    this.LEAN = 60;            // 🔸 WAIT FOR CONFIRMATION
    this.WATCH = 50;           // 👀 MONITOR ONLY
    this.AVOID = 0;            // ⛔ DO NOT TRADE

    // Position sizing
    this.POSITION_SIZE = 2000; // $2000 per trade

    // Option leverage estimates (delta-based)
    // Slightly OTM options typically have delta 0.30-0.50
    // A 1% move in underlying = ~2-4% option move
    this.OPTION_LEVERAGE = 3.5; // Conservative estimate
  }

  // Main entry point - generate full trade recommendation
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

    let confidenceScore = heatScore;
    const factors = [];
    const warnings = [];
    const tradingContext = {};

    // ============ TIMING ANALYSIS ============
    const phase = marketHours.getTradingPhase();
    tradingContext.phase = phase;

    // Best times to trade: Opening Drive and Power Hour
    if (phase.phase === 'opening_drive') {
      confidenceScore += 10;
      factors.push('🔥 OPENING DRIVE - Prime entry window');
    } else if (phase.phase === 'power_hour') {
      confidenceScore += 10;
      factors.push('⚡ POWER HOUR - Institutional flow');
    } else if (phase.phase === 'morning') {
      confidenceScore += 3;
      factors.push('Morning trend establishment');
    } else if (phase.phase === 'midday') {
      confidenceScore -= 15;
      warnings.push('⚠️ MIDDAY CHOP - High false signal risk, reduce size or skip');
    } else if (phase.phase === 'afternoon') {
      confidenceScore += 5;
      factors.push('Afternoon momentum building');
    }

    // ============ SPY/MARKET ALIGNMENT ============
    const spyContext = spyCorrelation.getSPYContext();
    const isBullish = priceChange > 0;

    if (spyContext.available) {
      tradingContext.spy = spyContext;
      const spyDir = spyContext.direction;

      // Aligned with market = much higher probability
      if ((spyDir === 'bullish' && isBullish) || (spyDir === 'bearish' && !isBullish)) {
        confidenceScore += 15;
        factors.push(`✅ SPY ALIGNED (${spyDir.toUpperCase()} ${spyContext.change > 0 ? '+' : ''}${spyContext.change}%)`);
      }
      // Counter-trend = relative strength play (risky but can work)
      else if (spyDir === 'bullish' && !isBullish) {
        confidenceScore -= 10;
        warnings.push('Moving against bullish market - needs extra confirmation');
      } else if (spyDir === 'bearish' && isBullish) {
        // Bullish stock in bearish market = relative strength
        if (Math.abs(priceChange) > Math.abs(spyContext.change) * 2) {
          confidenceScore += 5;
          factors.push('💪 RELATIVE STRENGTH - Outperforming weak market');
        } else {
          confidenceScore -= 8;
          warnings.push('Fighting bearish tape');
        }
      }
    }

    // ============ SECTOR ANALYSIS ============
    const sector = sectorHeatMap.getSectorForTicker(ticker);
    if (sector) {
      const sectorData = sectorHeatMap.getSectorStrength(sector);
      if (sectorData) {
        tradingContext.sector = { name: sector, ...sectorData };

        // Trading with hot sector = high probability
        if (sectorData.isHot && isBullish) {
          confidenceScore += 12;
          factors.push(`🔥 HOT SECTOR (${sector} +${sectorData.change.toFixed(2)}%)`);
        } else if (sectorData.isCold && !isBullish) {
          confidenceScore += 8;
          factors.push(`❄️ Weak sector confirms short (${sector})`);
        }
        // Counter-sector moves are dangerous
        else if (sectorData.isCold && isBullish) {
          confidenceScore -= 12;
          warnings.push(`⚠️ AGAINST SECTOR - ${sector} is weak today`);
        } else if (sectorData.isHot && !isBullish) {
          confidenceScore -= 10;
          warnings.push(`⚠️ Shorting hot sector - risky`);
        }
      }
    }

    // ============ KEY LEVELS ANALYSIS ============
    const levelContext = keyLevels.getContext(ticker, price);
    if (levelContext) {
      tradingContext.levels = levelContext;

      if (levelContext.nearLevel) {
        if (levelContext.levelType === 'support' && isBullish) {
          confidenceScore += 10;
          factors.push(`📈 BOUNCING OFF ${levelContext.levelName}`);
        } else if (levelContext.levelType === 'resistance' && isBullish) {
          if (levelContext.breaking) {
            confidenceScore += 15;
            factors.push(`🚀 BREAKING ${levelContext.levelName} - Breakout entry!`);
          } else {
            warnings.push(`Near resistance ${levelContext.levelName} - watch for rejection`);
          }
        } else if (levelContext.levelType === 'support' && !isBullish) {
          if (levelContext.breaking) {
            confidenceScore += 12;
            factors.push(`📉 BREAKING ${levelContext.levelName} - Breakdown entry!`);
          }
        }
      }
    }

    // ============ VOLUME ANALYSIS ============
    if (volumeMultiplier >= 7) {
      confidenceScore += 15;
      factors.push(`🐋 MONSTER VOLUME (${volumeMultiplier.toFixed(1)}x) - Institutional activity`);
    } else if (volumeMultiplier >= 5) {
      confidenceScore += 12;
      factors.push(`📊 EXTREME VOLUME (${volumeMultiplier.toFixed(1)}x)`);
    } else if (volumeMultiplier >= 3) {
      confidenceScore += 7;
      factors.push(`Volume spike (${volumeMultiplier.toFixed(1)}x)`);
    } else if (volumeMultiplier < 2) {
      confidenceScore -= 5;
      warnings.push('Low volume - less conviction');
    }

    // ============ SIGNAL TYPE BONUS ============
    if (signalType === 'breakout' || signalType === 'level_break') {
      confidenceScore += 8;
      factors.push('Breakout pattern detected');
    } else if (signalType === 'block_trade') {
      confidenceScore += 10;
      factors.push('🐋 Block trade - institutional buying');
    } else if (signalType === 'momentum_surge') {
      confidenceScore += 5;
      factors.push('Momentum accelerating');
    }

    // ============ EARNINGS CHECK ============
    const upcomingEarnings = earnings.hasUpcomingEarnings(ticker);
    if (upcomingEarnings) {
      if (upcomingEarnings.daysAway === 0) {
        confidenceScore -= 25;
        warnings.push('🚨 EARNINGS TODAY - EXTREME IV, avoid options');
      } else if (upcomingEarnings.daysAway === 1) {
        confidenceScore -= 15;
        warnings.push('⚠️ Earnings tomorrow - high IV crush risk');
      } else if (upcomingEarnings.daysAway <= 3) {
        confidenceScore -= 8;
        warnings.push(`Earnings in ${upcomingEarnings.daysAway} days`);
      }
    }

    // ============ MULTI-SIGNAL BONUS ============
    // If we have 3+ factors, this is a high-probability setup
    if (factors.length >= 4) {
      confidenceScore += 10;
      factors.unshift('🎯 MULTI-SIGNAL CONFLUENCE');
    } else if (factors.length >= 3) {
      confidenceScore += 5;
    }

    // Cap confidence
    confidenceScore = Math.min(100, Math.max(0, confidenceScore));

    // ============ GENERATE RECOMMENDATION ============
    const recommendation = this.getRecommendation(confidenceScore, isBullish, warnings.length);
    const optionSuggestion = this.suggestOption(price, isBullish, confidenceScore);
    const { target, stopLoss, partialTarget } = this.calculateTargets(price, isBullish, confidenceScore);

    // Calculate expected option P&L
    const optionPnL = this.calculateExpectedOptionPnL(price, target, stopLoss, isBullish);

    return {
      ticker,
      recommendation,
      confidenceScore,
      direction: isBullish ? 'BULLISH' : 'BEARISH',
      urgency: this.getUrgency(confidenceScore, phase.phase),
      factors,
      warnings,
      optionSuggestion,
      optionPnL,
      targets: {
        entry: price,
        partialTarget, // First target to take partial profits
        target,        // Full target
        stopLoss,
        riskReward: Math.abs((target - price) / (price - stopLoss)).toFixed(2)
      },
      tradingContext,
      positionSize: this.POSITION_SIZE,
      timestamp: new Date().toISOString()
    };
  }

  // Get recommendation with urgency level
  getRecommendation(score, isBullish, warningCount) {
    const adjustedScore = score - (warningCount * 3);
    const direction = isBullish ? 'CALLS' : 'PUTS';
    const dirWord = isBullish ? 'BULLISH' : 'BEARISH';

    if (adjustedScore >= this.FIRE_ALERT) {
      return {
        action: `🔥🔥🔥 ENTER NOW - BUY ${direction}`,
        shortAction: `BUY ${direction}`,
        emoji: '🔥',
        confidence: 'VERY HIGH',
        urgency: 'IMMEDIATE',
        message: `FIRE ALERT! Multiple signals aligning perfectly. This is a high-probability ${dirWord} setup. Enter with full size ($${this.POSITION_SIZE}).`
      };
    } else if (adjustedScore >= this.STRONG_BUY) {
      return {
        action: `🔥 STRONG ENTRY - BUY ${direction}`,
        shortAction: `BUY ${direction}`,
        emoji: '🔥',
        confidence: 'HIGH',
        urgency: 'SOON',
        message: `Strong ${dirWord} setup with good confirmation. Enter with 75-100% size.`
      };
    } else if (adjustedScore >= this.BUY) {
      return {
        action: `✅ GOOD ENTRY - BUY ${direction}`,
        shortAction: `BUY ${direction}`,
        emoji: '✅',
        confidence: 'MEDIUM-HIGH',
        urgency: 'WHEN READY',
        message: `Solid ${dirWord} setup. Enter with 50-75% size, leave room to add.`
      };
    } else if (adjustedScore >= this.LEAN) {
      return {
        action: `🔸 DEVELOPING - WAIT TO BUY ${direction}`,
        shortAction: `WATCH ${direction}`,
        emoji: '🔸',
        confidence: 'MEDIUM',
        urgency: 'WAIT',
        message: `Setup developing. Wait for more confirmation or use reduced size (25-50%).`
      };
    } else if (adjustedScore >= this.WATCH) {
      return {
        action: '👀 MONITOR ONLY',
        shortAction: 'WATCH',
        emoji: '👀',
        confidence: 'LOW',
        urgency: 'NO TRADE',
        message: 'Mixed signals. Add to watchlist but do not enter.'
      };
    } else {
      return {
        action: '⛔ DO NOT TRADE',
        shortAction: 'AVOID',
        emoji: '⛔',
        confidence: 'VERY LOW',
        urgency: 'SKIP',
        message: 'Poor setup or high risk. Skip this trade.'
      };
    }
  }

  // Get urgency text for time-sensitive alerts
  getUrgency(score, phase) {
    if (score >= 90 && (phase === 'opening_drive' || phase === 'power_hour')) {
      return '⚡ ENTER IMMEDIATELY';
    } else if (score >= 85) {
      return '🚨 ENTER WITHIN 5 MINUTES';
    } else if (score >= 75) {
      return '⏰ ENTER WHEN READY';
    } else if (score >= 65) {
      return '👀 WAIT FOR CONFIRMATION';
    }
    return '📋 MONITOR ONLY';
  }

  // Suggest option with more detail
  suggestOption(price, isBullish, confidence) {
    // Higher confidence = can go more aggressive (more OTM, shorter DTE)
    let otmPercent, dte, contractQty;

    if (confidence >= 90) {
      otmPercent = 0.03;   // 3% OTM - aggressive
      dte = 3;             // 3 days - aggressive
      contractQty = Math.floor(this.POSITION_SIZE / (price * 0.02 * 100)); // ~2% of price per contract
    } else if (confidence >= 80) {
      otmPercent = 0.025;  // 2.5% OTM
      dte = 5;
      contractQty = Math.floor(this.POSITION_SIZE / (price * 0.025 * 100));
    } else if (confidence >= 70) {
      otmPercent = 0.02;   // 2% OTM - standard
      dte = 7;
      contractQty = Math.floor(this.POSITION_SIZE / (price * 0.03 * 100));
    } else {
      otmPercent = 0.015;  // 1.5% OTM - conservative (more ITM)
      dte = 10;
      contractQty = Math.floor(this.POSITION_SIZE / (price * 0.035 * 100));
    }

    // Calculate strike
    const strike = isBullish
      ? Math.ceil((price * (1 + otmPercent)) / 0.5) * 0.5
      : Math.floor((price * (1 - otmPercent)) / 0.5) * 0.5;

    const optionType = isBullish ? 'CALL' : 'PUT';

    // Calculate expiration (next Friday)
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + dte);
    while (expDate.getDay() !== 5) {
      expDate.setDate(expDate.getDate() + 1);
    }
    const expStr = expDate.toISOString().split('T')[0];

    // Estimate premium (rough: ~2-4% of stock price for slightly OTM weeklies)
    const estimatedPremium = price * 0.025;
    const totalCost = estimatedPremium * 100 * Math.max(1, contractQty);

    return {
      type: optionType,
      strike,
      expiration: expStr,
      dte,
      estimatedPremium: estimatedPremium.toFixed(2),
      suggestedContracts: Math.max(1, contractQty),
      totalCost: totalCost.toFixed(0),
      description: `${strike} ${optionType} ${expStr} (~$${estimatedPremium.toFixed(2)})`,
      fullDescription: `BUY ${Math.max(1, contractQty)}x ${ticker} ${strike} ${optionType} ${expStr}`
    };
  }

  // Calculate targets with partial profit level
  calculateTargets(price, isBullish, confidence) {
    let targetPercent, partialPercent, stopPercent;

    // Aggressive targets for day trading
    if (confidence >= 90) {
      targetPercent = 0.035;   // 3.5% full target
      partialPercent = 0.02;   // 2% partial (take 50% off)
      stopPercent = 0.012;     // 1.2% stop (almost 3:1)
    } else if (confidence >= 80) {
      targetPercent = 0.03;    // 3% full target
      partialPercent = 0.018;  // 1.8% partial
      stopPercent = 0.012;     // 1.2% stop (2.5:1)
    } else if (confidence >= 70) {
      targetPercent = 0.025;   // 2.5% full target
      partialPercent = 0.015;  // 1.5% partial
      stopPercent = 0.012;     // 1.2% stop (2:1)
    } else {
      targetPercent = 0.02;    // 2% full target
      partialPercent = 0.012;  // 1.2% partial
      stopPercent = 0.012;     // 1.2% stop (1.7:1)
    }

    if (isBullish) {
      return {
        target: Number((price * (1 + targetPercent)).toFixed(2)),
        partialTarget: Number((price * (1 + partialPercent)).toFixed(2)),
        stopLoss: Number((price * (1 - stopPercent)).toFixed(2))
      };
    } else {
      return {
        target: Number((price * (1 - targetPercent)).toFixed(2)),
        partialTarget: Number((price * (1 - partialPercent)).toFixed(2)),
        stopLoss: Number((price * (1 + stopPercent)).toFixed(2))
      };
    }
  }

  // Calculate expected option P&L based on stock move
  calculateExpectedOptionPnL(price, target, stopLoss, isBullish) {
    const stockGainPercent = Math.abs((target - price) / price) * 100;
    const stockLossPercent = Math.abs((price - stopLoss) / price) * 100;

    // Option moves roughly 3-4x the underlying percentage for slightly OTM options
    const optionGainPercent = stockGainPercent * this.OPTION_LEVERAGE;
    const optionLossPercent = Math.min(100, stockLossPercent * this.OPTION_LEVERAGE);

    // Calculate dollar amounts
    const maxGain = (optionGainPercent / 100) * this.POSITION_SIZE;
    const maxLoss = (optionLossPercent / 100) * this.POSITION_SIZE;

    return {
      stockMoveToTarget: `${isBullish ? '+' : '-'}${stockGainPercent.toFixed(2)}%`,
      stockMoveToStop: `${isBullish ? '-' : '+'}${stockLossPercent.toFixed(2)}%`,
      expectedOptionGain: `+${optionGainPercent.toFixed(0)}%`,
      expectedOptionLoss: `-${optionLossPercent.toFixed(0)}%`,
      maxProfitDollars: maxGain.toFixed(0),
      maxLossDollars: maxLoss.toFixed(0),
      positionSize: this.POSITION_SIZE,
      riskRewardDollars: `$${maxGain.toFixed(0)} / $${maxLoss.toFixed(0)}`
    };
  }

  // Format for Discord with clear action items
  formatForDiscord(rec) {
    const lines = [];

    // HEADER - Big attention grabber
    if (rec.confidenceScore >= 90) {
      lines.push(`\n${'═'.repeat(40)}`);
      lines.push(`🔥🔥🔥 **FIRE ALERT - ENTER NOW** 🔥🔥🔥`);
      lines.push(`${'═'.repeat(40)}`);
    } else if (rec.confidenceScore >= 80) {
      lines.push(`\n${'─'.repeat(35)}`);
      lines.push(`🔥 **STRONG ENTRY SIGNAL** 🔥`);
      lines.push(`${'─'.repeat(35)}`);
    }

    // ACTION LINE
    lines.push(`\n**${rec.recommendation.action}**`);
    lines.push(`Confidence: **${rec.confidenceScore}/100** (${rec.recommendation.confidence})`);

    // OPTION TRADE
    if (rec.optionSuggestion) {
      lines.push(`\n**📋 TRADE:**`);
      lines.push(`${rec.optionSuggestion.fullDescription || rec.optionSuggestion.description}`);
      lines.push(`Est. Cost: ~$${rec.optionSuggestion.totalCost}`);
    }

    // TARGETS
    lines.push(`\n**🎯 LEVELS:**`);
    lines.push(`Entry: $${rec.targets.entry.toFixed(2)}`);
    lines.push(`Partial (50%): $${rec.targets.partialTarget.toFixed(2)}`);
    lines.push(`Full Target: $${rec.targets.target.toFixed(2)}`);
    lines.push(`Stop Loss: $${rec.targets.stopLoss.toFixed(2)}`);

    // EXPECTED P&L
    lines.push(`\n**💰 EXPECTED P&L ($${rec.positionSize} position):**`);
    lines.push(`If target hit: **+$${rec.optionPnL.maxProfitDollars}** (${rec.optionPnL.expectedOptionGain})`);
    lines.push(`If stopped out: **-$${rec.optionPnL.maxLossDollars}** (${rec.optionPnL.expectedOptionLoss})`);
    lines.push(`Risk/Reward: **${rec.targets.riskReward}:1**`);

    // FACTORS
    if (rec.factors.length > 0) {
      lines.push(`\n**✅ WHY ENTER:**`);
      rec.factors.forEach(f => lines.push(`• ${f}`));
    }

    // WARNINGS
    if (rec.warnings.length > 0) {
      lines.push(`\n**⚠️ WATCH OUT:**`);
      rec.warnings.forEach(w => lines.push(`• ${w}`));
    }

    // URGENCY
    lines.push(`\n**⏰ TIMING:** ${rec.urgency}`);

    // BOT'S FINAL WORD
    lines.push(`\n*${rec.recommendation.message}*`);

    return lines.join('\n');
  }
}

// Export singleton
module.exports = new TradeRecommendation();
