import { PublicClient, PerpsMeta } from '@nktkas/hyperliquid';

interface CoinMeta {
  index: number;
  name: string;
  szDecimals: number;
}

export class MetaCacheService {
  private metaCache: Map<string, CoinMeta> = new Map();
  private lastUpdate: number = 0;
  private readonly CACHE_DURATION = 60 * 60 * 1000;
  private publicClient: PublicClient;

  constructor(publicClient: PublicClient) {
    this.publicClient = publicClient;
  }

  async initialize(): Promise<void> {
    await this.refreshCache();
    console.log(`✓ Meta cache initialized with ${this.metaCache.size} coins`);
  }

  private async refreshCache(): Promise<void> {
    const meta = await this.publicClient.meta();

    this.metaCache.clear();
    meta.universe.forEach((asset, index) => {
      this.metaCache.set(asset.name, {
        index,
        name: asset.name,
        szDecimals: asset.szDecimals
      });
    });

    this.lastUpdate = Date.now();
  }

  private async ensureFresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastUpdate > this.CACHE_DURATION) {
      await this.refreshCache();
      console.log('✓ Meta cache refreshed');
    }
  }

  async getCoinIndex(coin: string): Promise<number> {
    await this.ensureFresh();

    const meta = this.metaCache.get(coin);
    if (!meta) {
      throw new Error(`Coin ${coin} not found`);
    }

    return meta.index;
  }

  async getSizeDecimals(coin: string): Promise<number> {
    await this.ensureFresh();

    const meta = this.metaCache.get(coin);
    if (!meta) {
      throw new Error(`Coin ${coin} not found`);
    }

    return meta.szDecimals;
  }

  getCoinIndexSync(coin: string): number | null {
    const meta = this.metaCache.get(coin);
    return meta ? meta.index : null;
  }

  getSizeDecimalsSync(coin: string): number | null {
    const meta = this.metaCache.get(coin);
    return meta ? meta.szDecimals : null;
  }

  getAllCoins(): string[] {
    return Array.from(this.metaCache.keys());
  }

  clear(): void {
    this.metaCache.clear();
    this.lastUpdate = 0;
  }
}
