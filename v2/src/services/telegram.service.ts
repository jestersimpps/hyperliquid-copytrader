import TelegramBot from 'node-telegram-bot-api'
import { DriftReport, Position } from '@/models'
import { config } from '@/config'
import { MonitorSnapshot } from './balance-monitor.service'
import { HyperliquidService } from './hyperliquid.service'

export class TelegramService {
  private bot: TelegramBot | null = null
  private chatId: string | null = null
  private enabled: boolean = false
  private lastSnapshot: MonitorSnapshot | null = null
  private startTime: number = Date.now()
  private tradingPaused: boolean = false
  private hyperliquidService: HyperliquidService | null = null

  constructor() {
    if (config.telegramBotToken && config.telegramChatId) {
      this.bot = new TelegramBot(config.telegramBotToken, { polling: true })
      this.chatId = config.telegramChatId
      this.enabled = true
      this.setupCommands()
      this.setupCallbackHandlers()
      this.setupErrorHandlers()
    }
  }

  setHyperliquidService(service: HyperliquidService): void {
    this.hyperliquidService = service
  }

  isTradingPaused(): boolean {
    return this.tradingPaused
  }

  private setupErrorHandlers(): void {
    if (!this.bot) return

    this.bot.on('polling_error', (error) => {
      console.error('Telegram polling error:', error.message)
    })

    this.bot.on('error', (error) => {
      console.error('Telegram bot error:', error.message)
    })
  }

