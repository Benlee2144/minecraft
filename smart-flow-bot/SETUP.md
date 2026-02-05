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

## Step 3: (Optional) Add Claude AI via OpenClaw

OpenClaw lets you use your Claude Max subscription through Discord.

### Install OpenClaw on Mac:

```bash
# Install via Homebrew
brew install openclaw/tap/openclaw

# Or via npm
npm install -g @openclaw/cli
```

### Configure OpenClaw:

```bash
# Generate a setup token from Claude Code
claude setup-token

# Copy the token, then paste it into OpenClaw
openclaw models auth paste-token --provider anthropic

# Connect to Discord
openclaw channels add discord
```

### Start OpenClaw:

```bash
openclaw start
```

---

## What Each Part Does:

| Component | Purpose | Needs AI? |
|-----------|---------|-----------|
| Stock Scanner Bot | Detects volume spikes, momentum, gaps | NO (math only) |
| OpenClaw (optional) | Chat with Claude in Discord | YES (your Claude Max) |

---

## Troubleshooting

**"WebSocket authentication failed"**
- You're running the old code. Run: `git reset --hard origin/claude/discord-trading-bot-Brlbq`

**"Market closed"**
- Normal outside market hours (9:30 AM - 4:00 PM ET)
- Bot will auto-start monitoring when market opens

**OpenClaw not finding Claude**
- Make sure you ran `claude setup-token` first
- Verify your Claude Max subscription is active
