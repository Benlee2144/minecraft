const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const database = require('../database/sqlite');

class PolygonRest {
  constructor() {
    this.baseUrl = config.polygon.restUrl;
    this.apiKey = config.polygon.apiKey;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      params: {
        apiKey: this.apiKey
      }
    });

    // Rate limiting: Polygon Starter tier = unlimited API calls
    // But we still throttle to be nice
    this.requestQueue = [];
    this.lastRequestTime = 0;
    this.minRequestInterval = 100; // 100ms between requests
  }

  async rateLimitedRequest(endpoint, params = {}) {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      await this.sleep(this.minRequestInterval - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();

    try {
      const response = await this.client.get(endpoint, { params });
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) {
        logger.warn('Rate limited by Polygon, waiting 60 seconds');
        await this.sleep(60000);
        return this.rateLimitedRequest(endpoint, params);
      }
      throw error;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ========== Stock Snapshots (Main polling method) ==========

  // Get snapshots for all tickers at once (most efficient for polling)
  async getAllTickerSnapshots() {
    try {
      const data = await this.rateLimitedRequest('/v2/snapshot/locale/us/markets/stocks/tickers');
      return data.tickers || [];
    } catch (error) {
      logger.error('Failed to get all ticker snapshots', { error: error.message });
      return [];
    }
  }

  // Get snapshots for specific tickers (gainers/losers)
  async getGainersLosers(direction = 'gainers') {
    try {
      const data = await this.rateLimitedRequest(`/v2/snapshot/locale/us/markets/stocks/${direction}`);
      return data.tickers || [];
    } catch (error) {
      logger.error(`Failed to get ${direction}`, { error: error.message });
      return [];
    }
  }

  // ========== Aggregates (OHLCV Data) ==========

  // Get minute aggregates for a ticker
  async getMinuteAggregates(ticker, fromTime, toTime) {
    try {
      const from = typeof fromTime === 'number' ? fromTime : new Date(fromTime).getTime();
      const to = typeof toTime === 'number' ? toTime : new Date(toTime).getTime();

      const data = await this.rateLimitedRequest(
        `/v2/aggs/ticker/${ticker}/range/1/minute/${from}/${to}`,
        { adjusted: true, sort: 'asc', limit: 500 }
      );

      return data.results || [];
    } catch (error) {
      logger.error(`Failed to get minute aggregates for ${ticker}`, { error: error.message });
      return [];
    }
  }

  // Get today's aggregates for a ticker
  async getTodayAggregates(ticker) {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(4, 0, 0, 0); // Pre-market start

    return this.getMinuteAggregates(ticker, startOfDay.getTime(), now.getTime());
  }

  // Get previous day's close for calculating gaps
  async getPreviousClose(ticker) {
    try {
      const data = await this.rateLimitedRequest(`/v2/aggs/ticker/${ticker}/prev`);
      if (data.results && data.results.length > 0) {
        return {
          ticker,
          close: data.results[0].c,
          open: data.results[0].o,
          high: data.results[0].h,
          low: data.results[0].l,
          volume: data.results[0].v,
          vwap: data.results[0].vw
        };
      }
      return null;
    } catch (error) {
      logger.error(`Failed to get previous close for ${ticker}`, { error: error.message });
      return null;
    }
  }

  // ========== Stock Trades ==========

  // Get recent trades for a ticker
  async getRecentTrades(ticker, limit = 100) {
    try {
      const data = await this.rateLimitedRequest(
        `/v3/trades/${ticker}`,
        { limit, order: 'desc' }
      );
      return data.results || [];
    } catch (error) {
      logger.error(`Failed to get recent trades for ${ticker}`, { error: error.message });
      return [];
    }
  }

  // ========== Stock Data ==========

  // Get current stock price
  async getStockPrice(ticker) {
    try {
      const data = await this.rateLimitedRequest(`/v2/aggs/ticker/${ticker}/prev`);
      if (data.results && data.results.length > 0) {
        return {
          ticker,
          close: data.results[0].c,
          open: data.results[0].o,
          high: data.results[0].h,
          low: data.results[0].l,
          volume: data.results[0].v,
          vwap: data.results[0].vw
        };
      }
      return null;
    } catch (error) {
      logger.error(`Failed to get stock price for ${ticker}`, { error: error.message });
      return null;
    }
  }

  // Get real-time snapshot for a single ticker
  async getStockSnapshot(ticker) {
    try {
      const data = await this.rateLimitedRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
      if (data.ticker) {
        const t = data.ticker;
        return {
          ticker: t.ticker,
          price: t.day?.c || t.lastTrade?.p || t.prevDay?.c,
          open: t.day?.o || t.prevDay?.c,
          high: t.day?.h || t.prevDay?.h,
          low: t.day?.l || t.prevDay?.l,
          todayVolume: t.day?.v || 0,
          prevDayVolume: t.prevDay?.v || 0,
          prevDayClose: t.prevDay?.c,
          todayChange: t.todaysChange,
          todayChangePercent: t.todaysChangePerc,
          vwap: t.day?.vw,
          lastTradePrice: t.lastTrade?.p,
          lastTradeSize: t.lastTrade?.s,
          lastTradeTime: t.lastTrade?.t
        };
      }
      return null;
    } catch (error) {
      logger.error(`Failed to get stock snapshot for ${ticker}`, { error: error.message });
      return null;
    }
  }

  // Get average daily volume (30-day average)
  async getAverageDailyVolume(ticker, days = 30) {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days - 10); // Extra days for weekends/holidays

      const data = await this.rateLimitedRequest(`/v2/aggs/ticker/${ticker}/range/1/day/${startDate.toISOString().split('T')[0]}/${endDate.toISOString().split('T')[0]}`);

      if (data.results && data.results.length > 0) {
        const volumes = data.results.slice(-days).map(d => d.v);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        return avgVolume;
      }
      return null;
    } catch (error) {
      logger.error(`Failed to get average volume for ${ticker}`, { error: error.message });
      return null;
    }
  }

  // ========== Market Data ==========

  // Get market status
  async getMarketStatus() {
    try {
      const data = await this.rateLimitedRequest('/v1/marketstatus/now');
      return {
        market: data.market,
        serverTime: data.serverTime,
        exchanges: data.exchanges,
        afterHours: data.afterHours,
        earlyHours: data.earlyHours
      };
    } catch (error) {
      logger.error('Failed to get market status', { error: error.message });
      return null;
    }
  }

  // ========== Ticker Details ==========

  async getTickerDetails(ticker) {
    try {
      const data = await this.rateLimitedRequest(`/v3/reference/tickers/${ticker}`);
      return data.results || null;
    } catch (error) {
      logger.error(`Failed to get ticker details for ${ticker}`, { error: error.message });
      return null;
    }
  }

  // ========== Intraday Bars (for VWAP calculation) ==========

  // Get intraday bars for VWAP calculation
  async getIntradayBars(ticker, minuteInterval = 5, days = 1) {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDate.setHours(4, 0, 0, 0); // Start from premarket

      const from = startDate.toISOString().split('T')[0];
      const to = endDate.toISOString().split('T')[0];

      const data = await this.rateLimitedRequest(
        `/v2/aggs/ticker/${ticker}/range/${minuteInterval}/minute/${from}/${to}`,
        { adjusted: true, sort: 'asc', limit: 5000 }
      );

      return data.results || [];
    } catch (error) {
      logger.debug(`Failed to get intraday bars for ${ticker}: ${error.message}`);
      return [];
    }
  }

  // Get daily bars for previous day levels
  async getDailyBars(ticker, days = 5) {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days - 5); // Extra for weekends

      const from = startDate.toISOString().split('T')[0];
      const to = endDate.toISOString().split('T')[0];

      const data = await this.rateLimitedRequest(
        `/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}`,
        { adjusted: true, sort: 'asc', limit: 50 }
      );

      return data.results || [];
    } catch (error) {
      logger.debug(`Failed to get daily bars for ${ticker}: ${error.message}`);
      return [];
    }
  }

  // ========== Batch Operations ==========

  // Fetch volume baselines for multiple tickers
  async fetchVolumeBaselines(tickers) {
    const baselines = {};
    const batchSize = 10;

    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const promises = batch.map(async ticker => {
        const avgVolume = await this.getAverageDailyVolume(ticker);
        if (avgVolume) {
          baselines[ticker] = avgVolume;
          // Save to database
          database.saveVolumeBaseline(ticker, avgVolume);
        }
      });

      await Promise.all(promises);
      logger.debug(`Fetched volume baselines: ${i + batch.length}/${tickers.length}`);

      // Small delay between batches
      if (i + batchSize < tickers.length) {
        await this.sleep(500);
      }
    }

    return baselines;
  }

  // Get snapshots for specific tickers (batch)
  async getMultipleSnapshots(tickers) {
    const snapshots = {};

    for (const ticker of tickers) {
      const snapshot = await this.getStockSnapshot(ticker);
      if (snapshot) {
        snapshots[ticker] = snapshot;
      }
    }

    return snapshots;
  }

  // Get previous closes for multiple tickers
  async getMultiplePreviousCloses(tickers) {
    const closes = {};

    for (const ticker of tickers) {
      const prev = await this.getPreviousClose(ticker);
      if (prev) {
        closes[ticker] = prev;
      }
    }

    return closes;
  }
}

// Export singleton instance
module.exports = new PolygonRest();
