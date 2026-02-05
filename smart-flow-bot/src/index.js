require('dotenv').config();

const config = require('../config');
const logger = require('./utils/logger');
const marketHours = require('./utils/marketHours');
const database = require('./database/sqlite');
const polygonRest = require('./polygon/rest');
const polygonWS = require('./polygon/websocket');

// Stock Detection modules
const stockHeatScore = require('./detection/stockHeatScore');
const keyLevels = require('./detection/keyLevels');
const spyCorrelation = require('./detection/spyCorrelation');
const sectorHeatMap = require('./detection/sectorHeatMap');
const tradeRecommendation = require('./detection/tradeRecommendation');

// Advanced Detection modules (Elite features)
const preMarketScanner = require('./detection/preMarketScanner');
const exitSignals = require('./detection/exitSignals');
const squeezeDetection = require('./detection/squeezeDetection');
const patternRecognition = require('./detection/patternRecognition');
const vixMonitor = require('./detection/vixMonitor');
const afterHoursScanner = require('./detection/afterHoursScanner');

// Elite Pro features (Institutional-grade)
const sectorCorrelation = require('./detection/sectorCorrelation');
const winRateTracker = require('./detection/winRateTracker');
const orderFlowImbalance = require('./detection/orderFlowImbalance');
const greeksCalculator = require('./detection/greeksCalculator');
const blockTradeDetector = require('./detection/blockTradeDetector');

// Data modules
const earningsCalendar = require('./utils/earnings');
const paperTrading = require('./utils/paperTrading');

// Discord
const discordBot = require('./discord/bot');

class SmartStockScanner {
  constructor() {
    this.isRunning = false;
    this.isMonitoring = false;
    this.marketCheckInterval = null;
    this.pollingInterval = null;
    this.sectorUpdateInterval = null;
    this.lastSnapshots = new Map(); // Track previous snapshots for change detection
    this.volumeBaselines = new Map();
    this.previousCloses = new Map();
    this.alertCooldowns = new Map(); // Throttle alerts per ticker
    this.alertCooldownMs = 60000; // 60 second cooldown
    this.pollIntervalMs = 30000; // REST poll every 30 seconds

    // REST polling is better than WebSocket on $29 plan
    // WebSocket = 15-min delayed, REST = current data every 30 sec
    this.useWebSocket = false;
    this.wsConnected = false;
    this.realtimeVolumes = new Map(); // Track real-time volume accumulation
    this.lastTradePrice = new Map(); // Track last trade price per ticker
    this.sectorUpdateIntervalMs = 120000; // Update sectors every 2 minutes

    // Elite feature intervals
    this.preMarketInterval = null;
    this.afterHoursInterval = null;
    this.vixUpdateInterval = null;
    this.sectorCorrelationInterval = null;
  }

