const database = require('../database/sqlite');
const logger = require('./logger');
const axios = require('axios');
const config = require('../../config');

class PaperTrading {
  constructor() {
    this.activeTrades = new Map(); // In-memory tracking of open trades
    this.dayResults = {
      trades: [],
      winners: 0,
      losers: 0,
      totalPnL: 0,
      totalPnLPercent: 0
    };
    this.initialized = false;
  }

  // Initialize paper trading system
  initialize() {
    this.createTable();
    this.loadActiveTrades();
    this.initialized = true;
    logger.info('Paper trading system initialized');
  }

  // Create paper trades table
  createTable() {
    try {
      database.db.exec(`
        CREATE TABLE IF NOT EXISTS paper_trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticker TEXT NOT NULL,
          direction TEXT NOT NULL,
          entry_price REAL NOT NULL,
          target_price REAL NOT NULL,
          stop_price REAL NOT NULL,
          option_type TEXT,
          option_strike REAL,
          option_expiry TEXT,
          confidence_score INTEGER NOT NULL,
          recommendation TEXT NOT NULL,
          factors TEXT,
          warnings TEXT,
          status TEXT DEFAULT 'OPEN',
          exit_price REAL,
          exit_reason TEXT,
          pnl_percent REAL,
          pnl_dollars REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          closed_at DATETIME,
          trade_date TEXT DEFAULT (DATE('now'))
        )
      `);

      // Index for quick lookups
      database.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
        CREATE INDEX IF NOT EXISTS idx_paper_trades_date ON paper_trades(trade_date);
        CREATE INDEX IF NOT EXISTS idx_paper_trades_ticker ON paper_trades(ticker);
      `);

      logger.debug('Paper trades table created/verified');
    } catch (error) {
      logger.error('Error creating paper trades table', { error: error.message });
    }
  }

  // Load active trades from database
  loadActiveTrades() {
    try {
      const trades = database.db.prepare(`
        SELECT * FROM paper_trades
        WHERE status = 'OPEN'
        AND trade_date = DATE('now')
      `).all();

      for (const trade of trades) {
        this.activeTrades.set(trade.id, trade);
      }

      logger.info(`Loaded ${trades.length} active paper trades`);
    } catch (error) {
      logger.error('Error loading active trades', { error: error.message });
    }
  }

  // Open a new paper trade
  openTrade(recommendation) {
    try {
      const stmt = database.db.prepare(`
        INSERT INTO paper_trades (
          ticker, direction, entry_price, target_price, stop_price,
          option_type, option_strike, option_expiry,
          confidence_score, recommendation, factors, warnings
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        recommendation.ticker,
        recommendation.direction,
        recommendation.targets.entry,
        recommendation.targets.target,
        recommendation.targets.stopLoss,
        recommendation.optionSuggestion?.type || null,
        recommendation.optionSuggestion?.strike || null,
        recommendation.optionSuggestion?.expiration || null,
        recommendation.confidenceScore,
        recommendation.recommendation.action,
        JSON.stringify(recommendation.factors),
        JSON.stringify(recommendation.warnings)
      );

      const tradeId = result.lastInsertRowid;

      // Add to active trades
      const trade = {
        id: tradeId,
        ticker: recommendation.ticker,
        direction: recommendation.direction,
        entry_price: recommendation.targets.entry,
        target_price: recommendation.targets.target,
        stop_price: recommendation.targets.stopLoss,
        option_type: recommendation.optionSuggestion?.type,
        option_strike: recommendation.optionSuggestion?.strike,
        option_expiry: recommendation.optionSuggestion?.expiration,
        confidence_score: recommendation.confidenceScore,
        recommendation: recommendation.recommendation.action,
        status: 'OPEN',
        created_at: new Date().toISOString()
      };

      this.activeTrades.set(tradeId, trade);

      logger.info(`Opened paper trade #${tradeId}: ${recommendation.ticker} ${recommendation.direction} @ $${recommendation.targets.entry}`);

      return tradeId;
    } catch (error) {
      logger.error('Error opening paper trade', { error: error.message });
      return null;
    }
  }

