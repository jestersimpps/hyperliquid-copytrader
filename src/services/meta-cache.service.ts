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
  private readonly MAX_RETRIES = 5;
  private readonly RETRY_DELAY_MS = 5000;

  constructor(publicClient: PublicClient) {
    this.publicClient = publicClient;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async initialize(): Promise<void> {
    await this.refreshCache();
    console.log(`✓ Meta cache initialized with ${this.metaCache.size} coins`);
  }

  async refreshCache(): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
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
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;
        const isTransientError =
          errorMessage.includes('502') ||
          errorMessage.includes('503') ||
          errorMessage.includes('504') ||
          errorMessage.includes('ECONNRESET') ||
          errorMessage.includes('ETIMEDOUT') ||
          errorMessage.includes('ENOTFOUND');

        if (isTransientError && attempt < this.MAX_RETRIES) {
          console.warn(`⚠️  Meta cache refresh failed (attempt ${attempt}/${this.MAX_RETRIES}): ${errorMessage}`);
          console.log(`   Retrying in ${this.RETRY_DELAY_MS / 1000}s...`);
          await this.sleep(this.RETRY_DELAY_MS);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error('Meta cache refresh failed after all retries');
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
