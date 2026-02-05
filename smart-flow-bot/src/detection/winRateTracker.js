/**
 * Win Rate Tracker & Backtesting Module
 * Provides institutional-grade performance analytics:
 * - Historical win rate by signal type
 * - Win rate by heat score range
 * - Win rate by time of day
 * - Win rate by sector
 * - Expectancy calculations
 * - Drawdown analysis
 */

const logger = require('../utils/logger');
const database = require('../database/sqlite');

class WinRateTracker {
  constructor() {
    this.winRateCache = null;
    this.lastCacheUpdate = null;
    this.cacheExpiryMs = 5 * 60 * 1000; // 5 minutes
  }

  // Get comprehensive win rate statistics
  async getWinRateStats() {
    // Check cache
    if (this.winRateCache && this.lastCacheUpdate &&
        Date.now() - this.lastCacheUpdate < this.cacheExpiryMs) {
      return this.winRateCache;
    }

    try {
      const stats = {
        overall: this.getOverallWinRate(),
        bySignalType: this.getWinRateBySignalType(),
        byHeatScore: this.getWinRateByHeatScore(),
        byTimeOfDay: this.getWinRateByTimeOfDay(),
        bySector: this.getWinRateBySector(),
        byDayOfWeek: this.getWinRateByDayOfWeek(),
        streaks: this.getStreakAnalysis(),
        expectancy: this.calculateExpectancy(),
        recentPerformance: this.getRecentPerformance()
      };

      this.winRateCache = stats;
      this.lastCacheUpdate = Date.now();

      return stats;
    } catch (error) {
      logger.error('Error calculating win rate stats', { error: error.message });
      return null;
    }
  }

  // Get overall win rate
  getOverallWinRate() {
    try {
      const stats = database.db.prepare(`
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          SUM(CASE WHEN pnl_dollars < 0 THEN 1 ELSE 0 END) as losers,
          SUM(CASE WHEN pnl_dollars = 0 THEN 1 ELSE 0 END) as breakeven,
          AVG(pnl_percent) as avg_return,
          SUM(pnl_dollars) as total_pnl,
          AVG(CASE WHEN pnl_dollars > 0 THEN pnl_percent ELSE NULL END) as avg_win,
          AVG(CASE WHEN pnl_dollars < 0 THEN pnl_percent ELSE NULL END) as avg_loss,
          MAX(pnl_percent) as best_trade,
          MIN(pnl_percent) as worst_trade
        FROM paper_trades
        WHERE status = 'CLOSED'
      `).get();

      if (!stats || stats.total_trades === 0) {
        return { message: 'No closed trades yet', totalTrades: 0 };
      }

      const winRate = (stats.winners / stats.total_trades) * 100;
      const profitFactor = stats.avg_loss !== 0 ?
        Math.abs(stats.avg_win * stats.winners) / Math.abs(stats.avg_loss * stats.losers) : 0;

      return {
        totalTrades: stats.total_trades,
        winners: stats.winners,
        losers: stats.losers,
        breakeven: stats.breakeven,
        winRate: winRate.toFixed(1),
        avgReturn: stats.avg_return?.toFixed(2) || '0.00',
        totalPnL: stats.total_pnl?.toFixed(2) || '0.00',
        avgWin: stats.avg_win?.toFixed(2) || '0.00',
        avgLoss: stats.avg_loss?.toFixed(2) || '0.00',
        bestTrade: stats.best_trade?.toFixed(2) || '0.00',
        worstTrade: stats.worst_trade?.toFixed(2) || '0.00',
        profitFactor: profitFactor.toFixed(2),
        riskRewardRatio: stats.avg_loss !== 0 ?
          Math.abs(stats.avg_win / stats.avg_loss).toFixed(2) : 'N/A'
      };
    } catch (error) {
      logger.error('Error getting overall win rate', { error: error.message });
      return { error: error.message };
    }
  }

