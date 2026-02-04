const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../../config');
const logger = require('../utils/logger');

class FlowDatabase {
  constructor() {
    this.db = null;
  }

  initialize() {
    try {
      // Ensure data directory exists
      const dbDir = path.dirname(config.database.path);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(config.database.path);
      this.db.pragma('journal_mode = WAL');

      this.createTables();
      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize database', { error: error.message });
      throw error;
    }
  }

  createTables() {
    // Stock alerts table - stores all sent stock alerts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stock_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        heat_score INTEGER NOT NULL,
        price REAL,
        volume REAL,
        signal_breakdown TEXT NOT NULL,
        channel TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Legacy alerts table - stores options alerts (for backwards compatibility)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        contract TEXT,
        heat_score INTEGER NOT NULL,
        premium REAL,
        strike REAL,
        spot_price REAL,
        expiration TEXT,
        option_type TEXT,
        signal_breakdown TEXT NOT NULL,
        channel TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        outcome TEXT DEFAULT NULL,
        outcome_price REAL DEFAULT NULL,
        outcome_date DATETIME DEFAULT NULL
      )
    `);

    // Watchlists table - user watchlists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watchlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        ticker TEXT NOT NULL,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, ticker)
      )
    `);

    // Heat history table - rolling window of signals per ticker
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS heat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        premium REAL NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Volume baselines table - stores daily volume baselines
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS volume_baselines (
        ticker TEXT PRIMARY KEY,
        avg_daily_volume REAL NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Earnings calendar table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS earnings_calendar (
        ticker TEXT PRIMARY KEY,
        earnings_date TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_alerts_ticker ON alerts(ticker);
      CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
      CREATE INDEX IF NOT EXISTS idx_stock_alerts_ticker ON stock_alerts(ticker);
      CREATE INDEX IF NOT EXISTS idx_stock_alerts_created ON stock_alerts(created_at);
      CREATE INDEX IF NOT EXISTS idx_heat_history_ticker ON heat_history(ticker);
      CREATE INDEX IF NOT EXISTS idx_heat_history_created ON heat_history(created_at);
      CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
    `);
  }

  // ========== Alert Methods ==========

  // Save stock alert (new format)
  saveAlert(alert) {
    // Check if this is a stock alert (has signalType) or options alert (has contract)
    if (alert.signalType) {
      return this.saveStockAlert(alert);
    } else {
      return this.saveOptionsAlert(alert);
    }
  }

  // Save stock alert
  saveStockAlert(alert) {
    const stmt = this.db.prepare(`
      INSERT INTO stock_alerts (ticker, signal_type, heat_score, price, volume, signal_breakdown, channel)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      alert.ticker,
      alert.signalType,
      alert.heatScore,
      alert.price || null,
      alert.volume || null,
      JSON.stringify(alert.signalBreakdown),
      alert.channel
    );

    return result.lastInsertRowid;
  }

  // Save options alert (legacy)
  saveOptionsAlert(alert) {
    const stmt = this.db.prepare(`
      INSERT INTO alerts (ticker, contract, heat_score, premium, strike, spot_price,
                         expiration, option_type, signal_breakdown, channel)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      alert.ticker,
      alert.contract || '',
      alert.heatScore,
      alert.premium || 0,
      alert.strike || 0,
      alert.spotPrice || 0,
      alert.expiration || '',
      alert.optionType || '',
      JSON.stringify(alert.signalBreakdown),
      alert.channel
    );

    return result.lastInsertRowid;
  }

  getAlertsByDate(date) {
    const stmt = this.db.prepare(`
      SELECT * FROM alerts
      WHERE DATE(created_at) = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(date);
  }

  getTodayAlerts() {
    const stmt = this.db.prepare(`
      SELECT * FROM stock_alerts
      WHERE DATE(created_at) = DATE('now')
      ORDER BY created_at DESC
    `);
    return stmt.all();
  }

  updateAlertOutcome(alertId, outcome, outcomePrice) {
    const stmt = this.db.prepare(`
      UPDATE alerts
      SET outcome = ?, outcome_price = ?, outcome_date = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    return stmt.run(outcome, outcomePrice, alertId);
  }

  // ========== Watchlist Methods ==========

  addToWatchlist(userId, ticker) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO watchlists (user_id, ticker)
      VALUES (?, ?)
    `);
    return stmt.run(userId, ticker.toUpperCase());
  }

  removeFromWatchlist(userId, ticker) {
    const stmt = this.db.prepare(`
      DELETE FROM watchlists
      WHERE user_id = ? AND ticker = ?
    `);
    return stmt.run(userId, ticker.toUpperCase());
  }

  getWatchlist(userId) {
    const stmt = this.db.prepare(`
      SELECT ticker FROM watchlists
      WHERE user_id = ?
      ORDER BY ticker
    `);
    return stmt.all(userId).map(row => row.ticker);
  }

  getAllWatchedTickers() {
    const stmt = this.db.prepare(`
      SELECT DISTINCT ticker FROM watchlists
    `);
    return stmt.all().map(row => row.ticker);
  }

  isTickerWatched(userId, ticker) {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM watchlists
      WHERE user_id = ? AND ticker = ?
    `);
    const result = stmt.get(userId, ticker.toUpperCase());
    return result.count > 0;
  }

  // ========== Heat History Methods ==========

  addHeatSignal(ticker, signalType, premium, details = null) {
    const stmt = this.db.prepare(`
      INSERT INTO heat_history (ticker, signal_type, premium, details)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(ticker.toUpperCase(), signalType, premium, details ? JSON.stringify(details) : null);
  }

  getRecentSignals(ticker, minutes = 60) {
    const stmt = this.db.prepare(`
      SELECT * FROM heat_history
      WHERE ticker = ?
        AND created_at >= datetime('now', '-' || ? || ' minutes')
      ORDER BY created_at DESC
    `);
    return stmt.all(ticker.toUpperCase(), minutes);
  }

  getSignalCount(ticker, minutes = 60) {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM heat_history
      WHERE ticker = ?
        AND created_at >= datetime('now', '-' || ? || ' minutes')
    `);
    const result = stmt.get(ticker.toUpperCase(), minutes);
    return result.count;
  }

  getSweepCount(ticker, minutes = 30) {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM heat_history
      WHERE ticker = ?
        AND signal_type = 'sweep'
        AND created_at >= datetime('now', '-' || ? || ' minutes')
    `);
    const result = stmt.get(ticker.toUpperCase(), minutes);
    return result.count;
  }

  getHotTickers(limit = 5) {
    const stmt = this.db.prepare(`
      SELECT ticker, COUNT(*) as signal_count, SUM(premium) as total_premium
      FROM heat_history
      WHERE created_at >= datetime('now', '-60 minutes')
      GROUP BY ticker
      HAVING signal_count >= 2
      ORDER BY signal_count DESC, total_premium DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  cleanOldHeatHistory() {
    // Remove signals older than 2 hours
    const stmt = this.db.prepare(`
      DELETE FROM heat_history
      WHERE created_at < datetime('now', '-120 minutes')
    `);
    return stmt.run();
  }

  // ========== Volume Baseline Methods ==========

  saveVolumeBaseline(ticker, avgVolume) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO volume_baselines (ticker, avg_daily_volume, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);
    return stmt.run(ticker.toUpperCase(), avgVolume);
  }

  getVolumeBaseline(ticker) {
    const stmt = this.db.prepare(`
      SELECT avg_daily_volume FROM volume_baselines
      WHERE ticker = ?
    `);
    const result = stmt.get(ticker.toUpperCase());
    return result ? result.avg_daily_volume : null;
  }

  getAllVolumeBaselines() {
    const stmt = this.db.prepare(`
      SELECT ticker, avg_daily_volume FROM volume_baselines
    `);
    return stmt.all();
  }

  // ========== Earnings Calendar Methods ==========

  saveEarningsDate(ticker, earningsDate) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO earnings_calendar (ticker, earnings_date, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);
    return stmt.run(ticker.toUpperCase(), earningsDate);
  }

  getEarningsDate(ticker) {
    const stmt = this.db.prepare(`
      SELECT earnings_date FROM earnings_calendar
      WHERE ticker = ?
    `);
    const result = stmt.get(ticker.toUpperCase());
    return result ? result.earnings_date : null;
  }

  // ========== Stats Methods ==========

  getTodayStats() {
    // Get stats from stock_alerts table
    const stockStats = this.db.prepare(`
      SELECT
        COUNT(*) as total_alerts,
        COUNT(CASE WHEN heat_score >= 80 THEN 1 END) as high_conviction,
        COUNT(CASE WHEN heat_score >= 60 AND heat_score < 80 THEN 1 END) as standard_alerts,
        AVG(heat_score) as avg_heat_score,
        SUM(volume) as total_volume,
        COUNT(DISTINCT ticker) as unique_tickers
      FROM stock_alerts
      WHERE DATE(created_at) = DATE('now')
    `).get();

    const topTickers = this.db.prepare(`
      SELECT ticker, COUNT(*) as alert_count, MAX(heat_score) as max_score
      FROM stock_alerts
      WHERE DATE(created_at) = DATE('now')
      GROUP BY ticker
      ORDER BY alert_count DESC
      LIMIT 5
    `).all();

    // Get signal type breakdown
    const signalBreakdown = this.db.prepare(`
      SELECT signal_type, COUNT(*) as count
      FROM stock_alerts
      WHERE DATE(created_at) = DATE('now')
      GROUP BY signal_type
      ORDER BY count DESC
    `).all();

    // Convert to object
    const signalBreakdownObj = {};
    signalBreakdown.forEach(row => {
      signalBreakdownObj[row.signal_type] = row.count;
    });

    return { ...stockStats, topTickers, signalBreakdown: signalBreakdownObj };
  }

  getFlowSummary(ticker) {
    const recentSignals = this.db.prepare(`
      SELECT * FROM stock_alerts
      WHERE ticker = ?
        AND created_at >= datetime('now', '-24 hours')
      ORDER BY created_at DESC
      LIMIT 10
    `).all(ticker.toUpperCase());

    const signalCount = this.getSignalCount(ticker);
    const currentHeat = this.getCurrentHeat(ticker);

    // Get latest price from most recent alert
    const latestAlert = recentSignals[0];
    const price = latestAlert ? latestAlert.price : null;

    return {
      ticker: ticker.toUpperCase(),
      recentSignals,
      signalsLast60min: signalCount,
      currentHeat,
      price
    };
  }

  // Get current heat score for a ticker based on recent signals
  getCurrentHeat(ticker) {
    const signalCount = this.getSignalCount(ticker, 60);
    // Simple heat calculation based on signal count
    return Math.min(100, signalCount * 20);
  }

  // ========== Cleanup ==========

  close() {
    if (this.db) {
      this.db.close();
      logger.info('Database connection closed');
    }
  }
}

// Export singleton instance
module.exports = new FlowDatabase();
