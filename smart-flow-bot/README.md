# Smart Flow Scanner - Discord Bot

A sophisticated Discord bot that monitors real-time options flow data from Polygon.io to detect unusual activity that suggests informed money is positioning. Alerts are scored using a "Heat Score" system and sent to Discord channels.

## Features

- **Real-time Options Flow Monitoring** - Connects to Polygon.io WebSocket for live data
- **Sweep Detection** - Identifies large orders broken into chunks across multiple exchanges
- **Volume Spike Detection** - Detects stocks trading 3x+ their average volume
- **IV Anomaly Detection** - Flags when implied volatility spikes without price movement
- **Heat Score System** - Scores alerts from 0-100 based on multiple factors
- **Outcome Tracking** - Tracks P/L of alerts at 15min, 30min, 1hr, 2hr, and 4hr intervals
- **Personal Watchlists** - Users can add tickers to get alerts at a lower threshold
- **Slash Commands** - Easy interaction via Discord commands

## Heat Score Breakdown

| Signal | Points |
|--------|--------|
| Volume 3x+ average | +15 |
| Sweep bought at ASK | +20 |
| Premium > $500k | +15 |
| Premium > $1M | +25 |
| 0-3 DTE | +10 |
| 4-7 DTE | +5 |
| Multiple sweeps (30 min) | +20 |
| IV spike without price move | +15 |
| Repeat activity (1hr) | +25 |

**Alert Thresholds:**
- `#high-conviction` channel: Heat Score 80+
- `#flow-alerts` channel: Heat Score 60-79
- Watchlist alerts: Heat Score 50+

## Prerequisites

- Node.js 18.0.0 or higher
- A Polygon.io account with API access
- A Discord account and server

## Setup Instructions

### 1. Clone and Install

```bash
cd smart-flow-bot
npm install
```

### 2. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name (e.g., "Smart Flow Scanner")
3. Go to the "Bot" section in the left sidebar
4. Click "Add Bot"
5. Under "Privileged Gateway Intents", enable:
   - Server Members Intent
   - Message Content Intent
6. Click "Reset Token" and copy the token - **save this securely!**

### 3. Invite Bot to Your Server

1. In the Developer Portal, go to "OAuth2" > "URL Generator"
2. Select scopes:
   - `bot`
   - `applications.commands`
3. Select bot permissions:
   - Send Messages
   - Embed Links
   - Read Message History
   - Use Slash Commands
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

### 4. Set Up Discord Channels

Create these channels in your Discord server:
- `#high-conviction` - For alerts with Heat Score 80+
- `#flow-alerts` - For alerts with Heat Score 60-79
- `#bot-status` - For startup messages and errors

Get the channel IDs:
1. Enable Developer Mode in Discord (Settings > App Settings > Advanced > Developer Mode)
2. Right-click each channel and select "Copy ID"

### 5. Configure Environment Variables

Create a `.env` file in the project root:

```env
# Discord Configuration
DISCORD_BOT_TOKEN=your_discord_bot_token_here
HIGH_CONVICTION_CHANNEL=channel_id_here
FLOW_ALERTS_CHANNEL=channel_id_here
BOT_STATUS_CHANNEL=channel_id_here

# Polygon.io Configuration (already set in config.js, but can override)
POLYGON_API_KEY=your_polygon_api_key
```

Alternatively, edit `config.js` directly to set your channel IDs.

### 6. Run the Bot

```bash
# Start the bot
npm start

# Or run in development mode (auto-restart on changes)
npm run dev
```

## Discord Commands

| Command | Description |
|---------|-------------|
| `/watchlist add TICKER` | Add a ticker to your personal watchlist |
| `/watchlist remove TICKER` | Remove a ticker from your watchlist |
| `/watchlist show` | Show your current watchlist |
| `/flow TICKER` | Get current flow summary for a ticker |
| `/hot` | Show top 5 "heating up" tickers |
| `/stats` | Show today's alerts and statistics |
| `/status` | Show bot connection status |

## Configuration

All settings can be adjusted in `config.js`:

```javascript
// Heat Score Thresholds
heatScore: {
  highConvictionThreshold: 80,  // Post to #high-conviction
  alertThreshold: 60,            // Post to #flow-alerts
  watchlistThreshold: 50         // Alert for watchlist tickers
}

// Detection Parameters
detection: {
  volumeSpikeMultiplier: 3.0,    // 3x average volume
  minSweepPremium: 100000,       // $100k minimum for sweeps
  // ... more settings
}

// Filters
filters: {
  minStockPrice: 10,             // Ignore stocks under $10
  minAvgDailyVolume: 500000,     // Minimum 500k avg daily volume
  earningsBlackoutDays: 3,       // Ignore 3 days before earnings
  // ... more settings
}
```

## File Structure

```
smart-flow-bot/
├── src/
│   ├── index.js              # Main entry point
│   ├── polygon/
│   │   ├── websocket.js      # Real-time WebSocket connection
│   │   ├── rest.js           # REST API calls
│   │   └── parser.js         # Parse incoming data
│   ├── detection/
│   │   ├── volumeSpike.js    # Volume spike detection
│   │   ├── sweepDetector.js  # Sweep detection
│   │   ├── ivAnomaly.js      # IV anomaly detection
│   │   ├── heatScore.js      # Heat score calculation
│   │   ├── filters.js        # Signal filtering
│   │   └── outcomeTracker.js # P/L tracking
│   ├── discord/
│   │   ├── bot.js            # Discord bot main module
│   │   ├── commands.js       # Slash commands handler
│   │   └── formatters.js     # Message formatters
│   ├── database/
│   │   └── sqlite.js         # SQLite database
│   └── utils/
│       ├── marketHours.js    # Market hours utilities
│       └── logger.js         # Logging utility
├── config.js                 # Configuration
├── package.json
└── README.md
```

## Data Storage

The bot uses SQLite to store:
- All alerts sent (for tracking win rate)
- User watchlists
- Ticker heat history (rolling 60 min window)
- Volume baselines

Database file: `./data/flowscanner.db`

## Logs

Logs are written to `./logs/bot.log` and also output to console with colors.

## Running on a VPS

For 24/7 operation, consider using:

**PM2 (Recommended):**
```bash
npm install -g pm2
pm2 start src/index.js --name "flow-scanner"
pm2 save
pm2 startup
```

**Systemd:**
Create `/etc/systemd/system/flow-scanner.service`:
```ini
[Unit]
Description=Smart Flow Scanner
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/smart-flow-bot
ExecStart=/usr/bin/node src/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable flow-scanner
sudo systemctl start flow-scanner
```

## Polygon.io API Notes

- The free tier has rate limits (5 calls/minute for REST API)
- WebSocket connections require at least a Starter plan for real-time options data
- If you have a free tier, the bot will work but may have limited data

## Troubleshooting

**Bot not responding to commands:**
- Make sure you've registered the slash commands (happens automatically on first start)
- Check that the bot has proper permissions in your server

**Not receiving alerts:**
- Verify channel IDs are correct in config
- Check that market is open (9:30 AM - 4:00 PM ET)
- Review the minimum thresholds in config.js

**WebSocket disconnecting:**
- The bot auto-reconnects up to 10 times
- Check your Polygon.io subscription level

**Database errors:**
- Make sure the `./data` directory is writable
- Delete `flowscanner.db` to reset if corrupted

## License

MIT

## Support

For issues and feature requests, please open an issue in the repository.
