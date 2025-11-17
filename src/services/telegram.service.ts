import TelegramBot from 'node-telegram-bot-api';

export interface MonitoringStats {
  trackedWallet: string;
  userWallet: string | null;
  trackedPositions: number;
  trackedBalance: number;
  userPositions: number;
  userBalance: number;
  balanceRatio: number;
  ignoredCoins: string[];
  uptime: number;
}

export class TelegramService {
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;
  private enabled: boolean = false;
  private stats: MonitoringStats | null = null;

  constructor(botToken: string | null, chatId: string | null) {
    if (botToken && chatId) {
      this.bot = new TelegramBot(botToken, { polling: true });
      this.chatId = chatId;
      this.enabled = true;
      this.setupCommands();
    }
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
          '🤖 *CopyScalper Bot*\n\n' +
          'Available commands:\n' +
          '/status - View current monitoring status\n' +
          '/start - Show this help message\n\n' +
          'You will receive notifications for all position changes:\n' +
          '• Position opened\n' +
          '• Position closed\n' +
          '• Position increased\n' +
          '• Position decreased\n' +
          '• Position reversed';
        this.sendMessage(message);
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

    let uptimeStr: string;
    if (uptimeHours > 0) {
      uptimeStr = `${uptimeHours}h ${uptimeRemainingMinutes}m`;
    } else {
      uptimeStr = `${uptimeMinutes}m`;
    }

    const message =
      '📊 *Monitoring Status*\n\n' +
      `*Tracked Wallet:* \`${this.formatAddress(this.stats.trackedWallet)}\`\n` +
      `*Positions:* ${this.stats.trackedPositions}\n` +
      `*Balance:* $${this.stats.trackedBalance.toFixed(2)}\n\n` +
      (this.stats.userWallet ?
        `*Your Wallet:* \`${this.formatAddress(this.stats.userWallet)}\`\n` +
        `*Positions:* ${this.stats.userPositions}\n` +
        `*Balance:* $${this.stats.userBalance.toFixed(2)}\n` +
        `*Balance Ratio:* 1:${this.stats.balanceRatio.toFixed(4)}\n\n` : '') +
      (this.stats.ignoredCoins.length > 0 ?
        `*Ignored Positions:* ${this.stats.ignoredCoins.length}\n` +
        `${this.stats.ignoredCoins.map(c => `  • ${c}`).join('\n')}\n\n` : '') +
      `*Uptime:* ${uptimeStr}`;

    await this.sendMessage(message);
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

  isEnabled(): boolean {
    return this.enabled;
  }
}
