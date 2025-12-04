import TelegramBot from 'node-telegram-bot-api'
import { DriftReport, Position, TelegramConfig, SubAccountConfig, SubAccountState } from '@/models'
import { MonitorSnapshot } from './balance-monitor.service'
import { HyperliquidService } from './hyperliquid.service'
import { LoggerService } from './logger.service'

interface AccountSnapshotData {
  snapshot: MonitorSnapshot
  config: SubAccountConfig
  state: SubAccountState
  loggerService: LoggerService
}

export class TelegramService {
  private bot: TelegramBot | null = null
  private chatId: string | null = null
  private enabled: boolean = false
  private startTime: number = Date.now()
  private hyperliquidService: HyperliquidService | null = null
  private accountSnapshots: Map<string, AccountSnapshotData> = new Map()
  private accountStates: Map<string, SubAccountState> = new Map()
  private selectedAccountId: string | null = null
  private lastDriftAlertTimes: Map<string, number> = new Map()
  private readonly DRIFT_ALERT_COOLDOWN_MS = 60 * 60 * 1000

  constructor(telegramConfig: TelegramConfig | null) {
    if (telegramConfig?.botToken && telegramConfig?.chatId) {
      this.bot = new TelegramBot(telegramConfig.botToken, { polling: telegramConfig.polling })
      this.chatId = telegramConfig.chatId
      this.enabled = true
      if (telegramConfig.polling) {
        this.setupCommands()
        this.setupCallbackHandlers()
        this.setupErrorHandlers()
      }
    }
  }

  setHyperliquidService(service: HyperliquidService): void {
    this.hyperliquidService = service
  }

  registerAccount(accountId: string, config: SubAccountConfig, state: SubAccountState, loggerService: LoggerService): void {
    this.accountStates.set(accountId, state)
    this.accountSnapshots.set(accountId, {
      snapshot: null as unknown as MonitorSnapshot,
      config,
      state,
      loggerService
    })
  }

