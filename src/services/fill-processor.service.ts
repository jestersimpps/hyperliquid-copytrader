import { UserFillData, TradeAction, SubAccountConfig, SubAccountState } from '@/models'
import { HyperliquidService } from './hyperliquid.service'
import { LoggerService } from './logger.service'
import { TelegramService } from './telegram.service'
import { scaleSize, formatScaledSize } from '@/utils/scaling.utils'

export class FillProcessorService {
  private balanceRatio: number = 1

  constructor(
    private accountId: string,
    private accountConfig: SubAccountConfig,
    private accountState: SubAccountState,
    private hyperliquidService: HyperliquidService,
    private loggerService: LoggerService,
    private telegramService: TelegramService,
    private minOrderValue: number
  ) {}

  getAccountId(): string {
    return this.accountId
  }

  setBalanceRatio(ratio: number): void {
    this.balanceRatio = ratio
  }

  getBalanceRatio(): number {
    return this.balanceRatio
  }

  async processFill(fill: UserFillData, connectionId: number): Promise<void> {
    const closedPnl = parseFloat(fill.closedPnl || '0')
    this.loggerService.logTrackedFill({
      coin: fill.coin,
      side: fill.side,
      size: parseFloat(fill.sz || '0'),
      price: parseFloat(fill.px),
      timestamp: fill.time,
      closedPnl,
      fee: parseFloat(fill.fee || '0')
    })

    const action = this.determineAction(fill)
    if (!action) return

    console.log(`\n📊 [${this.accountId}][Conn ${connectionId}] ${fill.coin} - ${action.action.toUpperCase()}`)
    console.log(`   ${action.reason}`)

    if (!this.hyperliquidService.canExecuteTrades()) {
      console.log(`   [${this.accountId}] ⚠️ Trading disabled, skipping execution`)
      return
    }

    if (this.accountState.tradingPaused) {
      console.log(`   [${this.accountId}] ⏸️ Trading paused, skipping execution`)
      return
    }

    const pausedUntil = this.accountState.pausedSymbols.get(fill.coin)
    if (pausedUntil && Date.now() < pausedUntil) {
      const remaining = Math.ceil((pausedUntil - Date.now()) / 60000)
      console.log(`   [${this.accountId}] ⏸️ ${fill.coin} paused for ${remaining} more minutes, skipping`)
      return
    } else if (pausedUntil) {
      this.accountState.pausedSymbols.delete(fill.coin)
    }

    if (this.accountState.hrefModeEnabled) {
      const entryActions: TradeAction[] = ['open', 'add', 'reverse']
      if (entryActions.includes(action.action)) {
        console.log(`   [${this.accountId}] 🔗 HREF mode active, skipping entry`)
        return
      }
    }

    const startTime = Date.now()

    try {
      await this.executeAction(action, fill)
      const executionMs = Date.now() - startTime
      console.log(`   [${this.accountId}] ✓ Executed in ${executionMs}ms`)

      const trackedPnl = parseFloat(fill.closedPnl || '0')
      const userEstimatedPnl = trackedPnl * this.balanceRatio

      this.loggerService.logTrade({
        coin: fill.coin,
        action: action.action,
        side: action.side,
        size: action.size,
        price: parseFloat(fill.px),
        timestamp: Date.now(),
        executionMs,
        connectionId,
        realizedPnl: userEstimatedPnl,
        fee: fill.fee,
        orderId: fill.oid
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`   [${this.accountId}] ✗ Execution failed: ${errorMsg}`)
    }
  }

  private determineAction(fill: UserFillData): { action: TradeAction; coin: string; side: 'long' | 'short'; size: number; reason: string } | null {
    const prevPosition = parseFloat(fill.startPosition || '0')
    const tradeSize = parseFloat(fill.sz || '0')
    const isBuy = fill.side === 'B'
    const price = parseFloat(fill.px)

    const finalPosition = isBuy ? prevPosition + tradeSize : prevPosition - tradeSize
    const newSide: 'long' | 'short' = finalPosition > 0 ? 'long' : 'short'
    const prevSide: 'long' | 'short' = prevPosition > 0 ? 'long' : 'short'

    const scaledTradeSize = formatScaledSize(scaleSize(tradeSize, this.balanceRatio))
    const scaledFinalSize = formatScaledSize(scaleSize(Math.abs(finalPosition), this.balanceRatio))

    const isClose = prevPosition !== 0 && finalPosition === 0
    const isReduce = Math.abs(finalPosition) < Math.abs(prevPosition) && finalPosition !== 0
    const isOpen = prevPosition === 0 && finalPosition !== 0

    const baseSize = isOpen ? scaledFinalSize : scaledTradeSize
    const orderValue = baseSize * price
    const elevatedSize = orderValue < this.minOrderValue
      ? formatScaledSize(this.minOrderValue / price)
      : baseSize

    if (orderValue < this.minOrderValue) {
      console.log(`   [${this.accountId}] ⬆️ Elevating order from $${orderValue.toFixed(2)} to $${this.minOrderValue} (size: ${baseSize} → ${elevatedSize})`)
    }

    if (isOpen) {
      return {
        action: 'open',
        coin: fill.coin,
        side: newSide,
        size: elevatedSize,
        reason: `Open ${newSide.toUpperCase()} @ $${price.toFixed(2)}`
      }
    }

    if (isClose) {
      return {
        action: 'close',
        coin: fill.coin,
        side: prevSide,
        size: elevatedSize,
        reason: `Close ${prevSide.toUpperCase()} @ $${price.toFixed(2)}`
      }
    }

    if (prevPosition !== 0 && finalPosition !== 0 && Math.sign(prevPosition) !== Math.sign(finalPosition)) {
      return {
        action: 'reverse',
        coin: fill.coin,
        side: newSide,
        size: scaledFinalSize,
        reason: `Reverse to ${newSide.toUpperCase()} @ $${price.toFixed(2)}`
      }
    }

    if (Math.abs(finalPosition) > Math.abs(prevPosition)) {
      return {
        action: 'add',
        coin: fill.coin,
        side: newSide,
        size: elevatedSize,
        reason: `Add to ${newSide.toUpperCase()} @ $${price.toFixed(2)}`
      }
    }

    if (isReduce) {
      return {
        action: 'reduce',
        coin: fill.coin,
        side: prevSide,
        size: elevatedSize,
        reason: `Reduce ${prevSide.toUpperCase()} @ $${price.toFixed(2)}`
      }
    }

    return null
  }

  private async executeAction(
    action: { action: TradeAction; coin: string; side: 'long' | 'short'; size: number },
    fill: UserFillData
  ): Promise<void> {
    const price = parseFloat(fill.px)
    const { userWallet } = this.accountConfig
    const vaultAddress = this.accountConfig.vaultAddress || undefined

    switch (action.action) {
      case 'open':
        if (action.side === 'long') {
          await this.hyperliquidService.openLong(action.coin, action.size, price, vaultAddress, this.minOrderValue)
        } else {
          await this.hyperliquidService.openShort(action.coin, action.size, price, vaultAddress, this.minOrderValue)
        }
        break

      case 'close':
        await this.hyperliquidService.closePosition(action.coin, price, userWallet, undefined, vaultAddress, this.minOrderValue)
        break

      case 'reverse':
        await this.hyperliquidService.closePosition(action.coin, price, userWallet, undefined, vaultAddress, this.minOrderValue)
        if (action.side === 'long') {
          await this.hyperliquidService.openLong(action.coin, action.size, price, vaultAddress, this.minOrderValue)
        } else {
          await this.hyperliquidService.openShort(action.coin, action.size, price, vaultAddress, this.minOrderValue)
        }
        break

      case 'add':
        await this.hyperliquidService.addToPosition(action.coin, action.size, price, action.side, vaultAddress, this.minOrderValue)
        break

      case 'reduce':
        await this.hyperliquidService.reducePosition(action.coin, action.size, price, userWallet, vaultAddress, this.minOrderValue)
        break
    }
  }
}
