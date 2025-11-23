import {
  PublicClient,
  WalletClient,
  HttpTransport,
  AssetPosition,
  FrontendOrder,
  OrderResponse
} from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import type { Position, Order, Balance } from '../models';
import { MetaCacheService } from './meta-cache.service';
import { TelegramService } from './telegram.service';
import { validateAndAdjustOrderSize } from '../utils/order-validation.utils';
import { loadConfig } from '../config';
import * as fs from 'fs';
import * as path from 'path';

export class HyperliquidService {
  public publicClient: PublicClient;
  private walletClient: WalletClient | null = null;
  private isTestnet: boolean;
  private userAddress: string | null = null;
  private metaCache: MetaCacheService;
  private initialized: boolean = false;
  private tickSizeCache: Map<string, number> = new Map();
  private readonly TICK_SIZE_CACHE_FILE = path.resolve(process.cwd(), 'data', 'tick-sizes.json');
  private minOrderValue: number;
  private telegramService: TelegramService | null = null;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 100;
  private readonly BASE_SLIPPAGE_PERCENT = 1.0;
  private readonly SLIPPAGE_INCREMENT = 0.5;
  private readonly MAX_SLIPPAGE_PERCENT = 3;
  private readonly ORDER_PLACEMENT_TIMEOUT_MS = 10000;

