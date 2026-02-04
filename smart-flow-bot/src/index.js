require('dotenv').config();

const config = require('../config');
const logger = require('./utils/logger');
const marketHours = require('./utils/marketHours');
const database = require('./database/sqlite');
const polygonRest = require('./polygon/rest');
const polygonWs = require('./polygon/websocket');

// Stock Detection modules
const stockSignals = require('./detection/stockSignals');
const stockHeatScore = require('./detection/stockHeatScore');

// Discord
const discordBot = require('./discord/bot');

class SmartStockScanner {
  constructor() {
    this.isRunning = false;
    this.isMonitoring = false;
    this.marketCheckInterval = null;
    this.signalBuffer = new Map(); // Buffer signals to avoid spam
    this.lastAlertTime = new Map(); // Throttle alerts per ticker
    this.alertCooldownMs = 30000; // 30 second cooldown per ticker
  }

  async start() {
    logger.info('='.repeat(50));
    logger.info('Starting Smart Stock Scanner...');
    logger.info('='.repeat(50));

    try {
      // Initialize database
      logger.info('Initializing database...');
      database.initialize();

      // Initialize stock signal detector
      logger.info('Initializing stock signal detector...');
      stockSignals.initialize();

      // Load volume baselines
      logger.info('Loading volume baselines...');
      await this.loadVolumeBaselines();

      // Initialize Discord bot
      logger.info('Initializing Discord bot...');
      await discordBot.initialize();

      // Set status callback for Discord
      discordBot.setStatusCallback(() => this.getStatus());

      // Connect to Polygon WebSocket
      logger.info('Connecting to Polygon WebSocket (Stocks)...');
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
      logger.info('Smart Stock Scanner is now running!');
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
      logger.error('Failed to start Smart Stock Scanner', { error: error.message });
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
        stockSignals.setBaseline(ticker, avgVolume);
      }

      logger.info(`Loaded ${Object.keys(baselines).length} volume baselines`);
    } else {
      logger.info(`Using ${existingBaselines.length} cached volume baselines`);
      for (const { ticker, avg_daily_volume } of existingBaselines) {
        stockSignals.setBaseline(ticker, avg_daily_volume);
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
    // Handle stock trades
    polygonWs.on('trade', (trade) => {
      if (trade.type === 'stock_trade') {
        this.processStockTrade(trade);
      }
    });

    // Handle aggregates (minute bars)
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

    // Subscribe to stock trades for top tickers
    logger.info('Subscribing to stock trades...');
    polygonWs.subscribeToStockTrades(config.topTickers.slice(0, 50)); // Limit for connection

    // Subscribe to minute aggregates for volume and OHLC tracking
    logger.info('Subscribing to minute aggregates...');
    polygonWs.subscribeToStockAggregates(config.topTickers.slice(0, 50));

    // Reset daily tracking
    stockSignals.resetDaily();
    database.cleanOldHeatHistory();

    logger.info('Monitoring started');
  }

  stopMonitoring() {
    this.isMonitoring = false;

    // Send daily summary
    const stats = database.getTodayStats();
    discordBot.sendDailySummary(stats);

    logger.info('Monitoring stopped for the day');
  }

  processStockTrade(trade) {
    try {
      const ticker = trade.ticker;

      // Skip if not in our monitored list
      if (!config.topTickers.includes(ticker)) return;

      // Process trade through signal detector
      const signals = stockSignals.processTrade(trade);

      // Handle any generated signals
      if (signals && signals.length > 0) {
        for (const signal of signals) {
          this.evaluateSignal(signal);
        }
      }
    } catch (error) {
      logger.error('Error processing stock trade', { error: error.message });
    }
  }

  processAggregate(agg) {
    try {
      const ticker = agg.ticker;

      // Skip if not in our monitored list
      if (!config.topTickers.includes(ticker)) return;

      // Process aggregate through signal detector
      const signals = stockSignals.processAggregate(agg);

      // Handle any generated signals
      if (signals && signals.length > 0) {
        for (const signal of signals) {
          this.evaluateSignal(signal);
        }
      }
    } catch (error) {
      logger.error('Error processing aggregate', { error: error.message });
    }
  }

  async evaluateSignal(signal) {
    const ticker = signal.ticker;

    // Check cooldown
    const lastAlert = this.lastAlertTime.get(ticker) || 0;
    const timeSinceLastAlert = Date.now() - lastAlert;

    if (timeSinceLastAlert < this.alertCooldownMs) {
      logger.debug(`Skipping alert for ${ticker}, cooldown active`);
      return;
    }

    // Get context for heat score calculation
    const context = {
      hasVolumeSpike: signal.hasVolumeSpike || false,
      volumeMultiple: signal.rvol || 0,
      priceChange: signal.priceChange || 0
    };

    // Calculate heat score
    const heatResult = stockHeatScore.calculate(signal, context);

    // Check if meets threshold
    if (!heatResult.meetsThreshold) {
      // Check if ticker is on any watchlist (lower threshold)
      const watchedTickers = discordBot.getAllWatchedTickers();
      if (watchedTickers.includes(ticker) && heatResult.heatScore >= config.heatScore.watchlistThreshold) {
        heatResult.meetsThreshold = true;
        heatResult.channel = 'watchlist';
      } else {
        logger.debug(`Signal below threshold for ${ticker}`, {
          heatScore: heatResult.heatScore,
          signalType: signal.type
        });
        return;
      }
    }

    // Update cooldown
    this.lastAlertTime.set(ticker, Date.now());

    // Log the signal
    logger.flow(ticker, heatResult.heatScore, heatResult.breakdown);

    // Send alert to Discord
    await discordBot.sendStockAlert(signal, heatResult);

    // Save to database
    database.saveAlert({
      ticker: heatResult.ticker,
      signalType: signal.type,
      heatScore: heatResult.heatScore,
      price: signal.price,
      volume: signal.volume || signal.currentVolume || 0,
      signalBreakdown: heatResult.breakdown,
      channel: heatResult.channel
    });

    // Add to heat history for tracking
    database.addHeatSignal(ticker, signal.type, signal.tradeValue || signal.volume || 0);
  }

  getStatus() {
    return {
      polygonConnected: polygonWs.isConnected,
      polygonAuthenticated: polygonWs.isAuthenticated,
      tickersMonitored: config.topTickers.length,
      baselinesLoaded: stockSignals.volumeBaselines?.size || 0,
      marketOpen: marketHours.isMarketOpen(),
      isMonitoring: this.isMonitoring || false,
      uptime: process.uptime(),
      dataSource: 'Stocks (Real-time)'
    };
  }

  async shutdown() {
    logger.info('Shutting down Smart Stock Scanner...');

    this.isRunning = false;

    if (this.marketCheckInterval) {
      clearInterval(this.marketCheckInterval);
    }

    // Shutdown components
    stockSignals.shutdown();
    polygonWs.close();
    await discordBot.shutdown();
    database.close();

    logger.info('Shutdown complete');
    process.exit(0);
  }
}

// Create and start the scanner
const scanner = new SmartStockScanner();

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
