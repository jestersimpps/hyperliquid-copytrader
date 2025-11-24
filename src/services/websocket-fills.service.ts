import { EventClient, WebSocketTransport, WsUserFills } from '@nktkas/hyperliquid';
import { TelegramService } from './telegram.service';

export class WebSocketFillsService {
  private eventClient: EventClient | null = null;
  private wsTransport: WebSocketTransport | null = null;
  private subscription: any = null;
  private isTestnet: boolean;
  private processedTids: Set<string> = new Set();
  private onFillCallback: ((fill: any) => void) | null = null;
  private isFirstSnapshot: boolean = true;
  private trackedWallet: string | null = null;
  private lastConnectedAt: number | null = null;
  private lastFillReceivedAt: number | null = null;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isReconnecting: boolean = false;
  private telegramService: TelegramService | null = null;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  constructor(isTestnet: boolean = false, telegramService?: TelegramService) {
    this.isTestnet = isTestnet;
    this.telegramService = telegramService || null;
  }

  async initialize(trackedWallet: string, onFill: (fill: any) => void): Promise<void> {
    if (this.eventClient && !this.isReconnecting) {
      return;
    }

    this.trackedWallet = trackedWallet;
    this.onFillCallback = onFill;

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

      console.log(`✓ WebSocket fills subscription initialized for ${trackedWallet}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ WebSocket connection failed: ${errorMessage}`);

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
          console.log(`[WebSocket] Received initial snapshot with ${data.fills.length} historical fills`);
          data.fills.forEach(fill => {
            if (fill.tid) {
              this.processedTids.add(String(fill.tid));
            }
          });
          this.isFirstSnapshot = false;
        }
        return;
      }

      for (const fill of data.fills) {
        const tid = String(fill.tid);

        if (this.processedTids.has(tid)) {
          continue;
        }

        this.processedTids.add(tid);

        if (this.processedTids.size > 1000) {
          const tidsArray = Array.from(this.processedTids);
          this.processedTids = new Set(tidsArray.slice(-500));
        }

        if (this.onFillCallback) {
          try {
            this.onFillCallback(fill);
          } catch (callbackError) {
            const errorMessage = callbackError instanceof Error ? callbackError.message : String(callbackError);
            console.error(`✗ Error in fill callback for ${fill.coin}: ${errorMessage}`);
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Error handling WebSocket fills: ${errorMessage}`);
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempts++;
    const delays = [5000, 10000, 30000, 60000, 300000];
    const delay = delays[Math.min(this.reconnectAttempts - 1, delays.length - 1)];

    console.log(`⟳ Scheduling WebSocket reconnection attempt ${this.reconnectAttempts} in ${delay / 1000}s...`);

    this.reconnectTimer = setTimeout(async () => {
      await this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (!this.trackedWallet || !this.onFillCallback) {
      console.error(`✗ Cannot reconnect: missing tracked wallet or callback`);
      return;
    }

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      const errorMsg = `❌ WebSocket reconnection failed after ${this.MAX_RECONNECT_ATTEMPTS} attempts. Restarting process...`;
      console.error(errorMsg);

      if (this.telegramService?.isEnabled()) {
        await this.telegramService.sendError(errorMsg).catch(() => {});
      }

      process.exit(1);
    }

    console.log(`⟳ Attempting WebSocket reconnection (attempt ${this.reconnectAttempts})...`);

    this.isReconnecting = true;

    const savedWallet = this.trackedWallet;
    const savedCallback = this.onFillCallback;

    try {
      await this.close();
      await this.initialize(savedWallet, savedCallback);
      console.log(`✓ WebSocket reconnected successfully after ${this.reconnectAttempts} attempt(s)`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Reconnection attempt ${this.reconnectAttempts} failed: ${errorMessage}`);
      this.onFillCallback = savedCallback;
      this.trackedWallet = savedWallet;
      this.isReconnecting = false;
    }
  }

  async forceReconnect(): Promise<void> {
    if (!this.trackedWallet || !this.onFillCallback) {
      throw new Error('Cannot reconnect: service not initialized');
    }

    if (this.isReconnecting) {
      console.log(`⟳ Reconnection already in progress, skipping force reconnect`);
      return;
    }

    console.log(`⟳ Force reconnecting WebSocket...`);
    this.isReconnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const savedWallet = this.trackedWallet;
    const savedCallback = this.onFillCallback;

    await this.close();
    await this.initialize(savedWallet, savedCallback);
  }

  isConnected(): boolean {
    return this.eventClient !== null && this.subscription !== null;
  }

  getConnectionStats(): {
    isConnected: boolean;
    lastConnectedAt: number | null;
    lastFillReceivedAt: number | null;
    reconnectAttempts: number;
    isReconnecting: boolean;
  } {
    return {
      isConnected: this.isConnected(),
      lastConnectedAt: this.lastConnectedAt,
      lastFillReceivedAt: this.lastFillReceivedAt,
      reconnectAttempts: this.reconnectAttempts,
      isReconnecting: this.isReconnecting
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
    this.processedTids.clear();
    this.onFillCallback = null;
    this.isReconnecting = false;
  }
}
