const database = require('../database/sqlite');
const logger = require('../utils/logger');

class EarningsCalendar {
  constructor() {
    // Known upcoming earnings (manually maintained or fetched)
    // Format: { TICKER: 'YYYY-MM-DD' }
    this.knownEarnings = {};
    this.warningDays = 3; // Warn if earnings within X days
  }

  initialize() {
    // Load known earnings from database
    this.loadFromDatabase();
    logger.info('Earnings calendar initialized');
  }

  loadFromDatabase() {
    try {
      // Load all earnings from database
      const earnings = database.db.prepare(`
        SELECT ticker, earnings_date FROM earnings_calendar
        WHERE earnings_date >= date('now')
      `).all();

      for (const row of earnings) {
        this.knownEarnings[row.ticker] = row.earnings_date;
      }

      logger.info(`Loaded ${Object.keys(this.knownEarnings).length} upcoming earnings dates`);
    } catch (error) {
      logger.error('Error loading earnings from database', { error: error.message });
    }
  }

  // Set earnings date for a ticker
  setEarningsDate(ticker, date) {
    ticker = ticker.toUpperCase();
    this.knownEarnings[ticker] = date;
    database.saveEarningsDate(ticker, date);
    logger.info(`Set earnings date for ${ticker}: ${date}`);
  }

  // Remove earnings date
  removeEarningsDate(ticker) {
    ticker = ticker.toUpperCase();
    delete this.knownEarnings[ticker];
    try {
      database.db.prepare('DELETE FROM earnings_calendar WHERE ticker = ?').run(ticker);
    } catch (error) {
      logger.error('Error removing earnings date', { error: error.message });
    }
  }

  // Check if ticker has earnings coming up
  hasUpcomingEarnings(ticker, days = null) {
    ticker = ticker.toUpperCase();
    const earningsDate = this.knownEarnings[ticker];

    if (!earningsDate) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const earnings = new Date(earningsDate);
    earnings.setHours(0, 0, 0, 0);

    const diffTime = earnings.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    const warningThreshold = days || this.warningDays;

    if (diffDays >= 0 && diffDays <= warningThreshold) {
      return {
        ticker,
        date: earningsDate,
        daysAway: diffDays,
        isToday: diffDays === 0,
        isTomorrow: diffDays === 1
      };
    }

    return null;
  }

  // Get warning message for alerts
  getEarningsWarning(ticker) {
    const upcoming = this.hasUpcomingEarnings(ticker);

    if (!upcoming) return null;

    if (upcoming.isToday) {
      return `⚠️ **EARNINGS TODAY** - High volatility expected!`;
    } else if (upcoming.isTomorrow) {
      return `⚠️ Earnings tomorrow (${upcoming.date}) - Expect increased volatility`;
    } else {
      return `📅 Earnings in ${upcoming.daysAway} days (${upcoming.date})`;
    }
  }

  // Get all upcoming earnings for the week
  getUpcomingEarnings(days = 7) {
    const upcoming = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const [ticker, dateStr] of Object.entries(this.knownEarnings)) {
      const earningsDate = new Date(dateStr);
      earningsDate.setHours(0, 0, 0, 0);

      const diffTime = earningsDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays >= 0 && diffDays <= days) {
        upcoming.push({
          ticker,
          date: dateStr,
          daysAway: diffDays
        });
      }
    }

    // Sort by date
    upcoming.sort((a, b) => a.daysAway - b.daysAway);
    return upcoming;
  }

  // Bulk set earnings dates (for populating)
  bulkSetEarnings(earningsData) {
    for (const [ticker, date] of Object.entries(earningsData)) {
      this.setEarningsDate(ticker, date);
    }
  }
}

// Export singleton
module.exports = new EarningsCalendar();
