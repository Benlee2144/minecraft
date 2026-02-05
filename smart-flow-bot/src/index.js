require('dotenv').config();

const config = require('../config');
const logger = require('./utils/logger');
const marketHours = require('./utils/marketHours');
const database = require('./database/sqlite');
const polygonRest = require('./polygon/rest');

// Stock Detection modules
const stockHeatScore = require('./detection/stockHeatScore');
const keyLevels = require('./detection/keyLevels');
const spyCorrelation = require('./detection/spyCorrelation');
const sectorHeatMap = require('./detection/sectorHeatMap');
const tradeRecommendation = require('./detection/tradeRecommendation');

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
    this.alertCooldownMs = 60000; // 60 second cooldown per ticker (polling is slower)
    this.pollIntervalMs = 30000; // Poll every 30 seconds
    this.sectorUpdateIntervalMs = 120000; // Update sectors every 2 minutes
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

      this.isRunning = true;

      // Send startup message
      const status = this.getStatus();
      await discordBot.sendStartupMessage(status);

      logger.info('='.repeat(50));
      logger.info('Smart Stock Scanner is now running!');
      logger.info(`Monitoring ${config.topTickers.length} tickers via REST API`);
      logger.info(`Polling interval: ${this.pollIntervalMs / 1000} seconds`);
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
    discordBot.sendDailySummary(stats);

    // Reset paper trading for next day
    paperTrading.resetDailyTracking();

    logger.info('Monitoring stopped for the day');
  }

  startPolling() {
    // Initial poll
    this.pollMarketData();

    // Set up interval for continuous polling
    this.pollingInterval = setInterval(() => {
      if (this.isMonitoring && marketHours.isMarketOpen()) {
        this.pollMarketData();
      }
    }, this.pollIntervalMs);
  }

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

    // Check if meets threshold
    if (!heatResult.meetsThreshold && heatResult.heatScore < config.heatScore.minThreshold) {
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
    } else if (heatResult.heatScore >= config.heatScore.minThreshold) {
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

    // Generate trade recommendation
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

    // Open paper trade if recommendation is actionable
    if (recommendation.confidenceScore >= 70 &&
        recommendation.recommendation.action !== 'WATCH' &&
        recommendation.recommendation.action !== 'AVOID') {
      // Check if we should open this trade
      if (paperTrading.shouldOpenTrade(ticker, recommendation.direction)) {
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

    // Send alert to Discord
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

    // Build price map from our snapshots
    const prices = {};
    for (const [ticker, snapshot] of this.lastSnapshots) {
      if (snapshot.price) {
        prices[ticker] = snapshot.price;
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

  getStatus() {
    const phase = marketHours.getTradingPhase();
    const spyData = spyCorrelation.getSPYContext();
    const activePaperTrades = paperTrading.getActiveTrades();
    const todayPaperCount = paperTrading.getTodayTradeCount();

    return {
      polygonConnected: true, // REST API is stateless
      polygonAuthenticated: true,
      tickersMonitored: config.topTickers.length,
      baselinesLoaded: this.volumeBaselines.size,
      keyLevelsLoaded: keyLevels.levels?.size || 0,
      marketOpen: marketHours.isMarketOpen(),
      isMonitoring: this.isMonitoring,
      uptime: process.uptime(),
      dataSource: 'REST API (Polling)',
      pollInterval: `${this.pollIntervalMs / 1000}s`,
      tradingPhase: phase.label,
      tradingPhaseEmoji: phase.emoji,
      heatBonus: phase.heatBonus || 0,
      spyDirection: spyData.available ? spyData.direction : 'unknown',
      spyChange: spyData.available ? spyData.change : null,
      paperTrades: {
        active: activePaperTrades.length,
        todayTotal: todayPaperCount
      },
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
