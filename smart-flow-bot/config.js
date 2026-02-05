module.exports = {
  // API Keys
  polygon: {
    apiKey: process.env.POLYGON_API_KEY || 'AFm3DfCNME7kNNyi5W1VzWTHSwhELs2l',
    wsUrl: 'wss://socket.polygon.io/stocks',  // Changed to stocks for Starter plan
    restUrl: 'https://api.polygon.io'
  },

  // Claude Chat uses Claude Code CLI (your Max subscription) - no API key needed
  // Just run: npm install -g @anthropic-ai/claude-code && claude /login

  discord: {
    token: process.env.DISCORD_BOT_TOKEN || '',
    // Channel IDs - Multi-channel setup
    channels: {
      fireAlerts: process.env.FIRE_ALERTS_CHANNEL || '1468815395719741625',
      flowScanner: process.env.FLOW_SCANNER_CHANNEL || '1468815500200120492',
      paperTrades: process.env.PAPER_TRADES_CHANNEL || '1468815561453469778',
      dailyRecap: process.env.DAILY_RECAP_CHANNEL || '1468815629036556410',
      claudeChat: process.env.CLAUDE_CHAT_CHANNEL || '1468815689140928634'
    },
    // Channel descriptions - what each room is for
    channelDescriptions: {
      fireAlerts: {
        name: '🔥 Fire Alerts',
        emoji: '🔥',
        description: 'FIRE ALERT (90+) and STRONG BUY (80+) signals only. This is your main action channel - when you see alerts here, pay attention! These are the highest conviction trades with multiple confirming signals.',
        threshold: '80+ Heat Score'
      },
      flowScanner: {
        name: '📊 Flow Scanner',
        emoji: '📊',
        description: 'Regular flow alerts (60-79 heat score), volume spikes, momentum surges, and sector updates. Good signals that may need additional confirmation before acting.',
        threshold: '60-79 Heat Score'
      },
      paperTrades: {
        name: '💰 Paper Trades',
        emoji: '💰',
        description: 'Paper trade entries, exits, trailing stop updates, and proximity alerts. Track simulated trades without risking real money. Perfect for testing strategies.',
        threshold: 'N/A'
      },
      dailyRecap: {
        name: '📈 Daily Recap',
        emoji: '📈',
        description: 'End-of-day summaries, performance stats, top movers, and win/loss tracking. Review your daily performance and learn from patterns.',
        threshold: 'N/A'
      },
      claudeChat: {
        name: '🤖 Claude Chat',
        emoji: '🤖',
        description: 'Ask Claude AI trading questions using /ask or @mention the bot. Get explanations about signals, trading concepts, market mechanics, and strategy ideas.',
        threshold: 'N/A'
      }
    }
  },

  // Heat Score Thresholds
  heatScore: {
    highConvictionThreshold: 80,  // Post to #high-conviction
    alertThreshold: 60,            // Post to #flow-alerts
    watchlistThreshold: 50         // Alert for watchlist tickers
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
