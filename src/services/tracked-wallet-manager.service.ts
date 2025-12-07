import { UserFillData, FillProcessor } from '@/models'
import { WebSocketPoolService, PoolStats } from './websocket-pool.service'
import { FillQueueService } from './fill-queue.service'
import { RiskMonitorService } from './risk-monitor.service'

interface TrackedWalletContext {
  trackedWallet: string
  pool: WebSocketPoolService
  fillQueue: FillQueueService
  subscribers: Map<string, { processor: FillProcessor; riskMonitor: RiskMonitorService }>
}

export class TrackedWalletManager {
  private wallets: Map<string, TrackedWalletContext> = new Map()

  async subscribeAccount(
    trackedWallet: string,
    accountId: string,
    processor: FillProcessor,
    riskMonitor: RiskMonitorService
  ): Promise<void> {
    const normalizedWallet = trackedWallet.toLowerCase()

    if (!this.wallets.has(normalizedWallet)) {
      const fillQueue = new FillQueueService()
      const pool = new WebSocketPoolService(fillQueue)

      const context: TrackedWalletContext = {
        trackedWallet: normalizedWallet,
        pool,
        fillQueue,
        subscribers: new Map()
      }

      fillQueue.setMultiSubscriberMode((fill, connectionId) => {
        this.broadcastFill(normalizedWallet, fill, connectionId)
      })
      fillQueue.setWebSocketPool(pool)

      await pool.initializeAll(trackedWallet)
      this.wallets.set(normalizedWallet, context)
      console.log(`✓ Created WebSocket pool for tracked wallet: ${trackedWallet.slice(0, 10)}...`)
    }

    const context = this.wallets.get(normalizedWallet)!
    context.subscribers.set(accountId, { processor, riskMonitor })
    context.fillQueue.setSubscriberIds(Array.from(context.subscribers.keys()))
    console.log(`✓ Account ${accountId} subscribed to tracked wallet ${trackedWallet.slice(0, 10)}...`)
  }

  private broadcastFill(trackedWallet: string, fill: UserFillData, connectionId: number): void {
    const context = this.wallets.get(trackedWallet)
    if (!context) return

    for (const [accountId, { processor, riskMonitor }] of context.subscribers) {
      riskMonitor.recordFill()
      processor(fill, connectionId).catch(error => {
        console.error(`[${accountId}] Error processing fill: ${error instanceof Error ? error.message : error}`)
      })
    }
  }

  unsubscribeAccount(trackedWallet: string, accountId: string): void {
    const normalizedWallet = trackedWallet.toLowerCase()
    const context = this.wallets.get(normalizedWallet)
    if (!context) return

    context.subscribers.delete(accountId)
    context.fillQueue.setSubscriberIds(Array.from(context.subscribers.keys()))
    console.log(`✓ Account ${accountId} unsubscribed from ${trackedWallet.slice(0, 10)}...`)

    if (context.subscribers.size === 0) {
      context.pool.closeAll()
      this.wallets.delete(normalizedWallet)
      console.log(`✓ Closed WebSocket pool for ${trackedWallet.slice(0, 10)}... (no subscribers)`)
    }
  }

  getPool(trackedWallet: string): WebSocketPoolService | undefined {
    const normalizedWallet = trackedWallet.toLowerCase()
    return this.wallets.get(normalizedWallet)?.pool
  }

  getPoolStats(trackedWallet: string): PoolStats | undefined {
    const normalizedWallet = trackedWallet.toLowerCase()
    return this.wallets.get(normalizedWallet)?.pool.getPoolStats()
  }

  getAllPoolStats(): Map<string, PoolStats> {
    const stats = new Map<string, PoolStats>()
    for (const [wallet, context] of this.wallets) {
      stats.set(wallet, context.pool.getPoolStats())
    }
    return stats
  }

  getSubscriberCount(trackedWallet: string): number {
    const normalizedWallet = trackedWallet.toLowerCase()
    return this.wallets.get(normalizedWallet)?.subscribers.size || 0
  }

  async closeAll(): Promise<void> {
    for (const [wallet, context] of this.wallets) {
      await context.pool.closeAll()
      console.log(`✓ Closed pool for ${wallet.slice(0, 10)}...`)
    }
    this.wallets.clear()
  }
}