  getAccountState(accountId: string): SubAccountState | undefined {
    return this.accountStates.get(accountId)
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

    this.bot.onText(/\/status(?:\s+(\S+))?/, (msg, match) => {
      if (msg.chat.id.toString() === this.chatId) {
        const accountId = match?.[1]
        if (accountId) {
          this.sendAccountStatus(accountId)
        } else {
          this.sendGlobalStatus()
        }
      }
    })

    this.bot.onText(/\/start/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        const accounts = Array.from(this.accountSnapshots.keys()).join(', ') || 'none'
        const message =
          '🤖 *Hyperscalper Multi-Account*\n\n' +
          'Commands:\n' +
          '/status - Global status (all accounts)\n' +
          '/status <id> - Specific account status\n' +
          '/menu - Account selector\n' +
          '/accounts - List all accounts\n\n' +
          `Active accounts: ${accounts}`
        this.sendMessage(message)
      }
    })

    this.bot.onText(/\/menu/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        this.sendAccountSelector()
      }
    })

    this.bot.onText(/\/accounts/, (msg) => {
      if (msg.chat.id.toString() === this.chatId) {
        this.sendAccountsList()
      }
    })
  }

  private setupCallbackHandlers(): void {
    if (!this.bot) return

    this.bot.on('callback_query', async (query) => {
      if (!query.message || query.message.chat.id.toString() !== this.chatId) return

      const data = query.data || ''
      await this.bot!.answerCallbackQuery(query.id)

      const parts = data.split(':')
      const action = parts[0]
      const accountId = parts[1]

      switch (action) {
        case 'sel':
          this.selectedAccountId = accountId
          await this.sendAccountMenu(accountId)
          break

        case 'pause':
          await this.setAccountTradingPaused(accountId, true)
          break

        case 'resume':
          await this.setAccountTradingPaused(accountId, false)
          break

        case 'href_on':
          await this.setAccountHrefMode(accountId, true)
          break

        case 'href_off':
          await this.setAccountHrefMode(accountId, false)
          break

        case 'status':
          await this.sendAccountStatus(accountId)
          break

        case 'close':
          if (parts.length >= 4) {
            const coin = parts[2]
            const percent = parseInt(parts[3])
            await this.closePositionPercent(accountId, coin, percent)
          }
          break

        case 'closeall4h':
          await this.closeAllPositionsAndPause(accountId)
          break

        case 'closepause':
          if (parts.length >= 3) {
            const coin = parts[2]
            await this.closePositionAndPause(accountId, coin)
          }
          break

        case 'pause4h':
          await this.pauseTradingFor4Hours(accountId)
          break

        case 'pause4hsym':
          if (parts.length >= 3) {
            const coin = parts[2]
            await this.pauseSymbol(accountId, coin, 4)
          }
          break

        case 'pause8hsym':
          if (parts.length >= 3) {
            const coin = parts[2]
            await this.pauseSymbol(accountId, coin, 8)
          }
          break

        case 'resumesym':
          if (parts.length >= 3) {
            const coin = parts[2]
            await this.resumeSymbol(accountId, coin)
          }
          break

        case 'pause16hsym':
          if (parts.length >= 3) {
            const coin = parts[2]
            await this.pauseSymbol(accountId, coin, 16)
          }
          break

        case 'pausedrawdown':
          if (parts.length >= 3) {
            const coin = parts[2]
            await this.pauseUntilDrawdown(accountId, coin)
          }
          break

        case 'closeall':
          await this.closeAllPositions(accountId)
          break

        case 'pauseall':
          if (parts.length >= 3) {
            const hours = parseInt(parts[2])
            await this.pauseAllSymbols(accountId, hours)
          }
          break

        case 'takeprofit_on':
          await this.setTakeProfitMode(accountId, true)
          break

        case 'takeprofit_off':
          await this.setTakeProfitMode(accountId, false)
          break

        case 'back':
          this.selectedAccountId = null
          await this.sendAccountSelector()
          break

        case 'global':
          await this.sendGlobalStatus()
          break

        case 'restart':
          await this.sendMessage('🔄 Restarting bot...')
          setTimeout(() => process.exit(0), 1000)
          break
      }
    })
  }

  private async sendAccountSelector(): Promise<void> {
    if (!this.bot || !this.chatId) return

    const keyboard: TelegramBot.InlineKeyboardButton[][] = []

    for (const [accountId, data] of this.accountSnapshots) {
      if (!data.snapshot) continue
      const balance = parseFloat(data.snapshot.userBalance.accountValue)
      const totalPnl = data.snapshot.userPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
      const pnlSign = totalPnl >= 0 ? '+' : ''
      const label = `${data.config.name} - $${balance.toFixed(0)} (${pnlSign}${totalPnl.toFixed(0)})`
      keyboard.push([{ text: label, callback_data: `sel:${accountId}` }])
    }

    keyboard.push([{ text: '📊 Global Status', callback_data: 'global' }])

    await this.bot.sendMessage(this.chatId, '🎛️ *Select Account*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    })
  }

  private async sendAccountMenu(accountId: string): Promise<void> {
    if (!this.bot || !this.chatId) return

    const data = this.accountSnapshots.get(accountId)
    if (!data) {
      await this.sendMessage(`⚠️ Account ${accountId} not found`)
      return
    }

    const state = this.accountStates.get(accountId)
    if (!state) return

    const keyboard: TelegramBot.InlineKeyboardButton[][] = []
    let messageText = ''

    const statusStr = state.tradingPaused ? '⏸️ PAUSED' : (state.hrefModeEnabled ? '🔗 HREF' : (state.takeProfitMode ? '💰 TP' : '✅ ACTIVE'))
    messageText = `🎛️ *${data.config.name}* (${statusStr})\n`
    messageText += `Tracking: \`${this.formatAddress(data.config.trackedWallet)}\`\n`

    if (data.snapshot && data.snapshot.userPositions.length > 0) {
      for (const pos of data.snapshot.userPositions) {
        const pnlSign = pos.unrealizedPnl >= 0 ? '+' : ''
        const positionUsd = pos.notionalValue.toFixed(0)
        messageText += `\n📊 *${pos.coin}* - $${positionUsd} - ${pnlSign}$${pos.unrealizedPnl.toFixed(0)}\n`

        keyboard.push([
          { text: '❌ 100%', callback_data: `close:${accountId}:${pos.coin}:100` },
          { text: '50%', callback_data: `close:${accountId}:${pos.coin}:50` },
          { text: '25%', callback_data: `close:${accountId}:${pos.coin}:25` }
        ])

        const pausedUntil = state.pausedSymbols.get(pos.coin)
        const isDrawdownPaused = state.drawdownPausedSymbols.has(pos.coin)

        if (isDrawdownPaused) {
          keyboard.push([{ text: `▶️ Resume ${pos.coin} (waiting for drawdown)`, callback_data: `resumesym:${accountId}:${pos.coin}` }])
        } else if (pausedUntil && Date.now() < pausedUntil) {
          const remaining = Math.ceil((pausedUntil - Date.now()) / 60000)
          const hours = Math.floor(remaining / 60)
          const mins = remaining % 60
          const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
          keyboard.push([{ text: `▶️ Resume ${pos.coin} (${timeStr} left)`, callback_data: `resumesym:${accountId}:${pos.coin}` }])
        } else {
          keyboard.push([
            { text: '⏸️ 4h', callback_data: `pause4hsym:${accountId}:${pos.coin}` },
            { text: '⏸️ 8h', callback_data: `pause8hsym:${accountId}:${pos.coin}` },
            { text: '⏸️ 16h', callback_data: `pause16hsym:${accountId}:${pos.coin}` }
          ])
          keyboard.push([{ text: '⏸️ Pause until large drawdown', callback_data: `pausedrawdown:${accountId}:${pos.coin}` }])
        }
      }
    } else {
      messageText += '\n_No open positions_\n'
    }

    keyboard.push([{ text: '🔴 Close All', callback_data: `closeall:${accountId}` }])
    keyboard.push([
      { text: '⏸️ 4h', callback_data: `pauseall:${accountId}:4` },
      { text: '⏸️ 8h', callback_data: `pauseall:${accountId}:8` },
      { text: '⏸️ 16h', callback_data: `pauseall:${accountId}:16` }
    ])

    const tradingButton = state.tradingPaused
      ? { text: '▶️ Resume Trading', callback_data: `resume:${accountId}` }
      : { text: '⏸️ Pause Trading', callback_data: `pause:${accountId}` }

    const hrefButton = state.hrefModeEnabled
      ? { text: '⚡ Disable HREF', callback_data: `href_off:${accountId}` }
      : { text: '🔗 Enable HREF', callback_data: `href_on:${accountId}` }

    keyboard.push([tradingButton, hrefButton])

    const takeProfitButton = state.takeProfitMode
      ? { text: '💰 Disable Take Profit Mode', callback_data: `takeprofit_off:${accountId}` }
      : { text: '💰 Enable Take Profit Mode', callback_data: `takeprofit_on:${accountId}` }

    keyboard.push([takeProfitButton])
    keyboard.push([{ text: '📊 Status', callback_data: `status:${accountId}` }])
    keyboard.push([{ text: '⬅️ Back', callback_data: 'back' }])

    await this.bot.sendMessage(
      this.chatId,
      messageText,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }
    )
  }

  private async sendGlobalStatus(): Promise<void> {
    if (!this.bot || !this.chatId) return

    let totalBalance = 0
    let totalPnl = 0
    let totalPositions = 0

    let message = '📊 *Global Dashboard*\n\n'

    for (const [accountId, data] of this.accountSnapshots) {
      if (!data.snapshot) continue
      const balance = parseFloat(data.snapshot.userBalance.accountValue)
      const pnl = data.snapshot.userPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
      const posCount = data.snapshot.userPositions.length

      totalBalance += balance
      totalPnl += pnl
      totalPositions += posCount

      const state = this.accountStates.get(accountId)
      const statusIcon = state?.tradingPaused ? '⏸️' : (state?.hrefModeEnabled ? '🔗' : '✅')
      const pnlSign = pnl >= 0 ? '+' : ''

      message += `${statusIcon} *${data.config.name}*\n`
      message += `   $${balance.toFixed(0)} (${pnlSign}${pnl.toFixed(0)}) | ${posCount} pos\n\n`
    }

    const totalPnlSign = totalPnl >= 0 ? '+' : ''
    message += `━━━━━━━━━━━━━━━━━━━━━\n`
    message += `💰 *Total:* $${totalBalance.toFixed(0)} (${totalPnlSign}${totalPnl.toFixed(0)})\n`
    message += `📈 *Positions:* ${totalPositions}\n\n`

    const uptimeMs = Date.now() - this.startTime
    const uptimeMinutes = Math.floor(uptimeMs / 60000)
    const uptimeStr = uptimeMinutes >= 60
      ? `${Math.floor(uptimeMinutes / 60)}h ${uptimeMinutes % 60}m`
      : `${uptimeMinutes}m`
    message += `⏱ Uptime: ${uptimeStr}`

    const keyboard: TelegramBot.InlineKeyboardButton[][] = []
    const accounts = Array.from(this.accountSnapshots.keys())
    const row: TelegramBot.InlineKeyboardButton[] = []
    for (const accountId of accounts) {
      const data = this.accountSnapshots.get(accountId)
      if (data) {
        row.push({ text: data.config.name, callback_data: `sel:${accountId}` })
        if (row.length === 2) {
          keyboard.push([...row])
          row.length = 0
        }
      }
    }
    if (row.length > 0) keyboard.push(row)
    keyboard.push([{ text: '🔄 Restart Bot', callback_data: 'restart' }])

    await this.bot.sendMessage(this.chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    })
  }

  private async sendAccountStatus(accountId: string): Promise<void> {
    const data = this.accountSnapshots.get(accountId)
    if (!data || !data.snapshot) {
      await this.sendMessage(`⚠️ No data for account ${accountId}`)
      return
    }

    const s = data.snapshot
    const userValue = parseFloat(s.userBalance.accountValue)

    let message = `📊 *${data.config.name} Status*\n`
    message += `Tracking: \`${this.formatAddress(data.config.trackedWallet)}\`\n\n`
    message += `💰 Balance: $${userValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n`

    if (s.userPositions.length > 0) {
      message += '📈 *Positions:*\n'
      for (const pos of s.userPositions) {
        message += this.formatPositionDetailed(pos, s)
      }
    } else {
      message += '_No open positions_\n'
    }

    await this.sendMessage(message)
  }

  private async sendAccountsList(): Promise<void> {
    let message = '📋 *Registered Accounts*\n\n'

    for (const [accountId, data] of this.accountSnapshots) {
      const state = this.accountStates.get(accountId)
      const statusIcon = state?.tradingPaused ? '⏸️' : (state?.hrefModeEnabled ? '🔗' : '✅')
      message += `${statusIcon} *${data.config.name}* (\`${accountId}\`)\n`
      message += `   Tracked: \`${this.formatAddress(data.config.trackedWallet)}\`\n`
      message += `   User: \`${this.formatAddress(data.config.userWallet)}\`\n\n`
    }

    await this.sendMessage(message)
  }

  private async setAccountTradingPaused(accountId: string, paused: boolean): Promise<void> {
    const state = this.accountStates.get(accountId)
    if (state) {
      state.tradingPaused = paused
      const data = this.accountSnapshots.get(accountId)
      const name = data?.config.name || accountId
      await this.sendMessage(paused
        ? `⏸️ [${name}] Trading *paused*`
        : `▶️ [${name}] Trading *resumed*`)
    }
  }

  private async setAccountHrefMode(accountId: string, enabled: boolean): Promise<void> {
    const state = this.accountStates.get(accountId)
    if (state) {
      state.hrefModeEnabled = enabled
      const data = this.accountSnapshots.get(accountId)
      const name = data?.config.name || accountId
      await this.sendMessage(enabled
        ? `🔗 [${name}] HREF mode *enabled*`
        : `⚡ [${name}] HREF mode *disabled*`)
    }
  }

  private async closePositionPercent(accountId: string, coin: string, percent: number): Promise<void> {
    const data = this.accountSnapshots.get(accountId)
    if (!data?.snapshot || !this.hyperliquidService) {
      await this.sendMessage('⚠️ No data or service available')
      return
    }

    const position = data.snapshot.userPositions.find(p => p.coin === coin)
    if (!position) {
      await this.sendMessage(`⚠️ No ${coin} position found in ${data.config.name}`)
      return
    }

    try {
      const closeSize = Math.abs(position.size) * (percent / 100)
      const startTime = Date.now()
      await this.sendMessage(`🔄 [${data.config.name}] Closing ${percent}% of ${coin}...`)

      const { userWallet } = data.config
      const vaultAddress = data.config.vaultAddress || undefined

      if (percent === 100) {
        await this.hyperliquidService.closePosition(coin, position.markPrice, userWallet, undefined, vaultAddress)
      } else {
        await this.hyperliquidService.reducePosition(coin, closeSize, position.markPrice, userWallet, vaultAddress)
      }

      const executionMs = Date.now() - startTime

      data.loggerService.logTrade({
        coin,
        action: percent === 100 ? 'close' : 'reduce',
        side: position.side,
        size: closeSize,
        price: position.markPrice,
        timestamp: Date.now(),
        executionMs,
        connectionId: -1,
        realizedPnl: position.unrealizedPnl * (percent / 100),
        source: 'telegram'
      })

      await this.sendMessage(`✅ [${data.config.name}] Closed ${percent}% of ${coin}`)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await this.sendMessage(`❌ [${data.config.name}] Failed to close: ${msg}`)
    }
  }

  private async closePositionAndPause(accountId: string, coin: string): Promise<void> {
    const data = this.accountSnapshots.get(accountId)
    const state = this.accountStates.get(accountId)
    if (!data?.snapshot || !this.hyperliquidService || !state) {
      await this.sendMessage('⚠️ No data or service available')
      return
    }

    const position = data.snapshot.userPositions.find(p => p.coin === coin)
    if (!position) {
      await this.sendMessage(`⚠️ No ${coin} position found in ${data.config.name}`)
      return
    }

    try {
      await this.sendMessage(`🔄 [${data.config.name}] Closing ${coin} and pausing...`)

      const { userWallet } = data.config
      const vaultAddress = data.config.vaultAddress || undefined

      await this.hyperliquidService.closePosition(coin, position.markPrice, userWallet, undefined, vaultAddress)

      data.loggerService.logTrade({
        coin,
        action: 'close',
        side: position.side,
        size: Math.abs(position.size),
        price: position.markPrice,
        timestamp: Date.now(),
        executionMs: 0,
        connectionId: -1,
        realizedPnl: position.unrealizedPnl,
        source: 'telegram'
      })

      const pauseUntil = Date.now() + 4 * 60 * 60 * 1000
      state.pausedSymbols.set(coin, pauseUntil)
      const resumeTime = new Date(pauseUntil)
      const timeStr = resumeTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

      await this.sendMessage(`✅ [${data.config.name}] Closed ${coin}\n⏸️ ${coin} trading paused until ${timeStr}`)

      setTimeout(() => {
        if (state.pausedSymbols.get(coin) === pauseUntil) {
          state.pausedSymbols.delete(coin)
          this.sendMessage(`▶️ [${data.config.name}] ${coin} trading auto-resumed after 4 hours`)
        }
      }, 4 * 60 * 60 * 1000)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      await this.sendMessage(`❌ [${data.config.name}] Failed to close ${coin}: ${msg}`)
    }
  }

  private async closeAllPositionsAndPause(accountId: string): Promise<void> {
    const data = this.accountSnapshots.get(accountId)
    const state = this.accountStates.get(accountId)
    if (!data?.snapshot || !this.hyperliquidService || !state) {
      await this.sendMessage('⚠️ No data or service available')
      return
    }

    const positions = data.snapshot.userPositions
    if (positions.length === 0) {
      await this.sendMessage(`⚠️ [${data.config.name}] No positions to close`)
      return
    }

    await this.sendMessage(`🔄 [${data.config.name}] Closing all ${positions.length} position(s)...`)

    const { userWallet } = data.config
    const vaultAddress = data.config.vaultAddress || undefined
    let closed = 0
    let failed = 0

    for (const position of positions) {
      try {
        await this.hyperliquidService.closePosition(position.coin, position.markPrice, userWallet, undefined, vaultAddress)
        data.loggerService.logTrade({
          coin: position.coin,
          action: 'close',
          side: position.side,
          size: Math.abs(position.size),
          price: position.markPrice,
          timestamp: Date.now(),
          executionMs: 0,
          connectionId: -1,
          realizedPnl: position.unrealizedPnl,
          source: 'telegram'
        })
        closed++
      } catch {
        failed++
      }
    }

    state.tradingPaused = true
    const resumeTime = new Date(Date.now() + 4 * 60 * 60 * 1000)
    const timeStr = resumeTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

    await this.sendMessage(`✅ [${data.config.name}] Closed ${closed}/${positions.length} positions${failed > 0 ? ` (${failed} failed)` : ''}\n⏸️ Trading paused until ${timeStr}`)

    setTimeout(() => {
      if (state.tradingPaused) {
        state.tradingPaused = false
        this.sendMessage(`▶️ [${data.config.name}] Trading auto-resumed after 4 hours`)
      }
    }, 4 * 60 * 60 * 1000)
  }

  private async pauseTradingFor4Hours(accountId: string): Promise<void> {
    const state = this.accountStates.get(accountId)
    const data = this.accountSnapshots.get(accountId)
    if (!state || !data) {
      await this.sendMessage('⚠️ Account not found')
      return
    }

    state.tradingPaused = true
    const resumeTime = new Date(Date.now() + 4 * 60 * 60 * 1000)
    const timeStr = resumeTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

    await this.sendMessage(`⏸️ [${data.config.name}] Trading paused for 4 hours\nWill auto-resume at ${timeStr}`)

    setTimeout(() => {
      if (state.tradingPaused) {
        state.tradingPaused = false
        this.sendMessage(`▶️ [${data.config.name}] Trading auto-resumed after 4 hours`)
      }
    }, 4 * 60 * 60 * 1000)
  }

  private async pauseSymbol(accountId: string, coin: string, hours: number): Promise<void> {
    const state = this.accountStates.get(accountId)
    const data = this.accountSnapshots.get(accountId)
    if (!state || !data) {
      await this.sendMessage('⚠️ Account not found')
      return
    }

    const pauseUntil = Date.now() + hours * 60 * 60 * 1000
    state.pausedSymbols.set(coin, pauseUntil)
    const resumeTime = new Date(pauseUntil)
    const timeStr = resumeTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

    await this.sendMessage(`⏸️ [${data.config.name}] ${coin} trading paused for ${hours} hours\nWill auto-resume at ${timeStr}`)

    setTimeout(() => {
      if (state.pausedSymbols.get(coin) === pauseUntil) {
        state.pausedSymbols.delete(coin)
        this.sendMessage(`▶️ [${data.config.name}] ${coin} trading auto-resumed after ${hours} hours`)
      }
    }, hours * 60 * 60 * 1000)

    await this.sendAccountMenu(accountId)
  }

  private async resumeSymbol(accountId: string, coin: string): Promise<void> {
    const state = this.accountStates.get(accountId)
    const data = this.accountSnapshots.get(accountId)
    if (!state || !data) {
      await this.sendMessage('⚠️ Account not found')
      return
    }

    state.pausedSymbols.delete(coin)
    state.drawdownPausedSymbols.delete(coin)
    await this.sendMessage(`▶️ [${data.config.name}] ${coin} trading resumed`)
    await this.sendAccountMenu(accountId)
  }

  private async pauseUntilDrawdown(accountId: string, coin: string): Promise<void> {
    const state = this.accountStates.get(accountId)
    const data = this.accountSnapshots.get(accountId)
    if (!state || !data) {
      await this.sendMessage('⚠️ Account not found')
      return
    }

    state.drawdownPausedSymbols.add(coin)
    await this.sendMessage(`⏸️ [${data.config.name}] ${coin} paused until tracked account shows >2% loss`)
    await this.sendAccountMenu(accountId)
  }

  private async closeAllPositions(accountId: string): Promise<void> {
    const data = this.accountSnapshots.get(accountId)
    if (!data?.snapshot || !this.hyperliquidService) {
      await this.sendMessage('⚠️ No data or service available')
      return
    }

    const positions = data.snapshot.userPositions
    if (positions.length === 0) {
      await this.sendMessage(`⚠️ [${data.config.name}] No positions to close`)
      return
    }

    await this.sendMessage(`🔄 [${data.config.name}] Closing all ${positions.length} position(s)...`)

    const { userWallet } = data.config
    const vaultAddress = data.config.vaultAddress || undefined
    let closed = 0
    let failed = 0

    for (const position of positions) {
      try {
        await this.hyperliquidService.closePosition(position.coin, position.markPrice, userWallet, undefined, vaultAddress)
        data.loggerService.logTrade({
          coin: position.coin,
          action: 'close',
          side: position.side,
          size: Math.abs(position.size),
          price: position.markPrice,
          timestamp: Date.now(),
          executionMs: 0,
          connectionId: -1,
          realizedPnl: position.unrealizedPnl,
          source: 'telegram'
        })
        closed++
      } catch {
        failed++
      }
    }

    await this.sendMessage(`✅ [${data.config.name}] Closed ${closed}/${positions.length} positions${failed > 0 ? ` (${failed} failed)` : ''}`)
  }

  private async pauseAllSymbols(accountId: string, hours: number): Promise<void> {
    const state = this.accountStates.get(accountId)
    const data = this.accountSnapshots.get(accountId)
    if (!state || !data?.snapshot) {
      await this.sendMessage('⚠️ Account not found')
      return
    }

    const pauseUntil = Date.now() + hours * 60 * 60 * 1000
    const coins: string[] = []

    for (const pos of data.snapshot.userPositions) {
      state.pausedSymbols.set(pos.coin, pauseUntil)
      coins.push(pos.coin)
    }

    if (coins.length === 0) {
      await this.sendMessage(`⚠️ [${data.config.name}] No positions to pause`)
      return
    }

    const resumeTime = new Date(pauseUntil)
    const timeStr = resumeTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

    await this.sendMessage(`⏸️ [${data.config.name}] Paused ${coins.length} symbol(s) for ${hours}h\nWill auto-resume at ${timeStr}`)

    setTimeout(() => {
      for (const coin of coins) {
        if (state.pausedSymbols.get(coin) === pauseUntil) {
          state.pausedSymbols.delete(coin)
        }
      }
      this.sendMessage(`▶️ [${data.config.name}] ${coins.length} symbol(s) auto-resumed after ${hours} hours`)
    }, hours * 60 * 60 * 1000)

    await this.sendAccountMenu(accountId)
  }

  private async setTakeProfitMode(accountId: string, enabled: boolean): Promise<void> {
    const state = this.accountStates.get(accountId)
    const data = this.accountSnapshots.get(accountId)
    if (!state || !data) {
      await this.sendMessage('⚠️ Account not found')
      return
    }

    state.takeProfitMode = enabled
    await this.sendMessage(enabled
      ? `💰 [${data.config.name}] Take profit mode *enabled*\nPositions will auto-close at +1% profit`
      : `💰 [${data.config.name}] Take profit mode *disabled*`)
    await this.sendAccountMenu(accountId)
  }

  updateSnapshot(accountId: string, snapshot: MonitorSnapshot): void {
    const data = this.accountSnapshots.get(accountId)
    if (data) {
      data.snapshot = snapshot
    }
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

  async sendDriftAlert(accountId: string, driftReport: DriftReport): Promise<void> {
    if (!this.enabled) return

    const now = Date.now()
    const lastAlert = this.lastDriftAlertTimes.get(accountId) || 0
    if (now - lastAlert < this.DRIFT_ALERT_COOLDOWN_MS) {
      return
    }
    this.lastDriftAlertTimes.set(accountId, now)

    const data = this.accountSnapshots.get(accountId)
    const name = data?.config.name || accountId

    let message = `⚠️ *[${name}] Drift Detected*\n\n`
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

  async sendMonitoringStarted(accountCount: number): Promise<void> {
    if (!this.enabled) return

    let message = '🚀 *Multi-Account Monitoring Started*\n\n'
    message += `Active accounts: ${accountCount}\n\n`

    for (const [accountId, data] of this.accountSnapshots) {
      message += `• *${data.config.name}*\n`
      message += `  Tracked: \`${this.formatAddress(data.config.trackedWallet)}\`\n`
      message += `  User: \`${this.formatAddress(data.config.userWallet)}\`\n\n`
    }

    message += 'Use /status to check positions'

    await this.sendMessage(message)
  }

  async sendError(error: string): Promise<void> {
    if (!this.enabled) return
    await this.sendMessage(`❌ *Error*\n\n${error}`)
  }

  async sendTotalPnlAlert(accountId: string, pnl: number, pnlPercent: number): Promise<void> {
    if (!this.enabled) return
    const data = this.accountSnapshots.get(accountId)
    const name = data?.config.name || accountId
    const vaultAddress = data?.config.vaultAddress || ''
    const sign = pnl >= 0 ? '+' : ''
    const tradeLink = vaultAddress ? `\n\n[View on Hyperformance](https://hyperformance.xyz/trade?${vaultAddress})` : ''
    await this.sendMessage(
      `⚠️ *[${name}] High Unrealized PnL*\n\n` +
      `Total PnL: ${sign}$${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}% of balance)` +
      tradeLink
    )
  }

  async sendLargePositionAlert(accountId: string, coin: string, sizePercent: number, notionalValue: number): Promise<void> {
    if (!this.enabled) return
    const data = this.accountSnapshots.get(accountId)
    const name = data?.config.name || accountId
    const vaultAddress = data?.config.vaultAddress || ''
    const tradeLink = vaultAddress ? `\n\n[View on Hyperformance](https://hyperformance.xyz/trade?${vaultAddress})` : ''
    await this.sendMessage(
      `⚠️ *[${name}] Large Position Size*\n\n` +
      `${coin} position is ${sizePercent.toFixed(1)}% of account value\n` +
      `Size: $${notionalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}` +
      tradeLink
    )
  }

  async sendPositionPnlAlert(accountId: string, coin: string, pnl: number, pnlPercent: number): Promise<void> {
    if (!this.enabled) return
    const data = this.accountSnapshots.get(accountId)
    const name = data?.config.name || accountId
    const vaultAddress = data?.config.vaultAddress || ''
    const sign = pnl >= 0 ? '+' : ''
    const tradeLink = vaultAddress ? `\n\n[View on Hyperformance](https://hyperformance.xyz/trade?${vaultAddress})` : ''
    await this.sendMessage(
      `⚠️ *[${name}] High Position PnL*\n\n` +
      `${coin} position PnL: ${sign}$${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}% of balance)` +
      tradeLink
    )
  }

  async sendNoFillsAlert(accountId: string, minutesSinceLastFill: number, lastFillTime: number): Promise<void> {
    if (!this.enabled) return
    const data = this.accountSnapshots.get(accountId)
    const name = data?.config.name || accountId
    const lastFillDate = new Date(lastFillTime)
    const timeStr = lastFillDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    await this.sendMessage(
      `⚠️ *[${name}] No Recent Fills*\n\n` +
      `No fills received for ${minutesSinceLastFill} minutes\n` +
      `Last fill: ${timeStr}`
    )
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
