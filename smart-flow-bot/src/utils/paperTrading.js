const database = require('../database/sqlite');
const logger = require('./logger');
const axios = require('axios');
const config = require('../../config');

class PaperTrading {
  constructor() {
    this.activeTrades = new Map();
    this.dayResults = {
      trades: [],
      winners: 0,
      losers: 0,
      totalPnL: 0,
      totalPnLPercent: 0
    };
    this.initialized = false;

    // Position sizing
    this.POSITION_SIZE = 2000; // $2000 per trade

    // Option leverage estimate (slightly OTM options move ~3.5x underlying)
    this.OPTION_LEVERAGE = 3.5;

    // Alert thresholds for proximity warnings
    this.PARTIAL_PROFIT_THRESHOLD = 0.6; // Alert when 60% of the way to partial target
    this.TARGET_PROXIMITY_THRESHOLD = 0.8; // Alert when 80% of the way to target
    this.STOP_PROXIMITY_THRESHOLD = 0.7; // Alert when 70% of the way to stop

    // Max daily loss protection
    this.MAX_DAILY_LOSS = 500; // Stop trading after losing $500 in a day
    this.MAX_CONSECUTIVE_LOSSES = 3; // Stop after 3 consecutive losses
    this.consecutiveLosses = 0;
    this.dailyLossLimitHit = false;
    this.dailyLossLimitMessage = null;
  }

  initialize() {
    this.createTable();
    this.loadActiveTrades();
    this.initialized = true;
    logger.info('Paper trading system initialized');
  }

  createTable() {
    try {
      // Enhanced table with more tracking fields
      database.db.exec(`
        CREATE TABLE IF NOT EXISTS paper_trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ticker TEXT NOT NULL,
          direction TEXT NOT NULL,
          entry_price REAL NOT NULL,
          partial_target REAL,
          target_price REAL NOT NULL,
          stop_price REAL NOT NULL,
          trailing_stop REAL,
          option_type TEXT,
          option_strike REAL,
          option_expiry TEXT,
          option_contracts INTEGER DEFAULT 1,
          estimated_premium REAL,
          confidence_score INTEGER NOT NULL,
          recommendation TEXT NOT NULL,
          factors TEXT,
          warnings TEXT,
          status TEXT DEFAULT 'OPEN',
          partial_filled INTEGER DEFAULT 0,
          exit_price REAL,
          exit_reason TEXT,
          stock_pnl_percent REAL,
          option_pnl_percent REAL,
          pnl_dollars REAL,
          high_price REAL,
          low_price REAL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          closed_at DATETIME,
          trade_date TEXT DEFAULT (DATE('now'))
        )
      `);

      database.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
        CREATE INDEX IF NOT EXISTS idx_paper_trades_date ON paper_trades(trade_date);
        CREATE INDEX IF NOT EXISTS idx_paper_trades_ticker ON paper_trades(ticker);
      `);

      logger.debug('Paper trades table ready');
    } catch (error) {
      logger.error('Error creating paper trades table', { error: error.message });
    }
  }

  loadActiveTrades() {
    try {
      const trades = database.db.prepare(`
        SELECT * FROM paper_trades
        WHERE status = 'OPEN'
        AND trade_date = DATE('now')
      `).all();

      for (const trade of trades) {
        this.activeTrades.set(trade.id, {
          ...trade,
          factors: JSON.parse(trade.factors || '[]'),
          warnings: JSON.parse(trade.warnings || '[]')
        });
      }

      logger.info(`Loaded ${trades.length} active paper trades`);
    } catch (error) {
      logger.error('Error loading active trades', { error: error.message });
    }
  }

  // Open a new paper trade with enhanced tracking
  openTrade(recommendation) {
    try {
      const stmt = database.db.prepare(`
        INSERT INTO paper_trades (
          ticker, direction, entry_price, partial_target, target_price, stop_price,
          option_type, option_strike, option_expiry, option_contracts, estimated_premium,
          confidence_score, recommendation, factors, warnings, high_price, low_price
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        recommendation.ticker,
        recommendation.direction,
        recommendation.targets.entry,
        recommendation.targets.partialTarget || null,
        recommendation.targets.target,
        recommendation.targets.stopLoss,
        recommendation.optionSuggestion?.type || null,
        recommendation.optionSuggestion?.strike || null,
        recommendation.optionSuggestion?.expiration || null,
        recommendation.optionSuggestion?.suggestedContracts || 1,
        recommendation.optionSuggestion?.estimatedPremium || null,
        recommendation.confidenceScore,
        recommendation.recommendation.action,
        JSON.stringify(recommendation.factors),
        JSON.stringify(recommendation.warnings),
        recommendation.targets.entry, // high starts at entry
        recommendation.targets.entry  // low starts at entry
      );

      const tradeId = result.lastInsertRowid;

      const trade = {
        id: tradeId,
        ticker: recommendation.ticker,
        direction: recommendation.direction,
        entry_price: recommendation.targets.entry,
        partial_target: recommendation.targets.partialTarget,
        target_price: recommendation.targets.target,
        stop_price: recommendation.targets.stopLoss,
        trailing_stop: null,
        option_type: recommendation.optionSuggestion?.type,
        option_strike: recommendation.optionSuggestion?.strike,
        option_expiry: recommendation.optionSuggestion?.expiration,
        option_contracts: recommendation.optionSuggestion?.suggestedContracts || 1,
        estimated_premium: recommendation.optionSuggestion?.estimatedPremium,
        confidence_score: recommendation.confidenceScore,
        recommendation: recommendation.recommendation.action,
        factors: recommendation.factors,
        warnings: recommendation.warnings,
        status: 'OPEN',
        partial_filled: 0,
        high_price: recommendation.targets.entry,
        low_price: recommendation.targets.entry,
        created_at: new Date().toISOString()
      };

      this.activeTrades.set(tradeId, trade);

      logger.info(`Opened paper trade #${tradeId}: ${recommendation.ticker} ${recommendation.direction} @ $${recommendation.targets.entry} | Confidence: ${recommendation.confidenceScore}`);

      return tradeId;
    } catch (error) {
      logger.error('Error opening paper trade', { error: error.message });
      return null;
    }
  }