  // Get win rate by signal type
  getWinRateBySignalType() {
    try {
      const results = database.db.prepare(`
        SELECT
          COALESCE(
            CASE
              WHEN recommendation LIKE '%volume%' THEN 'Volume Spike'
              WHEN recommendation LIKE '%breakout%' THEN 'Breakout'
              WHEN recommendation LIKE '%momentum%' THEN 'Momentum'
              WHEN recommendation LIKE '%gap%' THEN 'Gap Play'
              WHEN recommendation LIKE '%VWAP%' THEN 'VWAP'
              ELSE 'Other'
            END, 'Other'
          ) as signal_type,
          COUNT(*) as total,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          AVG(pnl_percent) as avg_return,
          SUM(pnl_dollars) as total_pnl
        FROM paper_trades
        WHERE status = 'CLOSED'
        GROUP BY signal_type
        HAVING total >= 3
        ORDER BY avg_return DESC
      `).all();

      return results.map(r => ({
        signalType: r.signal_type,
        totalTrades: r.total,
        winRate: ((r.winners / r.total) * 100).toFixed(1),
        avgReturn: r.avg_return?.toFixed(2) || '0.00',
        totalPnL: r.total_pnl?.toFixed(2) || '0.00',
        grade: this.getGrade(r.winners / r.total, r.avg_return)
      }));
    } catch (error) {
      return [];
    }
  }

  // Get win rate by heat score range
  getWinRateByHeatScore() {
    try {
      const results = database.db.prepare(`
        SELECT
          CASE
            WHEN confidence_score >= 90 THEN '90-100 (Fire)'
            WHEN confidence_score >= 80 THEN '80-89 (High)'
            WHEN confidence_score >= 70 THEN '70-79 (Good)'
            WHEN confidence_score >= 60 THEN '60-69 (Moderate)'
            ELSE 'Below 60'
          END as score_range,
          COUNT(*) as total,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          AVG(pnl_percent) as avg_return,
          SUM(pnl_dollars) as total_pnl
        FROM paper_trades
        WHERE status = 'CLOSED'
        GROUP BY score_range
        ORDER BY
          CASE score_range
            WHEN '90-100 (Fire)' THEN 1
            WHEN '80-89 (High)' THEN 2
            WHEN '70-79 (Good)' THEN 3
            WHEN '60-69 (Moderate)' THEN 4
            ELSE 5
          END
      `).all();

      return results.map(r => ({
        scoreRange: r.score_range,
        totalTrades: r.total,
        winRate: ((r.winners / r.total) * 100).toFixed(1),
        avgReturn: r.avg_return?.toFixed(2) || '0.00',
        totalPnL: r.total_pnl?.toFixed(2) || '0.00'
      }));
    } catch (error) {
      return [];
    }
  }

  // Get win rate by time of day
  getWinRateByTimeOfDay() {
    try {
      const results = database.db.prepare(`
        SELECT
          CASE
            WHEN CAST(strftime('%H', created_at) AS INTEGER) < 10 THEN 'Open (9:30-10)'
            WHEN CAST(strftime('%H', created_at) AS INTEGER) < 11 THEN 'Morning (10-11)'
            WHEN CAST(strftime('%H', created_at) AS INTEGER) < 12 THEN 'Mid-Morning (11-12)'
            WHEN CAST(strftime('%H', created_at) AS INTEGER) < 14 THEN 'Lunch (12-2)'
            WHEN CAST(strftime('%H', created_at) AS INTEGER) < 15 THEN 'Afternoon (2-3)'
            ELSE 'Power Hour (3-4)'
          END as time_period,
          COUNT(*) as total,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          AVG(pnl_percent) as avg_return
        FROM paper_trades
        WHERE status = 'CLOSED'
        GROUP BY time_period
        HAVING total >= 3
      `).all();

      return results.map(r => ({
        timePeriod: r.time_period,
        totalTrades: r.total,
        winRate: ((r.winners / r.total) * 100).toFixed(1),
        avgReturn: r.avg_return?.toFixed(2) || '0.00'
      }));
    } catch (error) {
      return [];
    }
  }

