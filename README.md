# Hyperscalper

A high-performance copy trading bot for Hyperliquid DEX with real-time dashboard.

![Dashboard](screenshot.png)

## Features

- **Real-time copy trading** via WebSocket fill detection
- **Multi-account support** with independent private keys
- **Smart position sizing** based on balance ratios
- **Limit orders** to reduce slippage with tracking in dashboard
- **Position drift sync** to maintain alignment with tracked wallets
- **Web dashboard** with live metrics, 30-day calendar heatmap, and fee tracking
- **Mobile responsive** design
- **Telegram notifications** (optional)

## Quick Start

```bash
npm install
cp accounts.example.json accounts.json  # Configure your accounts
npm start
```

## Configuration

Edit `accounts.json`:

```json
{
  "isTestnet": false,
  "globalMinOrderValue": 11,
  "globalDriftThresholdPercent": 1,
  "telegram": {
    "botToken": "your-telegram-bot-token",
    "chatId": "your-chat-id",
    "polling": true
  },
  "dashboardPort": 3000,
  "accounts": [
    {
      "id": "A",
      "name": "Trader 1",
      "privateKey": "0x...",
      "trackedWallet": "0x...",
      "userWallet": "0x...",
      "vaultAddress": "0x...",
      "enabled": true
    }
  ]
}
```

## Dashboard

Access at `http://localhost:3000` - includes:
- 30-day balance history with daily charts
- Calendar heatmap with per-day performance stats
- Real-time P&L tracking (realized/unrealized)
- Live fills with fee and slippage tracking
- Position allocation pie charts
- Risk metrics (margin, drawdown, leverage)

## License

ISC
