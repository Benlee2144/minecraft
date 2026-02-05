/**
 * Sector Correlation Analysis Module
 * Provides institutional-grade sector analysis:
 * - Cross-sector correlation tracking
 * - Sector rotation detection
 * - Risk-on/Risk-off regime identification
 * - Relative strength analysis
 */

const logger = require('../utils/logger');
const sectorHeatMap = require('./sectorHeatMap');
const polygonRest = require('../polygon/rest');

class SectorCorrelation {
  constructor() {
    // Historical sector performance for correlation
    this.sectorHistory = new Map(); // etf -> array of {timestamp, change}
    this.maxHistoryLength = 50;

    // Correlation matrix cache
    this.correlationMatrix = new Map();
    this.lastCorrelationUpdate = null;

    // Risk regime tracking
    this.riskRegime = 'NEUTRAL'; // RISK_ON, RISK_OFF, NEUTRAL
    this.regimeHistory = [];

    // Sector pairs for rotation analysis
    this.sectorPairs = {
      riskOn: ['XLK', 'XLY', 'XLF', 'XLI'],  // Growth/Cyclicals
      riskOff: ['XLU', 'XLP', 'XLRE', 'XLV'],  // Defensive/Safe havens
      cyclical: ['XLE', 'XLB', 'XLI'],
      growth: ['XLK', 'XLC']
    };

    // Rotation signals
    this.rotationSignals = [];
  }

  // Update sector history with new data
  async updateHistory() {
    try {
      await sectorHeatMap.updateSectors();

      const etfs = Object.keys(sectorHeatMap.sectors);
      const timestamp = Date.now();

      for (const etf of etfs) {
        const data = sectorHeatMap.sectorData.get(etf);
        if (!data) continue;

        if (!this.sectorHistory.has(etf)) {
          this.sectorHistory.set(etf, []);
        }

        const history = this.sectorHistory.get(etf);
        history.push({
          timestamp,
          change: data.changePercent || 0,
          price: data.price,
          volume: data.volume
        });

        // Trim history
        if (history.length > this.maxHistoryLength) {
          history.shift();
        }
      }

      // Update correlation matrix and regime
      this.calculateCorrelationMatrix();
      this.detectRiskRegime();
      this.detectSectorRotation();

      logger.debug('Sector correlation history updated');
      return true;
    } catch (error) {
      logger.error('Error updating sector history', { error: error.message });
      return false;
    }
  }

  // Calculate correlation between two sectors
  calculateCorrelation(etf1, etf2) {
    const history1 = this.sectorHistory.get(etf1);
    const history2 = this.sectorHistory.get(etf2);

    if (!history1 || !history2 || history1.length < 10 || history2.length < 10) {
      return null;
    }

    // Align timestamps and get changes
    const minLength = Math.min(history1.length, history2.length);
    const changes1 = history1.slice(-minLength).map(h => h.change);
    const changes2 = history2.slice(-minLength).map(h => h.change);

    // Calculate Pearson correlation
    const n = changes1.length;
    const mean1 = changes1.reduce((a, b) => a + b, 0) / n;
    const mean2 = changes2.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denom1 = 0;
    let denom2 = 0;

    for (let i = 0; i < n; i++) {
      const diff1 = changes1[i] - mean1;
      const diff2 = changes2[i] - mean2;
      numerator += diff1 * diff2;
      denom1 += diff1 * diff1;
      denom2 += diff2 * diff2;
    }

    const denominator = Math.sqrt(denom1 * denom2);
    if (denominator === 0) return 0;

    return numerator / denominator;
  }

  // Calculate full correlation matrix
  calculateCorrelationMatrix() {
    const etfs = Array.from(this.sectorHistory.keys());
    this.correlationMatrix.clear();

    for (let i = 0; i < etfs.length; i++) {
      for (let j = i + 1; j < etfs.length; j++) {
        const correlation = this.calculateCorrelation(etfs[i], etfs[j]);
        if (correlation !== null) {
          const key = `${etfs[i]}-${etfs[j]}`;
          this.correlationMatrix.set(key, correlation);
        }
      }
    }

    this.lastCorrelationUpdate = Date.now();
  }

