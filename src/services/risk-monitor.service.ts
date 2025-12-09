import { TelegramService } from './telegram.service'
import { MonitorSnapshot } from './balance-monitor.service'

interface RiskAlertState {
  lastTotalPnlAlert: number
  lastLargePositionAlerts: Map<string, number>
  lastPositionPnlAlerts: Map<string, number>
  lastNoFillsAlert: number
  lastFillTime: number
}

export class RiskMonitorService {
  private state: RiskAlertState = {
    lastTotalPnlAlert: 0,
    lastLargePositionAlerts: new Map(),
    lastPositionPnlAlerts: new Map(),
    lastNoFillsAlert: 0,
    lastFillTime: Date.now()
  }

  private readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000
  private readonly NO_FILLS_THRESHOLD_MS = 30 * 60 * 1000

  private readonly TOTAL_PNL_THRESHOLD = 0.05
  private readonly LARGE_POSITION_THRESHOLD = 0.75
  private readonly POSITION_PNL_THRESHOLD = 0.03

  constructor(
    private accountId: string,
    private telegramService: TelegramService
  ) {}

  recordFill(): void {
    this.state.lastFillTime = Date.now()
  }

  async checkRisks(snapshot: MonitorSnapshot): Promise<void> {
    const now = Date.now()
    const userValue = parseFloat(snapshot.userBalance.accountValue)

    await this.checkTotalPnl(snapshot, userValue, now)
    await this.checkLargePositions(snapshot, userValue, now)
    await this.checkPositionPnl(snapshot, userValue, now)
    await this.checkNoFills(snapshot, now)
  }

  private async checkTotalPnl(snapshot: MonitorSnapshot, userValue: number, now: number): Promise<void> {
    const totalPnl = snapshot.userPositions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0)
    const pnlPercent = Math.abs(totalPnl) / userValue

    if (pnlPercent > this.TOTAL_PNL_THRESHOLD) {
      if (now - this.state.lastTotalPnlAlert > this.ALERT_COOLDOWN_MS) {
        this.state.lastTotalPnlAlert = now
        await this.telegramService.sendTotalPnlAlert(this.accountId, totalPnl, pnlPercent * 100)
      }
    }
  }

  private async checkLargePositions(snapshot: MonitorSnapshot, userValue: number, now: number): Promise<void> {
    for (const pos of snapshot.userPositions) {
      const sizePercent = pos.notionalValue / userValue

      if (sizePercent > this.LARGE_POSITION_THRESHOLD) {
        const lastAlert = this.state.lastLargePositionAlerts.get(pos.coin) || 0
        if (now - lastAlert > this.ALERT_COOLDOWN_MS) {
          this.state.lastLargePositionAlerts.set(pos.coin, now)
          await this.telegramService.sendLargePositionAlert(this.accountId, pos.coin, sizePercent * 100, pos.notionalValue)
        }
      }
    }
  }

  private async checkPositionPnl(snapshot: MonitorSnapshot, userValue: number, now: number): Promise<void> {
    for (const pos of snapshot.userPositions) {
      const pnlPercent = Math.abs(pos.unrealizedPnl) / userValue

      if (pnlPercent > this.POSITION_PNL_THRESHOLD) {
        const lastAlert = this.state.lastPositionPnlAlerts.get(pos.coin) || 0
        if (now - lastAlert > this.ALERT_COOLDOWN_MS) {
          this.state.lastPositionPnlAlerts.set(pos.coin, now)
          await this.telegramService.sendPositionPnlAlert(this.accountId, pos.coin, pos.unrealizedPnl, pnlPercent * 100)
        }
      }
    }
  }

  private async checkNoFills(snapshot: MonitorSnapshot, now: number): Promise<void> {
    if (snapshot.trackedPositions.length === 0) {
      return
    }

    const timeSinceLastFill = now - this.state.lastFillTime

    if (timeSinceLastFill > this.NO_FILLS_THRESHOLD_MS) {
      const minutesSinceLastFill = Math.floor(timeSinceLastFill / 60000)

      if (now - this.state.lastNoFillsAlert > this.ALERT_COOLDOWN_MS) {
        this.state.lastNoFillsAlert = now
        await this.telegramService.sendNoFillsAlert(this.accountId, minutesSinceLastFill, this.state.lastFillTime)
      }

      console.log(`\n🔄 [${this.accountId}] No fills for ${minutesSinceLastFill} minutes, restarting...`)
      process.exit(1)
    }
  }
}