  private setupCommands(): void {
    if (!this.bot) return

    this.bot.onText(/\/status/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        this.sendStatus()
      }
    })

    this.bot.onText(/\/start/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        const message =
          '🤖 *Copyscalper v2*\n\n' +
          'Commands:\n' +
          '/status - View account status\n' +
          '/menu - Control panel\n' +
          '/start - Show this help\n\n' +
          'You will receive alerts when:\n' +
          '• Position drift is detected'
        this.sendMessage(message)
      }
    })

    this.bot.onText(/\/menu/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        this.sendMenu()
      }
    })
  }

  private setupCallbackHandlers(): void {
    if (!this.bot) return

    this.bot.on('callback_query', async (query) => {
      if (!query.message || query.message.chat.id.toString() !== this.chatId) return

      const action = query.data
      await this.bot!.answerCallbackQuery(query.id)

      switch (action) {
        case 'pause_trading':
          this.tradingPaused = true
          await this.sendMessage('⏸️ Trading *paused*. New trades will be skipped.')
          break

        case 'resume_trading':
          this.tradingPaused = false
          await this.sendMessage('▶️ Trading *resumed*. Back to normal operation.')
          break

        case 'restart_bot':
          await this.sendMessage('🔄 Restarting bot...')
          setTimeout(() => process.exit(0), 1000)
          break

        case 'close_profitable':
          await this.closeMostProfitablePosition()
          break

        case 'status':
          await this.sendStatus()
          break
      }
    })
  }

  private async sendMenu(): Promise<void> {
    if (!this.bot || !this.chatId) return

    const tradingButton = this.tradingPaused
      ? { text: '▶️ Resume Trading', callback_data: 'resume_trading' }
      : { text: '⏸️ Pause Trading', callback_data: 'pause_trading' }

    const keyboard = {
      inline_keyboard: [
        [tradingButton],
        [{ text: '📊 Status', callback_data: 'status' }],
        [{ text: '💰 Close Most Profitable', callback_data: 'close_profitable' }],
        [{ text: '🔄 Restart Bot', callback_data: 'restart_bot' }]
      ]
    }

    await this.bot.sendMessage(this.chatId, '🎛️ *Control Panel*', {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    })
  }

  private async closeMostProfitablePosition(): Promise<void> {
    if (!this.lastSnapshot || !this.hyperliquidService) {
      await this.sendMessage('⚠️ No data or service available')
      return
    }

    const positions = this.lastSnapshot.userPositions
    if (positions.length === 0) {
      await this.sendMessage('⚠️ No open positions')
      return
    }

    const mostProfitable = positions.reduce((best, pos) =>
      pos.unrealizedPnl > best.unrealizedPnl ? pos : best
    )

    if (mostProfitable.unrealizedPnl <= 0) {
      await this.sendMessage('⚠️ No profitable positions to close')
      return
    }

    try {
      await this.sendMessage(`🔄 Closing ${mostProfitable.coin} (+$${mostProfitable.unrealizedPnl.toFixed(2)})...`)
      await this.hyperliquidService.closePosition(mostProfitable.coin, mostProfitable.markPrice)
      await this.sendMessage(`✅ Closed ${mostProfitable.coin} position`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await this.sendMessage(`❌ Failed to close: ${msg}`)
    }
  }

  updateSnapshot(snapshot: MonitorSnapshot): void {
    this.lastSnapshot = snapshot
  }

  private async sendStatus(): Promise<void> {
    if (!this.lastSnapshot) {
      await this.sendMessage('⚠️ No data available yet')
      return
    }

    const s = this.lastSnapshot
    const uptimeMs = Date.now() - this.startTime
    const uptimeMinutes = Math.floor(uptimeMs / 60000)
    const uptimeStr = uptimeMinutes >= 60
      ? `${Math.floor(uptimeMinutes / 60)}h ${uptimeMinutes % 60}m`
      : `${uptimeMinutes}m`

    const userValue = parseFloat(s.userBalance.accountValue)

    let message = '📊 *Status*\n\n'
    message += `💰 Balance: $${userValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n`

    if (s.userPositions.length > 0) {
      message += '📈 *Positions:*\n'
      for (const pos of s.userPositions) {
        message += this.formatPositionDetailed(pos, s)
      }
    } else {
      message += '_No open positions_\n'
    }

    message += `\n⏱ Uptime: ${uptimeStr}`

    await this.sendMessage(message)
  }

  private formatPositionDetailed(pos: Position, snapshot: MonitorSnapshot): string {
    const userValue = parseFloat(snapshot.userBalance.accountValue)
    const sizePercent = (pos.notionalValue / userValue) * 100

    const trackedPos = snapshot.trackedPositions.find(p => p.coin === pos.coin)

    let sizeDiffStr = 'N/A'
    let entryDiffStr = 'N/A'

    if (trackedPos) {
      const scaledTargetSize = trackedPos.size * snapshot.balanceRatio
      const sizeDiff = ((pos.size - scaledTargetSize) / scaledTargetSize) * 100
      const sizeDiffSign = sizeDiff >= 0 ? '+' : ''
      sizeDiffStr = `${sizeDiffSign}${sizeDiff.toFixed(1)}%`

      const entryDiff = ((pos.entryPrice - trackedPos.entryPrice) / trackedPos.entryPrice) * 100
      const isFavorable = pos.side === 'long' ? entryDiff < 0 : entryDiff > 0
      const entryDiffSign = entryDiff >= 0 ? '+' : ''
      const favorableIcon = isFavorable ? '✓' : '✗'
      entryDiffStr = `${entryDiffSign}${entryDiff.toFixed(2)}% ${favorableIcon}`
    }

    const pnlSign = pos.unrealizedPnl >= 0 ? '+' : ''
    const pnlStr = `${pnlSign}$${pos.unrealizedPnl.toFixed(2)}`

    let result = `┌ *${pos.coin}* ${pos.side.toUpperCase()} (${pnlStr})\n`
    result += `├ Size: $${pos.notionalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${sizePercent.toFixed(1)}%)\n`
    result += `├ Size diff: ${sizeDiffStr}\n`
    result += `├ Entry: $${pos.entryPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`
    result += `└ Entry diff: ${entryDiffStr}\n\n`

    return result
  }

  async sendDriftAlert(driftReport: DriftReport): Promise<void> {
    if (!this.enabled) return

    let message = `⚠️ *Position Drift Detected*\n\n`
    message += `Found ${driftReport.drifts.length} drift(s):\n\n`

    for (const drift of driftReport.drifts) {
      const favorableStr = drift.isFavorable ? '✓ sync' : '✗ skip'
      message += `*${drift.coin}*\n`
      message += `├ Type: ${drift.driftType.replace('_', ' ')}\n`
      message += `├ Diff: ${drift.sizeDiffPercent.toFixed(1)}%\n`
      message += `└ Action: ${favorableStr}\n\n`
    }

    const favorableCount = driftReport.drifts.filter(d => d.isFavorable).length
    if (favorableCount > 0) {
      message += `_Syncing ${favorableCount} favorable position(s)..._`
    } else {
      message += `_No favorable sync opportunities_`
    }

    await this.sendMessage(message)
  }

  async sendMonitoringStarted(): Promise<void> {
    if (!this.enabled) return

    const message =
      '🚀 *Monitoring Started*\n\n' +
      `Tracked: \`${this.formatAddress(config.trackedWallet)}\`\n` +
      `User: \`${this.formatAddress(config.userWallet)}\`\n\n` +
      'Use /status to check positions'

    await this.sendMessage(message)
  }

  async sendError(error: string): Promise<void> {
    if (!this.enabled) return
    await this.sendMessage(`❌ *Error*\n\n${error}`)
  }

  private formatAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.bot || !this.chatId) return

    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: 'Markdown' })
    } catch (error) {
      console.error('Failed to send Telegram message:', error instanceof Error ? error.message : error)
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling()
    }
  }
}
