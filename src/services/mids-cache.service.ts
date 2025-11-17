import { EventClient, WebSocketTransport } from '@nktkas/hyperliquid';

export class MidsCacheService {
  private midsCache: Map<string, number> = new Map();
  private eventClient: EventClient | null = null;
  private wsTransport: WebSocketTransport | null = null;
  private subscription: any = null;
  private isTestnet: boolean;

  constructor(isTestnet: boolean = false) {
    this.isTestnet = isTestnet;
  }

  async initialize(): Promise<void> {
    if (this.eventClient) {
      return;
    }

    const wsUrl = this.isTestnet
      ? 'wss://api.hyperliquid-testnet.xyz/ws'
      : 'wss://api.hyperliquid.xyz/ws';

    this.wsTransport = new WebSocketTransport({ url: wsUrl });
    this.eventClient = new EventClient({ transport: this.wsTransport });

    this.subscription = await this.eventClient.allMids((mids: Record<string, string>) => {
      Object.entries(mids).forEach(([coin, mid]) => {
        this.midsCache.set(coin, parseFloat(mid));
      });
    });

    console.log('✓ Mids cache initialized via WebSocket');
  }

  getMid(coin: string): number | null {
    return this.midsCache.get(coin) || null;
  }

  hasMid(coin: string): boolean {
    return this.midsCache.has(coin);
  }

  getAllMids(): Map<string, number> {
    return new Map(this.midsCache);
  }

  async close(): Promise<void> {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    this.eventClient = null;
    this.wsTransport = null;
    this.midsCache.clear();
  }
}
