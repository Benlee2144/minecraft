# Smart Stock Scanner - Setup Guide

## Step 1: Sync Your Local Code (Run on Mac)

Open Terminal and run these commands one by one:

```bash
cd ~/smart-flow-bot
git fetch origin
git reset --hard origin/claude/discord-trading-bot-Brlbq
```

## Step 2: Start the Bot

```bash
npm start
```

You should see:
```
Starting Smart Stock Scanner (REST API Mode)...
```

**NOT** "Connecting to Polygon WebSocket" - that's the old version.

---

## Step 3: (Optional) Add Claude AI Chat

Chat with Claude directly in Discord! Ask trading questions, get explanations of signals, etc.

### Get a Free API Key:

1. Go to: https://console.anthropic.com
2. Create an account (free)
3. Go to API Keys and create a new key
4. Copy the key (starts with `sk-ant-api...`)

### Add to Your Bot:

Create a `.env` file in your smart-flow-bot folder:

```bash
cd ~/smart-flow-bot
echo "ANTHROPIC_API_KEY=sk-ant-api03-YOUR-KEY-HERE" >> .env
```

Or export it directly:
```bash
export ANTHROPIC_API_KEY=sk-ant-api03-YOUR-KEY-HERE
```

### Restart the Bot:

```bash
npm start
```

### How to Use Claude in Discord:

- **Slash command**: `/ask what is RVOL?`
- **Mention the bot**: `@YourBot what does a volume spike mean?`
- **!ask prefix**: `!ask explain momentum trading`
- **Clear history**: `/clear` or `!clear`

---

## What Each Part Does:

| Component | Purpose | Needs API Key? |
|-----------|---------|----------------|
| Stock Scanner Bot | Detects volume spikes, momentum, gaps | Polygon (included) |
| Claude Chat (optional) | Ask Claude questions in Discord | Anthropic (free tier) |

---

## Troubleshooting

**"WebSocket authentication failed"**
- You're running the old code. Run: `git reset --hard origin/claude/discord-trading-bot-Brlbq`

**"Market closed"**
- Normal outside market hours (9:30 AM - 4:00 PM ET)
- Bot will auto-start monitoring when market opens

**"Claude AI is not configured"**
- You need an Anthropic API key (free tier available)
- Get one at: https://console.anthropic.com
- Add it as `ANTHROPIC_API_KEY` environment variable
