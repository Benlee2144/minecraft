module.exports = {
  // API Keys
  polygon: {
    apiKey: process.env.POLYGON_API_KEY || 'AFm3DfCNME7kNNyi5W1VzWTHSwhELs2l',
    wsUrl: 'wss://socket.polygon.io/options',
    restUrl: 'https://api.polygon.io'
  },

  discord: {
    token: process.env.DISCORD_BOT_TOKEN || '',
    // Channel IDs - Update these after creating your Discord server
    channels: {
      highConviction: process.env.HIGH_CONVICTION_CHANNEL || '',
      flowAlerts: process.env.FLOW_ALERTS_CHANNEL || '',
      botStatus: process.env.BOT_STATUS_CHANNEL || ''
    }
  },

  // Heat Score Thresholds
  heatScore: {
    highConvictionThreshold: 80,  // Post to #high-conviction
    alertThreshold: 60,            // Post to #flow-alerts
    watchlistThreshold: 50         // Alert for watchlist tickers
  },

  // Heat Score Points
  points: {
    volume3x: 15,
    sweepAtAsk: 20,
    premium500k: 15,
    premium1M: 25,
    dte0to3: 10,
    dte4to7: 5,
    multipleSweeps30min: 20,
    ivSpikeNoPrice: 15,
    repeatActivity: 25
  },

  // Detection Parameters
  detection: {
    // Volume spike detection
    volumeSpikeMultiplier: 3.0,    // 3x average volume
    volumeWindowMinutes: 60,        // First 30-60 minutes of market

    // Sweep detection
    minSweepPremium: 100000,       // $100k minimum for sweeps
    sweepTimeWindowMs: 500,         // Time window to detect split orders

    // Premium thresholds
    minPremiumForAlert: 100000,    // $100k minimum premium
    largePremiumThreshold: 500000, // $500k for bonus points
    hugePremiumThreshold: 1000000, // $1M for max bonus points

    // OTM detection
    otmMinPercent: 5,              // 5% OTM minimum
    otmMaxPercent: 10,             // 10% OTM maximum

    // DTE ranges
    shortDteMax: 3,                // 0-3 DTE for max points
    mediumDteMax: 7,               // 4-7 DTE for medium points

    // IV Anomaly
    ivSpikeThreshold: 0.10,        // 10% IV spike
    priceChangeThreshold: 0.02,    // 2% price change threshold

    // Repeat tracking
    repeatWindowMinutes: 60,       // 60 minute rolling window
    repeatThreshold: 3,            // 3+ signals = "heating up"
    multipleSweepWindowMinutes: 30 // 30 min window for multiple sweeps
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
