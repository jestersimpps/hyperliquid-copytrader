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
import { MidsCacheService } from './mids-cache.service';
import { MetaCacheService } from './meta-cache.service';

export class HyperliquidService {
  public publicClient: PublicClient;
  private walletClient: WalletClient | null = null;
  private isTestnet: boolean;
  private userAddress: string | null = null;
  private midsCache: MidsCacheService;
  private metaCache: MetaCacheService;
  private initialized: boolean = false;

  constructor(privateKey: string | null, walletAddress: string | null, isTestnet: boolean = false) {
    this.isTestnet = isTestnet;
    this.userAddress = walletAddress;

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

    this.midsCache = new MidsCacheService(isTestnet);
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

    await Promise.all([
      this.midsCache.initialize(),
      this.metaCache.initialize()
    ]);

    this.initialized = true;
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
        leverage: parseFloat(pos.position.leverage.value),
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
      withdrawable: state.withdrawable,
      marginUsed: (state as any).marginUsed || '0',
      accountValue: state.marginSummary.accountValue
    };
  }

  async getCoinIndex(coin: string): Promise<number> {
    return await this.metaCache.getCoinIndex(coin);
  }

  private async getSizeDecimals(coin: string): Promise<number> {
    return await this.metaCache.getSizeDecimals(coin);
  }

  private async getTickSize(coin: string): Promise<number> {
    const book = await this.publicClient.l2Book({ coin });
    const bids = book.levels[0];

    if (!bids || bids.length < 2) {
      return 0.01;
    }

    const price1 = parseFloat(bids[0].px);
    const price2 = parseFloat(bids[1].px);
    let diff = Math.abs(price1 - price2);

    if (diff === 0 && bids.length >= 3) {
      const price3 = parseFloat(bids[2].px);
      diff = Math.abs(price1 - price3);
    }

    if (diff === 0) return 0.01;

    const isCloseTo = (value: number, target: number): boolean => {
      return Math.abs(value - target) < target * 0.1;
    };

    if (diff >= 10 || isCloseTo(diff, 10)) return 10;
    if (diff >= 5 || isCloseTo(diff, 5)) return 5;
    if (diff >= 1 || isCloseTo(diff, 1)) return 1;
    if (diff >= 0.5 || isCloseTo(diff, 0.5)) return 0.5;
    if (diff >= 0.1 || isCloseTo(diff, 0.1)) return 0.1;
    if (diff >= 0.05 || isCloseTo(diff, 0.05)) return 0.05;
    if (diff >= 0.01 || isCloseTo(diff, 0.01)) return 0.01;
    if (diff >= 0.005 || isCloseTo(diff, 0.005)) return 0.005;
    if (diff >= 0.001 || isCloseTo(diff, 0.001)) return 0.001;
    if (diff >= 0.0005 || isCloseTo(diff, 0.0005)) return 0.0005;
    if (diff >= 0.0001 || isCloseTo(diff, 0.0001)) return 0.0001;
    if (diff >= 0.00005 || isCloseTo(diff, 0.00005)) return 0.00005;
    if (diff >= 0.00001 || isCloseTo(diff, 0.00001)) return 0.00001;

    return 0.00001;
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

  private async getMarketPrice(coin: string, isBuy: boolean): Promise<string> {
    const mid = this.midsCache.getMid(coin);

    if (!mid) {
      const book = await this.publicClient.l2Book({ coin });
      const levels = isBuy ? book.levels[1] : book.levels[0];
      if (!levels || levels.length === 0) {
        throw new Error(`No market price available for ${coin}`);
      }
      const price = parseFloat(levels[0].px);
      const slippage = isBuy ? 1.005 : 0.995;
      return await this.formatPrice(price * slippage, coin);
    }

    const slippage = isBuy ? 1.005 : 0.995;
    return await this.formatPrice(mid * slippage, coin);
  }

  private ensureWalletClient(): void {
    if (!this.walletClient) {
      throw new Error('Wallet client not initialized. Trading operations require private key.');
    }
  }

  async placeMarketBuy(coin: string, size: number): Promise<OrderResponse> {
    this.ensureWalletClient();
    const coinIndex = await this.getCoinIndex(coin);
    const price = await this.getMarketPrice(coin, true);
    const formattedSize = await this.formatSize(size, coin);

    return await this.walletClient!.order({
      orders: [{
        a: coinIndex,
        b: true,
        p: price,
        s: formattedSize,
        r: false,
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    });
  }

  async placeMarketSell(coin: string, size: number): Promise<OrderResponse> {
    this.ensureWalletClient();
    const coinIndex = await this.getCoinIndex(coin);
    const price = await this.getMarketPrice(coin, false);
    const formattedSize = await this.formatSize(size, coin);

    return await this.walletClient!.order({
      orders: [{
        a: coinIndex,
        b: false,
        p: price,
        s: formattedSize,
        r: false,
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    });
  }

  async openLong(coin: string, size: number): Promise<OrderResponse> {
    return await this.placeMarketBuy(coin, size);
  }

  async openShort(coin: string, size: number): Promise<OrderResponse> {
    return await this.placeMarketSell(coin, size);
  }

  async closePosition(coin: string, size?: number): Promise<OrderResponse> {
    this.ensureWalletClient();
    const positions = await this.getOpenPositions(this.userAddress!);
    const position = positions.find(p => p.coin === coin);

    if (!position) {
      throw new Error(`No open position for ${coin}`);
    }

    const closeSize = size || position.size;
    const isLong = position.side === 'long';

    if (isLong) {
      return await this.placeMarketSell(coin, closeSize);
    } else {
      return await this.placeMarketBuy(coin, closeSize);
    }
  }

  async reducePosition(coin: string, reduceSize: number): Promise<OrderResponse> {
    return await this.closePosition(coin, reduceSize);
  }

  canExecuteTrades(): boolean {
    return this.walletClient !== null;
  }

  async cleanup(): Promise<void> {
    await this.midsCache.close();
    this.metaCache.clear();
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
