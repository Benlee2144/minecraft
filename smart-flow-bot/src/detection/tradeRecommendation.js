const logger = require('../utils/logger');
const marketHours = require('../utils/marketHours');
const earnings = require('../utils/earnings');
const spyCorrelation = require('./spyCorrelation');
const sectorHeatMap = require('./sectorHeatMap');
const keyLevels = require('./keyLevels');
const vwapTracker = require('./vwapTracker');

/**
 * PRO TRADER STRATEGIES IMPLEMENTED:
 *
 * 1. VWAP Trading - Price above VWAP = bullish, below = bearish
 *    Source: https://www.warriortrading.com/vwap/
 *
 * 2. Optimal Time Windows - 60% of daily range in first 90 mins
 *    - Opening Drive (9:30-10:00): +15 points - BEST TIME
 *    - Power Hour (3:00-4:00): +12 points - Second best
 *    - Midday (11:30-2:00): -25 points - "DEATH ZONE"
 *    Source: https://www.quantvps.com/blog/0dte-scalping-strategies
 *
 * 3. 0DTE Scalping - Take profits at 20-30%, stop at 50%
 *    Source: https://menthorq.com/guide/0dte-options-trading-strategies/
 *
 * 4. Near-the-Money Strikes - Tighter spreads, faster execution
 *    Source: https://chartvps.com/workshop/scalping-spy-and-qqq/
 *
 * 5. Theta Decay - Avoid afternoon 0DTE entries (70% decay in last hour)
 *    Source: https://www.strike.money/options/0dte
 */

