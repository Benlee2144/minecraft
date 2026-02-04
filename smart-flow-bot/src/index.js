require('dotenv').config();

const config = require('../config');
const logger = require('./utils/logger');
const marketHours = require('./utils/marketHours');
const database = require('./database/sqlite');
const polygonRest = require('./polygon/rest');
const polygonWs = require('./polygon/websocket');
const parser = require('./polygon/parser');

// Detection modules
const volumeSpike = require('./detection/volumeSpike');
const sweepDetector = require('./detection/sweepDetector');
const ivAnomaly = require('./detection/ivAnomaly');
const heatScore = require('./detection/heatScore');
const filters = require('./detection/filters');
const outcomeTracker = require('./detection/outcomeTracker');

// Discord
const discordBot = require('./discord/bot');

class SmartFlowScanner {
  constructor() {
    this.isRunning = false;
    this.stockPrices = new Map();
    this.marketCheckInterval = null;
  }

  async start() {
    logger.info('='.repeat(50));
    logger.info('Starting Smart Flow Scanner...');
    logger.info('='.repeat(50));

    try {
      // Initialize database
      logger.info('Initializing database...');
      database.initialize();

      // Initialize detection modules
      logger.info('Initializing detection modules...');
      volumeSpike.initialize();
      sweepDetector.initialize();
      ivAnomaly.initialize();
      filters.initialize();
      outcomeTracker.initialize();

      // Set outcome tracker callback
      outcomeTracker.setOutcomeCallback((alert, outcome) => {
        discordBot.sendOutcomeUpdate(alert, outcome);
      });

      // Load volume baselines
      logger.info('Loading volume baselines...');
      await this.loadVolumeBaselines();

      // Initialize Discord bot
      logger.info('Initializing Discord bot...');
      await discordBot.initialize();

      // Set status callback for Discord
      discordBot.setStatusCallback(() => this.getStatus());

      // Connect to Polygon WebSocket
      logger.info('Connecting to Polygon WebSocket...');
      await this.connectPolygon();

      // Set up event handlers
      this.setupEventHandlers();

      // Start market hours check
      this.startMarketHoursCheck();

      this.isRunning = true;

      // Send startup message
      const status = this.getStatus();
      await discordBot.sendStartupMessage(status);

      logger.info('='.repeat(50));
      logger.info('Smart Flow Scanner is now running!');
      logger.info(`Monitoring ${config.topTickers.length} tickers`);
      logger.info(`Market status: ${marketHours.isMarketOpen() ? 'OPEN' : 'CLOSED'}`);
      logger.info('='.repeat(50));

      // If market is open, start monitoring
      if (marketHours.isMarketOpen()) {
        this.startMonitoring();
      } else {
        const timeUntilOpen = marketHours.getTimeUntilOpen();
        const hoursUntil = Math.floor(timeUntilOpen / 3600000);
        const minutesUntil = Math.floor((timeUntilOpen % 3600000) / 60000);
        logger.info(`Market closed. Opens in ${hoursUntil}h ${minutesUntil}m`);
      }

    } catch (error) {
      logger.error('Failed to start Smart Flow Scanner', { error: error.message });
      await this.shutdown();
      throw error;
    }
  }

  async loadVolumeBaselines() {
    logger.info(`Fetching volume baselines for ${config.topTickers.length} tickers...`);

    // Check if we have recent baselines in the database
    const existingBaselines = database.getAllVolumeBaselines();
    const needsRefresh = existingBaselines.length < config.topTickers.length * 0.8;

    if (needsRefresh) {
      logger.info('Refreshing volume baselines from Polygon...');
      const baselines = await polygonRest.fetchVolumeBaselines(config.topTickers.slice(0, 100)); // Limit for API rate

      for (const [ticker, avgVolume] of Object.entries(baselines)) {
        volumeSpike.setBaseline(ticker, avgVolume);
        filters.setVolumeCache(ticker, avgVolume);
      }

      logger.info(`Loaded ${Object.keys(baselines).length} volume baselines`);
    } else {
      logger.info(`Using ${existingBaselines.length} cached volume baselines`);
      for (const { ticker, avg_daily_volume } of existingBaselines) {
        volumeSpike.setBaseline(ticker, avg_daily_volume);
        filters.setVolumeCache(ticker, avg_daily_volume);
      }
    }
  }