  // Get win rate by sector (using ticker)
  getWinRateBySector() {
    try {
      // Map tickers to sectors
      const sectorMap = {
        'AAPL': 'Technology', 'MSFT': 'Technology', 'NVDA': 'Technology', 'AMD': 'Technology',
        'GOOGL': 'Technology', 'META': 'Technology', 'TSLA': 'Consumer Disc',
        'AMZN': 'Consumer Disc', 'JPM': 'Financials', 'BAC': 'Financials',
        'XOM': 'Energy', 'CVX': 'Energy', 'UNH': 'Healthcare', 'JNJ': 'Healthcare',
        'SPY': 'Index', 'QQQ': 'Index', 'IWM': 'Index'
      };

      const trades = database.db.prepare(`
        SELECT ticker, pnl_dollars, pnl_percent
        FROM paper_trades
        WHERE status = 'CLOSED'
      `).all();

      // Aggregate by sector
      const sectorStats = {};

      for (const trade of trades) {
        const sector = sectorMap[trade.ticker] || 'Other';
        if (!sectorStats[sector]) {
          sectorStats[sector] = { total: 0, winners: 0, pnl: 0, returns: [] };
        }
        sectorStats[sector].total++;
        if (trade.pnl_dollars > 0) sectorStats[sector].winners++;
        sectorStats[sector].pnl += trade.pnl_dollars || 0;
        sectorStats[sector].returns.push(trade.pnl_percent || 0);
      }

      return Object.entries(sectorStats)
        .filter(([_, s]) => s.total >= 2)
        .map(([sector, s]) => ({
          sector,
          totalTrades: s.total,
          winRate: ((s.winners / s.total) * 100).toFixed(1),
          avgReturn: (s.returns.reduce((a, b) => a + b, 0) / s.returns.length).toFixed(2),
          totalPnL: s.pnl.toFixed(2)
        }))
        .sort((a, b) => parseFloat(b.avgReturn) - parseFloat(a.avgReturn));
    } catch (error) {
      return [];
    }
  }

  // Get win rate by day of week
  getWinRateByDayOfWeek() {
    try {
      const results = database.db.prepare(`
        SELECT
          CASE CAST(strftime('%w', created_at) AS INTEGER)
            WHEN 0 THEN 'Sunday'
            WHEN 1 THEN 'Monday'
            WHEN 2 THEN 'Tuesday'
            WHEN 3 THEN 'Wednesday'
            WHEN 4 THEN 'Thursday'
            WHEN 5 THEN 'Friday'
            WHEN 6 THEN 'Saturday'
          END as day_of_week,
          COUNT(*) as total,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          AVG(pnl_percent) as avg_return
        FROM paper_trades
        WHERE status = 'CLOSED'
        GROUP BY day_of_week
        HAVING total >= 2
      `).all();

      return results.map(r => ({
        day: r.day_of_week,
        totalTrades: r.total,
        winRate: ((r.winners / r.total) * 100).toFixed(1),
        avgReturn: r.avg_return?.toFixed(2) || '0.00'
      }));
    } catch (error) {
      return [];
    }
  }

  // Get streak analysis
  getStreakAnalysis() {
    try {
      const trades = database.db.prepare(`
        SELECT pnl_dollars, created_at
        FROM paper_trades
        WHERE status = 'CLOSED'
        ORDER BY created_at ASC
      `).all();

      if (trades.length === 0) {
        return { currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 };
      }

      let currentStreak = 0;
      let maxWinStreak = 0;
      let maxLossStreak = 0;
      let tempStreak = 0;
      let lastWin = null;

      for (const trade of trades) {
        const isWin = trade.pnl_dollars > 0;

        if (lastWin === null) {
          tempStreak = 1;
          lastWin = isWin;
        } else if (isWin === lastWin) {
          tempStreak++;
        } else {
          if (lastWin) {
            maxWinStreak = Math.max(maxWinStreak, tempStreak);
          } else {
            maxLossStreak = Math.max(maxLossStreak, tempStreak);
          }
          tempStreak = 1;
          lastWin = isWin;
        }
      }

      // Check final streak
      if (lastWin) {
        maxWinStreak = Math.max(maxWinStreak, tempStreak);
      } else {
        maxLossStreak = Math.max(maxLossStreak, tempStreak);
      }

      // Current streak
      const recentTrades = trades.slice(-10).reverse();
      currentStreak = 0;
      const firstTradeWin = recentTrades[0]?.pnl_dollars > 0;
      for (const trade of recentTrades) {
        if ((trade.pnl_dollars > 0) === firstTradeWin) {
          currentStreak++;
        } else {
          break;
        }
      }

      return {
        currentStreak: firstTradeWin ? currentStreak : -currentStreak,
        currentStreakType: firstTradeWin ? 'WIN' : 'LOSS',
        maxWinStreak,
        maxLossStreak
      };
    } catch (error) {
      return { currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 };
    }
  }

