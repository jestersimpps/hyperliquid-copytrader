import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs';
import * as path from 'path';
import type { Balance, Position } from '../models';

export interface MonitoringStats {
  trackedWallet: string;
  userWallet: string | null;
  trackedPositions: Position[];
  trackedBalance: Balance;
  userPositions: Position[];
  userBalance: Balance | null;
  balanceRatio: number;
  ignoredCoins: string[];
  uptime: number;
}

interface BalanceSnapshot {
  timestamp: number;
  date: string;
  tracked: {
    accountValue: number;
    withdrawable: number;
  };
  user: {
    accountValue: number;
    withdrawable: number;
  };
}

export class TelegramService {
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;
  private enabled: boolean = false;
  private stats: MonitoringStats | null = null;
  private tradingPaused: boolean = false;
  private readonly STATE_FILE = path.resolve(process.cwd(), 'data', 'trading-state.json');

  constructor(botToken: string | null, chatId: string | null) {
    if (botToken && chatId) {
      this.bot = new TelegramBot(botToken, { polling: true });
      this.chatId = chatId;
      this.enabled = true;
      this.loadState();
      this.setupCommands();
      this.setupErrorHandlers();
    }
  }

  private setupErrorHandlers(): void {
    if (!this.bot) return;

    this.bot.on('polling_error', (error) => {
      console.error('Telegram polling error:', error.message);
    });

    this.bot.on('error', (error) => {
      console.error('Telegram bot error:', error.message);
    });
  }