class TradeRecommendation {
  constructor() {
    // Confidence thresholds - MAXIMUM ACTION for day trading (15-30 trades/day)
    this.FIRE_ALERT = 75;      // 🔥🔥🔥 ENTER NOW
    this.STRONG_BUY = 65;      // 🔥 STRONG ENTRY
    this.BUY = 50;             // ✅ GOOD ENTRY
    this.LEAN = 35;            // 🔸 LEAN ENTRY (tradeable)
    this.WATCH = 20;           // 👀 WATCH (still trades for tracking)
    this.AVOID = 0;            // ⛔ DO NOT TRADE

    // Position sizing
    this.POSITION_SIZE = 2000; // $2000 per trade

    // Option leverage (ATM options have ~0.50 delta, slightly OTM ~0.35)
    // For scalps, we use ATM which moves faster
    this.OPTION_LEVERAGE = 4.0; // ATM moves ~4x the underlying for scalps

    // Pro trader profit targets (research shows 20-30% target, 50% stop)
    this.SCALP_TARGET_PERCENT = 0.25;  // 25% option profit target
    this.SCALP_STOP_PERCENT = 0.50;    // 50% option stop loss
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

    // ============ TIMING ANALYSIS (PRO TRADER WINDOWS) ============
    // Research: 60% of daily range forms in first 90 minutes
    // Source: https://www.quantvps.com/blog/0dte-scalping-strategies
    const phase = marketHours.getTradingPhase();
    tradingContext.phase = phase;
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    if (phase.phase === 'opening_drive') {
      // BEST TIME TO TRADE - 9:30-10:00 AM
      // "The first 60-90 minutes offer the best setups"
      confidenceScore += 15;
      factors.push('🔥 OPENING DRIVE - 60% of daily range forms now!');
    } else if (phase.phase === 'power_hour') {
      // SECOND BEST - 3:00-4:00 PM
      // "Final 30-60 minutes bring extreme gamma, 10-20% moves in minutes"
      confidenceScore += 12;
      factors.push('⚡ POWER HOUR - Gamma spikes, big moves!');
      // But warn about theta on 0DTE
      if (hour >= 15 && minute >= 30) {
        warnings.push('⏰ Late power hour - 0DTE theta accelerating');
      }
    } else if (phase.phase === 'morning') {
      // Good - 10:00-11:30 AM
      // "Best for VWAP reversion and trend strategies"
      confidenceScore += 8;
      factors.push('📈 Morning session - trends established');
    } else if (phase.phase === 'midday') {
      // DEATH ZONE - 11:30-2:00 PM
      // "Midday volatility drops 30-50%, favors short sellers"
      // "1:00-2:00 PM often a lull - better to avoid"
      confidenceScore -= 25;
      warnings.push('💀 MIDDAY DEATH ZONE - 30-50% less volatility, skip or reduce size!');
    } else if (phase.phase === 'afternoon') {
      // Building - 2:00-3:00 PM
      confidenceScore += 5;
      factors.push('Afternoon momentum building to power hour');
    }

    // ============ VWAP ANALYSIS (PRO TRADER KEY INDICATOR) ============
    // "Institutions use VWAP for entries - price above = bullish, below = bearish"
    // Source: https://www.schwab.com/learn/story/how-to-use-volume-weighted-indicators-trading
    const isBullish = priceChange > 0;

    // Check if VWAP data is in signal breakdown
    if (signalBreakdown && signalBreakdown.vwap) {
      const vwap = signalBreakdown.vwap;
      tradingContext.vwap = vwap;

      // Price vs VWAP alignment
      if (vwap.isAboveVWAP && isBullish) {
        confidenceScore += 12;
        factors.push(`📈 ABOVE VWAP ($${vwap.vwap?.toFixed(2)}) - Bullish bias confirmed`);
      } else if (!vwap.isAboveVWAP && !isBullish) {
        confidenceScore += 12;
        factors.push(`📉 BELOW VWAP ($${vwap.vwap?.toFixed(2)}) - Bearish bias confirmed`);
      } else if (vwap.isAboveVWAP && !isBullish) {
        confidenceScore -= 8;
        warnings.push('Shorting above VWAP - fighting the trend');
      } else if (!vwap.isAboveVWAP && isBullish) {
        confidenceScore -= 8;
        warnings.push('Buying below VWAP - fighting the trend');
      }

      // VWAP signals (breakouts, pullbacks)
      if (vwap.signals && vwap.signals.length > 0) {
        for (const signal of vwap.signals) {
          if (signal.points > 0) {
            confidenceScore += signal.points;
            factors.push(`🎯 ${signal.description}`);
          } else if (signal.points < 0) {
            confidenceScore += signal.points; // Negative
            warnings.push(signal.description);
          }
        }
      }
    }

    // ============ SPY/MARKET ALIGNMENT ============
    const spyContext = spyCorrelation.getSPYContext();

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
    const optionSuggestion = this.suggestOption(ticker, price, isBullish, confidenceScore);
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
        action: `🔸 LEAN ENTRY - BUY ${direction}`,
        shortAction: `BUY ${direction}`,
        emoji: '🔸',
        confidence: 'MEDIUM',
        urgency: 'SCALP',
        message: `Developing setup. Enter with smaller size (25-50%) for quick scalp.`
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

  // Suggest option - PRO TRADER STYLE
  // "Scalpers focus on liquid, near-the-money strikes with tight bid-ask spreads"
  // "If SPY is $425.50, trade $425 or $426 strikes for best volume and execution"
  // Source: https://www.quantvps.com/blog/0dte-spy-options
  suggestOption(ticker, price, isBullish, confidence) {
    // PRO STRATEGY: ATM or 1 strike OTM for scalps
    // - ATM has highest delta (faster moves)
    // - Tightest bid-ask spreads
    // - Best liquidity for quick exits
    let otmPercent, dte, contractQty;

    const now = new Date();
    const hour = now.getHours();
    const isOpeningDrive = hour === 9 || (hour === 10 && now.getMinutes() < 30);
    const isPowerHour = hour >= 15;

    if (confidence >= 85 && isOpeningDrive) {
      // FIRE ALERT during Opening Drive = 0DTE ATM
      // "0DTE options create extreme gamma effects"
      otmPercent = 0.005;  // Basically ATM (0.5% OTM max)
      dte = 0;             // 0DTE for maximum leverage
      contractQty = Math.floor(this.POSITION_SIZE / (price * 0.015 * 100));
    } else if (confidence >= 80) {
      // High confidence = near ATM, short DTE
      otmPercent = 0.01;   // 1% OTM (1 strike out)
      dte = isPowerHour ? 1 : 2; // Next day if power hour (theta)
      contractQty = Math.floor(this.POSITION_SIZE / (price * 0.02 * 100));
    } else if (confidence >= 65) {
      // Good confidence = 1-2 strikes OTM
      otmPercent = 0.015;  // 1.5% OTM
      dte = 3;             // 3 days for some cushion
      contractQty = Math.floor(this.POSITION_SIZE / (price * 0.025 * 100));
    } else {
      // Lower confidence = slightly more OTM, more time
      otmPercent = 0.02;   // 2% OTM
      dte = 5;             // 5 days
      contractQty = Math.floor(this.POSITION_SIZE / (price * 0.03 * 100));
    }

    // Calculate strike - round to nearest $1 for liquid strikes
    // Pro tip: SPY/QQQ use $1 strikes, individual stocks use $2.50 or $5
    let strikeInterval = 1;
    if (price > 200) strikeInterval = 5;
    else if (price > 50) strikeInterval = 2.5;
    else if (price > 20) strikeInterval = 1;
    else strikeInterval = 0.5;

    const strike = isBullish
      ? Math.ceil((price * (1 + otmPercent)) / strikeInterval) * strikeInterval
      : Math.floor((price * (1 - otmPercent)) / strikeInterval) * strikeInterval;

    const optionType = isBullish ? 'CALL' : 'PUT';

    // Calculate expiration
    const expDate = new Date();
    if (dte === 0) {
      // 0DTE = today (if market open) or tomorrow
      const dayOfWeek = expDate.getDay();
      if (dayOfWeek === 0) expDate.setDate(expDate.getDate() + 1); // Sunday -> Monday
      if (dayOfWeek === 6) expDate.setDate(expDate.getDate() + 2); // Saturday -> Monday
    } else {
      expDate.setDate(expDate.getDate() + dte);
      // Find next expiration (Mon/Wed/Fri for SPY/QQQ, Fridays for others)
      while (expDate.getDay() === 0 || expDate.getDay() === 6) {
        expDate.setDate(expDate.getDate() + 1);
      }
    }
    const expStr = expDate.toISOString().split('T')[0];

    // Estimate premium based on moneyness and DTE
    // ATM 0DTE ~ 0.5-1% of stock price
    // ATM weekly ~ 2-3% of stock price
    let premiumMultiplier = 0.02;
    if (dte === 0) premiumMultiplier = 0.008;
    else if (dte <= 2) premiumMultiplier = 0.012;
    else if (dte <= 5) premiumMultiplier = 0.02;
    else premiumMultiplier = 0.025;

    const estimatedPremium = price * premiumMultiplier;
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

  // Calculate targets - PRO SCALPER STYLE
  // "Take profits at 20-30%, cut losses at 50%"
  // "Positions held 5-30 minutes, aiming for 20-50% per trade"
  // Source: https://menthorq.com/guide/0dte-options-trading-strategies/
  calculateTargets(price, isBullish, confidence) {
    let targetPercent, partialPercent, stopPercent;

    // PRO SCALP TARGETS based on ATM option behavior
    // Stock move needed for 25% option profit = ~0.6-0.8% (with 4x leverage)
    // Stock move that causes 50% option loss = ~1.2-1.5%
    if (confidence >= 85) {
      // Fire alert = tight targets, quick exits
      targetPercent = 0.015;   // 1.5% stock = ~40-50% option profit
      partialPercent = 0.008;  // 0.8% stock = ~25% option (take half off)
      stopPercent = 0.012;     // 1.2% stock = ~50% option loss
    } else if (confidence >= 70) {
      // Strong setup
      targetPercent = 0.018;   // 1.8% stock target
      partialPercent = 0.01;   // 1% partial
      stopPercent = 0.012;     // 1.2% stop
    } else if (confidence >= 55) {
      // Good setup - slightly wider
      targetPercent = 0.02;    // 2% stock target
      partialPercent = 0.012;  // 1.2% partial
      stopPercent = 0.015;     // 1.5% stop
    } else {
      // Lower conviction - need more room
      targetPercent = 0.025;   // 2.5% target
      partialPercent = 0.015;  // 1.5% partial
      stopPercent = 0.018;     // 1.8% stop
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