  // Calculate mathematical expectancy
  calculateExpectancy() {
    try {
      const stats = database.db.prepare(`
        SELECT
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          SUM(CASE WHEN pnl_dollars < 0 THEN 1 ELSE 0 END) as losers,
          AVG(CASE WHEN pnl_dollars > 0 THEN pnl_percent ELSE NULL END) as avg_win,
          AVG(CASE WHEN pnl_dollars < 0 THEN ABS(pnl_percent) ELSE NULL END) as avg_loss,
          COUNT(*) as total
        FROM paper_trades
        WHERE status = 'CLOSED' AND pnl_dollars != 0
      `).get();

      if (!stats || stats.total === 0) {
        return { expectancy: 0, message: 'Insufficient data' };
      }

      const winRate = stats.winners / stats.total;
      const lossRate = stats.losers / stats.total;
      const avgWin = stats.avg_win || 0;
      const avgLoss = stats.avg_loss || 0;

      // Expectancy = (Win Rate × Average Win) - (Loss Rate × Average Loss)
      const expectancy = (winRate * avgWin) - (lossRate * avgLoss);

      // Kelly Criterion for optimal position sizing
      const kellyPercent = avgLoss > 0 ?
        (winRate - (lossRate / (avgWin / avgLoss))) * 100 : 0;

      return {
        expectancy: expectancy.toFixed(2),
        expectancyPerTrade: `${expectancy > 0 ? '+' : ''}${expectancy.toFixed(2)}%`,
        isPositive: expectancy > 0,
        kellyCriterion: Math.max(0, kellyPercent).toFixed(1),
        interpretation: this.interpretExpectancy(expectancy)
      };
    } catch (error) {
      return { expectancy: 0, error: error.message };
    }
  }

  // Interpret expectancy value
  interpretExpectancy(expectancy) {
    if (expectancy > 2.0) return 'Excellent edge - system is highly profitable';
    if (expectancy > 1.0) return 'Good edge - profitable system';
    if (expectancy > 0.5) return 'Slight edge - marginally profitable';
    if (expectancy > 0) return 'Break even - needs improvement';
    if (expectancy > -1.0) return 'Negative edge - review losing trades';
    return 'Significant negative edge - system needs major changes';
  }

  // Get recent performance (last 7 days)
  getRecentPerformance() {
    try {
      const results = database.db.prepare(`
        SELECT
          DATE(created_at) as trade_date,
          COUNT(*) as trades,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          SUM(pnl_dollars) as daily_pnl
        FROM paper_trades
        WHERE status = 'CLOSED'
          AND created_at >= DATE('now', '-7 days')
        GROUP BY trade_date
        ORDER BY trade_date DESC
      `).all();

      return results.map(r => ({
        date: r.trade_date,
        trades: r.trades,
        winRate: ((r.winners / r.trades) * 100).toFixed(0),
        pnl: r.daily_pnl?.toFixed(2) || '0.00',
        isGreenDay: r.daily_pnl > 0
      }));
    } catch (error) {
      return [];
    }
  }

  // Get grade based on win rate and return
  getGrade(winRate, avgReturn) {
    const score = (winRate * 50) + (avgReturn * 10);
    if (score > 60) return 'A';
    if (score > 45) return 'B';
    if (score > 30) return 'C';
    if (score > 15) return 'D';
    return 'F';
  }

