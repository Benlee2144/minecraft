module.exports = {
  // API Keys
  polygon: {
    apiKey: process.env.POLYGON_API_KEY || 'AFm3DfCNME7kNNyi5W1VzWTHSwhELs2l',
    wsUrl: 'wss://delayed.polygon.io/stocks',  // Delayed endpoint for $29 plan (15-min delay)
    restUrl: 'https://api.polygon.io'
  },

  // Claude Chat uses Claude Code CLI (your Max subscription) - no API key needed
  // Just run: npm install -g @anthropic-ai/claude-code && claude /login

  discord: {
    token: process.env.DISCORD_BOT_TOKEN || '',
    // Channel IDs - Multi-channel setup for organized alerts
    channels: {
      // Fire alerts channel - ONLY for high confidence (90+) and strong entry (80+) signals
      fireAlerts: process.env.FIRE_ALERTS_CHANNEL || '1468815395719741625',
      // Flow scanner channel - Regular flow alerts, heat maps, sector updates
      flowScanner: process.env.FLOW_SCANNER_CHANNEL || '1468815500200120492',
      // Paper trades channel - Paper trade opens, closes, trailing stops, proximity alerts
      paperTrades: process.env.PAPER_TRADES_CHANNEL || '1468815561453469778',
      // Daily recap channel - End-of-day summaries and performance stats
      dailyRecap: process.env.DAILY_RECAP_CHANNEL || '1468815629036556410',
      // Claude chat channel - Claude AI responses from /ask commands
      claudeChat: process.env.CLAUDE_CHAT_CHANNEL || '1468815689140928634',
      // Pre-market channel - Gap alerts, pre-market movers (9:00-9:30 AM)
      preMarket: process.env.PRE_MARKET_CHANNEL || '1468830284127539221',
      // Legacy mappings for backwards compatibility
      highConviction: process.env.HIGH_CONVICTION_CHANNEL || '1468815395719741625',
      flowAlerts: process.env.FLOW_ALERTS_CHANNEL || '1468815500200120492',
      botStatus: process.env.BOT_STATUS_CHANNEL || '1468815629036556410'
    }
  },

  // Heat Score Thresholds - VERY AGGRESSIVE for active day trading
  heatScore: {
    highConvictionThreshold: 75,  // Post to #fire-alerts
    alertThreshold: 35,            // Post to #flow-alerts (very low for max action)
    watchlistThreshold: 25         // Alert for watchlist tickers
  },

  // Heat Score Points (Stock Scanner)
  points: {
    volume3x: 20,              // 3x+ volume spike
    volume5x: 30,              // 5x+ volume spike (extreme)
    priceUp2Pct: 15,           // Price up 2%+ with volume
    priceUp5Pct: 25,           // Price up 5%+ with volume
    largeBlockTrade: 20,       // Block trade > $500k
    hugeBlockTrade: 30,        // Block trade > $1M
    breakoutPattern: 20,       // Breaking above resistance
    preMarketMover: 15,        // Unusual pre-market activity
    repeatActivity: 25,        // Multiple signals in 1 hour
    momentumSurge: 15          // Rapid price acceleration
  },

  // Detection Parameters (Stock Scanner)
  detection: {
    // Volume spike detection
    volumeSpikeMultiplier: 3.0,    // 3x average volume for alert
    volumeExtremeMultiplier: 5.0,  // 5x average volume for high conviction
    volumeWindowMinutes: 60,        // First 60 minutes of market

    // Block trade detection
    minBlockValue: 500000,         // $500k minimum for block trades
    largeBlockValue: 1000000,      // $1M for large block bonus

    // Price movement thresholds
    minPriceChange: 0.02,          // 2% minimum price change
    largePriceChange: 0.05,        // 5% for high conviction

    // Momentum detection
    momentumWindowSeconds: 60,     // Look for moves in 60 seconds
    momentumThreshold: 0.01,       // 1% move in 60 seconds = momentum

    // Breakout detection
    breakoutLookback: 20,          // 20 bars for resistance level
    breakoutBuffer: 0.001,         // 0.1% above resistance to confirm

    // Repeat tracking
    repeatWindowMinutes: 60,       // 60 minute rolling window
    repeatThreshold: 3,            // 3+ signals = "heating up"
    multipleSignalWindowMinutes: 30 // 30 min window for multiple signals
  },

  // Filters
  filters: {
    minStockPrice: 10,             // Ignore stocks under $10
    minAvgDailyVolume: 500000,     // Minimum 500k avg daily volume
    minOpenInterest: 1000,         // Minimum 1000 OI on strike
    earningsBlackoutDays: 3,       // Ignore 3 days before earnings

    // Market hours (Eastern Time)
    marketOpen: { hour: 9, minute: 30 },
    marketClose: { hour: 16, minute: 0 }
  },

  // Tickers to always ignore (add earnings plays, known volatile, etc)
  ignoredTickers: [
    // Add tickers to ignore here
  ],

  // Top tickers to monitor (most liquid)
  topTickers: [
    'SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'AMZN', 'GOOGL', 'META',
    'NFLX', 'CRM', 'ORCL', 'ADBE', 'INTC', 'MU', 'QCOM', 'AVGO', 'TXN', 'AMAT',
    'LRCX', 'KLAC', 'MRVL', 'ON', 'SMCI', 'ARM', 'MARA', 'RIOT', 'COIN', 'SQ',
    'PYPL', 'V', 'MA', 'JPM', 'GS', 'MS', 'BAC', 'WFC', 'C', 'SCHW',
    'BRK.B', 'UNH', 'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'BMY', 'GILD', 'AMGN',
    'XOM', 'CVX', 'OXY', 'COP', 'SLB', 'HAL', 'DVN', 'EOG', 'MPC', 'VLO',
    'BA', 'LMT', 'RTX', 'NOC', 'GD', 'CAT', 'DE', 'HON', 'GE', 'MMM',
    'HD', 'LOW', 'TGT', 'WMT', 'COST', 'DG', 'DLTR', 'ROSS', 'TJX', 'NKE',
    'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'PARA', 'WBD', 'NFLX', 'ROKU',
    'F', 'GM', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI', 'FSR', 'UBER', 'LYFT',
    'ABNB', 'BKNG', 'EXPE', 'MAR', 'HLT', 'RCL', 'CCL', 'NCLH', 'DAL', 'UAL',
    'AAL', 'LUV', 'SAVE', 'JBLU', 'ALK', 'XLF', 'XLE', 'XLK', 'XLV', 'XLI',
    'XLP', 'XLY', 'XLB', 'XLU', 'XLRE', 'GLD', 'SLV', 'USO', 'UNG', 'TLT',
    'IWM', 'DIA', 'VXX', 'UVXY', 'SQQQ', 'TQQQ', 'SPXU', 'SPXL', 'SOXL', 'SOXS'
  ],

  // Database
  database: {
    path: './data/flowscanner.db'
  },

  // Logging
  logging: {
    level: 'info',  // 'debug', 'info', 'warn', 'error'
    file: './logs/bot.log'
  }
};
