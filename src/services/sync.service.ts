import { DriftReport, PositionDrift, SubAccountConfig, SubAccountState } from '@/models'
import { HyperliquidService } from './hyperliquid.service'
import { TelegramService } from './telegram.service'
import { LoggerService } from './logger.service'

export class SyncService {
  private userBalance: number = 0
  private readonly MIN_BALANCE_TO_TRADE = 10

  constructor(
    private accountId: string,
    private accountConfig: SubAccountConfig,
    private accountState: SubAccountState,
    private hyperliquidService: HyperliquidService,
    private telegramService: TelegramService,
    private loggerService: LoggerService,
    private minOrderValue: number
  ) {}

  setUserBalance(balance: number): void {
    this.userBalance = balance
  }

  async syncFavorable(driftReport: DriftReport, trackedBalance: number): Promise<void> {
    if (this.accountState.tradingPaused) {
      console.log(`   [${this.accountId}] ⏸️ Trading paused, skipping sync`)
      return
    }

    if (this.userBalance < this.MIN_BALANCE_TO_TRADE) {
      console.log(`   [${this.accountId}] 💰 Balance $${this.userBalance.toFixed(2)} < $${this.MIN_BALANCE_TO_TRADE}, skipping sync`)
      return
    }

    const now = Date.now()
    const favorableDrifts = driftReport.drifts.filter(d => {
      if (!d.isFavorable) return false

      if (this.accountState.drawdownPausedSymbols.has(d.coin)) {
        console.log(`   [${this.accountId}] ⏸️ ${d.coin} waiting for drawdown, skipping sync`)
        return false
      }

      const pausedUntil = this.accountState.pausedSymbols.get(d.coin)
      if (pausedUntil && now < pausedUntil) {
        console.log(`   [${this.accountId}] ⏸️ ${d.coin} paused, skipping sync`)
        return false
      }
      if (pausedUntil) this.accountState.pausedSymbols.delete(d.coin)

      const entryDriftTypes = ['missing', 'side_mismatch']
      const isEntryDrift = entryDriftTypes.includes(d.driftType) ||
        (d.driftType === 'size_mismatch' && d.userPosition && d.trackedPosition &&
         d.userPosition.size < d.scaledTargetSize)

      if (this.accountState.hrefThreshold > 0 && isEntryDrift && d.trackedPosition) {
        const pnlPercent = (d.trackedPosition.unrealizedPnl / trackedBalance) * 100
        if (pnlPercent >= -this.accountState.hrefThreshold) {
          console.log(`   [${this.accountId}] ⏸️ ${d.coin} waiting for drawdown, skipping sync`)
          return false
        }
        console.log(`   [${this.accountId}] 🔗 HREF ${this.accountState.hrefThreshold}% threshold met for ${d.coin}, allowing sync`)
      }

      return true
    })

    if (favorableDrifts.length === 0) {
      console.log(`   [${this.accountId}] No favorable sync opportunities`)
      return
    }

    console.log(`\n[${this.accountId}] 🔄 Syncing ${favorableDrifts.length} favorable drift(s)...`)

    for (const drift of favorableDrifts) {
      try {
        await this.executeSyncTrade(drift)
      } catch (error) {
        console.error(`   [${this.accountId}] ✗ Failed to sync ${drift.coin}:`, error instanceof Error ? error.message : error)
      }
    }
  }

  private async executeSyncTrade(drift: PositionDrift): Promise<void> {
    const startTime = Date.now()
    const { userWallet } = this.accountConfig
    const vaultAddress = this.accountConfig.vaultAddress || undefined

    if (drift.driftType === 'missing' && drift.trackedPosition) {
      const { coin, side, markPrice } = drift.trackedPosition
      const size = drift.scaledTargetSize

      console.log(`   [${this.accountId}] 📈 Opening ${side.toUpperCase()} ${coin}: ${size.toFixed(4)} @ $${markPrice.toFixed(2)}`)

      if (side === 'long') {
        await this.hyperliquidService.openLong(coin, size, markPrice, vaultAddress, this.minOrderValue)
      } else {
        await this.hyperliquidService.openShort(coin, size, markPrice, vaultAddress, this.minOrderValue)
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

      console.log(`   [${this.accountId}] ✓ Synced ${coin}`)
    } else if (drift.driftType === 'extra' && drift.userPosition) {
      const { coin, markPrice } = drift.userPosition

      console.log(`   [${this.accountId}] 📉 Closing orphan ${coin} @ $${markPrice.toFixed(2)}`)
      await this.hyperliquidService.closePosition(coin, markPrice, userWallet, undefined, vaultAddress, this.minOrderValue)

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

      console.log(`   [${this.accountId}] ✓ Closed orphan ${coin}`)
    } else if (drift.driftType === 'size_mismatch' && drift.trackedPosition && drift.userPosition) {
      const { coin, side, markPrice } = drift.trackedPosition
      const currentSize = drift.userPosition.size
      const targetSize = drift.scaledTargetSize
      const sizeDiff = Math.abs(targetSize - currentSize)

      if (currentSize < targetSize) {
        console.log(`   [${this.accountId}] 📈 Adding to ${side.toUpperCase()} ${coin}: +${sizeDiff.toFixed(4)} @ $${markPrice.toFixed(2)}`)
        await this.hyperliquidService.addToPosition(coin, sizeDiff, markPrice, side, vaultAddress, this.minOrderValue)

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
        console.log(`   [${this.accountId}] 📉 Reducing ${side.toUpperCase()} ${coin}: -${sizeDiff.toFixed(4)} @ $${markPrice.toFixed(2)}`)
        await this.hyperliquidService.reducePosition(coin, sizeDiff, markPrice, userWallet, vaultAddress, this.minOrderValue)

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

      console.log(`   [${this.accountId}] ✓ Size adjusted ${coin}`)
    } else if (drift.driftType === 'side_mismatch' && drift.trackedPosition && drift.userPosition) {
      const { coin, side, markPrice } = drift.trackedPosition
      const targetSize = drift.scaledTargetSize

      console.log(`   [${this.accountId}] 🔄 Reversing ${coin} from ${drift.userPosition.side.toUpperCase()} to ${side.toUpperCase()}: ${targetSize.toFixed(4)} @ $${markPrice.toFixed(2)}`)

      await this.hyperliquidService.closePosition(coin, markPrice, userWallet, undefined, vaultAddress, this.minOrderValue)

      if (side === 'long') {
        await this.hyperliquidService.openLong(coin, targetSize, markPrice, vaultAddress, this.minOrderValue)
      } else {
        await this.hyperliquidService.openShort(coin, targetSize, markPrice, vaultAddress, this.minOrderValue)
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

      console.log(`   [${this.accountId}] ✓ Reversed ${coin} to ${side.toUpperCase()}`)
    }
  }
}