  // Detect current risk regime (Risk-On vs Risk-Off)
  detectRiskRegime() {
    // Compare risk-on sectors vs risk-off sectors
    const riskOnPerf = this.getGroupPerformance(this.sectorPairs.riskOn);
    const riskOffPerf = this.getGroupPerformance(this.sectorPairs.riskOff);

    if (riskOnPerf === null || riskOffPerf === null) {
      this.riskRegime = 'UNKNOWN';
      return;
    }

    const spread = riskOnPerf - riskOffPerf;

    // Determine regime based on spread
    let newRegime;
    if (spread > 0.5) {
      newRegime = 'RISK_ON';
    } else if (spread < -0.5) {
      newRegime = 'RISK_OFF';
    } else {
      newRegime = 'NEUTRAL';
    }

    // Track regime changes
    if (newRegime !== this.riskRegime) {
      this.regimeHistory.push({
        from: this.riskRegime,
        to: newRegime,
        timestamp: Date.now(),
        spread
      });

      // Keep last 20 regime changes
      if (this.regimeHistory.length > 20) {
        this.regimeHistory.shift();
      }
    }

    this.riskRegime = newRegime;
    return newRegime;
  }

  // Get average performance for a group of sectors
  getGroupPerformance(etfs) {
    let total = 0;
    let count = 0;

    for (const etf of etfs) {
      const data = sectorHeatMap.sectorData.get(etf);
      if (data && data.changePercent !== undefined) {
        total += data.changePercent;
        count++;
      }
    }

    return count > 0 ? total / count : null;
  }

  // Detect sector rotation patterns
  detectSectorRotation() {
    this.rotationSignals = [];

    const ranking = sectorHeatMap.getRanking();
    if (ranking.length < 5) return;

    // Check for cyclical vs defensive rotation
    const cyclicalPerf = this.getGroupPerformance(this.sectorPairs.cyclical);
    const defensivePerf = this.getGroupPerformance(this.sectorPairs.riskOff);

    if (cyclicalPerf !== null && defensivePerf !== null) {
      const cyclicalSpread = cyclicalPerf - defensivePerf;

      if (cyclicalSpread > 1.0) {
        this.rotationSignals.push({
          type: 'CYCLICAL_ROTATION',
          direction: 'INTO_CYCLICALS',
          strength: Math.min(100, cyclicalSpread * 30),
          message: 'Money flowing into cyclical sectors (XLE, XLB, XLI)',
          timestamp: Date.now()
        });
      } else if (cyclicalSpread < -1.0) {
        this.rotationSignals.push({
          type: 'DEFENSIVE_ROTATION',
          direction: 'INTO_DEFENSIVES',
          strength: Math.min(100, Math.abs(cyclicalSpread) * 30),
          message: 'Money flowing into defensive sectors (XLU, XLP, XLV)',
          timestamp: Date.now()
        });
      }
    }

    // Check for growth vs value rotation
    const growthPerf = this.getGroupPerformance(this.sectorPairs.growth);
    const valuePerf = this.getGroupPerformance(['XLF', 'XLE', 'XLB']);

    if (growthPerf !== null && valuePerf !== null) {
      const growthSpread = growthPerf - valuePerf;

      if (growthSpread > 1.0) {
        this.rotationSignals.push({
          type: 'GROWTH_ROTATION',
          direction: 'INTO_GROWTH',
          strength: Math.min(100, growthSpread * 30),
          message: 'Growth outperforming value (XLK, XLC leading)',
          timestamp: Date.now()
        });
      } else if (growthSpread < -1.0) {
        this.rotationSignals.push({
          type: 'VALUE_ROTATION',
          direction: 'INTO_VALUE',
          strength: Math.min(100, Math.abs(growthSpread) * 30),
          message: 'Value outperforming growth (XLF, XLE leading)',
          timestamp: Date.now()
        });
      }
    }

    // Check for extreme sector divergence
    const topSector = ranking[0];
    const bottomSector = ranking[ranking.length - 1];

    if (topSector && bottomSector) {
      const divergence = topSector.change - bottomSector.change;

      if (divergence > 2.0) {
        this.rotationSignals.push({
          type: 'SECTOR_DIVERGENCE',
          direction: 'HIGH_DIVERGENCE',
          strength: Math.min(100, divergence * 20),
          leader: topSector.etf,
          laggard: bottomSector.etf,
          message: `${topSector.name} leading (+${topSector.change.toFixed(1)}%), ${bottomSector.name} lagging (${bottomSector.change.toFixed(1)}%)`,
          timestamp: Date.now()
        });
      }
    }

    return this.rotationSignals;
  }

