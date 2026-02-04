const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

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

    // Rate limiting: Polygon free tier = 5 calls/minute
    this.requestQueue = [];
    this.lastRequestTime = 0;
    this.minRequestInterval = 250; // 250ms between requests
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

  // Get real-time snapshot
  async getStockSnapshot(ticker) {
    try {
      const data = await this.rateLimitedRequest(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
      if (data.ticker) {
        return {
          ticker: data.ticker.ticker,
          price: data.ticker.day?.c || data.ticker.prevDay?.c,
          todayVolume: data.ticker.day?.v || 0,
          prevDayVolume: data.ticker.prevDay?.v || 0,
          todayChange: data.ticker.todaysChange,
          todayChangePercent: data.ticker.todaysChangePerc
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

  // ========== Options Data ==========

  // Get options contracts for a ticker
  async getOptionsContracts(ticker, expirationDate = null) {
    try {
      const params = {
        underlying_ticker: ticker,
        limit: 250
      };

      if (expirationDate) {
        params.expiration_date = expirationDate;
      }

      const data = await this.rateLimitedRequest('/v3/reference/options/contracts', params);
      return data.results || [];
    } catch (error) {
      logger.error(`Failed to get options contracts for ${ticker}`, { error: error.message });
      return [];
    }
  }

  // Get options snapshot (real-time data)
  async getOptionsSnapshot(underlyingTicker) {
    try {
      const data = await this.rateLimitedRequest(
        `/v3/snapshot/options/${underlyingTicker}`,
        { limit: 250 }
      );
      return data.results || [];
    } catch (error) {
      logger.error(`Failed to get options snapshot for ${underlyingTicker}`, { error: error.message });
      return [];
    }
  }

  // Get specific option contract details
  async getOptionContractDetails(optionTicker) {
    try {
      const data = await this.rateLimitedRequest(`/v3/reference/options/contracts/${optionTicker}`);
      return data.results || null;
    } catch (error) {
      logger.error(`Failed to get option contract details for ${optionTicker}`, { error: error.message });
      return null;
    }
  }

  // Get open interest for an option
  async getOptionOpenInterest(optionTicker) {
    try {
      const data = await this.rateLimitedRequest(`/v2/aggs/ticker/${optionTicker}/prev`);
      if (data.results && data.results.length > 0) {
        return data.results[0].v; // Volume as proxy, OI requires different endpoint
      }
      return 0;
    } catch (error) {
      logger.error(`Failed to get open interest for ${optionTicker}`, { error: error.message });
      return 0;
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
        exchanges: data.exchanges
      };
    } catch (error) {
      logger.error('Failed to get market status', { error: error.message });
      return null;
    }
  }

  // ========== Earnings Data ==========

  // Get upcoming earnings dates (using ticker news as proxy)
  async getTickerDetails(ticker) {
    try {
      const data = await this.rateLimitedRequest(`/v3/reference/tickers/${ticker}`);
      return data.results || null;
    } catch (error) {
      logger.error(`Failed to get ticker details for ${ticker}`, { error: error.message });
      return null;
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
        }
      });

      await Promise.all(promises);
      logger.debug(`Fetched volume baselines: ${i + batch.length}/${tickers.length}`);

      // Small delay between batches
      if (i + batchSize < tickers.length) {
        await this.sleep(1000);
      }
    }

    return baselines;
  }

  // Get current prices for multiple tickers
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

  // ========== IV Calculation Helpers ==========

  // Estimate IV from options data (simplified)
  async getImpliedVolatility(optionTicker) {
    try {
      const data = await this.rateLimitedRequest(`/v3/snapshot/options/${optionTicker.split('O:')[1]?.substring(0, optionTicker.indexOf('C') - 2) || optionTicker}`);
      if (data.results && data.results.length > 0) {
        // Find the specific contract
        const contract = data.results.find(r => r.details?.ticker === optionTicker);
        if (contract && contract.implied_volatility) {
          return contract.implied_volatility;
        }
      }
      return null;
    } catch (error) {
      logger.debug(`Failed to get IV for ${optionTicker}`, { error: error.message });
      return null;
    }
  }
}

// Export singleton instance
module.exports = new PolygonRest();
