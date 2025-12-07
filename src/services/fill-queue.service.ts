import { UserFillData, FillProcessor } from '@/models'
import { RiskMonitorService } from './risk-monitor.service'
import { WebSocketPoolService } from './websocket-pool.service'

type MultiFillProcessor = (fill: UserFillData, connectionId: number) => void

export class FillQueueService {
  private processedTids: Set<string> = new Set()
  private fillProcessor: FillProcessor | null = null
  private multiFillProcessor: MultiFillProcessor | null = null
  private riskMonitor: RiskMonitorService | null = null
  private webSocketPool: WebSocketPoolService | null = null
  private subscriberIds: string[] = []
  private readonly MAX_PROCESSED_TIDS = 1000

  setFillProcessor(processor: FillProcessor): void {
    this.fillProcessor = processor
  }

  setMultiSubscriberMode(processor: MultiFillProcessor): void {
    this.multiFillProcessor = processor
  }

  setRiskMonitor(riskMonitor: RiskMonitorService): void {
    this.riskMonitor = riskMonitor
  }

  setWebSocketPool(pool: WebSocketPoolService): void {
    this.webSocketPool = pool
  }

  setSubscriberIds(ids: string[]): void {
    this.subscriberIds = ids
  }

  enqueueFill(fill: UserFillData, connectionId: number): void {
    const tidString = String(fill.tid)

    this.webSocketPool?.trackFillReception(tidString, connectionId)

    if (this.processedTids.has(tidString)) {
      const accountLabel = this.subscriberIds.length > 0
        ? `[${this.subscriberIds.join('][')}] `
        : ''
      console.log(`  ${accountLabel}⊘ Duplicate fill dropped (TID: ${fill.tid}, Connection: ${connectionId})`)
      return
    }

    this.processedTids.add(tidString)
    this.trimProcessedTids()

    if (this.multiFillProcessor) {
      this.multiFillProcessor(fill, connectionId)
    } else {
      this.riskMonitor?.recordFill()
      if (this.fillProcessor) {
        this.fillProcessor(fill, connectionId).catch(error => {
          console.error(`✗ Error processing fill: ${error instanceof Error ? error.message : error}`)
        })
      }
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