  // Format win rate stats for Discord
  formatWinRateEmbed() {
    const { EmbedBuilder } = require('discord.js');
    const overall = this.getOverallWinRate();

    if (overall.totalTrades === 0) {
      return new EmbedBuilder()
        .setTitle('📊 Win Rate Analysis')
        .setDescription('No closed trades yet. Complete some paper trades to see your stats!')
        .setColor(0x808080);
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 Win Rate Analysis')
      .setColor(parseFloat(overall.totalPnL) >= 0 ? 0x00FF00 : 0xFF0000)
      .setTimestamp();

    // Overall stats
    const winEmoji = parseFloat(overall.winRate) >= 50 ? '🟢' : '🔴';
    let description = `${winEmoji} **Overall Win Rate: ${overall.winRate}%**\n\n`;
    description += `📈 Total Trades: ${overall.totalTrades}\n`;
    description += `✅ Winners: ${overall.winners} | ❌ Losers: ${overall.losers}\n`;
    description += `💰 Total P&L: $${overall.totalPnL}\n`;
    description += `📊 Avg Win: +${overall.avgWin}% | Avg Loss: ${overall.avgLoss}%\n`;
    description += `🎯 Profit Factor: ${overall.profitFactor}\n`;

    embed.setDescription(description);

    // Win rate by heat score
    const byScore = this.getWinRateByHeatScore();
    if (byScore.length > 0) {
      const scoreText = byScore.map(s =>
        `${s.scoreRange}: ${s.winRate}% (${s.totalTrades} trades)`
      ).join('\n');
      embed.addFields({
        name: '🔥 By Heat Score',
        value: scoreText || 'N/A',
        inline: false
      });
    }

    // Streaks
    const streaks = this.getStreakAnalysis();
    const streakEmoji = streaks.currentStreak > 0 ? '🔥' : '❄️';
    embed.addFields({
      name: `${streakEmoji} Streaks`,
      value: `Current: ${Math.abs(streaks.currentStreak)} ${streaks.currentStreakType}\n` +
             `Max Win: ${streaks.maxWinStreak} | Max Loss: ${streaks.maxLossStreak}`,
      inline: true
    });

    // Expectancy
    const expectancy = this.calculateExpectancy();
    embed.addFields({
      name: '🎲 Expectancy',
      value: `${expectancy.expectancyPerTrade} per trade\n${expectancy.interpretation}`,
      inline: true
    });

    return embed;
  }

  // Format detailed backtest report
  formatBacktestReport() {
    const { EmbedBuilder } = require('discord.js');
    const stats = this.getWinRateStats();

    const embeds = [];

    // Main stats embed
    const mainEmbed = this.formatWinRateEmbed();
    embeds.push(mainEmbed);

    // By time of day embed
    const byTime = this.getWinRateByTimeOfDay();
    if (byTime.length > 0) {
      const timeEmbed = new EmbedBuilder()
        .setTitle('⏰ Performance by Time of Day')
        .setColor(0x3498DB);

      const timeText = byTime.map(t =>
        `**${t.timePeriod}**: ${t.winRate}% win rate, ${t.avgReturn}% avg (${t.totalTrades} trades)`
      ).join('\n');

      timeEmbed.setDescription(timeText);
      embeds.push(timeEmbed);
    }

    // By day of week embed
    const byDay = this.getWinRateByDayOfWeek();
    if (byDay.length > 0) {
      const dayEmbed = new EmbedBuilder()
        .setTitle('📅 Performance by Day of Week')
        .setColor(0x9B59B6);

      const dayText = byDay.map(d =>
        `**${d.day}**: ${d.winRate}% win rate, ${d.avgReturn}% avg`
      ).join('\n');

      dayEmbed.setDescription(dayText);
      embeds.push(dayEmbed);
    }

    return embeds;
  }

  // Get trade recommendations based on historical performance
  getTradeRecommendations() {
    const byScore = this.getWinRateByHeatScore();
    const byTime = this.getWinRateByTimeOfDay();

    const recommendations = [];

    // Find best performing heat score range
    const bestScore = byScore.sort((a, b) =>
      parseFloat(b.avgReturn) - parseFloat(a.avgReturn)
    )[0];

    if (bestScore && parseFloat(bestScore.winRate) > 50) {
      recommendations.push(
        `Focus on ${bestScore.scoreRange} heat score signals (${bestScore.winRate}% win rate)`
      );
    }

    // Find best time of day
    const bestTime = byTime.sort((a, b) =>
      parseFloat(b.avgReturn) - parseFloat(a.avgReturn)
    )[0];

    if (bestTime && parseFloat(bestTime.winRate) > 50) {
      recommendations.push(
        `Best performance during ${bestTime.timePeriod} (${bestTime.winRate}% win rate)`
      );
    }

    // Check expectancy
    const expectancy = this.calculateExpectancy();
    if (expectancy.isPositive) {
      recommendations.push(
        `System has positive expectancy (+${expectancy.expectancy}% per trade)`
      );
    } else {
      recommendations.push(
        `System has negative expectancy - consider adjusting strategy`
      );
    }

    return recommendations;
  }
}

module.exports = new WinRateTracker();