  // Get relative strength for a ticker compared to its sector
  getRelativeStrength(ticker, tickerChange) {
    const sector = sectorHeatMap.getSectorForTicker(ticker);
    if (!sector || !sector.data) return null;

    const sectorChange = sector.data.changePercent || 0;
    const relativeStrength = tickerChange - sectorChange;

    return {
      ticker,
      tickerChange,
      sector: sector.name,
      sectorETF: sector.etf,
      sectorChange,
      relativeStrength,
      isOutperforming: relativeStrength > 0.5,
      isUnderperforming: relativeStrength < -0.5,
      strengthRating: this.getRatingFromRelativeStrength(relativeStrength)
    };
  }

  // Convert relative strength to rating
  getRatingFromRelativeStrength(rs) {
    if (rs > 2.0) return { label: 'STRONG OUTPERFORM', score: 5, emoji: '🔥🔥' };
    if (rs > 1.0) return { label: 'OUTPERFORM', score: 4, emoji: '🔥' };
    if (rs > 0.3) return { label: 'SLIGHT OUTPERFORM', score: 3, emoji: '✅' };
    if (rs > -0.3) return { label: 'IN-LINE', score: 2, emoji: '➡️' };
    if (rs > -1.0) return { label: 'SLIGHT UNDERPERFORM', score: 1, emoji: '⚠️' };
    return { label: 'UNDERPERFORM', score: 0, emoji: '🔻' };
  }

  // Get correlation with SPY
  async getSpyCorrelation(ticker) {
    try {
      // Get recent price data for both
      const [tickerData, spyData] = await Promise.all([
        polygonRest.getStockSnapshot(ticker),
        polygonRest.getStockSnapshot('SPY')
      ]);

      if (!tickerData || !spyData) return null;

      // For now, return basic correlation indicator
      // In production, would use historical price series
      const tickerChange = tickerData.todayChangePercent || 0;
      const spyChange = spyData.todayChangePercent || 0;

      // Same direction = correlated
      const sameDirection = (tickerChange > 0 && spyChange > 0) || (tickerChange < 0 && spyChange < 0);
      const betaMagnitude = spyChange !== 0 ? Math.abs(tickerChange / spyChange) : 1;

      return {
        ticker,
        tickerChange,
        spyChange,
        sameDirection,
        estimatedBeta: betaMagnitude.toFixed(2),
        correlation: sameDirection ? 'POSITIVE' : 'NEGATIVE',
        interpretation: this.interpretCorrelation(sameDirection, betaMagnitude)
      };
    } catch (error) {
      return null;
    }
  }

  // Interpret correlation for trading
  interpretCorrelation(sameDirection, beta) {
    if (!sameDirection) {
      return 'Diverging from market - potential independent catalyst';
    }
    if (beta > 1.5) {
      return 'High beta - amplified market moves';
    }
    if (beta < 0.5) {
      return 'Low beta - muted market sensitivity';
    }
    return 'Normal market correlation';
  }

  // Format regime status for Discord
  formatRegimeStatus() {
    const { EmbedBuilder } = require('discord.js');

    const regimeEmoji = {
      'RISK_ON': '🟢',
      'RISK_OFF': '🔴',
      'NEUTRAL': '🟡',
      'UNKNOWN': '⚪'
    };

    const embed = new EmbedBuilder()
      .setTitle(`${regimeEmoji[this.riskRegime]} Market Regime: ${this.riskRegime.replace('_', ' ')}`)
      .setColor(this.riskRegime === 'RISK_ON' ? 0x00FF00 :
                this.riskRegime === 'RISK_OFF' ? 0xFF0000 : 0xFFFF00)
      .setTimestamp();

    // Add sector group performance
    const riskOnPerf = this.getGroupPerformance(this.sectorPairs.riskOn);
    const riskOffPerf = this.getGroupPerformance(this.sectorPairs.riskOff);

    let description = '';
    if (riskOnPerf !== null && riskOffPerf !== null) {
      description += `**Risk-On Sectors:** ${riskOnPerf > 0 ? '+' : ''}${riskOnPerf.toFixed(2)}%\n`;
      description += `**Risk-Off Sectors:** ${riskOffPerf > 0 ? '+' : ''}${riskOffPerf.toFixed(2)}%\n`;
      description += `**Spread:** ${(riskOnPerf - riskOffPerf).toFixed(2)}%\n`;
    }

    embed.setDescription(description);

    // Add rotation signals if any
    if (this.rotationSignals.length > 0) {
      const signalText = this.rotationSignals.map(s =>
        `• ${s.message} (${s.strength.toFixed(0)}% strength)`
      ).join('\n');

      embed.addFields({
        name: '🔄 Rotation Signals',
        value: signalText,
        inline: false
      });
    }

    // Add trading implications
    const implications = this.getTradingImplications();
    embed.addFields({
      name: '📋 Trading Implications',
      value: implications,
      inline: false
    });

    return embed;
  }

