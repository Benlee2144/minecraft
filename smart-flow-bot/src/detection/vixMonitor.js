/**
 * VIX Monitor Module
 * Monitors the VIX (Volatility Index) for risk management:
 * - VIX < 15: Low volatility - normal trading conditions
 * - VIX 15-20: Normal volatility
 * - VIX 20-25: Elevated volatility - consider smaller positions
 * - VIX 25-30: High volatility - tighten stops, reduce size
 * - VIX > 30: Extreme volatility - caution, potential opportunities
 */

const logger = require('../utils/logger');
const polygonRest = require('../polygon/rest');

class VixMonitor {
  constructor() {
    this.currentVix = null;
    this.previousVix = null;
    this.vixHistory = [];
    this.lastUpdate = null;
    this.lastAlertLevel = null;
    this.UPDATE_INTERVAL = 5 * 60 * 1000; // Update every 5 minutes

    // VIX levels
    this.LEVELS = {
      LOW: 15,
      NORMAL: 20,
      ELEVATED: 25,
      HIGH: 30,
      EXTREME: 35
    };
  }

  // Get current VIX data
  async updateVix() {
    try {
      // VIX is traded as ^VIX or VIX on different platforms
      // Using UVXY as a proxy since it tracks VIX
      const vixData = await polygonRest.getStockSnapshot('UVXY');

      if (vixData && vixData.price) {
        // UVXY is not 1:1 with VIX, but we can use relative changes
        // For demo, we'll estimate VIX based on UVXY price patterns
        this.previousVix = this.currentVix;
        this.currentVix = this.estimateVixFromProxy(vixData.price, vixData.changePercent);

        this.vixHistory.push({
          value: this.currentVix,
          timestamp: Date.now()
        });

        // Keep last 50 readings
        if (this.vixHistory.length > 50) {
          this.vixHistory.shift();
        }

        this.lastUpdate = new Date();
        logger.debug(`VIX updated: ${this.currentVix.toFixed(2)}`);
      }

      return this.currentVix;
    } catch (error) {
      logger.error('Error updating VIX', { error: error.message });
      return null;
    }
  }

  // Estimate VIX from UVXY proxy
  estimateVixFromProxy(uvxyPrice, changePercent) {
    // UVXY typically correlates with VIX
    // Base estimate: VIX around 15-20 when UVXY is stable
    // This is a rough approximation
    const baseVix = 18;
    const changeImpact = (changePercent || 0) * 0.5; // VIX moves ~50% of UVXY move
    return Math.max(10, baseVix + changeImpact);
  }

  // Get current VIX level classification
  getVixLevel() {
    if (!this.currentVix) return null;

    if (this.currentVix >= this.LEVELS.EXTREME) {
      return {
        level: 'EXTREME',
        value: this.currentVix,
        color: 0xFF0000, // Red
        emoji: '🔴🔴🔴',
        warning: 'EXTREME volatility - Market in panic mode',
        positionSizeMultiplier: 0.25,
        stopMultiplier: 2.0
      };
    } else if (this.currentVix >= this.LEVELS.HIGH) {
      return {
        level: 'HIGH',
        value: this.currentVix,
        color: 0xFF4500, // Orange-Red
        emoji: '🔴🔴',
        warning: 'HIGH volatility - Use caution, tighten stops',
        positionSizeMultiplier: 0.5,
        stopMultiplier: 1.5
      };
    } else if (this.currentVix >= this.LEVELS.ELEVATED) {
      return {
        level: 'ELEVATED',
        value: this.currentVix,
        color: 0xFFA500, // Orange
        emoji: '🟠',
        warning: 'ELEVATED volatility - Consider smaller positions',
        positionSizeMultiplier: 0.75,
        stopMultiplier: 1.25
      };
    } else if (this.currentVix >= this.LEVELS.NORMAL) {
      return {
        level: 'NORMAL',
        value: this.currentVix,
        color: 0xFFFF00, // Yellow
        emoji: '🟡',
        warning: 'Normal volatility - Standard trading conditions',
        positionSizeMultiplier: 1.0,
        stopMultiplier: 1.0
      };
    } else {
      return {
        level: 'LOW',
        value: this.currentVix,
        color: 0x00FF00, // Green
        emoji: '🟢',
        warning: 'LOW volatility - Calm markets, watch for breakouts',
        positionSizeMultiplier: 1.0,
        stopMultiplier: 1.0
      };
    }
  }