  async start() {
    logger.info('='.repeat(50));
    logger.info('Starting Smart Stock Scanner (REST API Mode)...');
    logger.info('='.repeat(50));

    try {
      // Initialize database
      logger.info('Initializing database...');
      database.initialize();

      // Initialize earnings calendar
      earningsCalendar.initialize();
      earningsCalendar.cleanPastEarnings();

      // Initialize paper trading system
      logger.info('Initializing paper trading system...');
      paperTrading.initialize();

      // Auto-fetch earnings from Yahoo Finance (runs in background)
      logger.info('Fetching earnings calendar from Yahoo Finance...');
      earningsCalendar.autoFetchEarnings(config.topTickers).catch(err => {
        logger.warn('Could not auto-fetch earnings', { error: err.message });
      });

      // Load volume baselines
      logger.info('Loading volume baselines...');
      await this.loadVolumeBaselines();

      // Load previous closes for gap detection
      logger.info('Loading previous closes...');
      await this.loadPreviousCloses();

      // Initialize Discord bot
      logger.info('Initializing Discord bot...');
      await discordBot.initialize();

      // Set status callback for Discord
      discordBot.setStatusCallback(() => this.getStatus());

      // Verify Polygon API connection
      logger.info('Verifying Polygon API connection...');
      const marketStatus = await polygonRest.getMarketStatus();
      if (marketStatus) {
        logger.info('Polygon API connected successfully', { market: marketStatus.market });
      } else {
        throw new Error('Failed to connect to Polygon API');
      }

      // Start market hours check
      this.startMarketHoursCheck();

      // Start pre-market scanner (9:00-9:30 AM)
      this.startPreMarketScanner();

      // Start after-hours scanner (4:00-8:00 PM)
      this.startAfterHoursScanner();

      // Start VIX monitoring
      this.startVixMonitoring();

      // Start sector correlation monitoring
      this.startSectorCorrelationMonitoring();

      // Connect to WebSocket for real-time streaming
      if (this.useWebSocket) {
        await this.startWebSocket();
      }

      this.isRunning = true;

      // Send startup message
      const status = this.getStatus();
      await discordBot.sendStartupMessage(status);

      logger.info('='.repeat(50));
      logger.info('Smart Stock Scanner is now running!');
      logger.info(`Mode: ${this.wsConnected ? '⚡ REAL-TIME WebSocket' : '🔄 REST API Polling'}`);
      logger.info(`Monitoring ${config.topTickers.length} tickers`);
      if (!this.wsConnected) {
        logger.info(`REST polling interval: ${this.pollIntervalMs / 1000} seconds`);
      }
      logger.info(`Market status: ${marketHours.isMarketOpen() ? 'OPEN' : 'CLOSED'}`);
      logger.info('='.repeat(50));

      // If market is open, start monitoring
      if (marketHours.isMarketOpen()) {
        await this.startMonitoring();
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
    const needsRefresh = existingBaselines.length < config.topTickers.length * 0.5;

    if (needsRefresh) {
      logger.info('Refreshing volume baselines from Polygon...');
      const baselines = await polygonRest.fetchVolumeBaselines(config.topTickers.slice(0, 50)); // Limit for API rate

      for (const [ticker, avgVolume] of Object.entries(baselines)) {
        this.volumeBaselines.set(ticker, avgVolume);
      }

      logger.info(`Loaded ${Object.keys(baselines).length} volume baselines from API`);
    } else {
      logger.info(`Using ${existingBaselines.length} cached volume baselines`);
      for (const { ticker, avg_daily_volume } of existingBaselines) {
        this.volumeBaselines.set(ticker, avg_daily_volume);
      }
    }
  }

  async loadPreviousCloses() {
    logger.info('Fetching previous closes for gap detection...');

    // Get previous closes in batches
    const batchSize = 20;
    for (let i = 0; i < config.topTickers.length && i < 50; i += batchSize) {
      const batch = config.topTickers.slice(i, i + batchSize);
      for (const ticker of batch) {
        const prevClose = await polygonRest.getPreviousClose(ticker);
        if (prevClose) {
          this.previousCloses.set(ticker, prevClose);
        }
      }
      await this.sleep(500); // Small delay between batches
    }

    logger.info(`Loaded ${this.previousCloses.size} previous closes`);
  }

  startMarketHoursCheck() {
    // Check market status every minute
    this.marketCheckInterval = setInterval(async () => {
      const wasOpen = this.isMonitoring;
      const isOpen = marketHours.isMarketOpen();

      if (isOpen && !wasOpen) {
        logger.info('Market just opened! Starting monitoring...');
        await this.startMonitoring();
      } else if (!isOpen && wasOpen) {
        logger.info('Market just closed! Stopping monitoring...');
        this.stopMonitoring();
      }
    }, 60000);
  }

  async startMonitoring() {
    this.isMonitoring = true;

    // Reset daily tracking
    database.cleanOldHeatHistory();
    this.alertCooldowns.clear();
    keyLevels.cleanOldAlerts();

    // Refresh previous closes for new day
    await this.loadPreviousCloses();

    // Calculate key levels for tracked tickers
    logger.info('Calculating key levels...');
    await this.calculateAllKeyLevels();

    // Initial SPY update
    logger.info('Fetching initial SPY data...');
    await spyCorrelation.updateSPY();

    // Initial sector update
    logger.info('Fetching sector data...');
    await sectorHeatMap.updateSectors();

    // Start polling
    logger.info('Starting REST API polling...');
    this.startPolling();

    // Start sector update interval
    this.startSectorUpdates();

    logger.info('Monitoring started');
  }

  // Calculate key levels for all tracked tickers
  async calculateAllKeyLevels() {
    for (const [ticker, prevClose] of this.previousCloses) {
      const snapshot = await polygonRest.getStockSnapshot(ticker);
      if (snapshot) {
        keyLevels.calculateLevels(ticker, snapshot, prevClose);
      }
      await this.sleep(50);
    }
    logger.info(`Calculated key levels for ${this.previousCloses.size} tickers`);
  }

  // Start periodic sector updates
  startSectorUpdates() {
    this.sectorUpdateInterval = setInterval(async () => {
      if (this.isMonitoring && marketHours.isMarketOpen()) {
        await spyCorrelation.updateSPY();
        await sectorHeatMap.updateSectors();
        logger.debug('Updated SPY and sector data');
      }
    }, this.sectorUpdateIntervalMs);
  }

  // Start pre-market scanner (9:00-9:30 AM ET)
  startPreMarketScanner() {
    logger.info('Pre-market scanner initialized (9:00-9:30 AM ET)');

    // Check every minute during pre-market window
    this.preMarketInterval = setInterval(async () => {
      if (preMarketScanner.isPreMarketTime()) {
        try {
          const results = await preMarketScanner.scan();
          if (results && results.gaps.length > 0) {
            // Send gap alerts to pre-market channel
            const gapEmbed = preMarketScanner.formatGapAlerts();
            if (gapEmbed) {
              await discordBot.sendEmbed('preMarket', gapEmbed);
            }

            // Send volume leaders
            const volumeEmbed = preMarketScanner.formatVolumeLeaders();
            if (volumeEmbed) {
              await discordBot.sendEmbed('preMarket', volumeEmbed);
            }
          }
        } catch (error) {
          logger.error('Pre-market scan error', { error: error.message });
        }
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  // Start after-hours scanner (4:00-8:00 PM ET)
  startAfterHoursScanner() {
    logger.info('After-hours scanner initialized (4:00-8:00 PM ET)');

    // Check every 10 minutes during after-hours
    this.afterHoursInterval = setInterval(async () => {
      if (afterHoursScanner.isAfterHoursTime()) {
        try {
          const results = await afterHoursScanner.scan();
          if (results && results.movers.length > 0) {
            const embed = afterHoursScanner.formatAfterHoursAlerts();
            if (embed) {
              await discordBot.sendEmbed('preMarket', embed); // Use pre-market channel for AH too
            }

            // Send next-day setups at end of after-hours
            const now = new Date();
            const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            if (et.getHours() === 19 && et.getMinutes() >= 50) { // Near 8 PM
              const setupsEmbed = afterHoursScanner.formatNextDaySetups();
              if (setupsEmbed) {
                await discordBot.sendEmbed('preMarket', setupsEmbed);
              }
            }
          }
        } catch (error) {
          logger.error('After-hours scan error', { error: error.message });
        }
      }
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  // Start VIX monitoring
  startVixMonitoring() {
    logger.info('VIX monitoring initialized');

    // Update VIX every 5 minutes during market hours
    this.vixUpdateInterval = setInterval(async () => {
      if (marketHours.isMarketOpen() || preMarketScanner.isPreMarketTime()) {
        try {
          await vixMonitor.updateVix();

          // Check for significant level changes
          const levelChange = vixMonitor.checkForLevelChange();
          if (levelChange) {
            const embed = vixMonitor.formatVixAlert(levelChange);
            await discordBot.sendEmbed('flowScanner', embed);
            logger.info(`VIX level change: ${levelChange.from} -> ${levelChange.to}`);
          }
        } catch (error) {
          logger.error('VIX update error', { error: error.message });
        }
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  // Start sector correlation monitoring
  startSectorCorrelationMonitoring() {
    logger.info('Sector correlation monitoring initialized');

    // Update sector correlation every 10 minutes
    this.sectorCorrelationInterval = setInterval(async () => {
      if (marketHours.isMarketOpen()) {
        try {
          await sectorCorrelation.updateHistory();

          // Check for rotation signals
          const signals = sectorCorrelation.rotationSignals;
          if (signals && signals.length > 0) {
            for (const signal of signals) {
              if (signal.strength >= 60) {
                logger.info(`Sector rotation: ${signal.type} - ${signal.message}`);
              }
            }
          }
        } catch (error) {
          logger.error('Sector correlation update error', { error: error.message });
        }
      }
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  async stopMonitoring() {
    this.isMonitoring = false;

    // Stop polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    // Stop sector updates
    if (this.sectorUpdateInterval) {
      clearInterval(this.sectorUpdateInterval);
      this.sectorUpdateInterval = null;
    }

    // Store closing prices for after-hours scanner
    logger.info('Storing closing prices for after-hours scanner...');
    const closingPrices = {};
    for (const [ticker, snapshot] of this.lastSnapshots) {
      if (snapshot.price) {
        closingPrices[ticker] = snapshot.price;
      }
    }
    afterHoursScanner.storeClosingPrices(closingPrices);

    // Close all open paper trades at market close
    logger.info('Closing all open paper trades at market close...');

    // Build price map for closing
    const prices = {};
    for (const [ticker, snapshot] of this.lastSnapshots) {
      if (snapshot.price) {
        prices[ticker] = snapshot.price;
      }
    }

    const closedTrades = await paperTrading.closeAllAtMarketClose(prices);
    logger.info(`Closed ${closedTrades.length} paper trades at market close`);

    // Notify about each closed trade in paper-trades channel
    for (const trade of closedTrades) {
      const pnlSign = trade.pnlDollars >= 0 ? '+' : '';
      const emoji = trade.pnlDollars >= 0 ? '✅' : '❌';
      const message = `${emoji} **MARKET CLOSE** - ${trade.ticker}\n` +
                     `${pnlSign}$${trade.pnlDollars.toFixed(0)} (${pnlSign}${trade.optionPnlPercent.toFixed(0)}%)`;
      await discordBot.sendMessage('paperTrades', message);
    }

    // Send paper trading daily recap to daily-recap channel
    const paperRecap = paperTrading.formatRecapForDiscord();
    await discordBot.sendMessage('dailyRecap', paperRecap);

    // Send daily summary
    const stats = database.getTodayStats();
    await discordBot.sendDailySummary(stats);

    // Reset paper trading for next day
    paperTrading.resetDailyTracking();

    // Reset real-time volume tracking for next day
    this.realtimeVolumes.clear();
    this.lastTradePrice.clear();

    logger.info('Monitoring stopped for the day');
  }

  startPolling() {
    // Initial poll
    this.pollMarketData();

    // Set up interval for continuous polling (backup for WebSocket)
    this.pollingInterval = setInterval(() => {
      if (this.isMonitoring && marketHours.isMarketOpen()) {
        this.pollMarketData();
      }
    }, this.pollIntervalMs);
  }

  // ========== WEBSOCKET REAL-TIME STREAMING ==========
  async startWebSocket() {
    try {
      logger.info('⚡ Connecting to Polygon WebSocket for real-time streaming...');

      // Set up event handlers before connecting
      this.setupWebSocketHandlers();

      // Connect to WebSocket
      await polygonWS.connect();
      this.wsConnected = true;

      // Wait for authentication
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket auth timeout')), 10000);
        polygonWS.once('authenticated', () => {
          clearTimeout(timeout);
          resolve();
        });
        polygonWS.once('auth_failed', (msg) => {
          clearTimeout(timeout);
          reject(new Error(`Auth failed: ${msg}`));
        });
      });

      // Clear any old subscriptions first
      polygonWS.clearSubscriptions();

      // Subscribe to stock aggregates for our watchlist
      // Starter plan has limits - only subscribe to top tickers
      const tickersToStream = [...new Set([
        ...config.topTickers.slice(0, 15), // Top 15 most liquid (Starter plan limit)
        ...discordBot.getAllWatchedTickers()
      ])].slice(0, 20); // Max 20 tickers total

      logger.info(`Subscribing to real-time data for ${tickersToStream.length} tickers...`);

      // Subscribe to minute aggregates only (trades would double the subscriptions)
      polygonWS.subscribeToStockAggregates(tickersToStream);

      logger.info('⚡ WebSocket connected and streaming real-time data!');

    } catch (error) {
      logger.warn('WebSocket connection failed, falling back to REST polling', { error: error.message });
      this.wsConnected = false;
      this.useWebSocket = false;
    }
  }

  setupWebSocketHandlers() {
    // Handle real-time trades
    polygonWS.on('trade', (trade) => {
      if (!this.isMonitoring || !marketHours.isMarketOpen()) return;
      this.processRealtimeTrade(trade);
    });

    // Handle minute aggregates
    polygonWS.on('aggregate', (agg) => {
      if (!this.isMonitoring || !marketHours.isMarketOpen()) return;
      this.processRealtimeAggregate(agg);
    });

    // Handle disconnection
    polygonWS.on('max_reconnect_reached', () => {
      logger.error('WebSocket max reconnect attempts reached, switching to REST polling');
      this.wsConnected = false;
    });

    polygonWS.on('error', (error) => {
      logger.error('WebSocket error', { error: error.message });
    });
  }

  processRealtimeTrade(trade) {
    try {
      const { ticker, price, size, timestamp } = trade;
      if (!ticker || !price) return;

      // Track last trade price
      this.lastTradePrice.set(ticker, price);

      // Accumulate volume
      const currentVolume = this.realtimeVolumes.get(ticker) || 0;
      this.realtimeVolumes.set(ticker, currentVolume + size);

      // Check for block trades (>10k shares or >$200k)
      const tradeValue = price * size;
      if (size >= 10000 || tradeValue >= 200000) {
        logger.info(`🔷 Block trade: ${ticker} ${size.toLocaleString()} shares @ $${price.toFixed(2)} ($${(tradeValue / 1000000).toFixed(2)}M)`);

        blockTradeDetector.analyzeBlock(ticker, {
          price,
          size,
          value: tradeValue,
          conditions: trade.conditions || [],
          previousClose: this.previousCloses.get(ticker)?.close
        });

        // Trigger immediate evaluation for block trades
        this.evaluateRealtimeSignal(ticker, 'block_trade', {
          size,
          value: tradeValue,
          price
        });
      }

      // Update order flow in real-time
      const prevPrice = this.lastSnapshots.get(ticker)?.price || price;
      const direction = price > prevPrice ? 'buy' : price < prevPrice ? 'sell' : 'neutral';

      orderFlowImbalance.updateFlowData(ticker, {
        price,
        volume: size,
        change: ((price - prevPrice) / prevPrice) * 100
      });

    } catch (error) {
      logger.debug('Error processing real-time trade', { error: error.message });
    }
  }

  processRealtimeAggregate(agg) {
    try {
      const { ticker, open, high, low, close, volume, vwap } = agg;
      if (!ticker || !close) return;

      const avgVolume = this.volumeBaselines.get(ticker) || 1;
      const totalVolume = this.realtimeVolumes.get(ticker) || volume;
      const prevClose = this.previousCloses.get(ticker)?.close;

      // Build snapshot from aggregate
      const snapshot = {
        ticker,
        price: close,
        open,
        high,
        low,
        todayVolume: totalVolume,
        prevDayVolume: avgVolume,
        prevDayClose: prevClose,
        todayChange: prevClose ? close - prevClose : 0,
        todayChangePercent: prevClose ? ((close - prevClose) / prevClose) * 100 : 0,
        vwap,
        isRealtime: true
      };

      // Process through normal signal detection
      this.processSnapshot(snapshot);

    } catch (error) {
      logger.debug('Error processing real-time aggregate', { error: error.message });
    }
  }

  async evaluateRealtimeSignal(ticker, signalType, data) {
    try {
      // Check cooldown
      const cooldownKey = `${ticker}-${signalType}`;
      const lastAlert = this.alertCooldowns.get(cooldownKey);
      if (lastAlert && Date.now() - lastAlert < this.alertCooldownMs) {
        return; // Still in cooldown
      }

      const price = data.price || this.lastTradePrice.get(ticker);
      const avgVolume = this.volumeBaselines.get(ticker) || 1;
      const currentVolume = this.realtimeVolumes.get(ticker) || 0;
      const prevClose = this.previousCloses.get(ticker)?.close;

      // Calculate RVOL
      const minutesSinceOpen = marketHours.getMinutesSinceOpen();
      const expectedRvol = minutesSinceOpen / 390;
      const rvol = avgVolume > 0 ? (currentVolume / avgVolume) / (expectedRvol || 0.1) : 1;

      // Calculate change
      const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

      // Build signal for heat score
      const signal = {
        type: signalType,
        ticker,
        price,
        rvol,
        currentVolume,
        avgVolume,
        severity: signalType === 'block_trade' ? 'high' : 'medium',
        description: signalType === 'block_trade'
          ? `Block: ${data.size.toLocaleString()} shares ($${(data.value / 1000).toFixed(0)}k)`
          : `Real-time signal`
      };

      // Calculate heat score
      const heatResult = stockHeatScore.calculateHeatScore(ticker, [signal], {
        price,
        rvol,
        priceChange: changePercent,
        volume: currentVolume,
        isWatched: discordBot.getAllWatchedTickers().includes(ticker)
      });

      if (heatResult.score >= config.heatScore.alertThreshold) {
        this.alertCooldowns.set(cooldownKey, Date.now());

        // Get recommendation
        const recommendation = tradeRecommendation.generateRecommendation({
          ticker,
          price,
          heatScore: heatResult.score,
          signalType: signalType,
          volumeMultiplier: rvol,
          priceChange: changePercent,
          signalBreakdown: heatResult.breakdown
        });

        // Send alert
        await this.sendSignalAlert(ticker, signal, heatResult, recommendation);
      }

    } catch (error) {
      logger.error('Error evaluating real-time signal', { error: error.message, ticker });
    }
  }

  // Resubscribe when watchlist changes
  updateWebSocketSubscriptions() {
    if (!this.wsConnected) return;

    const tickersToStream = [...new Set([
      ...config.topTickers.slice(0, 15),
      ...discordBot.getAllWatchedTickers()
    ])].slice(0, 20); // Max 20 for Starter plan

    polygonWS.subscribeToStockAggregates(tickersToStream);
    logger.info(`Updated WebSocket subscriptions: ${tickersToStream.length} tickers`);
  }

  // ========== END WEBSOCKET ==========

  async pollMarketData() {
    try {
      logger.debug('Polling market data...');

      // Update SPY first (important for alignment checking)
      await spyCorrelation.updateSPY();

      // Log trading phase periodically
      const phase = marketHours.getTradingPhase();
      if (phase.phase !== 'closed') {
        logger.debug(`Trading phase: ${phase.label} (${phase.emoji}) - Heat bonus: ${phase.heatBonus > 0 ? '+' : ''}${phase.heatBonus}`);
      }

      // Get gainers and losers (these are often the most interesting)
      const [gainers, losers] = await Promise.all([
        polygonRest.getGainersLosers('gainers'),
        polygonRest.getGainersLosers('losers')
      ]);

      // Process top gainers
      for (const ticker of gainers.slice(0, 10)) {
        await this.processSnapshot(ticker);
      }

      // Process top losers
      for (const ticker of losers.slice(0, 10)) {
        await this.processSnapshot(ticker);
      }

      // Also poll our specific watchlist tickers
      const watchedTickers = discordBot.getAllWatchedTickers();
      const tickersToCheck = [...new Set([...config.topTickers.slice(0, 20), ...watchedTickers])];

      for (const ticker of tickersToCheck.slice(0, 30)) { // Limit to 30 to stay within rate limits
        const snapshot = await polygonRest.getStockSnapshot(ticker);
        if (snapshot) {
          await this.processSnapshot(snapshot);
        }
        await this.sleep(100); // Small delay between requests
      }

      // Check paper trades against current prices
      await this.checkPaperTrades();

      // Run advanced pattern detection on hot tickers
      await this.runAdvancedDetection();

      logger.debug('Polling cycle complete');

    } catch (error) {
      logger.error('Error during polling', { error: error.message });
    }
  }

  async processSnapshot(tickerData) {
    try {
      // Handle both raw ticker object from gainers/losers and snapshot format
      const snapshot = tickerData.ticker
        ? {
            ticker: tickerData.ticker,
            price: tickerData.day?.c || tickerData.lastTrade?.p || tickerData.prevDay?.c,
            open: tickerData.day?.o,
            high: tickerData.day?.h,
            low: tickerData.day?.l,
            todayVolume: tickerData.day?.v || 0,
            prevDayVolume: tickerData.prevDay?.v || 0,
            prevDayClose: tickerData.prevDay?.c,
            todayChange: tickerData.todaysChange,
            todayChangePercent: tickerData.todaysChangePerc,
            vwap: tickerData.day?.vw
          }
        : tickerData;

      if (!snapshot.ticker || !snapshot.price) return;

      const ticker = snapshot.ticker;
      const lastSnapshot = this.lastSnapshots.get(ticker);

      // Store current snapshot for next comparison
      this.lastSnapshots.set(ticker, { ...snapshot, timestamp: Date.now() });

      // Update order flow imbalance tracking
      if (snapshot.todayVolume && snapshot.todayChangePercent !== undefined) {
        orderFlowImbalance.updateFlowData(ticker, {
          price: snapshot.price,
          volume: snapshot.todayVolume - (lastSnapshot?.todayVolume || 0),
          change: snapshot.todayChangePercent
        });
      }

      // Check for block trade patterns
      if (snapshot.todayVolume > 500000 && snapshot.price > 20) {
        // Estimate if there might be block activity based on volume patterns
        const avgVolume = this.volumeBaselines.get(ticker) || snapshot.prevDayVolume || 1;
        const volumeRatio = snapshot.todayVolume / avgVolume;

        if (volumeRatio > 2.5) {
          // High volume suggests possible block activity
          blockTradeDetector.analyzeBlock(ticker, {
            price: snapshot.price,
            size: Math.round((snapshot.todayVolume - (lastSnapshot?.todayVolume || 0)) * 0.1),
            value: (snapshot.todayVolume - (lastSnapshot?.todayVolume || 0)) * 0.1 * snapshot.price,
            conditions: [],
            previousClose: snapshot.prevDayClose
          });
        }
      }

      // Detect signals
      const signals = this.detectSignals(snapshot, lastSnapshot);

      // Process any detected signals
      for (const signal of signals) {
        await this.evaluateSignal(signal);
      }

    } catch (error) {
      logger.error('Error processing snapshot', { error: error.message, ticker: tickerData?.ticker });
    }
  }

  detectSignals(snapshot, lastSnapshot) {
    const signals = [];
    const ticker = snapshot.ticker;
    const avgVolume = this.volumeBaselines.get(ticker) || snapshot.prevDayVolume || 1;
    const prevClose = this.previousCloses.get(ticker)?.close || snapshot.prevDayClose;

    // 1. Volume Spike Detection (RVOL)
    if (snapshot.todayVolume > 0 && avgVolume > 0) {
      const rvol = snapshot.todayVolume / avgVolume;
      const minutesSinceOpen = marketHours.getMinutesSinceOpen();

      // Normalize for time of day (expected volume)
      const expectedRvol = minutesSinceOpen / 390; // 390 minutes in trading day
      const adjustedRvol = expectedRvol > 0 ? rvol / expectedRvol : rvol;

      if (adjustedRvol >= 3.0) {
        signals.push({
          type: 'volume_spike',
          ticker,
          price: snapshot.price,
          rvol: adjustedRvol,
          currentVolume: snapshot.todayVolume,
          avgVolume,
          severity: adjustedRvol >= 5.0 ? 'extreme' : 'high',
          description: `${adjustedRvol.toFixed(1)}x relative volume (adjusted for time)`
        });
      }
    }

    // 2. Price Change / Momentum Detection
    if (snapshot.todayChangePercent !== undefined) {
      const changePercent = Math.abs(snapshot.todayChangePercent);

      if (changePercent >= 5) {
        signals.push({
          type: 'momentum_surge',
          ticker,
          price: snapshot.price,
          priceChange: snapshot.todayChangePercent,
          direction: snapshot.todayChangePercent > 0 ? 'up' : 'down',
          severity: changePercent >= 10 ? 'extreme' : 'high',
          description: `${snapshot.todayChangePercent > 0 ? '+' : ''}${snapshot.todayChangePercent.toFixed(2)}% move today`
        });
      }
    }

    // 3. Gap Detection (comparing open to previous close)
    if (snapshot.open && prevClose) {
      const gapPercent = ((snapshot.open - prevClose) / prevClose) * 100;

      if (Math.abs(gapPercent) >= 3) {
        signals.push({
          type: 'gap',
          ticker,
          price: snapshot.price,
          gapPercent,
          gapSize: snapshot.open - prevClose,
          previousClose: prevClose,
          openPrice: snapshot.open,
          direction: gapPercent > 0 ? 'up' : 'down',
          severity: Math.abs(gapPercent) >= 5 ? 'high' : 'medium',
          description: `${gapPercent > 0 ? '+' : ''}${gapPercent.toFixed(2)}% gap ${gapPercent > 0 ? 'up' : 'down'}`
        });
      }
    }

    // 4. New High/Low Detection
    if (snapshot.price && snapshot.high && snapshot.low) {
      // New intraday high
      if (lastSnapshot && snapshot.high > (lastSnapshot.high || 0) && snapshot.price >= snapshot.high * 0.998) {
        signals.push({
          type: 'new_high',
          ticker,
          price: snapshot.price,
          high: snapshot.high,
          severity: 'medium',
          description: `New intraday high at $${snapshot.high.toFixed(2)}`
        });
      }

      // New intraday low
      if (lastSnapshot && snapshot.low < (lastSnapshot.low || Infinity) && snapshot.price <= snapshot.low * 1.002) {
        signals.push({
          type: 'new_low',
          ticker,
          price: snapshot.price,
          low: snapshot.low,
          severity: 'medium',
          description: `New intraday low at $${snapshot.low.toFixed(2)}`
        });
      }
    }

    // 5. VWAP Cross Detection
    if (snapshot.vwap && snapshot.price && lastSnapshot?.price) {
      const wasAboveVwap = lastSnapshot.price > lastSnapshot.vwap;
      const isAboveVwap = snapshot.price > snapshot.vwap;

      if (wasAboveVwap !== isAboveVwap) {
        signals.push({
          type: 'vwap_cross',
          ticker,
          price: snapshot.price,
          vwap: snapshot.vwap,
          direction: isAboveVwap ? 'above' : 'below',
          severity: 'medium',
          description: `Price crossed ${isAboveVwap ? 'above' : 'below'} VWAP ($${snapshot.vwap.toFixed(2)})`
        });
      }
    }

    // 6. Key Level Break Detection
    if (lastSnapshot?.price && snapshot.price) {
      // Update key levels if we have previous close data
      const prevClose = this.previousCloses.get(ticker);
      if (prevClose) {
        keyLevels.calculateLevels(ticker, snapshot, prevClose);
      }

      // Check for level breaks
      const levelBreaks = keyLevels.checkLevelBreak(ticker, snapshot.price, lastSnapshot.price);
      for (const levelBreak of levelBreaks) {
        signals.push({
          type: 'level_break',
          ticker,
          price: snapshot.price,
          level: levelBreak.level,
          levelType: levelBreak.type,
          direction: levelBreak.direction,
          severity: levelBreak.significance === 'high' ? 'high' : 'medium',
          description: `${levelBreak.emoji} ${levelBreak.label} at $${levelBreak.level.toFixed(2)}`
        });
      }
    }

    return signals;
  }

  async evaluateSignal(signal) {
    const ticker = signal.ticker;

    // Check cooldown
    const lastAlert = this.alertCooldowns.get(ticker) || 0;
    const timeSinceLastAlert = Date.now() - lastAlert;

    if (timeSinceLastAlert < this.alertCooldownMs) {
      logger.debug(`Skipping alert for ${ticker}, cooldown active`);
      return;
    }

    // Calculate heat score
    const context = {
      hasVolumeSpike: signal.type === 'volume_spike' || signal.rvol > 0,
      volumeMultiple: signal.rvol || 0,
      priceChange: signal.priceChange || signal.todayChangePercent || 0
    };

    const heatResult = stockHeatScore.calculate(signal, context);

    // Apply time-based heat bonus
    const tradingPhase = marketHours.getTradingPhase();
    const timeBonus = tradingPhase.heatBonus || 0;
    if (timeBonus !== 0) {
      heatResult.heatScore += timeBonus;
      heatResult.breakdown.timeBonus = timeBonus;
      heatResult.breakdown.tradingPhase = tradingPhase.label;
    }

    // Check SPY alignment
    const spyAlignment = spyCorrelation.checkAlignment(
      signal.priceChange || signal.todayChangePercent || 0,
      signal.direction
    );

    // Penalize signals moving against SPY trend (unless strong relative strength)
    if (!spyAlignment.aligned && spyAlignment.confidence === 'low') {
      heatResult.heatScore -= 10;
      heatResult.breakdown.spyPenalty = -10;
      heatResult.spyWarning = spyAlignment.warning;
    } else if (spyAlignment.type === 'relative_strength') {
      heatResult.heatScore += 10;
      heatResult.breakdown.relativeStrengthBonus = 10;
    }

    // Add SPY context
    heatResult.spyContext = spyCorrelation.getSPYContext();

    // Add sector context
    const sectorContext = sectorHeatMap.getSectorContext(ticker);
    if (sectorContext) {
      heatResult.sectorContext = sectorContext;
      // Bonus for being in a hot sector
      if (sectorContext.isLeader) {
        heatResult.heatScore += 5;
        heatResult.breakdown.sectorBonus = 5;
      }
    }

    // Add key levels info
    const levelsInfo = keyLevels.formatLevelsForAlert(ticker);
    if (levelsInfo) {
      heatResult.keyLevels = levelsInfo;
    }

    // Cap heat score at 100
    heatResult.heatScore = Math.min(100, Math.max(0, heatResult.heatScore));

    // Log all signals for debugging
    logger.info(`Signal: ${ticker} ${signal.type} | Heat: ${heatResult.heatScore} | Threshold: ${config.heatScore.alertThreshold}`);

    // Check if meets threshold
    if (!heatResult.meetsThreshold && heatResult.heatScore < config.heatScore.alertThreshold) {
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

    // Re-check if signal now meets threshold after bonuses
    if (heatResult.heatScore >= config.heatScore.highConvictionThreshold) {
      heatResult.meetsThreshold = true;
      heatResult.isHighConviction = true;
      heatResult.channel = 'high-conviction';
    } else if (heatResult.heatScore >= config.heatScore.alertThreshold) {
      heatResult.meetsThreshold = true;
      heatResult.channel = 'flow-alerts';
    }

    if (!heatResult.meetsThreshold) {
      return;
    }

    // Update cooldown
    this.alertCooldowns.set(ticker, Date.now());

    // Check for upcoming earnings
    const earningsWarning = earningsCalendar.getEarningsWarning(ticker);
    if (earningsWarning) {
      heatResult.earningsWarning = earningsWarning;
    }

    // Log the signal
    logger.flow(ticker, heatResult.heatScore, heatResult.breakdown);

    // Generate trade recommendation (wrapped in try-catch so alerts still send if this fails)
    try {
      const recommendation = tradeRecommendation.generateRecommendation({
        ticker,
        price: signal.price,
        heatScore: heatResult.heatScore,
        signalType: signal.type,
        volumeMultiplier: signal.rvol || context.volumeMultiple || 1,
        priceChange: signal.priceChange || signal.todayChangePercent || 0,
        signalBreakdown: heatResult.breakdown
      });

      // Add recommendation to heat result for display
      heatResult.recommendation = recommendation;

      // Open paper trade if recommendation is actionable (lowered threshold for day trading)
      // Day traders need action - if heat score hit 60+ threshold, we should trade
      logger.info(`Trade check: ${ticker} | Confidence: ${recommendation.confidenceScore} | Action: ${recommendation.recommendation.shortAction}`);

      if (recommendation && recommendation.confidenceScore >= 60 &&
          !recommendation.recommendation.shortAction.includes('AVOID') &&
          !recommendation.recommendation.shortAction.includes('WATCH')) {
        // Check if we should open this trade
        const canOpen = paperTrading.shouldOpenTrade(ticker, recommendation.direction);
        logger.info(`Paper trade eligible: ${ticker} | Can open: ${canOpen}`);

        if (canOpen) {
          const tradeId = paperTrading.openTrade(recommendation);
          if (tradeId) {
            heatResult.paperTradeId = tradeId;
            logger.info(`Opened paper trade #${tradeId} for ${ticker}`);

            // Send paper trade open notification to paper-trades channel
            const dirEmoji = recommendation.direction === 'BULLISH' ? '🟢' : '🔴';
            const confEmoji = recommendation.confidenceScore >= 90 ? '🔥🔥🔥' :
                             recommendation.confidenceScore >= 80 ? '🔥' : '📊';
            const openMsg = `${confEmoji} **PAPER TRADE OPENED** - ${ticker} ${dirEmoji}\n` +
                           `━━━━━━━━━━━━━━━━━━━━━━\n` +
                           `**Direction:** ${recommendation.direction}\n` +
                           `**Entry:** $${recommendation.targets.entry.toFixed(2)}\n` +
                           `**Target:** $${recommendation.targets.target.toFixed(2)}\n` +
                           `**Stop:** $${recommendation.targets.stopLoss.toFixed(2)}\n` +
                           `**Confidence:** ${recommendation.confidenceScore}/100\n` +
                           (recommendation.optionSuggestion ? `**Option:** ${recommendation.optionSuggestion.description}\n` : '') +
                           `**Trade ID:** #${tradeId}`;
            await discordBot.sendMessage('paperTrades', openMsg);
          }
        }
      }
    } catch (recError) {
      logger.warn(`Recommendation generation failed for ${ticker}`, { error: recError.message });
    }

    // Send alert to Discord (always try even if recommendation failed)
    await discordBot.sendStockAlert(signal, heatResult);

    // Save to database
    database.saveAlert({
      ticker: heatResult.ticker,
      signalType: signal.type,
      heatScore: heatResult.heatScore,
      price: signal.price,
      volume: signal.currentVolume || 0,
      signalBreakdown: heatResult.breakdown,
      channel: heatResult.channel
    });

    // Add to heat history for tracking
    database.addHeatSignal(ticker, signal.type, signal.currentVolume || 0);
  }

  // Check paper trades against current prices
  async checkPaperTrades() {
    const activeTrades = paperTrading.getActiveTrades();
    if (activeTrades.length === 0) return;

    // Build price map and volume map from our snapshots
    const prices = {};
    const volumes = {};
    for (const [ticker, snapshot] of this.lastSnapshots) {
      if (snapshot.price) {
        prices[ticker] = snapshot.price;
        volumes[ticker] = snapshot.todayVolume || 0;
      }
    }

    // Check for exit signals on active trades
    for (const trade of activeTrades) {
      const currentPrice = prices[trade.ticker];
      const currentVolume = volumes[trade.ticker];

      if (currentPrice && currentVolume) {
        const signals = exitSignals.checkExitSignals(trade, currentPrice, currentVolume);

        // Send exit signal alerts to paper-trades channel
        for (const signal of signals) {
          if (signal.severity === 'warning' || signal.severity === 'positive') {
            const message = exitSignals.formatExitSignal(trade, signal);
            await discordBot.sendMessage('paperTrades', message);
            logger.info(`Exit signal: ${trade.ticker} - ${signal.type}`);
          }
        }
      }
    }

    // Check for closed trades, proximity alerts, and trailing stop updates
    const results = await paperTrading.checkActiveTrades(prices);

    // Notify about closed trades with full details - send to paper-trades channel
    for (const trade of results.closedTrades) {
      const emoji = trade.pnlDollars > 0 ? '✅' : '❌';
      const resultText = trade.exitReason === 'TARGET_HIT' ? '🎯 TARGET HIT!' :
                         trade.exitReason === 'STOP_LOSS' ? '🛑 STOPPED OUT' :
                         trade.exitReason === 'TRAILING_STOP' ? '📈 TRAILING STOP' : '⏰ MARKET CLOSE';

      const pnlSign = trade.pnlDollars >= 0 ? '+' : '';
      const message = `${emoji} **PAPER TRADE CLOSED** - ${trade.ticker}\n` +
                     `━━━━━━━━━━━━━━━━━━━━━━\n` +
                     `**Result:** ${resultText}\n` +
                     `**Entry:** $${trade.entry_price.toFixed(2)} → **Exit:** $${trade.exit_price.toFixed(2)}\n` +
                     `**Stock Move:** ${trade.stockPnlPercent > 0 ? '+' : ''}${trade.stockPnlPercent.toFixed(2)}%\n` +
                     `**Option P&L:** ${pnlSign}${trade.optionPnlPercent.toFixed(0)}%\n` +
                     `**💰 Dollar P&L:** ${pnlSign}$${trade.pnlDollars.toFixed(0)}\n` +
                     `**Duration:** ${trade.duration}\n` +
                     `**Confidence:** ${trade.confidence}/100`;

      await discordBot.sendMessage('paperTrades', message);
      logger.info(`Paper trade closed: ${trade.ticker} ${trade.exitReason} | Option: ${trade.optionPnlPercent.toFixed(0)}% | P&L: $${trade.pnlDollars.toFixed(0)}`);
    }

    // Send proximity alerts to paper-trades channel
    for (const alert of results.proximityAlerts) {
      await discordBot.sendMessage('paperTrades', alert.message);
      logger.info(`Proximity alert: ${alert.trade.ticker} ${alert.type}`);
    }

    // Notify about trailing stop updates in paper-trades channel
    for (const update of results.trailingStopUpdates) {
      await discordBot.sendMessage('paperTrades', update.message);
      logger.info(`Trailing stop update: ${update.trade.ticker} new stop $${update.newStop.toFixed(2)}`);
    }
  }

  // Run advanced detection (squeeze, patterns) on tracked tickers
  async runAdvancedDetection() {
    try {
      // Run on tickers that have had recent activity
      for (const [ticker, snapshot] of this.lastSnapshots) {
        if (!snapshot.price || !snapshot.high || !snapshot.low) continue;

        // Update squeeze detection history
        squeezeDetection.updatePriceHistory(
          ticker,
          snapshot.high,
          snapshot.low,
          snapshot.price,
          snapshot.todayVolume || 0
        );

        // Update pattern recognition history
        patternRecognition.updatePriceHistory(
          ticker,
          snapshot.high,
          snapshot.low,
          snapshot.price,
          snapshot.todayVolume || 0,
          snapshot.vwap
        );

        // Check for squeeze
        const squeeze = squeezeDetection.detectSqueeze(ticker);
        if (squeeze && squeeze.squeezeScore >= 75) {
          const message = squeezeDetection.formatSqueezeAlert(squeeze);
          // Route to fire-alerts if score >= 80, otherwise flow-scanner
          const channel = squeeze.squeezeScore >= 80 ? 'fireAlerts' : 'flowScanner';
          await discordBot.sendMessage(channel, message);
          logger.info(`Squeeze detected: ${ticker} (score: ${squeeze.squeezeScore}) -> ${channel}`);
        }

        // Check for patterns
        const patterns = patternRecognition.detectPatterns(
          ticker,
          snapshot.price,
          snapshot.todayVolume || 0
        );

        for (const pattern of patterns) {
          if (pattern.confidence >= 70) {
            const message = patternRecognition.formatPatternAlert(pattern);
            // Route to fire-alerts if confidence >= 80, otherwise flow-scanner
            const channel = pattern.confidence >= 80 ? 'fireAlerts' : 'flowScanner';
            await discordBot.sendMessage(channel, message);
            logger.info(`Pattern detected: ${ticker} - ${pattern.type} (${pattern.confidence}%) -> ${channel}`);
          }
        }
      }
    } catch (error) {
      logger.error('Advanced detection error', { error: error.message });
    }
  }

  getStatus() {
    const phase = marketHours.getTradingPhase();
    const spyData = spyCorrelation.getSPYContext();
    const activePaperTrades = paperTrading.getActiveTrades();
    const todayPaperCount = paperTrading.getTodayTradeCount();
    const riskStatus = paperTrading.getRiskStatus();
    const vixLevel = vixMonitor.getVixLevel();

    return {
      polygonConnected: true, // REST API is stateless
      polygonAuthenticated: true,
      websocketConnected: this.wsConnected,
      tickersMonitored: config.topTickers.length,
      baselinesLoaded: this.volumeBaselines.size,
      keyLevelsLoaded: keyLevels.levels?.size || 0,
      marketOpen: marketHours.isMarketOpen(),
      isMonitoring: this.isMonitoring,
      uptime: process.uptime(),
      dataSource: this.wsConnected ? '⚡ Real-Time WebSocket' : '🔄 REST API (Polling)',
      pollInterval: this.wsConnected ? 'Real-time' : `${this.pollIntervalMs / 1000}s`,
      tradingPhase: phase.label,
      tradingPhaseEmoji: phase.emoji,
      heatBonus: phase.heatBonus || 0,
      spyDirection: spyData.available ? spyData.direction : 'unknown',
      spyChange: spyData.available ? spyData.change : null,
      paperTrades: {
        active: activePaperTrades.length,
        todayTotal: todayPaperCount
      },
      riskStatus: {
        dailyPnL: riskStatus.dailyPnL,
        tradingPaused: riskStatus.tradingPaused,
        pauseReason: riskStatus.pauseReason,
        consecutiveLosses: riskStatus.consecutiveLosses
      },
      vix: vixLevel ? {
        value: vixLevel.value,
        level: vixLevel.level,
        emoji: vixLevel.emoji
      } : null,
      marketStatus: {
        phase: phase.phase,
        description: phase.description,
        spy: spyData
      }
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async shutdown() {
    logger.info('Shutting down Smart Stock Scanner...');

    this.isRunning = false;

    if (this.marketCheckInterval) {
      clearInterval(this.marketCheckInterval);
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    if (this.sectorUpdateInterval) {
      clearInterval(this.sectorUpdateInterval);
    }

    // Clear elite feature intervals
    if (this.preMarketInterval) {
      clearInterval(this.preMarketInterval);
    }

    if (this.afterHoursInterval) {
      clearInterval(this.afterHoursInterval);
    }

    if (this.vixUpdateInterval) {
      clearInterval(this.vixUpdateInterval);
    }

    if (this.sectorCorrelationInterval) {
      clearInterval(this.sectorCorrelationInterval);
    }

    // Close WebSocket connection
    if (this.wsConnected) {
      logger.info('Closing WebSocket connection...');
      polygonWS.close();
      this.wsConnected = false;
    }

    // Clear elite module data
    orderFlowImbalance.clearAllFlowData();
    blockTradeDetector.clearDayData();

    // Shutdown components
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