  private setupCommands(): void {
    if (!this.bot) return;

    this.bot.onText(/\/status/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        this.sendStatus();
      }
    });

    this.bot.onText(/\/start/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        const message =
          '🤖 *Hyperscalper Bot*\n\n' +
          'Available commands:\n' +
          '/menu - Trading control panel\n' +
          '/status - View current monitoring status\n' +
          '/start - Show this help message\n\n' +
          'You will receive notifications for:\n' +
          '• Critical errors (order failures)\n' +
          '• Underwater positions (>10% account loss)';
        this.sendMessage(message);
      }
    });

    this.bot.onText(/\/menu/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        this.sendControlPanel();
      }
    });

    this.bot.on('callback_query', (query) => {
      if (query.message?.chat.id.toString() === this.chatId) {
        this.handleCallbackQuery(query);
      }
    });
  }

  updateStats(stats: MonitoringStats): void {
    this.stats = stats;
  }

  private async sendStatus(): Promise<void> {
    if (!this.stats) {
      await this.sendMessage('⚠️ No monitoring data available yet');
      return;
    }

    const uptimeMinutes = Math.floor(this.stats.uptime / 60000);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeRemainingMinutes = uptimeMinutes % 60;
    const uptimeStr = uptimeHours > 0 ? `${uptimeHours}h ${uptimeRemainingMinutes}m` : `${uptimeMinutes}m`;

    const trackedAccountValue = parseFloat(this.stats.trackedBalance.accountValue);
    const trackedWithdrawable = parseFloat(this.stats.trackedBalance.withdrawable);
    const trackedPnlData = await this.calculatePnlSinceMidnight(trackedAccountValue, 'tracked');

    let message = '📊 *Account Status*\n\n';
    message += '*TRACKED ACCOUNT*\n';
    message += `Address: \`${this.formatAddress(this.stats.trackedWallet)}\`\n`;
    message += `Balance: $${trackedAccountValue.toFixed(2)} ($${trackedWithdrawable.toFixed(2)} withdrawable)\n`;
    if (trackedPnlData) {
      const sign = trackedPnlData.pnl >= 0 ? '+' : '';
      message += `PNL Today: ${sign}$${trackedPnlData.pnl.toFixed(2)} (${sign}${trackedPnlData.percentage.toFixed(2)}%)\n`;
    }
    message += '\n';

    if (this.stats.userWallet && this.stats.userBalance) {
      const userAccountValue = parseFloat(this.stats.userBalance.accountValue);
      const userWithdrawable = parseFloat(this.stats.userBalance.withdrawable);
      const userPnlData = await this.calculatePnlSinceMidnight(userAccountValue, 'user');

      const marginRatio = userAccountValue > 0
        ? (parseFloat(this.stats.userBalance.crossMaintenanceMarginUsed) / userAccountValue) * 100
        : 0;

      message += '*YOUR ACCOUNT*\n';
      message += `Address: \`${this.formatAddress(this.stats.userWallet)}\`\n`;
      message += `Balance: $${userAccountValue.toFixed(2)} ($${userWithdrawable.toFixed(2)} withdrawable)\n`;
      if (userPnlData) {
        const sign = userPnlData.pnl >= 0 ? '+' : '';
        message += `PNL Today: ${sign}$${userPnlData.pnl.toFixed(2)} (${sign}${userPnlData.percentage.toFixed(2)}%)\n`;
      }
      message += `Balance Ratio: 1:${this.stats.balanceRatio.toFixed(4)}\n`;
      message += `Margin Usage: ${marginRatio.toFixed(2)}%\n\n`;
    }

    if (this.stats.userPositions.length > 0) {
      message += `*OPEN POSITIONS (${this.stats.userPositions.length})*\n\n`;
      for (const position of this.stats.userPositions) {
        message += this.formatPosition(position);
      }
    }

    if (this.stats.ignoredCoins.length > 0) {
      message += `\n*Ignored: ${this.stats.ignoredCoins.length} positions*\n`;
      message += this.stats.ignoredCoins.map(c => `  • ${c}`).join('\n') + '\n';
    }

    message += `\n*Uptime:* ${uptimeStr}`;

    await this.sendMessage(message);
  }

  private async readMidnightSnapshot(): Promise<BalanceSnapshot | null> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const filePath = path.join(process.cwd(), 'data', `snapshots-${today}.jsonl`);

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        if (lines.length > 0 && lines[0]) {
          return JSON.parse(lines[0]);
        }
      }

      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const yesterdayPath = path.join(process.cwd(), 'data', `snapshots-${yesterday}.jsonl`);

      if (fs.existsSync(yesterdayPath)) {
        const content = fs.readFileSync(yesterdayPath, 'utf-8');
        const lines = content.trim().split('\n');
        if (lines.length > 0 && lines[lines.length - 1]) {
          return JSON.parse(lines[lines.length - 1]);
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private async calculatePnlSinceMidnight(
    currentAccountValue: number,
    walletType: 'tracked' | 'user'
  ): Promise<{ pnl: number; percentage: number } | null> {
    const midnightSnapshot = await this.readMidnightSnapshot();
    if (!midnightSnapshot) {
      return null;
    }

    const midnightValue = walletType === 'tracked'
      ? midnightSnapshot.tracked.accountValue
      : midnightSnapshot.user.accountValue;

    const pnl = currentAccountValue - midnightValue;
    const percentage = midnightValue > 0 ? (pnl / midnightValue) * 100 : 0;

    return { pnl, percentage };
  }

  private formatPosition(position: Position): string {
    const notionalValue = position.size * position.markPrice;
    const pnlSign = position.unrealizedPnl >= 0 ? '+' : '';

    let message = `*${position.coin}*\n`;
    message += `├ ${position.side.charAt(0).toUpperCase() + position.side.slice(1)} ${position.leverage.toFixed(0)}x | $${notionalValue.toFixed(2)} notional\n`;
    message += `├ Size: ${position.size.toFixed(4)} @ $${position.entryPrice.toFixed(2)}\n`;
    message += `└ Mark: $${position.markPrice.toFixed(2)} | PnL: ${pnlSign}$${position.unrealizedPnl.toFixed(2)}\n\n`;

    return message;
  }

  private formatAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  async sendMonitoringStarted(trackedWallet: string, userWallet: string | null): Promise<void> {
    if (!this.enabled) return;

    let message = '🚀 *Monitoring Started*\n\n';
    message += `*Tracked Wallet:* \`${this.formatAddress(trackedWallet)}\`\n`;
    if (userWallet) {
      message += `*Your Wallet:* \`${this.formatAddress(userWallet)}\`\n`;
    }
    message += '\nUse /status to check current positions';

    await this.sendMessage(message);
  }

  async sendError(error: string): Promise<void> {
    if (!this.enabled) return;
    await this.sendMessage(`❌ *Error*\n\n${error}`);
  }

  async sendUnderwaterPositionAlert(
    coin: string,
    side: string,
    leverage: number,
    size: number,
    entryPrice: number,
    markPrice: number,
    unrealizedPnl: number,
    percentOfAccount: number,
    lastTradeTime: number
  ): Promise<void> {
    if (!this.enabled) return;

    const timeAgo = this.formatTimeAgo(Date.now() - lastTradeTime);

    const message =
      '⚠️ *Position Underwater*\n\n' +
      `*Coin:* ${coin}\n` +
      `*Side:* ${side.toUpperCase()} ${leverage}x\n` +
      `*Size:* ${size.toFixed(4)}\n` +
      `*Entry:* $${entryPrice.toFixed(4)}\n` +
      `*Mark:* $${markPrice.toFixed(4)}\n` +
      `*Unrealized PnL:* $${unrealizedPnl.toFixed(2)}\n` +
      `*Loss:* ${percentOfAccount.toFixed(2)}% of account\n` +
      `*Last Trade:* ${timeAgo}`;

    await this.sendMessage(message);
  }

  async sendDailyLossWarning(
    threshold: number,
    lossPercent: number,
    lossAmount: number,
    currentBalance: number
  ): Promise<void> {
    if (!this.enabled) return;

    const emoji = lossPercent >= 15 ? '🔴' : '⚠️';
    const message =
      `${emoji} *Daily Loss Warning*\n\n` +
      `*Loss Threshold:* ${threshold}% reached\n` +
      `*Actual Loss:* ${lossPercent.toFixed(2)}%\n` +
      `*Amount Lost:* $${lossAmount.toFixed(2)}\n` +
      `*Current Balance:* $${currentBalance.toFixed(2)}\n\n` +
      `_Consider reducing position sizes or taking a break_`;

    await this.sendMessage(message);
  }

  async sendBalanceDropAlert(
    threshold: number,
    dropPercent: number,
    dropAmount: number,
    peakBalance: number,
    currentBalance: number
  ): Promise<void> {
    if (!this.enabled) return;

    const emoji = dropPercent >= 15 ? '🔴' : '⚠️';
    const message =
      `${emoji} *Balance Drop Alert*\n\n` +
      `*Drop:* ${dropPercent.toFixed(2)}% from daily high\n` +
      `*Peak Balance:* $${peakBalance.toFixed(2)}\n` +
      `*Current Balance:* $${currentBalance.toFixed(2)}\n` +
      `*Amount Lost:* $${dropAmount.toFixed(2)}`;

    await this.sendMessage(message);
  }

  async sendMarginUsageWarning(
    marginRatio: number,
    marginUsed: number,
    accountValue: number
  ): Promise<void> {
    if (!this.enabled) return;

    const message =
      '⚠️ *High Margin Usage*\n\n' +
      `*Margin Ratio:* ${marginRatio.toFixed(2)}%\n` +
      `*Margin Used:* $${marginUsed.toFixed(2)}\n` +
      `*Account Value:* $${accountValue.toFixed(2)}\n` +
      `*Available:* $${(accountValue - marginUsed).toFixed(2)}\n\n` +
      `_Consider reducing leverage or closing positions_`;

    await this.sendMessage(message);
  }

  async sendPositionSizeInfo(
    coin: string,
    notionalValue: number,
    percentOfAccount: number,
    accountValue: number
  ): Promise<void> {
    if (!this.enabled) return;

    const message =
      '📊 *Large Position Alert*\n\n' +
      `*Coin:* ${coin}\n` +
      `*Position Size:* $${notionalValue.toFixed(2)}\n` +
      `*% of Account:* ${percentOfAccount.toFixed(2)}%\n` +
      `*Account Value:* $${accountValue.toFixed(2)}\n\n` +
      `_FYI: Single position is ${percentOfAccount.toFixed(0)}% of your account_`;

    await this.sendMessage(message);
  }

  private formatTimeAgo(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ago`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return;

    try {
      await this.bot.sendMessage(this.chatId, text, {
        parse_mode: 'Markdown'
      });
    } catch (error) {
      console.error('Failed to send Telegram message:', error instanceof Error ? error.message : error);
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
    }
  }

  private async sendControlPanel(): Promise<void> {
    if (!this.bot || !this.chatId) return;

    const status = this.tradingPaused ? '⏸️ *PAUSED*' : '▶️ *ACTIVE*';
    const message = `*Hyperscalper Control Panel*\n\nTrading Status: ${status}`;

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '▶️ Resume Trading', callback_data: 'start_trading' },
              { text: '⏸️ Pause Trading', callback_data: 'pause_trading' }
            ],
            [
              { text: '📊 Status', callback_data: 'status' }
            ]
          ]
        }
      });
    } catch (error) {
      console.error('Failed to send control panel:', error instanceof Error ? error.message : error);
    }
  }

  private async handleCallbackQuery(query: any): Promise<void> {
    if (!this.bot) return;

    const action = query.data;

    try {
      switch (action) {
        case 'pause_trading':
          this.pauseTrading();
          await this.sendMessage('⏸️ *Trading Paused*\n\nAll new trades are now blocked. Existing positions remain open.');
          break;
        case 'start_trading':
          this.resumeTrading();
          await this.sendMessage('▶️ *Trading Resumed*\n\nBot will now execute trades based on tracked wallet activity.');
          break;
        case 'status':
          await this.sendStatus();
          break;
      }

      await this.bot.answerCallbackQuery(query.id);
    } catch (error) {
      console.error('Failed to handle callback query:', error instanceof Error ? error.message : error);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isTradingPaused(): boolean {
    return this.tradingPaused;
  }

  pauseTrading(): void {
    this.tradingPaused = true;
    this.saveState();
  }

  resumeTrading(): void {
    this.tradingPaused = false;
    this.saveState();
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(this.STATE_FILE, 'utf-8'));
        this.tradingPaused = data.tradingPaused || false;
        console.log(`✓ Trading state loaded: ${this.tradingPaused ? 'PAUSED' : 'ACTIVE'}`);
      }
    } catch (error) {
      console.error('Failed to load trading state:', error instanceof Error ? error.message : error);
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.STATE_FILE, JSON.stringify({
        tradingPaused: this.tradingPaused,
        lastUpdated: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      console.error('Failed to save trading state:', error instanceof Error ? error.message : error);
    }
  }
}
