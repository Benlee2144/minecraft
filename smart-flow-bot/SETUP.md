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

Chat with Claude directly in Discord using your **Max subscription** - no API key needed!

### Setup Claude Code CLI:

```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Login with your Max subscription
claude /login
```

This opens a browser to authenticate with your Anthropic account.

### Restart the Bot:

```bash
npm start
```

You should see: `Claude Code CLI found - chat enabled (using Max subscription)`

### How to Use Claude in Discord:

- **Slash command**: `/ask what is RVOL?`
- **Mention the bot**: `@YourBot what does a volume spike mean?`
- **!ask prefix**: `!ask explain momentum trading`

---

## What Each Part Does:

| Component | Purpose | Cost |
|-----------|---------|------|
| Stock Scanner Bot | Detects volume spikes, momentum, gaps | Polygon key (included) |
| Claude Chat (optional) | Ask Claude questions in Discord | **FREE** (uses your Max subscription) |

---

## Troubleshooting

**"WebSocket authentication failed"**
- You're running the old code. Run: `git reset --hard origin/claude/discord-trading-bot-Brlbq`

**"Market closed"**
- Normal outside market hours (9:30 AM - 4:00 PM ET)
- Bot will auto-start monitoring when market opens

**"Claude CLI not found"**
- Install: `npm install -g @anthropic-ai/claude-code`
- Login: `claude /login`
- Restart bot: `npm start`
