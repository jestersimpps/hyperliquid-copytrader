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

  constructor(privateKey: string | null, walletAddress: string | null, isTestnet: boolean = false) {
    this.isTestnet = isTestnet;
    this.userAddress = walletAddress;
    this.minOrderValue = loadConfig().minOrderValue;

    const httpUrl = isTestnet
      ? 'https://api.hyperliquid-testnet.xyz'
      : 'https://api.hyperliquid.xyz';

    const httpTransport = new HttpTransport({
      url: httpUrl,
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

    await this.metaCache.initialize();

    this.loadTickSizeCache();

    this.initialized = true;
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
      return {
        coin: pos.position.coin,
        size: Math.abs(size),
        entryPrice: parseFloat(pos.position.entryPx || '0'),
        markPrice: parseFloat(pos.position.positionValue) / Math.abs(size),
        unrealizedPnl: parseFloat(pos.position.unrealizedPnl),
        leverage: typeof pos.position.leverage.value === 'number' ? pos.position.leverage.value : parseFloat(pos.position.leverage.value),
        marginUsed: parseFloat(pos.position.marginUsed),
        liquidationPrice: parseFloat(pos.position.liquidationPx || '0'),
        side: size > 0 ? 'long' : 'short'
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

  getCoinIndex(coin: string): number {
    const index = this.metaCache.getCoinIndexSync(coin);
    if (index === null) {
      throw new Error(`Coin ${coin} not found in metadata cache`);
    }
    return index;
  }

  private getSizeDecimals(coin: string): number {
    const decimals = this.metaCache.getSizeDecimalsSync(coin);
    if (decimals === null) {
      throw new Error(`Coin ${coin} not found in metadata cache`);
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

  formatSize(size: number, coin: string): string {
    const decimals = this.getSizeDecimals(coin);
    return size.toFixed(decimals);
  }

  private ensureWalletClient(): void {
    if (!this.walletClient) {
      throw new Error('Wallet client not initialized. Trading operations require private key.');
    }
  }

  async placeMarketBuy(coin: string, size: number, fillPrice: number, reduceOnly: boolean = false): Promise<OrderResponse> {
    this.ensureWalletClient();
    const coinIndex = this.getCoinIndex(coin);

    // Use the tracked wallet's fill price with slippage
    const orderPrice = fillPrice * 1.005;
    const priceString = await this.formatPrice(orderPrice, coin);

    const sizeDecimals = this.getSizeDecimals(coin);
    const initialFormattedSize = this.formatSize(size, coin);

    // API validates using the base price without slippage
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

    return await this.walletClient!.order({
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
  }

  async placeMarketSell(coin: string, size: number, fillPrice: number, reduceOnly: boolean = false): Promise<OrderResponse> {
    this.ensureWalletClient();
    const coinIndex = this.getCoinIndex(coin);

    // Use the tracked wallet's fill price with slippage
    const orderPrice = fillPrice * 0.995;
    const priceString = await this.formatPrice(orderPrice, coin);

    const sizeDecimals = this.getSizeDecimals(coin);
    const initialFormattedSize = this.formatSize(size, coin);

    // API validates using the base price without slippage
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

    return await this.walletClient!.order({
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
    return this.walletClient !== null;
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