  async connectPolygon() {
    await polygonWs.connect();

    // Wait for authentication
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Polygon authentication timeout'));
      }, 30000);

      polygonWs.once('authenticated', () => {
        clearTimeout(timeout);
        resolve();
      });

      polygonWs.once('auth_failed', (message) => {
        clearTimeout(timeout);
        reject(new Error(`Polygon auth failed: ${message}`));
      });
    });
  }

  setupEventHandlers() {
    // Handle option trades
    polygonWs.on('trade', (trade) => {
      if (trade.type === 'option_trade') {
        this.processOptionTrade(trade);
      } else if (trade.type === 'stock_trade') {
        this.processStockTrade(trade);
      }
    });

    // Handle quotes
    polygonWs.on('quote', (quote) => {
      if (quote.type === 'option_quote') {
        sweepDetector.updateQuote(quote);
      }
    });

    // Handle aggregates
    polygonWs.on('aggregate', (agg) => {
      this.processAggregate(agg);
    });

    // Handle WebSocket errors
    polygonWs.on('error', (error) => {
      logger.error('Polygon WebSocket error', { error: error.message });
      discordBot.sendError(error, 'Polygon WebSocket connection');
    });

    // Handle max reconnect reached
    polygonWs.on('max_reconnect_reached', () => {
      logger.error('Max reconnection attempts reached for Polygon');
      discordBot.sendError(new Error('Polygon connection lost'), 'Max reconnection attempts reached');
    });
  }

  startMarketHoursCheck() {
    // Check market status every minute
    this.marketCheckInterval = setInterval(() => {
      const wasOpen = this.isMonitoring;
      const isOpen = marketHours.isMarketOpen();

      if (isOpen && !wasOpen) {
        logger.info('Market just opened! Starting monitoring...');
        this.startMonitoring();
      } else if (!isOpen && wasOpen) {
        logger.info('Market just closed! Stopping monitoring...');
        this.stopMonitoring();
      }
    }, 60000);
  }

  startMonitoring() {
    this.isMonitoring = true;

    // Subscribe to options trades for top tickers
    logger.info('Subscribing to options flow...');
    polygonWs.subscribeToOptionsTrades(config.topTickers.slice(0, 50)); // Limit for connection

    // Subscribe to stock aggregates for volume tracking
    polygonWs.subscribeToStockAggregates(config.topTickers.slice(0, 50));

    // Reset daily tracking
    volumeSpike.resetDaily();
    database.cleanOldHeatHistory();

    logger.info('Monitoring started');
  }

  stopMonitoring() {
    this.isMonitoring = false;

    // Send daily summary
    const stats = database.getTodayStats();
    const outcomes = outcomeTracker.getTodayOutcomes();
    discordBot.sendDailySummary(stats, outcomes);

    logger.info('Monitoring stopped for the day');
  }

  async processOptionTrade(trade) {
    try {
      const ticker = trade.underlyingTicker;

      // Get current stock price
      const spotPrice = this.stockPrices.get(ticker) || 0;

      // Process for sweep detection
      const sweep = sweepDetector.processTrade(trade);

      if (sweep) {
        await this.evaluateSweep(sweep, spotPrice);
      }

      // Process for IV anomaly detection
      if (spotPrice > 0) {
        const ivAnomalyResult = ivAnomaly.processOptionTrade(trade, spotPrice);
        if (ivAnomalyResult) {
          logger.debug('IV anomaly detected', { ticker, ivChange: ivAnomalyResult.ivChange });
        }
      }

    } catch (error) {
      logger.error('Error processing option trade', { error: error.message });
    }
  }

  processStockTrade(trade) {
    this.stockPrices.set(trade.ticker, trade.price);
    ivAnomaly.updatePrice(trade.ticker, trade.price);
  }

  processAggregate(agg) {
    // Update volume tracking
    volumeSpike.updateVolume(agg.ticker, agg.volume);

    // Update stock price
    this.stockPrices.set(agg.ticker, agg.close);
  }

  async evaluateSweep(sweep, spotPrice) {
    const ticker = sweep.underlyingTicker;

    // Apply filters
    const filterResult = filters.shouldFilter(sweep, {
      spotPrice,
      avgVolume: volumeSpike.getBaseline(ticker)
    });

    if (filterResult.filtered) {
      logger.debug(`Sweep filtered for ${ticker}`, { reasons: filterResult.reasons });
      return;
    }

    // Check for volume spike
    const volumeSpikeResult = volumeSpike.detectSpike(ticker);
    const hasVolumeSpike = volumeSpikeResult?.isSpike || false;

    // Check for IV anomaly
    const ivAnomalyResult = ivAnomaly.detectAnomaly(ticker);
    const hasIVAnomaly = ivAnomalyResult !== null;

    // Calculate heat score
    const heatResult = heatScore.calculate(sweep, {
      spotPrice,
      hasVolumeSpike,
      volumeMultiple: volumeSpikeResult?.volumeMultiple || 0,
      ivAnomaly: hasIVAnomaly,
      ivChange: ivAnomalyResult?.ivChange || 0
    });

    // Add additional info
    heatResult.optionTicker = sweep.optionTicker;

    // Check if meets threshold
    if (!heatResult.meetsThreshold) {
      // Check if ticker is on any watchlist (lower threshold)
      const watchedTickers = discordBot.getAllWatchedTickers();
      if (watchedTickers.includes(ticker) && heatResult.heatScore >= config.heatScore.watchlistThreshold) {
        heatResult.meetsThreshold = true;
        heatResult.channel = 'watchlist';
      } else {
        logger.debug(`Sweep below threshold for ${ticker}`, { heatScore: heatResult.heatScore });
        return;
      }
    }

    // Log and send alert
    logger.flow(ticker, heatResult.heatScore, heatResult.breakdown);

    await discordBot.sendAlert(heatResult);

    // Track for outcome
    const alertId = await database.saveAlert({
      ticker: heatResult.ticker,
      contract: heatResult.contract,
      heatScore: heatResult.heatScore,
      premium: heatResult.premium,
      strike: heatResult.strike,
      spotPrice: heatResult.spotPrice,
      expiration: sweep.expiration,
      optionType: sweep.optionType,
      signalBreakdown: heatResult.breakdown,
      channel: heatResult.channel
    });

    // Start tracking outcome
    outcomeTracker.trackAlert(alertId, heatResult, sweep.avgPrice);
  }

  getStatus() {
    return {
      polygonConnected: polygonWs.isConnected,
      polygonAuthenticated: polygonWs.isAuthenticated,
      tickersMonitored: config.topTickers.length,
      baselinesLoaded: volumeSpike.volumeBaselines?.size || 0,
      marketOpen: marketHours.isMarketOpen(),
      isMonitoring: this.isMonitoring || false,
      uptime: process.uptime()
    };
  }

  async shutdown() {
    logger.info('Shutting down Smart Flow Scanner...');

    this.isRunning = false;

    if (this.marketCheckInterval) {
      clearInterval(this.marketCheckInterval);
    }

    // Shutdown components
    sweepDetector.shutdown();
    outcomeTracker.shutdown();
    polygonWs.close();
    await discordBot.shutdown();
    database.close();

    logger.info('Shutdown complete');
    process.exit(0);
  }
}

// Create and start the scanner
const scanner = new SmartFlowScanner();

// Handle graceful shutdown
process.on('SIGINT', () => scanner.shutdown());
process.on('SIGTERM', () => scanner.shutdown());

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  scanner.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: reason?.toString() });
});

// Start the scanner
scanner.start().catch((error) => {
  logger.error('Failed to start scanner', { error: error.message });
  process.exit(1);
});
