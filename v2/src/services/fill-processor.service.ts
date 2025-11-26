import { UserFillData, TradeAction } from '@/models'
import { HyperliquidService } from './hyperliquid.service'
import { LoggerService } from './logger.service'
import { TelegramService } from './telegram.service'
import { scaleSize, formatScaledSize } from '@/utils/scaling.utils'
import { config } from '@/config'

export class FillProcessorService {
  private balanceRatio: number = 1

  constructor(
    private hyperliquidService: HyperliquidService,
    private loggerService: LoggerService,
    private telegramService: TelegramService
  ) {}

  setBalanceRatio(ratio: number): void {
    this.balanceRatio = ratio
  }

  getBalanceRatio(): number {
    return this.balanceRatio
  }

  async processFill(fill: UserFillData, connectionId: number): Promise<void> {
    const action = this.determineAction(fill)
    if (!action) return

    console.log(`\n📊 [Connection ${connectionId}] ${fill.coin} - ${action.action.toUpperCase()}`)
    console.log(`   ${action.reason}`)

    if (!this.hyperliquidService.canExecuteTrades()) {
      console.log('   ⚠️ Trading disabled, skipping execution')
      return
    }

    if (this.telegramService.isTradingPaused()) {
      console.log('   ⏸️ Trading paused via Telegram, skipping execution')
      return
    }

    if (this.telegramService.isHrefModeEnabled()) {
      console.log('   🔗 HREF mode active, skipping websocket fill')
      return
    }

    const startTime = Date.now()

    try {
      await this.executeAction(action, fill)
      const executionMs = Date.now() - startTime
      console.log(`   ✓ Executed in ${executionMs}ms`)

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
      console.error(`   ✗ Execution failed: ${errorMsg}`)
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

    const orderValue = scaledTradeSize * price
    if (orderValue < config.minOrderValue) {
      console.log(`   ⚠️ Order value $${orderValue.toFixed(2)} below min $${config.minOrderValue}, skipping`)
      return null
    }

    if (prevPosition === 0 && finalPosition !== 0) {
      return {
        action: 'open',
        coin: fill.coin,
        side: newSide,
        size: scaledFinalSize,
        reason: `Open ${newSide.toUpperCase()} @ $${price.toFixed(2)}`
      }
    }

    if (prevPosition !== 0 && finalPosition === 0) {
      return {
        action: 'close',
        coin: fill.coin,
        side: prevSide,
        size: scaledTradeSize,
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
        size: scaledTradeSize,
        reason: `Add to ${newSide.toUpperCase()} @ $${price.toFixed(2)}`
      }
    }

    if (Math.abs(finalPosition) < Math.abs(prevPosition)) {
      return {
        action: 'reduce',
        coin: fill.coin,
        side: prevSide,
        size: scaledTradeSize,
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

    switch (action.action) {
      case 'open':
        if (action.side === 'long') {
          await this.hyperliquidService.openLong(action.coin, action.size, price)
        } else {
          await this.hyperliquidService.openShort(action.coin, action.size, price)
        }
        break

      case 'close':
        await this.hyperliquidService.closePosition(action.coin, price)
        break

      case 'reverse':
        await this.hyperliquidService.closePosition(action.coin, price)
        if (action.side === 'long') {
          await this.hyperliquidService.openLong(action.coin, action.size, price)
        } else {
          await this.hyperliquidService.openShort(action.coin, action.size, price)
        }
        break

      case 'add':
        await this.hyperliquidService.addToPosition(action.coin, action.size, price, action.side)
        break

      case 'reduce':
        await this.hyperliquidService.reducePosition(action.coin, action.size, price)
        break
    }
  }
}