  // Close a trade with exit price and reason
  closeTrade(tradeId, exitPrice, exitReason) {
    try {
      const trade = this.activeTrades.get(tradeId);
      if (!trade) {
        logger.warn(`Trade ${tradeId} not found in active trades`);
        return null;
      }

      const isBullish = trade.direction === 'BULLISH';
      const pnlPercent = isBullish
        ? ((exitPrice - trade.entry_price) / trade.entry_price) * 100
        : ((trade.entry_price - exitPrice) / trade.entry_price) * 100;

      // Assume $1000 position size for dollar P&L
      const positionSize = 1000;
      const pnlDollars = (pnlPercent / 100) * positionSize;

      const stmt = database.db.prepare(`
        UPDATE paper_trades SET
          status = 'CLOSED',
          exit_price = ?,
          exit_reason = ?,
          pnl_percent = ?,
          pnl_dollars = ?,
          closed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      stmt.run(exitPrice, exitReason, pnlPercent, pnlDollars, tradeId);

      // Remove from active trades
      this.activeTrades.delete(tradeId);

      // Update day results
      this.dayResults.trades.push({
        ...trade,
        exit_price: exitPrice,
        exit_reason: exitReason,
        pnl_percent: pnlPercent,
        pnl_dollars: pnlDollars
      });

      if (pnlPercent > 0) {
        this.dayResults.winners++;
      } else {
        this.dayResults.losers++;
      }
      this.dayResults.totalPnL += pnlDollars;
      this.dayResults.totalPnLPercent += pnlPercent;

      logger.info(`Closed paper trade #${tradeId}: ${trade.ticker} ${exitReason} P&L: ${pnlPercent.toFixed(2)}%`);

      return {
        tradeId,
        ticker: trade.ticker,
        pnlPercent,
        pnlDollars,
        exitReason
      };
    } catch (error) {
      logger.error('Error closing paper trade', { error: error.message });
      return null;
    }
  }

  // Check active trades against current prices
  async checkActiveTrades(priceData) {
    const closedTrades = [];

    for (const [tradeId, trade] of this.activeTrades) {
      const currentPrice = priceData[trade.ticker];
      if (!currentPrice) continue;

      const isBullish = trade.direction === 'BULLISH';

      // Check if target hit
      if (isBullish && currentPrice >= trade.target_price) {
        const result = this.closeTrade(tradeId, currentPrice, 'TARGET_HIT');
        if (result) closedTrades.push(result);
      } else if (!isBullish && currentPrice <= trade.target_price) {
        const result = this.closeTrade(tradeId, currentPrice, 'TARGET_HIT');
        if (result) closedTrades.push(result);
      }
      // Check if stop hit
      else if (isBullish && currentPrice <= trade.stop_price) {
        const result = this.closeTrade(tradeId, currentPrice, 'STOP_LOSS');
        if (result) closedTrades.push(result);
      } else if (!isBullish && currentPrice >= trade.stop_price) {
        const result = this.closeTrade(tradeId, currentPrice, 'STOP_LOSS');
        if (result) closedTrades.push(result);
      }
    }

    return closedTrades;
  }

  // Fetch current prices for active trades
  async fetchPricesForTrades() {
    const tickers = [...new Set([...this.activeTrades.values()].map(t => t.ticker))];
    if (tickers.length === 0) return {};

    const prices = {};

    for (const ticker of tickers) {
      try {
        const response = await axios.get(
          `${config.polygon.restUrl}/v2/aggs/ticker/${ticker}/prev`,
          {
            params: { apiKey: config.polygon.apiKey },
            timeout: 5000
          }
        );

        if (response.data?.results?.[0]) {
          prices[ticker] = response.data.results[0].c;
        }
      } catch (error) {
        // Silent fail for individual tickers
      }
    }

    return prices;
  }

  // Close all remaining trades at market close
  async closeAllAtMarketClose() {
    const prices = await this.fetchPricesForTrades();
    const closedTrades = [];

    for (const [tradeId, trade] of this.activeTrades) {
      const currentPrice = prices[trade.ticker] || trade.entry_price;
      const result = this.closeTrade(tradeId, currentPrice, 'MARKET_CLOSE');
      if (result) closedTrades.push(result);
    }

    return closedTrades;
  }

  // Get today's paper trades
  getTodayTrades() {
    try {
      return database.db.prepare(`
        SELECT * FROM paper_trades
        WHERE trade_date = DATE('now')
        ORDER BY created_at DESC
      `).all();
    } catch (error) {
      logger.error('Error getting today trades', { error: error.message });
      return [];
    }
  }

  // Get active (open) trades
  getActiveTrades() {
    return [...this.activeTrades.values()];
  }

  // Get today's performance summary
  getTodaySummary() {
    try {
      const stats = database.db.prepare(`
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN status = 'CLOSED' AND pnl_percent > 0 THEN 1 ELSE 0 END) as winners,
          SUM(CASE WHEN status = 'CLOSED' AND pnl_percent <= 0 THEN 1 ELSE 0 END) as losers,
          SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_trades,
          AVG(CASE WHEN status = 'CLOSED' THEN pnl_percent END) as avg_pnl_percent,
          SUM(CASE WHEN status = 'CLOSED' THEN pnl_dollars END) as total_pnl_dollars,
          SUM(CASE WHEN exit_reason = 'TARGET_HIT' THEN 1 ELSE 0 END) as targets_hit,
          SUM(CASE WHEN exit_reason = 'STOP_LOSS' THEN 1 ELSE 0 END) as stops_hit,
          AVG(confidence_score) as avg_confidence
        FROM paper_trades
        WHERE trade_date = DATE('now')
      `).get();

      // Get trades by direction
      const byDirection = database.db.prepare(`
        SELECT
          direction,
          COUNT(*) as count,
          AVG(pnl_percent) as avg_pnl
        FROM paper_trades
        WHERE trade_date = DATE('now') AND status = 'CLOSED'
        GROUP BY direction
      `).all();

      // Get best and worst trades
      const bestTrade = database.db.prepare(`
        SELECT ticker, pnl_percent, direction, recommendation
        FROM paper_trades
        WHERE trade_date = DATE('now') AND status = 'CLOSED'
        ORDER BY pnl_percent DESC
        LIMIT 1
      `).get();

      const worstTrade = database.db.prepare(`
        SELECT ticker, pnl_percent, direction, recommendation
        FROM paper_trades
        WHERE trade_date = DATE('now') AND status = 'CLOSED'
        ORDER BY pnl_percent ASC
        LIMIT 1
      `).get();

      // Get by confidence level
      const byConfidence = database.db.prepare(`
        SELECT
          CASE
            WHEN confidence_score >= 85 THEN 'High (85+)'
            WHEN confidence_score >= 70 THEN 'Medium (70-84)'
            ELSE 'Low (<70)'
          END as confidence_level,
          COUNT(*) as count,
          AVG(pnl_percent) as avg_pnl,
          SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as winners
        FROM paper_trades
        WHERE trade_date = DATE('now') AND status = 'CLOSED'
        GROUP BY confidence_level
      `).all();

      return {
        ...stats,
        byDirection,
        byConfidence,
        bestTrade,
        worstTrade,
        winRate: stats.winners && (stats.winners + stats.losers) > 0
          ? ((stats.winners / (stats.winners + stats.losers)) * 100).toFixed(1)
          : 0
      };
    } catch (error) {
      logger.error('Error getting today summary', { error: error.message });
      return null;
    }
  }

  // Get historical performance (last N days)
  getHistoricalPerformance(days = 7) {
    try {
      return database.db.prepare(`
        SELECT
          trade_date,
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) as winners,
          SUM(CASE WHEN pnl_percent <= 0 THEN 1 ELSE 0 END) as losers,
          AVG(pnl_percent) as avg_pnl_percent,
          SUM(pnl_dollars) as total_pnl_dollars
        FROM paper_trades
        WHERE status = 'CLOSED'
          AND trade_date >= DATE('now', '-' || ? || ' days')
        GROUP BY trade_date
        ORDER BY trade_date DESC
      `).all(days);
    } catch (error) {
      logger.error('Error getting historical performance', { error: error.message });
      return [];
    }
  }

  // Format recap for Discord
  formatRecapForDiscord() {
    const summary = this.getTodaySummary();
    if (!summary || summary.total_trades === 0) {
      return '**Paper Trading Recap**\n\nNo paper trades today.';
    }

    const lines = [];
    lines.push('**📊 Paper Trading Daily Recap**\n');

    // Overall stats
    lines.push('**Overall Performance:**');
    lines.push(`Total Trades: ${summary.total_trades} | Open: ${summary.open_trades || 0}`);

    const closedCount = (summary.winners || 0) + (summary.losers || 0);
    if (closedCount > 0) {
      lines.push(`Win Rate: ${summary.winRate}% (${summary.winners}W / ${summary.losers}L)`);
      lines.push(`Avg P&L: ${summary.avg_pnl_percent?.toFixed(2) || 0}%`);
      lines.push(`Total P&L: $${summary.total_pnl_dollars?.toFixed(2) || 0} (based on $1000/trade)\n`);

      // Exit stats
      lines.push('**Trade Exits:**');
      lines.push(`Targets Hit: ${summary.targets_hit || 0} | Stops Hit: ${summary.stops_hit || 0}`);
    }

    // By direction
    if (summary.byDirection && summary.byDirection.length > 0) {
      lines.push('\n**By Direction:**');
      for (const dir of summary.byDirection) {
        lines.push(`${dir.direction}: ${dir.count} trades, Avg ${dir.avg_pnl?.toFixed(2) || 0}%`);
      }
    }

    // By confidence
    if (summary.byConfidence && summary.byConfidence.length > 0) {
      lines.push('\n**By Confidence Level:**');
      for (const conf of summary.byConfidence) {
        const winRate = conf.count > 0 ? ((conf.winners / conf.count) * 100).toFixed(0) : 0;
        lines.push(`${conf.confidence_level}: ${conf.count} trades, ${winRate}% win rate, Avg ${conf.avg_pnl?.toFixed(2) || 0}%`);
      }
    }

    // Best/worst trades
    if (summary.bestTrade) {
      lines.push(`\n**Best Trade:** ${summary.bestTrade.ticker} ${summary.bestTrade.direction} +${summary.bestTrade.pnl_percent?.toFixed(2)}%`);
    }
    if (summary.worstTrade) {
      lines.push(`**Worst Trade:** ${summary.worstTrade.ticker} ${summary.worstTrade.direction} ${summary.worstTrade.pnl_percent?.toFixed(2)}%`);
    }

    // Insight
    lines.push('\n---');
    if (parseFloat(summary.winRate) >= 60) {
      lines.push('*Strong day! The signals are working well.*');
    } else if (parseFloat(summary.winRate) >= 50) {
      lines.push('*Decent performance. Continue monitoring signal quality.*');
    } else if (closedCount > 0) {
      lines.push('*Challenging day. Review which factors led to losing trades.*');
    }

    return lines.join('\n');
  }

  // Format active trades for Discord
  formatActiveTradesForDiscord() {
    const trades = this.getActiveTrades();
    if (trades.length === 0) {
      return '**Open Paper Trades**\n\nNo active paper trades.';
    }

    const lines = [];
    lines.push(`**📈 Open Paper Trades (${trades.length})**\n`);

    for (const trade of trades) {
      const emoji = trade.direction === 'BULLISH' ? '🟢' : '🔴';
      lines.push(`${emoji} **${trade.ticker}** ${trade.direction}`);
      lines.push(`   Entry: $${trade.entry_price.toFixed(2)} | Target: $${trade.target_price.toFixed(2)} | Stop: $${trade.stop_price.toFixed(2)}`);
      if (trade.option_type) {
        lines.push(`   Option: ${trade.option_strike} ${trade.option_type} ${trade.option_expiry}`);
      }
      lines.push(`   Confidence: ${trade.confidence_score}/100`);
      lines.push('');
    }

    return lines.join('\n');
  }

  // Reset daily tracking
  resetDailyTracking() {
    this.dayResults = {
      trades: [],
      winners: 0,
      losers: 0,
      totalPnL: 0,
      totalPnLPercent: 0
    };
    this.activeTrades.clear();
    this.loadActiveTrades();
  }

  // Check if we should open a trade (avoid duplicates)
  shouldOpenTrade(ticker, direction) {
    // Check if we already have an open trade for this ticker in same direction
    for (const trade of this.activeTrades.values()) {
      if (trade.ticker === ticker && trade.direction === direction) {
        return false;
      }
    }
    return true;
  }

  // Get trade count for today
  getTodayTradeCount() {
    try {
      const result = database.db.prepare(`
        SELECT COUNT(*) as count FROM paper_trades
        WHERE trade_date = DATE('now')
      `).get();
      return result.count;
    } catch (error) {
      return 0;
    }
  }
}

// Export singleton
module.exports = new PaperTrading();
