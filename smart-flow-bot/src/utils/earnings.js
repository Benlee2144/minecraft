const database = require('../database/sqlite');
const logger = require('../utils/logger');
const axios = require('axios');

class EarningsCalendar {
  constructor() {
    // Known upcoming earnings (manually maintained or fetched)
    // Format: { TICKER: 'YYYY-MM-DD' }
    this.knownEarnings = {};
    this.warningDays = 3; // Warn if earnings within X days
    this.lastFetchTime = null;
    this.fetchCooldownHours = 6; // Only fetch every 6 hours
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

  // Fetch earnings date for a single ticker
  // Tries multiple free sources with fallbacks
  async fetchEarningsForTicker(ticker) {
    ticker = ticker.toUpperCase();

    // Try Yahoo Finance v7 options endpoint (more reliable)
    try {
      const yahooUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`;
      const response = await axios.get(yahooUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        },
        timeout: 10000
      });

      const quote = response.data?.optionChain?.result?.[0]?.quote;
      if (quote?.earningsTimestamp) {
        const earningsDate = new Date(quote.earningsTimestamp * 1000);
        const dateStr = earningsDate.toISOString().split('T')[0];

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (earningsDate >= today) {
          this.setEarningsDate(ticker, dateStr);
          return { ticker, date: dateStr, source: 'yahoo' };
        }
      }
    } catch (error) {
      // Try backup source
    }

    // Try Yahoo quote endpoint as backup
    try {
      const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
      const response = await axios.get(quoteUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': '*/*'
        },
        timeout: 10000
      });

      const quote = response.data?.quoteResponse?.result?.[0];
      if (quote?.earningsTimestamp) {
        const earningsDate = new Date(quote.earningsTimestamp * 1000);
        const dateStr = earningsDate.toISOString().split('T')[0];

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (earningsDate >= today) {
          this.setEarningsDate(ticker, dateStr);
          return { ticker, date: dateStr, source: 'yahoo-quote' };
        }
      }
    } catch (error) {
      // Both sources failed
    }

    logger.debug(`Could not fetch earnings for ${ticker}`);
    return null;
  }

  // Fetch earnings for multiple tickers
  async fetchEarningsForTickers(tickers) {
    // Check cooldown
    if (this.lastFetchTime) {
      const hoursSinceFetch = (Date.now() - this.lastFetchTime) / (1000 * 60 * 60);
      if (hoursSinceFetch < this.fetchCooldownHours) {
        logger.debug(`Skipping earnings fetch - last fetch was ${hoursSinceFetch.toFixed(1)} hours ago`);
        return { fetched: 0, skipped: tickers.length };
      }
    }

    logger.info(`Fetching earnings for ${tickers.length} tickers...`);

    let fetched = 0;
    let failed = 0;

    for (const ticker of tickers) {
      try {
        const result = await this.fetchEarningsForTicker(ticker);
        if (result) {
          fetched++;
          logger.debug(`Found earnings for ${ticker}: ${result.date}`);
        }
        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));
      } catch (error) {
        failed++;
      }
    }

    this.lastFetchTime = Date.now();
    logger.info(`Fetched earnings: ${fetched} found, ${failed} failed, ${tickers.length - fetched - failed} no data`);

    return { fetched, failed };
  }

  // Auto-fetch earnings for watchlist and top tickers
  async autoFetchEarnings(topTickers = []) {
    // Combine top tickers with any manually tracked
    const tickersToFetch = [...new Set([
      ...topTickers.slice(0, 50), // Limit to 50 to avoid too many requests
      ...Object.keys(this.knownEarnings)
    ])];

    if (tickersToFetch.length === 0) {
      logger.debug('No tickers to fetch earnings for');
      return;
    }

    return this.fetchEarningsForTickers(tickersToFetch);
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

  // Get total count of tracked earnings
  getCount() {
    return Object.keys(this.knownEarnings).length;
  }

  // Bulk set earnings dates (for populating)
  bulkSetEarnings(earningsData) {
    for (const [ticker, date] of Object.entries(earningsData)) {
      this.setEarningsDate(ticker, date);
    }
  }

  // Clean up past earnings
  cleanPastEarnings() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let removed = 0;
    for (const [ticker, dateStr] of Object.entries(this.knownEarnings)) {
      const earningsDate = new Date(dateStr);
      if (earningsDate < today) {
        this.removeEarningsDate(ticker);
        removed++;
      }
    }

    if (removed > 0) {
      logger.info(`Cleaned up ${removed} past earnings dates`);
    }
  }
}

// Export singleton
module.exports = new EarningsCalendar();