  // Get trading implications based on regime
  getTradingImplications() {
    switch (this.riskRegime) {
      case 'RISK_ON':
        return '• Favor growth/tech stocks (AAPL, NVDA, TSLA)\n' +
               '• Consider reducing defensive positions\n' +
               '• Look for breakout setups in cyclicals';
      case 'RISK_OFF':
        return '• Favor defensive sectors (XLU, XLP, XLV)\n' +
               '• Tighten stops on growth positions\n' +
               '• Consider reducing overall exposure';
      case 'NEUTRAL':
        return '• Selective stock picking preferred\n' +
               '• Watch for regime change signals\n' +
               '• Focus on high-conviction setups only';
      default:
        return 'Insufficient data for regime analysis';
    }
  }

  // Format sector correlation matrix for Discord
  formatCorrelationMatrix() {
    const { EmbedBuilder } = require('discord.js');

    const embed = new EmbedBuilder()
      .setTitle('📊 Sector Correlation Matrix')
      .setColor(0x3498DB)
      .setTimestamp();

    // Get notable correlations (very high or very low)
    const correlations = Array.from(this.correlationMatrix.entries())
      .map(([key, value]) => ({ pair: key, correlation: value }))
      .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    if (correlations.length === 0) {
      embed.setDescription('Insufficient data for correlation analysis. Check back later.');
      return embed;
    }

    // Show top positive and negative correlations
    const highCorr = correlations.filter(c => c.correlation > 0.7).slice(0, 5);
    const lowCorr = correlations.filter(c => c.correlation < -0.3).slice(0, 5);

    let description = '**High Positive Correlations (move together):**\n';
    if (highCorr.length > 0) {
      description += highCorr.map(c =>
        `  ${c.pair}: ${(c.correlation * 100).toFixed(0)}%`
      ).join('\n');
    } else {
      description += '  None significant\n';
    }

    description += '\n\n**Negative Correlations (move opposite):**\n';
    if (lowCorr.length > 0) {
      description += lowCorr.map(c =>
        `  ${c.pair}: ${(c.correlation * 100).toFixed(0)}%`
      ).join('\n');
    } else {
      description += '  None significant\n';
    }

    embed.setDescription(description);

    return embed;
  }

  // Get sector score adjustment for heat score
  getSectorScoreAdjustment(ticker) {
    const sector = sectorHeatMap.getSectorForTicker(ticker);
    if (!sector || !sector.data) return { adjustment: 0, reason: null };

    const sectorChange = sector.data.changePercent || 0;
    const ranking = sectorHeatMap.getRanking();
    const rank = ranking.findIndex(s => s.etf === sector.etf) + 1;

    let adjustment = 0;
    let reason = null;

    // Bonus for stocks in hot sectors
    if (rank <= 3 && sectorChange > 0.5) {
      adjustment = 10;
      reason = `${sector.name} is a leading sector today`;
    }
    // Penalty for stocks in cold sectors
    else if (rank >= ranking.length - 2 && sectorChange < -0.5) {
      adjustment = -5;
      reason = `${sector.name} is lagging today`;
    }

    // Additional adjustment based on regime
    if (this.riskRegime === 'RISK_ON' && this.sectorPairs.riskOn.includes(sector.etf)) {
      adjustment += 5;
      reason = (reason ? reason + '; ' : '') + 'Risk-on regime favors this sector';
    } else if (this.riskRegime === 'RISK_OFF' && this.sectorPairs.riskOff.includes(sector.etf)) {
      adjustment += 5;
      reason = (reason ? reason + '; ' : '') + 'Risk-off regime favors this sector';
    }

    return { adjustment, reason, sector: sector.name, sectorChange, rank };
  }
}

module.exports = new SectorCorrelation();
