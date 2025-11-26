import { WebSocketConnectionService, ConnectionStats } from './websocket-connection.service'
import { FillQueueService } from './fill-queue.service'

export interface PoolStats {
  totalConnections: number
  activeConnections: number
  totalFillsReceived: number
  connections: ConnectionStats[]
  healthStatus: 'healthy' | 'degraded' | 'critical'
}

export class WebSocketPoolService {
  private connections: WebSocketConnectionService[] = []
  private readonly POOL_SIZE = 3
  private healthCheckInterval: NodeJS.Timeout | null = null

  constructor(private fillQueue: FillQueueService) {
    for (let i = 0; i < this.POOL_SIZE; i++) {
      this.connections.push(new WebSocketConnectionService(i + 1, fillQueue))
    }
  }

  async initializeAll(trackedWallet: string): Promise<void> {
    console.log(`\n🔌 Initializing WebSocket pool (${this.POOL_SIZE} connections)...`)

    const results = await Promise.allSettled(
      this.connections.map(conn => conn.initialize(trackedWallet))
    )

    const activeCount = this.getActiveConnectionCount()
    console.log(`✓ WebSocket pool: ${activeCount}/${this.POOL_SIZE} connections active\n`)

    if (activeCount === 0) {
      console.error('❌ All WebSocket connections failed. Exiting...')
      process.exit(1)
    }

    this.startHealthCheck()
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      const stats = this.getPoolStats()
      if (stats.activeConnections === 0) {
        console.error('❌ All WebSocket connections lost. Exiting...')
        process.exit(1)
      }
    }, 30000)
  }

  async restartConnection(index: number): Promise<void> {
    if (index < 0 || index >= this.POOL_SIZE) return
    await this.connections[index].forceReconnect()
  }

  private pendingFillChecks: Map<string, { receivedBy: Set<number>; timestamp: number }> = new Map()

  trackFillReception(tid: string, connectionId: number): void {
    if (!this.pendingFillChecks.has(tid)) {
      this.pendingFillChecks.set(tid, {
        receivedBy: new Set([connectionId]),
        timestamp: Date.now()
      })
      setTimeout(() => this.checkMissedFill(tid), 5000)
    } else {
      this.pendingFillChecks.get(tid)!.receivedBy.add(connectionId)
    }
  }

  private checkMissedFill(tid: string): void {
    const fillData = this.pendingFillChecks.get(tid)
    if (!fillData) return

    this.pendingFillChecks.delete(tid)

    for (const conn of this.connections) {
      const stats = conn.getStats()
      if (!stats.isConnected) continue
      if (fillData.receivedBy.has(stats.id)) continue

      console.log(`⟳ Connection ${stats.id} missed TID ${tid}, reconnecting...`)
      conn.forceReconnect().catch(err =>
        console.error(`Failed to reconnect ${stats.id}:`, err instanceof Error ? err.message : err)
      )
    }
  }

  getActiveConnectionCount(): number {
    return this.connections.filter(c => c.isConnected()).length
  }

  getPoolStats(): PoolStats {
    const connectionStats = this.connections.map(c => c.getStats())
    const activeConnections = connectionStats.filter(s => s.isConnected).length
    const totalFillsReceived = connectionStats.reduce((sum, s) => sum + s.fillsReceived, 0)

    let healthStatus: 'healthy' | 'degraded' | 'critical'
    if (activeConnections === this.POOL_SIZE) {
      healthStatus = 'healthy'
    } else if (activeConnections >= 2) {
      healthStatus = 'degraded'
    } else {
      healthStatus = 'critical'
    }

    return {
      totalConnections: this.POOL_SIZE,
      activeConnections,
      totalFillsReceived,
      connections: connectionStats,
      healthStatus
    }
  }

  async closeAll(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
    await Promise.allSettled(this.connections.map(c => c.close()))
    console.log('✓ All WebSocket connections closed')
  }
}
