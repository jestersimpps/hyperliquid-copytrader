import { Position, Balance, SubAccountConfig } from '@/models'
import { HyperliquidService } from './hyperliquid.service'
import { DriftDetectorService } from './drift-detector.service'
import { SyncService } from './sync.service'
import { TelegramService } from './telegram.service'
import { LoggerService } from './logger.service'
import { FillProcessorService } from './fill-processor.service'
import { RiskMonitorService } from './risk-monitor.service'
import { calculateBalanceRatio } from '@/utils/scaling.utils'

export interface MonitorSnapshot {
  trackedBalance: Balance
  trackedPositions: Position[]
  userBalance: Balance
  userPositions: Position[]
  balanceRatio: number
  timestamp: number
}

export class BalanceMonitorService {
  private interval: NodeJS.Timeout | null = null
  private readonly POLL_INTERVAL_MS = 60000

  constructor(
    private accountId: string,
    private accountConfig: SubAccountConfig,
    private hyperliquidService: HyperliquidService,
    private driftDetector: DriftDetectorService,
    private syncService: SyncService,
    private telegramService: TelegramService,
    private loggerService: LoggerService,
    private fillProcessor: FillProcessorService,
    private riskMonitor: RiskMonitorService
  ) {}

  getAccountId(): string {
    return this.accountId
  }

  start(): void {
    console.log(`[${this.accountId}] 📊 Starting balance monitor (60s interval)...`)
    this.poll()
    this.interval = setInterval(() => this.poll(), this.POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async poll(): Promise<void> {
    try {
      const { trackedWallet, userWallet, vaultAddress } = this.accountConfig
      const userPositionWallet = vaultAddress || userWallet

      const [trackedBalance, trackedPositions, userBalance, userPositions] = await Promise.all([
        this.hyperliquidService.getAccountBalance(trackedWallet),
        this.hyperliquidService.getOpenPositions(trackedWallet),
        this.hyperliquidService.getAccountBalance(userPositionWallet),
        this.hyperliquidService.getOpenPositions(userPositionWallet)
      ])

      const trackedValue = parseFloat(trackedBalance.accountValue)
      const userValue = parseFloat(userBalance.accountValue)
      const balanceRatio = calculateBalanceRatio(userValue, trackedValue)

      this.fillProcessor.setBalanceRatio(balanceRatio)
      this.fillProcessor.setLatestSnapshot(trackedPositions, trackedValue)

      const state = this.telegramService.getAccountState(this.accountId)
      if (state) {
        this.fillProcessor.setPositionSizeMultiplier(state.positionSizeMultiplier)
      }

      const snapshot: MonitorSnapshot = {
        trackedBalance,
        trackedPositions,
        userBalance,
        userPositions,
        balanceRatio,
        timestamp: Date.now()
      }

      this.loggerService.logSnapshot(snapshot)
      this.telegramService.updateSnapshot(this.accountId, snapshot)
      await this.riskMonitor.checkRisks(snapshot)

      await this.checkTakeProfitMode(userPositions, userValue)

      console.log(`\n[${this.accountId}] 📊 Balance | Tracked: $${trackedValue.toFixed(2)} (${trackedPositions.length} pos) | User: $${userValue.toFixed(2)} (${userPositions.length} pos) | Ratio: ${balanceRatio.toFixed(4)}`)

      const driftReport = this.driftDetector.detect(trackedPositions, userPositions, trackedValue, userValue)

      if (driftReport.hasDrift) {
        console.log(`\n[${this.accountId}] ⚠️  Drift detected: ${driftReport.drifts.length} position(s)`)

        for (const drift of driftReport.drifts) {
          const favorableStr = drift.isFavorable ? '✓ favorable' : '✗ unfavorable'
          console.log(`   - ${drift.coin}: ${drift.driftType} (${favorableStr}, ${drift.sizeDiffPercent.toFixed(1)}% diff)`)
        }

        await this.telegramService.sendDriftAlert(this.accountId, driftReport)
        await this.syncService.syncFavorable(driftReport, trackedValue)
      }
    } catch (error) {
      console.error(`[${this.accountId}] ❌ Balance monitor error:`, error instanceof Error ? error.message : error)
    }
  }

  async getSnapshot(): Promise<MonitorSnapshot | null> {
    try {
      const { trackedWallet, userWallet, vaultAddress } = this.accountConfig
      const userPositionWallet = vaultAddress || userWallet

      const [trackedBalance, trackedPositions, userBalance, userPositions] = await Promise.all([
        this.hyperliquidService.getAccountBalance(trackedWallet),
        this.hyperliquidService.getOpenPositions(trackedWallet),
        this.hyperliquidService.getAccountBalance(userPositionWallet),
        this.hyperliquidService.getOpenPositions(userPositionWallet)
      ])

      const trackedValue = parseFloat(trackedBalance.accountValue)
      const userValue = parseFloat(userBalance.accountValue)
      const balanceRatio = calculateBalanceRatio(userValue, trackedValue)

      return {
        trackedBalance,
        trackedPositions,
        userBalance,
        userPositions,
        balanceRatio,
        timestamp: Date.now()
      }
    } catch (error) {
      console.error(`[${this.accountId}] Failed to get snapshot:`, error instanceof Error ? error.message : error)
      return null
    }
  }

  private async checkTakeProfitMode(userPositions: Position[], userBalance: number): Promise<void> {
    const state = this.telegramService.getAccountState(this.accountId)
    if (!state?.takeProfitMode) return

    const { userWallet, vaultAddress } = this.accountConfig

    for (const pos of userPositions) {
      const profitPercent = (pos.unrealizedPnl / userBalance) * 100

      if (profitPercent > 1) {
        console.log(`[${this.accountId}] 💰 Take profit: ${pos.coin} at +${profitPercent.toFixed(2)}%`)

        try {
          await this.hyperliquidService.closePosition(
            pos.coin,
            pos.markPrice,
            userWallet,
            undefined,
            vaultAddress || undefined
          )

          this.loggerService.logTrade({
            coin: pos.coin,
            action: 'close',
            side: pos.side,
            size: Math.abs(pos.size),
            price: pos.markPrice,
            timestamp: Date.now(),
            executionMs: 0,
            connectionId: -1,
            realizedPnl: pos.unrealizedPnl,
            source: 'take-profit'
          })

          await this.telegramService.sendMessage(
            `💰 [${state.name}] Take profit: Closed ${pos.coin} at +${profitPercent.toFixed(1)}% (+$${pos.unrealizedPnl.toFixed(2)})`
          )
        } catch (error) {
          console.error(`[${this.accountId}] Take profit failed for ${pos.coin}:`, error instanceof Error ? error.message : error)
        }
      }
    }
  }
}
