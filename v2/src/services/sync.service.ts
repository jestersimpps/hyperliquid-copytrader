import { DriftReport, PositionDrift } from '@/models'
import { HyperliquidService } from './hyperliquid.service'
import { WebSocketPoolService } from './websocket-pool.service'
import { TelegramService } from './telegram.service'
import { LoggerService } from './logger.service'

export class SyncService {
  constructor(
    private hyperliquidService: HyperliquidService,
    private webSocketPool: WebSocketPoolService,
    private telegramService: TelegramService,
    private loggerService: LoggerService
  ) {}

  async syncFavorable(driftReport: DriftReport): Promise<void> {
    const favorableDrifts = driftReport.drifts.filter(d => d.isFavorable)

    if (favorableDrifts.length === 0) {
      console.log('   No favorable sync opportunities')
      return
    }

    console.log(`\n🔄 Syncing ${favorableDrifts.length} favorable drift(s)...`)

    for (const drift of favorableDrifts) {
      try {
        await this.executeSyncTrade(drift)
      } catch (error) {
        console.error(`   ✗ Failed to sync ${drift.coin}:`, error instanceof Error ? error.message : error)
      }
    }
  }

  private async executeSyncTrade(drift: PositionDrift): Promise<void> {
    const startTime = Date.now()

    if (drift.driftType === 'missing' && drift.trackedPosition) {
      const { coin, side, markPrice } = drift.trackedPosition
      const size = drift.scaledTargetSize

      console.log(`   📈 Opening ${side.toUpperCase()} ${coin}: ${size.toFixed(4)} @ $${markPrice.toFixed(2)}`)

      if (side === 'long') {
        await this.hyperliquidService.openLong(coin, size, markPrice)
      } else {
        await this.hyperliquidService.openShort(coin, size, markPrice)
      }

      this.loggerService.logTrade({
        coin,
        action: 'open',
        side,
        size,
        price: markPrice,
        timestamp: Date.now(),
        executionMs: Date.now() - startTime,
        connectionId: 0,
        syncReason: 'missing_position'
      })

      console.log(`   ✓ Synced ${coin}`)
    } else if (drift.driftType === 'extra' && drift.userPosition) {
      const { coin, markPrice } = drift.userPosition

      console.log(`   📉 Closing orphan ${coin} @ $${markPrice.toFixed(2)}`)
      await this.hyperliquidService.closePosition(coin, markPrice)

      this.loggerService.logTrade({
        coin,
        action: 'close',
        side: drift.userPosition.side,
        size: drift.userPosition.size,
        price: markPrice,
        timestamp: Date.now(),
        executionMs: Date.now() - startTime,
        connectionId: 0,
        syncReason: 'orphan_position'
      })

      console.log(`   ✓ Closed orphan ${coin}`)
    } else if (drift.driftType === 'size_mismatch' && drift.trackedPosition && drift.userPosition) {
      const { coin, side, markPrice } = drift.trackedPosition
      const currentSize = drift.userPosition.size
      const targetSize = drift.scaledTargetSize
      const sizeDiff = Math.abs(targetSize - currentSize)

      if (currentSize < targetSize) {
        console.log(`   📈 Adding to ${side.toUpperCase()} ${coin}: +${sizeDiff.toFixed(4)} @ $${markPrice.toFixed(2)}`)
        await this.hyperliquidService.addToPosition(coin, sizeDiff, markPrice, side)

        this.loggerService.logTrade({
          coin,
          action: 'add',
          side,
          size: sizeDiff,
          price: markPrice,
          timestamp: Date.now(),
          executionMs: Date.now() - startTime,
          connectionId: 0,
          syncReason: 'size_under'
        })
      } else {
        console.log(`   📉 Reducing ${side.toUpperCase()} ${coin}: -${sizeDiff.toFixed(4)} @ $${markPrice.toFixed(2)}`)
        await this.hyperliquidService.reducePosition(coin, sizeDiff, markPrice)

        this.loggerService.logTrade({
          coin,
          action: 'reduce',
          side,
          size: sizeDiff,
          price: markPrice,
          timestamp: Date.now(),
          executionMs: Date.now() - startTime,
          connectionId: 0,
          syncReason: 'size_over'
        })
      }

      console.log(`   ✓ Size adjusted ${coin}`)
    } else if (drift.driftType === 'side_mismatch' && drift.trackedPosition && drift.userPosition) {
      const { coin, side, markPrice } = drift.trackedPosition
      const targetSize = drift.scaledTargetSize

      console.log(`   🔄 Reversing ${coin} from ${drift.userPosition.side.toUpperCase()} to ${side.toUpperCase()}: ${targetSize.toFixed(4)} @ $${markPrice.toFixed(2)}`)

      await this.hyperliquidService.closePosition(coin, markPrice)

      if (side === 'long') {
        await this.hyperliquidService.openLong(coin, targetSize, markPrice)
      } else {
        await this.hyperliquidService.openShort(coin, targetSize, markPrice)
      }

      this.loggerService.logTrade({
        coin,
        action: 'reverse',
        side,
        size: targetSize,
        price: markPrice,
        timestamp: Date.now(),
        executionMs: Date.now() - startTime,
        connectionId: 0,
        syncReason: 'side_mismatch'
      })

      console.log(`   ✓ Reversed ${coin} to ${side.toUpperCase()}`)
    }
  }
}