  // Close a trade with full P&L calculation
  closeTrade(tradeId, exitPrice, exitReason) {
    try {
      const trade = this.activeTrades.get(tradeId);
      if (!trade) {
        logger.warn(`Trade ${tradeId} not found`);
        return null;
      }

      const isBullish = trade.direction === 'BULLISH';

      // Calculate stock P&L
      const stockPnlPercent = isBullish
        ? ((exitPrice - trade.entry_price) / trade.entry_price) * 100
        : ((trade.entry_price - exitPrice) / trade.entry_price) * 100;

      // Calculate option P&L with leverage
      const optionPnlPercent = Math.max(-100, stockPnlPercent * this.OPTION_LEVERAGE);

      // Calculate dollar P&L
      const pnlDollars = (optionPnlPercent / 100) * this.POSITION_SIZE;

      const stmt = database.db.prepare(`
        UPDATE paper_trades SET
          status = 'CLOSED',
          exit_price = ?,
          exit_reason = ?,
          stock_pnl_percent = ?,
          option_pnl_percent = ?,
          pnl_dollars = ?,
          closed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      stmt.run(exitPrice, exitReason, stockPnlPercent, optionPnlPercent, pnlDollars, tradeId);

      this.activeTrades.delete(tradeId);

      // Update day results
      this.dayResults.trades.push({
        ...trade,
        exit_price: exitPrice,
        exit_reason: exitReason,
        stock_pnl_percent: stockPnlPercent,
        option_pnl_percent: optionPnlPercent,
        pnl_dollars: pnlDollars
      });

      if (pnlDollars > 0) {
        this.dayResults.winners++;
      } else {
        this.dayResults.losers++;
      }
      this.dayResults.totalPnL += pnlDollars;

      // Update loss tracking for risk management
      this.updateLossTracking(pnlDollars);

      logger.info(`Closed paper trade #${tradeId}: ${trade.ticker} ${exitReason} | Stock: ${stockPnlPercent > 0 ? '+' : ''}${stockPnlPercent.toFixed(2)}% | Option: ${optionPnlPercent > 0 ? '+' : ''}${optionPnlPercent.toFixed(0)}% | P&L: $${pnlDollars > 0 ? '+' : ''}${pnlDollars.toFixed(0)}`);

      return {
        tradeId,
        ticker: trade.ticker,
        direction: trade.direction,
        entry_price: trade.entry_price,
        exit_price: exitPrice,
        stockPnlPercent,
        optionPnlPercent,
        pnlDollars,
        exitReason,
        confidence: trade.confidence_score,
        duration: this.getTradeDefinition(trade.created_at)
      };
    } catch (error) {
      logger.error('Error closing paper trade', { error: error.message });
      return null;
    }
  }

  // Get trade duration
  getTradeDefinition(createdAt) {
    const start = new Date(createdAt);
    const end = new Date();
    const minutes = Math.floor((end - start) / 60000);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  // Check active trades and return alerts for proximity/exits
  async checkActiveTrades(priceData) {
    const results = {
      closedTrades: [],
      proximityAlerts: [],
      trailingStopUpdates: []
    };

    for (const [tradeId, trade] of this.activeTrades) {
      const currentPrice = priceData[trade.ticker];
      if (!currentPrice) continue;

      const isBullish = trade.direction === 'BULLISH';

      // Update high/low tracking
      if (currentPrice > trade.high_price) {
        trade.high_price = currentPrice;
        this.updateTradeHighLow(tradeId, currentPrice, null);
      }
      if (currentPrice < trade.low_price) {
        trade.low_price = currentPrice;
        this.updateTradeHighLow(tradeId, null, currentPrice);
      }

      // Calculate current P&L
      const currentStockPnl = isBullish
        ? ((currentPrice - trade.entry_price) / trade.entry_price) * 100
        : ((trade.entry_price - currentPrice) / trade.entry_price) * 100;
      const currentOptionPnl = currentStockPnl * this.OPTION_LEVERAGE;
      const currentDollarPnl = (currentOptionPnl / 100) * this.POSITION_SIZE;

      // Check for target hit
      if (isBullish && currentPrice >= trade.target_price) {
        const result = this.closeTrade(tradeId, currentPrice, 'TARGET_HIT');
        if (result) results.closedTrades.push(result);
        continue;
      } else if (!isBullish && currentPrice <= trade.target_price) {
        const result = this.closeTrade(tradeId, currentPrice, 'TARGET_HIT');
        if (result) results.closedTrades.push(result);
        continue;
      }

      // Check for stop hit
      const effectiveStop = trade.trailing_stop || trade.stop_price;
      if (isBullish && currentPrice <= effectiveStop) {
        const result = this.closeTrade(tradeId, currentPrice, trade.trailing_stop ? 'TRAILING_STOP' : 'STOP_LOSS');
        if (result) results.closedTrades.push(result);
        continue;
      } else if (!isBullish && currentPrice >= effectiveStop) {
        const result = this.closeTrade(tradeId, currentPrice, trade.trailing_stop ? 'TRAILING_STOP' : 'STOP_LOSS');
        if (result) results.closedTrades.push(result);
        continue;
      }

      // Check for partial target (take profits alert)
      if (trade.partial_target && !trade.partial_filled) {
        if ((isBullish && currentPrice >= trade.partial_target) ||
            (!isBullish && currentPrice <= trade.partial_target)) {
          results.proximityAlerts.push({
            type: 'PARTIAL_TARGET',
            trade,
            currentPrice,
            currentPnl: currentDollarPnl,
            message: `🎯 **TAKE PARTIAL PROFITS** - ${trade.ticker}\nHit partial target ($${trade.partial_target.toFixed(2)})\nCurrent P&L: **$${currentDollarPnl > 0 ? '+' : ''}${currentDollarPnl.toFixed(0)}** (${currentOptionPnl > 0 ? '+' : ''}${currentOptionPnl.toFixed(0)}%)\n*Consider selling 50% and moving stop to breakeven*`
          });
          // Mark partial as alerted
          trade.partial_filled = 1;
          this.updatePartialFilled(tradeId);
        }
      }

      // Trailing stop logic - when in profit, trail the stop
      if (currentStockPnl > 1.5) { // At least 1.5% profit
        const newTrailingStop = isBullish
          ? currentPrice * 0.99  // 1% below current for longs
          : currentPrice * 1.01; // 1% above current for shorts

        const shouldUpdateTrailing = isBullish
          ? (!trade.trailing_stop || newTrailingStop > trade.trailing_stop)
          : (!trade.trailing_stop || newTrailingStop < trade.trailing_stop);

        if (shouldUpdateTrailing) {
          const oldStop = trade.trailing_stop || trade.stop_price;
          trade.trailing_stop = isBullish
            ? Math.max(trade.entry_price, newTrailingStop) // Never below entry for longs
            : Math.min(trade.entry_price, newTrailingStop); // Never above entry for shorts

          this.updateTrailingStop(tradeId, trade.trailing_stop);

          results.trailingStopUpdates.push({
            trade,
            oldStop,
            newStop: trade.trailing_stop,
            currentPrice,
            message: `📈 **TRAILING STOP UPDATED** - ${trade.ticker}\nNew stop: $${trade.trailing_stop.toFixed(2)} (was $${oldStop.toFixed(2)})\nLocking in profits: $${currentDollarPnl.toFixed(0)}`
          });
        }
      }

      // Proximity alerts - approaching target or stop
      const distanceToTarget = isBullish
        ? (trade.target_price - currentPrice) / (trade.target_price - trade.entry_price)
        : (currentPrice - trade.target_price) / (trade.entry_price - trade.target_price);

      const distanceToStop = isBullish
        ? (currentPrice - effectiveStop) / (trade.entry_price - effectiveStop)
        : (effectiveStop - currentPrice) / (effectiveStop - trade.entry_price);

      if (distanceToTarget <= (1 - this.TARGET_PROXIMITY_THRESHOLD) && distanceToTarget > 0) {
        results.proximityAlerts.push({
          type: 'NEAR_TARGET',
          trade,
          currentPrice,
          currentPnl: currentDollarPnl,
          message: `🎯 **APPROACHING TARGET** - ${trade.ticker}\nPrice: $${currentPrice.toFixed(2)} → Target: $${trade.target_price.toFixed(2)}\nCurrent P&L: **$${currentDollarPnl > 0 ? '+' : ''}${currentDollarPnl.toFixed(0)}**\n*Consider tightening stop or taking partial profits*`
        });
      }

      if (distanceToStop <= (1 - this.STOP_PROXIMITY_THRESHOLD) && distanceToStop > 0) {
        results.proximityAlerts.push({
          type: 'NEAR_STOP',
          trade,
          currentPrice,
          currentPnl: currentDollarPnl,
          message: `⚠️ **APPROACHING STOP** - ${trade.ticker}\nPrice: $${currentPrice.toFixed(2)} → Stop: $${effectiveStop.toFixed(2)}\nCurrent P&L: **$${currentDollarPnl > 0 ? '+' : ''}${currentDollarPnl.toFixed(0)}**\n*Prepare for potential exit*`
        });
      }
    }

    return results;
  }

  // Database update helpers
  updateTradeHighLow(tradeId, high, low) {
    try {
      if (high !== null) {
        database.db.prepare('UPDATE paper_trades SET high_price = ? WHERE id = ?').run(high, tradeId);
      }
      if (low !== null) {
        database.db.prepare('UPDATE paper_trades SET low_price = ? WHERE id = ?').run(low, tradeId);
      }
    } catch (error) {
      // Silent fail
    }
  }

  updateTrailingStop(tradeId, stop) {
    try {
      database.db.prepare('UPDATE paper_trades SET trailing_stop = ? WHERE id = ?').run(stop, tradeId);
    } catch (error) {
      // Silent fail
    }
  }

  updatePartialFilled(tradeId) {
    try {
      database.db.prepare('UPDATE paper_trades SET partial_filled = 1 WHERE id = ?').run(tradeId);
    } catch (error) {
      // Silent fail
    }
  }

  // Close all trades at market close
  async closeAllAtMarketClose(priceData) {
    const closedTrades = [];

    for (const [tradeId, trade] of this.activeTrades) {
      const currentPrice = priceData[trade.ticker] || trade.entry_price;
      const result = this.closeTrade(tradeId, currentPrice, 'MARKET_CLOSE');
      if (result) closedTrades.push(result);
    }

    return closedTrades;
  }

  // Get comprehensive today summary
  getTodaySummary() {
    try {
      const stats = database.db.prepare(`
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN status = 'CLOSED' AND pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          SUM(CASE WHEN status = 'CLOSED' AND pnl_dollars <= 0 THEN 1 ELSE 0 END) as losers,
          SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_trades,
          AVG(CASE WHEN status = 'CLOSED' THEN stock_pnl_percent END) as avg_stock_pnl,
          AVG(CASE WHEN status = 'CLOSED' THEN option_pnl_percent END) as avg_option_pnl,
          SUM(CASE WHEN status = 'CLOSED' THEN pnl_dollars END) as total_pnl_dollars,
          MAX(CASE WHEN status = 'CLOSED' THEN pnl_dollars END) as best_pnl,
          MIN(CASE WHEN status = 'CLOSED' THEN pnl_dollars END) as worst_pnl,
          SUM(CASE WHEN exit_reason = 'TARGET_HIT' THEN 1 ELSE 0 END) as targets_hit,
          SUM(CASE WHEN exit_reason = 'STOP_LOSS' THEN 1 ELSE 0 END) as stops_hit,
          SUM(CASE WHEN exit_reason = 'TRAILING_STOP' THEN 1 ELSE 0 END) as trailing_stops,
          SUM(CASE WHEN exit_reason = 'MARKET_CLOSE' THEN 1 ELSE 0 END) as market_closes,
          AVG(confidence_score) as avg_confidence
        FROM paper_trades
        WHERE trade_date = DATE('now')
      `).get();

      // By confidence level
      const byConfidence = database.db.prepare(`
        SELECT
          CASE
            WHEN confidence_score >= 90 THEN 'Fire (90+)'
            WHEN confidence_score >= 80 THEN 'Strong (80-89)'
            WHEN confidence_score >= 70 THEN 'Good (70-79)'
            ELSE 'Developing (<70)'
          END as confidence_level,
          COUNT(*) as count,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          AVG(option_pnl_percent) as avg_option_pnl,
          SUM(pnl_dollars) as total_pnl
        FROM paper_trades
        WHERE trade_date = DATE('now') AND status = 'CLOSED'
        GROUP BY confidence_level
        ORDER BY MIN(confidence_score) DESC
      `).all();

      // By direction
      const byDirection = database.db.prepare(`
        SELECT
          direction,
          COUNT(*) as count,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          AVG(option_pnl_percent) as avg_option_pnl,
          SUM(pnl_dollars) as total_pnl
        FROM paper_trades
        WHERE trade_date = DATE('now') AND status = 'CLOSED'
        GROUP BY direction
      `).all();

      // Best and worst trades
      const bestTrade = database.db.prepare(`
        SELECT ticker, direction, entry_price, exit_price, confidence_score,
               stock_pnl_percent, option_pnl_percent, pnl_dollars, exit_reason
        FROM paper_trades
        WHERE trade_date = DATE('now') AND status = 'CLOSED'
        ORDER BY pnl_dollars DESC
        LIMIT 1
      `).get();

      const worstTrade = database.db.prepare(`
        SELECT ticker, direction, entry_price, exit_price, confidence_score,
               stock_pnl_percent, option_pnl_percent, pnl_dollars, exit_reason
        FROM paper_trades
        WHERE trade_date = DATE('now') AND status = 'CLOSED'
        ORDER BY pnl_dollars ASC
        LIMIT 1
      `).get();

      // All trades for detailed recap
      const allTrades = database.db.prepare(`
        SELECT * FROM paper_trades
        WHERE trade_date = DATE('now')
        ORDER BY created_at DESC
      `).all();

      const closedCount = (stats.winners || 0) + (stats.losers || 0);
      const winRate = closedCount > 0
        ? ((stats.winners / closedCount) * 100).toFixed(1)
        : 0;

      return {
        ...stats,
        closedCount,
        winRate,
        byConfidence,
        byDirection,
        bestTrade,
        worstTrade,
        allTrades,
        positionSize: this.POSITION_SIZE
      };
    } catch (error) {
      logger.error('Error getting summary', { error: error.message });
      return null;
    }
  }

  // Get active trades
  getActiveTrades() {
    return [...this.activeTrades.values()];
  }

  getTodayTrades() {
    try {
      return database.db.prepare(`
        SELECT * FROM paper_trades
        WHERE trade_date = DATE('now')
        ORDER BY created_at DESC
      `).all();
    } catch (error) {
      return [];
    }
  }

  // Get historical performance
  getHistoricalPerformance(days = 7) {
    try {
      return database.db.prepare(`
        SELECT
          trade_date,
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as winners,
          SUM(CASE WHEN pnl_dollars <= 0 THEN 1 ELSE 0 END) as losers,
          AVG(option_pnl_percent) as avg_option_pnl,
          SUM(pnl_dollars) as total_pnl_dollars,
          AVG(confidence_score) as avg_confidence
        FROM paper_trades
        WHERE status = 'CLOSED'
          AND trade_date >= DATE('now', '-' || ? || ' days')
        GROUP BY trade_date
        ORDER BY trade_date DESC
      `).all(days);
    } catch (error) {
      return [];
    }
  }

  // Format comprehensive recap for Discord
  formatRecapForDiscord() {
    const summary = this.getTodaySummary();
    if (!summary || summary.total_trades === 0) {
      return '**📊 Paper Trading Daily Recap**\n\nNo paper trades today.';
    }

    const lines = [];

    // Header with big numbers
    lines.push('═'.repeat(45));
    lines.push('📊 **PAPER TRADING DAILY RECAP** 📊');
    lines.push('═'.repeat(45));

    // BIG P&L NUMBER
    const totalPnl = summary.total_pnl_dollars || 0;
    const pnlEmoji = totalPnl >= 0 ? '💰' : '📉';
    lines.push(`\n${pnlEmoji} **TODAY'S P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}** ${pnlEmoji}`);
    lines.push(`(Based on $${this.POSITION_SIZE} per trade)\n`);

    // Win/Loss Stats
    if (summary.closedCount > 0) {
      const winEmoji = parseFloat(summary.winRate) >= 60 ? '🔥' : (parseFloat(summary.winRate) >= 50 ? '✅' : '⚠️');
      lines.push(`${winEmoji} **Win Rate: ${summary.winRate}%** (${summary.winners}W / ${summary.losers}L)`);
      lines.push(`📈 Avg Stock Move: ${(summary.avg_stock_pnl || 0) > 0 ? '+' : ''}${(summary.avg_stock_pnl || 0).toFixed(2)}%`);
      lines.push(`📊 Avg Option P&L: ${(summary.avg_option_pnl || 0) > 0 ? '+' : ''}${(summary.avg_option_pnl || 0).toFixed(0)}%`);
    }

    // Exit breakdown
    lines.push('\n**📋 Trade Exits:**');
    lines.push(`🎯 Targets Hit: ${summary.targets_hit || 0}`);
    lines.push(`🛑 Stops Hit: ${summary.stops_hit || 0}`);
    lines.push(`📈 Trailing Stops: ${summary.trailing_stops || 0}`);
    lines.push(`⏰ Market Close: ${summary.market_closes || 0}`);
    if (summary.open_trades > 0) {
      lines.push(`⏳ Still Open: ${summary.open_trades}`);
    }

    // By confidence level - THIS IS KEY FOR BACKTESTING
    if (summary.byConfidence && summary.byConfidence.length > 0) {
      lines.push('\n**🎚️ PERFORMANCE BY CONFIDENCE:**');
      for (const conf of summary.byConfidence) {
        const wr = conf.count > 0 ? ((conf.winners / conf.count) * 100).toFixed(0) : 0;
        const pnl = conf.total_pnl || 0;
        const emoji = parseFloat(wr) >= 60 ? '🔥' : (parseFloat(wr) >= 50 ? '✅' : '❌');
        lines.push(`${emoji} ${conf.confidence_level}: ${conf.count} trades, ${wr}% win, ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`);
      }
    }

    // By direction
    if (summary.byDirection && summary.byDirection.length > 0) {
      lines.push('\n**📈 By Direction:**');
      for (const dir of summary.byDirection) {
        const wr = dir.count > 0 ? ((dir.winners / dir.count) * 100).toFixed(0) : 0;
        const emoji = dir.direction === 'BULLISH' ? '🟢' : '🔴';
        lines.push(`${emoji} ${dir.direction}: ${dir.count} trades, ${wr}% win, ${(dir.total_pnl || 0) >= 0 ? '+' : ''}$${(dir.total_pnl || 0).toFixed(0)}`);
      }
    }

    // Best and worst
    if (summary.bestTrade) {
      const bt = summary.bestTrade;
      lines.push(`\n🏆 **BEST TRADE:**`);
      lines.push(`${bt.ticker} ${bt.direction} | +$${bt.pnl_dollars.toFixed(0)} (+${bt.option_pnl_percent?.toFixed(0)}%)`);
      lines.push(`Entry: $${bt.entry_price.toFixed(2)} → Exit: $${bt.exit_price.toFixed(2)} (${bt.exit_reason})`);
    }

    if (summary.worstTrade && summary.worstTrade.pnl_dollars < 0) {
      const wt = summary.worstTrade;
      lines.push(`\n💔 **WORST TRADE:**`);
      lines.push(`${wt.ticker} ${wt.direction} | $${wt.pnl_dollars.toFixed(0)} (${wt.option_pnl_percent?.toFixed(0)}%)`);
      lines.push(`Entry: $${wt.entry_price.toFixed(2)} → Exit: $${wt.exit_price.toFixed(2)} (${wt.exit_reason})`);
    }

    // Insights
    lines.push('\n' + '─'.repeat(40));
    if (parseFloat(summary.winRate) >= 65) {
      lines.push('🔥 **EXCELLENT DAY!** High win rate and positive P&L.');
      lines.push('The system is identifying high-probability setups accurately.');
    } else if (parseFloat(summary.winRate) >= 55) {
      lines.push('✅ **SOLID DAY.** Win rate above breakeven threshold.');
      lines.push('Continue following the signals, especially high-confidence ones.');
    } else if (parseFloat(summary.winRate) >= 45) {
      lines.push('📊 **MIXED DAY.** Near breakeven performance.');
      lines.push('Consider focusing only on 80+ confidence signals.');
    } else if (summary.closedCount > 0) {
      lines.push('⚠️ **TOUGH DAY.** Below target win rate.');
      lines.push('Review: Were we trading against the market? Was it choppy midday?');
    }

    // What would have happened with real money
    lines.push('\n**💵 IF THIS WERE REAL:**');
    const startingCapital = summary.total_trades * this.POSITION_SIZE;
    const endingCapital = startingCapital + totalPnl;
    const returnPct = (totalPnl / startingCapital) * 100;
    lines.push(`Starting capital: $${startingCapital.toLocaleString()}`);
    lines.push(`Ending capital: $${endingCapital.toLocaleString()}`);
    lines.push(`Return: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%`);

    lines.push('\n' + '═'.repeat(45));

    return lines.join('\n');
  }

  // Format active trades
  formatActiveTradesForDiscord() {
    const trades = this.getActiveTrades();
    if (trades.length === 0) {
      return '**📈 Open Paper Trades**\n\nNo active paper trades.';
    }

    const lines = [];
    lines.push(`**📈 Open Paper Trades (${trades.length})**\n`);

    for (const trade of trades) {
      const emoji = trade.direction === 'BULLISH' ? '🟢' : '🔴';
      lines.push(`${emoji} **${trade.ticker}** ${trade.direction}`);
      lines.push(`   Confidence: ${trade.confidence_score}/100`);
      lines.push(`   Entry: $${trade.entry_price.toFixed(2)}`);
      lines.push(`   Target: $${trade.target_price.toFixed(2)} | Stop: $${(trade.trailing_stop || trade.stop_price).toFixed(2)}`);
      if (trade.option_type) {
        lines.push(`   Option: ${trade.option_strike} ${trade.option_type} ${trade.option_expiry}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // Check if should open trade (includes risk management)
  shouldOpenTrade(ticker, direction) {
    // Check for duplicate position
    for (const trade of this.activeTrades.values()) {
      if (trade.ticker === ticker && trade.direction === direction) {
        return false;
      }
    }

    // Check daily loss limit
    if (this.isDailyLossLimitHit()) {
      return false;
    }

    // Check consecutive losses
    if (this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
      logger.warn(`Consecutive loss limit hit (${this.consecutiveLosses} losses) - pausing new trades`);
      return false;
    }

    return true;
  }

  // Check if daily loss limit has been hit
  isDailyLossLimitHit() {
    if (this.dailyLossLimitHit) {
      return true;
    }

    // Calculate today's P&L
    const todayPnL = this.dayResults.totalPnL;

    if (todayPnL <= -this.MAX_DAILY_LOSS) {
      this.dailyLossLimitHit = true;
      this.dailyLossLimitMessage = `Daily loss limit hit: $${Math.abs(todayPnL).toFixed(0)} loss (limit: $${this.MAX_DAILY_LOSS})`;
      logger.warn(this.dailyLossLimitMessage);
      return true;
    }

    return false;
  }

  // Update loss tracking when a trade closes
  updateLossTracking(pnlDollars) {
    if (pnlDollars < 0) {
      this.consecutiveLosses++;
      logger.info(`Consecutive losses: ${this.consecutiveLosses}`);
    } else if (pnlDollars > 0) {
      this.consecutiveLosses = 0; // Reset on winner
    }
  }

  // Get risk management status
  getRiskStatus() {
    return {
      dailyPnL: this.dayResults.totalPnL,
      maxDailyLoss: this.MAX_DAILY_LOSS,
      dailyLossLimitHit: this.dailyLossLimitHit,
      consecutiveLosses: this.consecutiveLosses,
      maxConsecutiveLosses: this.MAX_CONSECUTIVE_LOSSES,
      tradingPaused: this.dailyLossLimitHit || this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES,
      pauseReason: this.dailyLossLimitHit
        ? `Daily loss limit ($${this.MAX_DAILY_LOSS})`
        : this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES
          ? `${this.MAX_CONSECUTIVE_LOSSES} consecutive losses`
          : null
    };
  }

  getTodayTradeCount() {
    try {
      const result = database.db.prepare(`
        SELECT COUNT(*) as count FROM paper_trades WHERE trade_date = DATE('now')
      `).get();
      return result.count;
    } catch (error) {
      return 0;
    }
  }

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

    // Reset risk management for new day
    this.consecutiveLosses = 0;
    this.dailyLossLimitHit = false;
    this.dailyLossLimitMessage = null;
    logger.info('Daily tracking and risk limits reset');
  }
}

module.exports = new PaperTrading();
