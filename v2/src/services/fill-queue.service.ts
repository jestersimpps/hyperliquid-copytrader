import { UserFillData, FillProcessor } from '@/models'
import { RiskMonitorService } from './risk-monitor.service'
import { WebSocketPoolService } from './websocket-pool.service'

export class FillQueueService {
  private processedTids: Set<string> = new Set()
  private fillProcessor: FillProcessor | null = null
  private riskMonitor: RiskMonitorService | null = null
  private webSocketPool: WebSocketPoolService | null = null
  private readonly MAX_PROCESSED_TIDS = 1000

  setFillProcessor(processor: FillProcessor): void {
    this.fillProcessor = processor
  }

  setRiskMonitor(riskMonitor: RiskMonitorService): void {
    this.riskMonitor = riskMonitor
  }

  setWebSocketPool(pool: WebSocketPoolService): void {
    this.webSocketPool = pool
  }

  enqueueFill(fill: UserFillData, connectionId: number): void {
    const tidString = String(fill.tid)

    this.webSocketPool?.trackFillReception(tidString, connectionId)

    if (this.processedTids.has(tidString)) {
      console.log(`  ⊘ Duplicate fill dropped (TID: ${fill.tid}, Connection: ${connectionId})`)
      return
    }

    this.processedTids.add(tidString)
    this.trimProcessedTids()
    this.riskMonitor?.recordFill()

    if (this.fillProcessor) {
      this.fillProcessor(fill, connectionId).catch(error => {
        console.error(`✗ Error processing fill: ${error instanceof Error ? error.message : error}`)
      })
    }
  }

  private trimProcessedTids(): void {
    if (this.processedTids.size > this.MAX_PROCESSED_TIDS) {
      const tidsArray = Array.from(this.processedTids)
      this.processedTids = new Set(tidsArray.slice(-500))
    }
  }

  clear(): void {
    this.processedTids.clear()
  }
}