  constructor(privateKey: string | null, walletAddress: string | null, isTestnet: boolean = false, telegramService: TelegramService | null = null) {
    this.isTestnet = isTestnet;
    this.userAddress = walletAddress;
    this.minOrderValue = loadConfig().minOrderValue;
    this.telegramService = telegramService;

    const httpUrl = isTestnet
      ? 'https://api.hyperliquid-testnet.xyz'
      : 'https://api.hyperliquid.xyz';

    const httpTransport = new HttpTransport({
      url: httpUrl,
      timeout: 30000,
      fetchOptions: {
        keepalive: false
      }
    });

    this.publicClient = new PublicClient({ transport: httpTransport });

    this.metaCache = new MetaCacheService(this.publicClient);

    if (privateKey && walletAddress) {
      try {
        const account = privateKeyToAccount(privateKey as `0x${string}`);

        this.walletClient = new WalletClient({
          wallet: account,
          transport: httpTransport,
          isTestnet
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Failed to initialize wallet client:', errorMessage);
        throw new Error(`Wallet initialization failed: ${errorMessage}`);
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const MAX_INIT_RETRIES = 3;
    const INIT_RETRY_DELAY_MS = 10000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_INIT_RETRIES; attempt++) {
      try {
        await this.metaCache.initialize();
        this.loadTickSizeCache();
        this.initialized = true;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;

        if (attempt < MAX_INIT_RETRIES) {
          console.error(`\n❌ Initialization failed (attempt ${attempt}/${MAX_INIT_RETRIES}): ${errorMessage}`);
          console.log(`   Retrying in ${INIT_RETRY_DELAY_MS / 1000}s...\n`);
          await new Promise(resolve => setTimeout(resolve, INIT_RETRY_DELAY_MS));
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error('Service initialization failed after all retries');
  }

  async preCacheTickSizes(coins: string[]): Promise<void> {
    console.log(`Pre-caching tick sizes for ${coins.length} coins...`);

    const uncachedCoins = coins.filter(coin => !this.tickSizeCache.has(coin));
    if (uncachedCoins.length === 0) {
      console.log('All coins already cached');
      return;
    }

    console.log(`Fetching tick sizes for ${uncachedCoins.length} uncached coins...`);
    let cached = 0;
    let failed = 0;

    for (const coin of uncachedCoins) {
      try {
        await this.getTickSize(coin);
        cached++;
      } catch (error) {
        failed++;
      }
    }

    console.log(`✓ Pre-cached ${cached} tick sizes (${failed} failed)`);
  }

  private loadTickSizeCache(): void {
    try {
      if (fs.existsSync(this.TICK_SIZE_CACHE_FILE)) {
        const data = fs.readFileSync(this.TICK_SIZE_CACHE_FILE, 'utf-8');
        const cache = JSON.parse(data);

        Object.entries(cache).forEach(([coin, tickSize]) => {
          if (coin !== 'lastUpdated' && typeof tickSize === 'number') {
            this.tickSizeCache.set(coin, tickSize);
          }
        });

        console.log(`✓ Loaded ${this.tickSizeCache.size} tick sizes from cache`);
      }
    } catch (error) {
      console.error('Failed to load tick size cache:', error instanceof Error ? error.message : error);
    }
  }

  private saveTickSizeCache(): void {
    try {
      const dataDir = path.dirname(this.TICK_SIZE_CACHE_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const cache: Record<string, number | string> = {
        lastUpdated: new Date().toISOString()
      };

      this.tickSizeCache.forEach((tickSize, coin) => {
        cache[coin] = tickSize;
      });

      fs.writeFileSync(this.TICK_SIZE_CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (error) {
      console.error('Failed to save tick size cache:', error instanceof Error ? error.message : error);
    }
  }

  async getOpenPositions(walletAddress: string): Promise<Position[]> {
    const state = await this.publicClient.clearinghouseState({
      user: walletAddress as `0x${string}`
    });

    const openPositions = state.assetPositions.filter(
      (pos: AssetPosition) => parseFloat(pos.position.szi) !== 0
    );

    return openPositions.map((pos: AssetPosition) => {
      const size = parseFloat(pos.position.szi);
      const markPrice = parseFloat(pos.position.positionValue) / Math.abs(size);
      return {
        coin: pos.position.coin,
        size: Math.abs(size),
        entryPrice: parseFloat(pos.position.entryPx || '0'),
        markPrice,
        unrealizedPnl: parseFloat(pos.position.unrealizedPnl),
        leverage: typeof pos.position.leverage.value === 'number' ? pos.position.leverage.value : parseFloat(pos.position.leverage.value),
        marginUsed: parseFloat(pos.position.marginUsed),
        liquidationPrice: parseFloat(pos.position.liquidationPx || '0'),
        side: size > 0 ? 'long' : 'short',
        notionalValue: Math.abs(size) * markPrice
      };
    });
  }

  async getOpenOrders(walletAddress: string): Promise<Order[]> {
    const orders = await this.publicClient.frontendOpenOrders({
      user: walletAddress as `0x${string}`
    });

    return orders.map((order: FrontendOrder) => ({
      coin: order.coin,
      side: order.side === 'B' ? 'buy' : 'sell',
      size: parseFloat(order.sz),
      price: parseFloat(order.limitPx || order.triggerPx || '0'),
      orderType: order.orderType || 'limit',
      orderId: order.oid,
      timestamp: order.timestamp,
      isTrigger: order.isTrigger || false,
      triggerPrice: order.triggerPx ? parseFloat(order.triggerPx) : undefined,
      reduceOnly: order.reduceOnly || false
    }));
  }

  async getAccountBalance(walletAddress: string): Promise<Balance> {
    const state = await this.publicClient.clearinghouseState({
      user: walletAddress as `0x${string}`
    });

    return {
      accountValue: state.marginSummary.accountValue,
      withdrawable: state.withdrawable,
      totalMarginUsed: state.marginSummary.totalMarginUsed,
      crossMaintenanceMarginUsed: state.crossMaintenanceMarginUsed,
      totalNtlPos: state.marginSummary.totalNtlPos,
      totalRawUsd: state.marginSummary.totalRawUsd,
      crossMarginSummary: {
        accountValue: state.crossMarginSummary.accountValue,
        totalNtlPos: state.crossMarginSummary.totalNtlPos,
        totalRawUsd: state.crossMarginSummary.totalRawUsd,
        totalMarginUsed: state.crossMarginSummary.totalMarginUsed
      },
      timestamp: state.time
    };
  }

  async getCoinIndex(coin: string): Promise<number> {
    let index = this.metaCache.getCoinIndexSync(coin);
    if (index === null) {
      console.warn(`⚠️  Coin ${coin} not found in cache, forcing refresh...`);
      try {
        await this.metaCache.refreshCache();
        index = this.metaCache.getCoinIndexSync(coin);
        if (index === null) {
          throw new Error(`Coin ${coin} not found in metadata cache even after refresh`);
        }
      } catch (error) {
        throw new Error(`Failed to refresh metadata cache for ${coin}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return index;
  }

  private async getSizeDecimals(coin: string): Promise<number> {
    let decimals = this.metaCache.getSizeDecimalsSync(coin);
    if (decimals === null) {
      console.warn(`⚠️  Coin ${coin} size decimals not found in cache, forcing refresh...`);
      try {
        await this.metaCache.refreshCache();
        decimals = this.metaCache.getSizeDecimalsSync(coin);
        if (decimals === null) {
          throw new Error(`Coin ${coin} size decimals not found in metadata cache even after refresh`);
        }
      } catch (error) {
        throw new Error(`Failed to refresh metadata cache for ${coin}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return decimals;
  }

  private async getTickSize(coin: string): Promise<number> {
    // Check cache first
    if (this.tickSizeCache.has(coin)) {
      return this.tickSizeCache.get(coin)!;
    }

    // Fetch from orderbook and calculate
    const book = await this.publicClient.l2Book({ coin });
    const bids = book.levels[0];

    let tickSize = 0.01;

    if (bids && bids.length >= 2) {
      const price1 = parseFloat(bids[0].px);
      const price2 = parseFloat(bids[1].px);
      let diff = Math.abs(price1 - price2);

      if (diff === 0 && bids.length >= 3) {
        const price3 = parseFloat(bids[2].px);
        diff = Math.abs(price1 - price3);
      }

      if (diff > 0) {
        const isCloseTo = (value: number, target: number): boolean => {
          return Math.abs(value - target) < target * 0.1;
        };

        if (diff >= 10 || isCloseTo(diff, 10)) tickSize = 10;
        else if (diff >= 5 || isCloseTo(diff, 5)) tickSize = 5;
        else if (diff >= 1 || isCloseTo(diff, 1)) tickSize = 1;
        else if (diff >= 0.5 || isCloseTo(diff, 0.5)) tickSize = 0.5;
        else if (diff >= 0.1 || isCloseTo(diff, 0.1)) tickSize = 0.1;
        else if (diff >= 0.05 || isCloseTo(diff, 0.05)) tickSize = 0.05;
        else if (diff >= 0.01 || isCloseTo(diff, 0.01)) tickSize = 0.01;
        else if (diff >= 0.005 || isCloseTo(diff, 0.005)) tickSize = 0.005;
        else if (diff >= 0.001 || isCloseTo(diff, 0.001)) tickSize = 0.001;
        else if (diff >= 0.0005 || isCloseTo(diff, 0.0005)) tickSize = 0.0005;
        else if (diff >= 0.0001 || isCloseTo(diff, 0.0001)) tickSize = 0.0001;
        else if (diff >= 0.00005 || isCloseTo(diff, 0.00005)) tickSize = 0.00005;
        else if (diff >= 0.00001 || isCloseTo(diff, 0.00001)) tickSize = 0.00001;
        else tickSize = 0.00001;
      }
    }

    // Cache the result
    this.tickSizeCache.set(coin, tickSize);
    this.saveTickSizeCache();

    return tickSize;
  }

  private roundToTickSize(price: number, tickSize: number): number {
    const rounded = Math.round(price / tickSize) * tickSize;
    const decimals = this.getDecimalsFromTickSize(tickSize);
    return parseFloat(rounded.toFixed(decimals));
  }

  private getDecimalsFromTickSize(tickSize: number): number {
    if (tickSize >= 1) return 0;
    if (tickSize >= 0.1) return 1;
    if (tickSize >= 0.01) return 2;
    if (tickSize >= 0.001) return 3;
    if (tickSize >= 0.0001) return 4;
    if (tickSize >= 0.00001) return 5;
    return 6;
  }

  async formatPrice(price: number, coin: string): Promise<string> {
    const tickSize = await this.getTickSize(coin);
    const rounded = this.roundToTickSize(price, tickSize);
    const decimals = this.getDecimalsFromTickSize(tickSize);
    return rounded.toFixed(decimals);
  }

  async formatSize(size: number, coin: string): Promise<string> {
    const decimals = await this.getSizeDecimals(coin);
    return size.toFixed(decimals);
  }

  private ensureWalletClient(): void {
    if (!this.walletClient) {
      throw new Error('Wallet client not initialized. Trading operations require private key.');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async placeMarketBuy(coin: string, size: number, fillPrice: number, reduceOnly: boolean = false): Promise<OrderResponse> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Order placement timed out after ${this.ORDER_PLACEMENT_TIMEOUT_MS}ms`)), this.ORDER_PLACEMENT_TIMEOUT_MS)
    );

    const orderPromise = (async () => {
      this.ensureWalletClient();
      const coinIndex = await this.getCoinIndex(coin);

      const sizeDecimals = await this.getSizeDecimals(coin);
      const initialFormattedSize = await this.formatSize(size, coin);
      const validationPrice = fillPrice;

      const validationResult = validateAndAdjustOrderSize(
        size,
        initialFormattedSize,
        validationPrice,
        this.minOrderValue,
        sizeDecimals
      );

      if (validationResult.wasAdjusted) {
        setImmediate(() => {
          console.log(`   ⚠️  Adjusted ${coin}: ${initialFormattedSize} → ${validationResult.formattedSize} ($${validationResult.originalOrderValue.toFixed(2)} → $${validationResult.finalOrderValue.toFixed(2)})`);
        });
      }

      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      // Calculate progressive slippage for each attempt
      const slippagePercent = this.BASE_SLIPPAGE_PERCENT + (this.SLIPPAGE_INCREMENT * (attempt - 1));
      const orderPrice = fillPrice * (1 + slippagePercent / 100);
      const priceString = await this.formatPrice(orderPrice, coin);

      try {
        const orderResponse = await this.walletClient!.order({
          orders: [{
            a: coinIndex,
            b: true,
            p: priceString,
            s: validationResult.formattedSize,
            r: reduceOnly,
            t: { limit: { tif: reduceOnly ? 'FrontendMarket' : 'Ioc' } }
          }],
          grouping: 'na'
        });

        const status = orderResponse.response.data.statuses[0];
        if (status && 'error' in status) {
          const errorMessage = status.error;

          if (errorMessage.toLowerCase().includes('could not immediately match')) {
            if (attempt < this.MAX_RETRIES) {
              console.log(`   🔄 IOC failed for ${coin}, retry ${attempt}/${this.MAX_RETRIES} (slippage: ${slippagePercent}%)`);
              await this.sleep(this.RETRY_DELAY_MS);
              lastError = new Error(errorMessage);
              continue;
            } else {
              // Final attempt with max slippage
              const maxSlippagePrice = fillPrice * (1 + this.MAX_SLIPPAGE_PERCENT / 100);
              const maxSlippagePriceString = await this.formatPrice(maxSlippagePrice, coin);
              console.log(`   🔄 IOC failed for ${coin} after ${this.MAX_RETRIES} attempts, trying FrontendMarket (slippage: ${this.MAX_SLIPPAGE_PERCENT}%)`);
              return await this.walletClient!.order({
                orders: [{
                  a: coinIndex,
                  b: true,
                  p: maxSlippagePriceString,
                  s: validationResult.formattedSize,
                  r: reduceOnly,
                  t: { limit: { tif: 'FrontendMarket' } }
                }],
                grouping: 'na'
              });
            }
          }

          throw new Error(errorMessage);
        }

        return orderResponse;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.toLowerCase().includes('could not immediately match')) {
          if (attempt < this.MAX_RETRIES) {
            console.log(`   🔄 IOC failed for ${coin}, retry ${attempt}/${this.MAX_RETRIES} (slippage: ${slippagePercent}%)`);
            await this.sleep(this.RETRY_DELAY_MS);
            lastError = error instanceof Error ? error : new Error(errorMessage);
            continue;
          } else {
            // Final attempt with max slippage
            const maxSlippagePrice = fillPrice * (1 + this.MAX_SLIPPAGE_PERCENT / 100);
            const maxSlippagePriceString = await this.formatPrice(maxSlippagePrice, coin);
            console.log(`   🔄 IOC failed for ${coin} after ${this.MAX_RETRIES} attempts, trying FrontendMarket (slippage: ${this.MAX_SLIPPAGE_PERCENT}%)`);
            return await this.walletClient!.order({
              orders: [{
                a: coinIndex,
                b: true,
                p: maxSlippagePriceString,
                s: validationResult.formattedSize,
                r: reduceOnly,
                t: { limit: { tif: 'FrontendMarket' } }
              }],
              grouping: 'na'
            });
          }
        }

        lastError = error instanceof Error ? error : new Error(errorMessage);
        throw error;
      }
    }

      if (lastError && this.telegramService?.isEnabled()) {
        this.telegramService.sendError(`BUY order failed for ${coin} after ${this.MAX_RETRIES} retries: ${lastError.message}`).catch(() => {});
      }

      throw lastError || new Error(`Order failed after ${this.MAX_RETRIES} attempts`);
    })();

    return Promise.race([orderPromise, timeoutPromise]);
  }

  async placeMarketSell(coin: string, size: number, fillPrice: number, reduceOnly: boolean = false): Promise<OrderResponse> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Order placement timed out after ${this.ORDER_PLACEMENT_TIMEOUT_MS}ms`)), this.ORDER_PLACEMENT_TIMEOUT_MS)
    );

    const orderPromise = (async () => {
      this.ensureWalletClient();
      const coinIndex = await this.getCoinIndex(coin);

      const sizeDecimals = await this.getSizeDecimals(coin);
      const initialFormattedSize = await this.formatSize(size, coin);
      const validationPrice = fillPrice;

      const validationResult = validateAndAdjustOrderSize(
        size,
        initialFormattedSize,
        validationPrice,
        this.minOrderValue,
        sizeDecimals
      );

      if (validationResult.wasAdjusted) {
        setImmediate(() => {
          console.log(`   ⚠️  Adjusted ${coin}: ${initialFormattedSize} → ${validationResult.formattedSize} ($${validationResult.originalOrderValue.toFixed(2)} → $${validationResult.finalOrderValue.toFixed(2)})`);
        });
      }

      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      // Calculate progressive slippage for each attempt (negative for sells)
      const slippagePercent = this.BASE_SLIPPAGE_PERCENT + (this.SLIPPAGE_INCREMENT * (attempt - 1));
      const orderPrice = fillPrice * (1 - slippagePercent / 100);
      const priceString = await this.formatPrice(orderPrice, coin);

      try {
        const orderResponse = await this.walletClient!.order({
          orders: [{
            a: coinIndex,
            b: false,
            p: priceString,
            s: validationResult.formattedSize,
            r: reduceOnly,
            t: { limit: { tif: reduceOnly ? 'FrontendMarket' : 'Ioc' } }
          }],
          grouping: 'na'
        });

        const status = orderResponse.response.data.statuses[0];
        if (status && 'error' in status) {
          const errorMessage = status.error;

          if (errorMessage.toLowerCase().includes('could not immediately match')) {
            if (attempt < this.MAX_RETRIES) {
              console.log(`   🔄 IOC failed for ${coin}, retry ${attempt}/${this.MAX_RETRIES} (slippage: ${slippagePercent}%)`);
              await this.sleep(this.RETRY_DELAY_MS);
              lastError = new Error(errorMessage);
              continue;
            } else {
              // Final attempt with max slippage
              const maxSlippagePrice = fillPrice * (1 - this.MAX_SLIPPAGE_PERCENT / 100);
              const maxSlippagePriceString = await this.formatPrice(maxSlippagePrice, coin);
              console.log(`   🔄 IOC failed for ${coin} after ${this.MAX_RETRIES} attempts, trying FrontendMarket (slippage: ${this.MAX_SLIPPAGE_PERCENT}%)`);
              return await this.walletClient!.order({
                orders: [{
                  a: coinIndex,
                  b: false,
                  p: maxSlippagePriceString,
                  s: validationResult.formattedSize,
                  r: reduceOnly,
                  t: { limit: { tif: 'FrontendMarket' } }
                }],
                grouping: 'na'
              });
            }
          }

          throw new Error(errorMessage);
        }

        return orderResponse;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.toLowerCase().includes('could not immediately match')) {
          if (attempt < this.MAX_RETRIES) {
            console.log(`   🔄 IOC failed for ${coin}, retry ${attempt}/${this.MAX_RETRIES} (slippage: ${slippagePercent}%)`);
            await this.sleep(this.RETRY_DELAY_MS);
            lastError = error instanceof Error ? error : new Error(errorMessage);
            continue;
          } else {
            // Final attempt with max slippage
            const maxSlippagePrice = fillPrice * (1 - this.MAX_SLIPPAGE_PERCENT / 100);
            const maxSlippagePriceString = await this.formatPrice(maxSlippagePrice, coin);
            console.log(`   🔄 IOC failed for ${coin} after ${this.MAX_RETRIES} attempts, trying FrontendMarket (slippage: ${this.MAX_SLIPPAGE_PERCENT}%)`);
            return await this.walletClient!.order({
              orders: [{
                a: coinIndex,
                b: false,
                p: maxSlippagePriceString,
                s: validationResult.formattedSize,
                r: reduceOnly,
                t: { limit: { tif: 'FrontendMarket' } }
              }],
              grouping: 'na'
            });
          }
        }

        lastError = error instanceof Error ? error : new Error(errorMessage);
        throw error;
      }
    }

      if (lastError && this.telegramService?.isEnabled()) {
        this.telegramService.sendError(`SELL order failed for ${coin} after ${this.MAX_RETRIES} retries: ${lastError.message}`).catch(() => {});
      }

      throw lastError || new Error(`Order failed after ${this.MAX_RETRIES} attempts`);
    })();

    return Promise.race([orderPromise, timeoutPromise]);
  }

  async openLong(coin: string, size: number, fillPrice: number): Promise<OrderResponse> {
    return await this.placeMarketBuy(coin, size, fillPrice);
  }

  async openShort(coin: string, size: number, fillPrice: number): Promise<OrderResponse> {
    return await this.placeMarketSell(coin, size, fillPrice);
  }

  async closePosition(coin: string, fillPrice: number, size?: number): Promise<OrderResponse> {
    this.ensureWalletClient();
    const positions = await this.getOpenPositions(this.userAddress!);
    const position = positions.find(p => p.coin === coin);

    if (!position) {
      throw new Error(`No open position for ${coin}`);
    }

    const requestedSize = size || position.size;
    const closeSize = Math.min(requestedSize, position.size);

    if (requestedSize > position.size) {
      console.warn(`⚠️  Requested close size ${requestedSize} exceeds position size ${position.size} for ${coin}. Capping to prevent flip.`);
    }

    const isLong = position.side === 'long';

    if (isLong) {
      return await this.placeMarketSell(coin, closeSize, fillPrice, true);
    } else {
      return await this.placeMarketBuy(coin, closeSize, fillPrice, true);
    }
  }

  async reducePosition(coin: string, reduceSize: number, fillPrice: number): Promise<OrderResponse> {
    return await this.closePosition(coin, fillPrice, reduceSize);
  }

  canExecuteTrades(): boolean {
    if (this.walletClient === null) {
      return false;
    }
    if (this.telegramService && this.telegramService.isTradingPaused()) {
      return false;
    }
    return true;
  }

  async cleanup(): Promise<void> {
    this.saveTickSizeCache();
    this.metaCache.clear();
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
