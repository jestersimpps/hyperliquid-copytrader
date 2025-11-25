import { EventClient, WebSocketTransport, WsUserFills } from '@nktkas/hyperliquid';
import type { UserFillData } from '@/types/websocket.types';
import type { TelegramService } from './telegram.service';
import type { FillQueueService } from './fill-queue.service';

export interface ConnectionStats {
  id: number;
  isConnected: boolean;
  lastConnectedAt: number | null;
  lastFillReceivedAt: number | null;
  reconnectAttempts: number;
  isReconnecting: boolean;
  fillsReceived: number;
}

export class WebSocketConnectionService {
  private eventClient: EventClient | null = null;
  private wsTransport: WebSocketTransport | null = null;
  private subscription: any = null;
  private isTestnet: boolean;
  private isFirstSnapshot = true;
  private trackedWallet: string | null = null;
  private lastConnectedAt: number | null = null;
  private lastFillReceivedAt: number | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isReconnecting = false;
  private fillsReceived = 0;
  private readonly connectionId: number;
  private readonly fillQueue: FillQueueService;
  private readonly telegramService: TelegramService | null;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  constructor(
    connectionId: number,
    fillQueue: FillQueueService,
    isTestnet: boolean = false,
    telegramService?: TelegramService
  ) {
    this.connectionId = connectionId;
    this.fillQueue = fillQueue;
    this.isTestnet = isTestnet;
    this.telegramService = telegramService || null;
  }

  async initialize(trackedWallet: string): Promise<void> {
    if (this.eventClient && !this.isReconnecting) {
      return;
    }

    this.trackedWallet = trackedWallet;

    try {
      const wsUrl = this.isTestnet
        ? 'wss://api.hyperliquid-testnet.xyz/ws'
        : 'wss://api.hyperliquid.xyz/ws';

      this.wsTransport = new WebSocketTransport({ url: wsUrl });
      this.eventClient = new EventClient({ transport: this.wsTransport });

      const connectionTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('WebSocket connection timeout after 30 seconds')), 30000);
      });

      this.subscription = await Promise.race([
        this.eventClient.userFills(
          { user: trackedWallet as `0x${string}` },
          (data: WsUserFills) => {
            this.handleFills(data);
          }
        ),
        connectionTimeout
      ]);

      this.lastConnectedAt = Date.now();
      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      console.log(`✓ Connection ${this.connectionId}: WebSocket subscription initialized for ${trackedWallet}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Connection ${this.connectionId}: WebSocket connection failed: ${errorMessage}`);

      this.eventClient = null;
      this.wsTransport = null;
      this.subscription = null;

      await this.scheduleReconnect();
      throw error;
    }
  }

  private handleFills(data: WsUserFills): void {
    try {
      this.lastFillReceivedAt = Date.now();

      if (data.isSnapshot) {
        if (this.isFirstSnapshot) {
          console.log(`[Connection ${this.connectionId}] Received initial snapshot with ${data.fills.length} historical fills`);
          this.isFirstSnapshot = false;
        }
        return;
      }

      for (const fill of data.fills) {
        this.fillsReceived++;
        this.fillQueue.enqueueFill(fill as UserFillData, this.connectionId);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Connection ${this.connectionId}: Error handling WebSocket fills: ${errorMessage}`);
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempts++;
    const delays = [5000, 10000, 30000, 60000, 300000];
    const delay = delays[Math.min(this.reconnectAttempts - 1, delays.length - 1)];

    console.log(`⟳ Connection ${this.connectionId}: Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay / 1000}s...`);

    this.reconnectTimer = setTimeout(async () => {
      await this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.trackedWallet) {
      console.error(`✗ Connection ${this.connectionId}: Cannot reconnect: missing tracked wallet`);
      return;
    }

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      const errorMsg = `❌ Connection ${this.connectionId}: WebSocket reconnection failed after ${this.MAX_RECONNECT_ATTEMPTS} attempts`;
      console.error(errorMsg);

      if (this.telegramService?.isEnabled()) {
        await this.telegramService.sendError(errorMsg).catch(() => {});
      }

      return;
    }

    console.log(`⟳ Connection ${this.connectionId}: Attempting WebSocket reconnection (attempt ${this.reconnectAttempts})...`);

    this.isReconnecting = true;

    const savedWallet = this.trackedWallet;

    try {
      await this.close();
      await this.initialize(savedWallet);
      console.log(`✓ Connection ${this.connectionId}: WebSocket reconnected successfully after ${this.reconnectAttempts} attempt(s)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Connection ${this.connectionId}: Reconnection attempt ${this.reconnectAttempts} failed: ${errorMessage}`);
      this.trackedWallet = savedWallet;
      this.isReconnecting = false;
    }
  }

  async forceReconnect(): Promise<void> {
    if (!this.trackedWallet) {
      throw new Error(`Connection ${this.connectionId}: Cannot reconnect: service not initialized`);
    }

    if (this.isReconnecting) {
      console.log(`⟳ Connection ${this.connectionId}: Reconnection already in progress, skipping force reconnect`);
      return;
    }

    console.log(`⟳ Connection ${this.connectionId}: Force reconnecting WebSocket...`);
    this.isReconnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const savedWallet = this.trackedWallet;

    await this.close();
    await this.initialize(savedWallet);
  }

  isConnected(): boolean {
    return this.eventClient !== null && this.subscription !== null;
  }

  getConnectionStats(): ConnectionStats {
    return {
      id: this.connectionId,
      isConnected: this.isConnected(),
      lastConnectedAt: this.lastConnectedAt,
      lastFillReceivedAt: this.lastFillReceivedAt,
      reconnectAttempts: this.reconnectAttempts,
      isReconnecting: this.isReconnecting,
      fillsReceived: this.fillsReceived
    };
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }

    this.eventClient = null;
    this.wsTransport = null;
    this.isReconnecting = false;
  }
}
