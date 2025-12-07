import { EventClient, WebSocketTransport, WsUserFills } from '@nktkas/hyperliquid'
import { UserFillData } from '@/models'
import { FillQueueService } from './fill-queue.service'
import { config } from '@/config'

export interface ConnectionStats {
  id: number
  isConnected: boolean
  lastConnectedAt: number | null
  lastFillReceivedAt: number | null
  fillsReceived: number
}

export class WebSocketConnectionService {
  private eventClient: EventClient | null = null
  private wsTransport: WebSocketTransport | null = null
  private subscription: any = null
  private trackedWallet: string | null = null
  private lastConnectedAt: number | null = null
  private lastFillReceivedAt: number | null = null
  private fillsReceived = 0
  private isFirstSnapshot = true

  constructor(
    private connectionId: number,
    private fillQueue: FillQueueService
  ) {}

  async initialize(trackedWallet: string): Promise<void> {
    this.trackedWallet = trackedWallet

    const wsUrl = config.isTestnet
      ? 'wss://api.hyperliquid-testnet.xyz/ws'
      : 'wss://api.hyperliquid.xyz/ws'

    this.wsTransport = new WebSocketTransport({ url: wsUrl })
    this.eventClient = new EventClient({ transport: this.wsTransport })

    const connectionTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('WebSocket connection timeout')), 30000)
    })

    this.subscription = await Promise.race([
      this.eventClient.userFills(
        { user: trackedWallet as `0x${string}` },
        (data: WsUserFills) => this.handleFills(data)
      ),
      connectionTimeout
    ])

    this.lastConnectedAt = Date.now()
    console.log(`✓ Connection ${this.connectionId}: Subscribed to ${trackedWallet}`)
  }

  private handleFills(data: WsUserFills): void {
    this.lastFillReceivedAt = Date.now()

    if (data.isSnapshot) {
      if (this.isFirstSnapshot) {
        console.log(`[Connection ${this.connectionId}] Snapshot: ${data.fills.length} historical fills`)
        this.isFirstSnapshot = false
      }
      return
    }

    for (const fill of data.fills) {
      this.fillsReceived++
      this.fillQueue.enqueueFill(fill as UserFillData, this.connectionId)
    }
  }

  async forceReconnect(): Promise<void> {
    if (!this.trackedWallet) {
      throw new Error(`Connection ${this.connectionId}: Cannot reconnect without wallet`)
    }

    console.log(`⟳ Connection ${this.connectionId}: Reconnecting...`)
    const wallet = this.trackedWallet
    await this.close()
    this.isFirstSnapshot = true
    await this.initialize(wallet)
  }

  isConnected(): boolean {
    return this.eventClient !== null && this.subscription !== null
  }

  getStats(): ConnectionStats {
    return {
      id: this.connectionId,
      isConnected: this.isConnected(),
      lastConnectedAt: this.lastConnectedAt,
      lastFillReceivedAt: this.lastFillReceivedAt,
      fillsReceived: this.fillsReceived
    }
  }

  async close(): Promise<void> {
    if (this.subscription) {
      this.subscription.unsubscribe()
      this.subscription = null
    }
    if (this.wsTransport) {
      try {
        await this.wsTransport.close()
      } catch (err) {
        console.error(`Connection ${this.connectionId}: Error closing transport:`, err instanceof Error ? err.message : err)
      }
    }
    this.eventClient = null
    this.wsTransport = null
  }
}