  // Check if VIX level changed significantly
  checkForLevelChange() {
    const currentLevel = this.getVixLevel();
    if (!currentLevel) return null;

    if (this.lastAlertLevel !== currentLevel.level) {
      const previousLevel = this.lastAlertLevel;
      this.lastAlertLevel = currentLevel.level;

      // Only alert on significant changes
      if (previousLevel) {
        const levelOrder = ['LOW', 'NORMAL', 'ELEVATED', 'HIGH', 'EXTREME'];
        const prevIdx = levelOrder.indexOf(previousLevel);
        const currIdx = levelOrder.indexOf(currentLevel.level);

        // Alert if VIX increased to ELEVATED or higher
        if (currIdx >= 2 && currIdx > prevIdx) {
          return {
            type: 'VIX_SPIKE',
            from: previousLevel,
            to: currentLevel.level,
            vix: this.currentVix,
            ...currentLevel
          };
        }

        // Alert if VIX dropped from HIGH to NORMAL or below
        if (currIdx <= 1 && prevIdx >= 3) {
          return {
            type: 'VIX_CALM',
            from: previousLevel,
            to: currentLevel.level,
            vix: this.currentVix,
            ...currentLevel
          };
        }
      }
    }

    return null;
  }

  // Calculate VIX trend (rising, falling, stable)
  getVixTrend() {
    if (this.vixHistory.length < 5) return 'UNKNOWN';

    const recent = this.vixHistory.slice(-5).map(h => h.value);
    const firstHalf = recent.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
    const secondHalf = recent.slice(3).reduce((a, b) => a + b, 0) / 2;

    const change = ((secondHalf - firstHalf) / firstHalf) * 100;

    if (change > 5) return 'RISING';
    if (change < -5) return 'FALLING';
    return 'STABLE';
  }

  // Get trading recommendations based on VIX
  getTradingRecommendations() {
    const level = this.getVixLevel();
    const trend = this.getVixTrend();

    if (!level) return null;

    const recommendations = [];

    // Level-based recommendations
    if (level.level === 'EXTREME' || level.level === 'HIGH') {
      recommendations.push('Reduce position sizes by 50-75%');
      recommendations.push('Widen stops to account for volatility');
      recommendations.push('Focus on liquid names only (SPY, QQQ, AAPL, etc.)');
      recommendations.push('Avoid holding overnight');
    } else if (level.level === 'ELEVATED') {
      recommendations.push('Consider 75% normal position size');
      recommendations.push('Use slightly wider stops');
      recommendations.push('Be patient for clear setups');
    }

    // Trend-based additions
    if (trend === 'RISING') {
      recommendations.push('VIX rising - volatility increasing, be defensive');
    } else if (trend === 'FALLING') {
      recommendations.push('VIX falling - market calming, good for trends');
    }

    return {
      level: level.level,
      value: this.currentVix,
      trend,
      recommendations,
      positionSizeMultiplier: level.positionSizeMultiplier,
      stopMultiplier: level.stopMultiplier
    };
  }

  // Format VIX status for Discord
  formatVixStatus() {
    const level = this.getVixLevel();
    const trend = this.getVixTrend();

    if (!level) return 'VIX data unavailable';

    const trendEmoji = trend === 'RISING' ? '📈' : trend === 'FALLING' ? '📉' : '➡️';

    let message = `${level.emoji} **VIX: ${this.currentVix?.toFixed(2) || 'N/A'}** (${level.level})\n`;
    message += `Trend: ${trendEmoji} ${trend}\n`;
    message += `\n**${level.warning}**\n`;

    if (level.positionSizeMultiplier < 1) {
      message += `\n📊 Position Size: ${(level.positionSizeMultiplier * 100).toFixed(0)}% of normal`;
    }
    if (level.stopMultiplier > 1) {
      message += `\n🛑 Stops: ${(level.stopMultiplier * 100).toFixed(0)}% wider than normal`;
    }

    return message;
  }

  // Format VIX alert for Discord embed
  formatVixAlert(alert) {
    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setTitle(`${alert.emoji} VIX Alert: ${alert.type === 'VIX_SPIKE' ? 'Volatility Spike!' : 'Volatility Calming'}`)
      .setColor(alert.color)
      .setDescription(`VIX moved from **${alert.from}** to **${alert.to}**`)
      .addFields(
        { name: 'Current VIX', value: this.currentVix?.toFixed(2) || 'N/A', inline: true },
        { name: 'Trend', value: this.getVixTrend(), inline: true },
        { name: 'Warning', value: alert.warning }
      )
      .setTimestamp();

    if (alert.type === 'VIX_SPIKE') {
      embed.addFields({
        name: '📋 Recommendations',
        value: this.getTradingRecommendations()?.recommendations.join('\n') || 'Use caution'
      });
    }

    return embed;
  }

  // Check if we need to update
  needsUpdate() {
    if (!this.lastUpdate) return true;
    return Date.now() - this.lastUpdate.getTime() > this.UPDATE_INTERVAL;
  }
}

module.exports = new VixMonitor();
