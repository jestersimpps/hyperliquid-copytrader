import {
  PublicClient,
  WalletClient,
  HttpTransport,
  AssetPosition,
  OrderResponse
} from '@nktkas/hyperliquid'
import { privateKeyToAccount } from 'viem/accounts'
import { Position, Balance, MultiAccountConfig } from '@/models'
import * as fs from 'fs'
import * as path from 'path'

interface CoinMeta {
  index: number
  name: string
  szDecimals: number
}

export class HyperliquidService {
  private publicClient: PublicClient
  private walletClient: WalletClient | null = null
  private metaCache: Map<string, CoinMeta> = new Map()
  private tickSizeCache: Map<string, number> = new Map()
  private readonly TICK_SIZE_CACHE_FILE = path.resolve(process.cwd(), 'data', 'tick-sizes.json')
  private readonly MAX_RETRIES = 3
  private readonly BASE_SLIPPAGE_PERCENT = 1.0
  private readonly SLIPPAGE_INCREMENT = 0.5
  private readonly MAX_SLIPPAGE_PERCENT = 3
  private globalMinOrderValue: number

  constructor(config: MultiAccountConfig) {
    const httpUrl = config.isTestnet
      ? 'https://api.hyperliquid-testnet.xyz'
      : 'https://api.hyperliquid.xyz'

    const httpTransport = new HttpTransport({
      url: httpUrl,
      timeout: 30000,
      fetchOptions: { keepalive: false }
    })

    this.publicClient = new PublicClient({ transport: httpTransport })
    this.globalMinOrderValue = config.globalMinOrderValue

    if (config.privateKey) {
      const account = privateKeyToAccount(config.privateKey as `0x${string}`)
      this.walletClient = new WalletClient({
        wallet: account,
        transport: httpTransport,
        isTestnet: config.isTestnet
      })
    }
  }

  async initialize(): Promise<void> {
    await this.refreshMetaCache()
    this.loadTickSizeCache()
    console.log(`✓ HyperliquidService initialized with ${this.metaCache.size} coins`)
  }

  private async refreshMetaCache(): Promise<void> {
    const meta = await this.publicClient.meta()
    this.metaCache.clear()
    meta.universe.forEach((asset, index) => {
      this.metaCache.set(asset.name, {
        index,
        name: asset.name,
        szDecimals: asset.szDecimals
      })
    })
  }

  private loadTickSizeCache(): void {
    try {
      if (fs.existsSync(this.TICK_SIZE_CACHE_FILE)) {
        const data = fs.readFileSync(this.TICK_SIZE_CACHE_FILE, 'utf-8')
        const cache = JSON.parse(data)
        Object.entries(cache).forEach(([coin, tickSize]) => {
          if (coin !== 'lastUpdated' && typeof tickSize === 'number') {
            this.tickSizeCache.set(coin, tickSize)
          }
        })
        console.log(`✓ Loaded ${this.tickSizeCache.size} tick sizes from cache`)
      }
    } catch (error) {
      console.error('Failed to load tick size cache:', error instanceof Error ? error.message : error)
    }
  }

  private saveTickSizeCache(): void {
    try {
      const dataDir = path.dirname(this.TICK_SIZE_CACHE_FILE)
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
      }
      const cache: Record<string, number | string> = { lastUpdated: new Date().toISOString() }
      this.tickSizeCache.forEach((tickSize, coin) => { cache[coin] = tickSize })
      fs.writeFileSync(this.TICK_SIZE_CACHE_FILE, JSON.stringify(cache, null, 2))
    } catch (error) {
      console.error('Failed to save tick size cache:', error instanceof Error ? error.message : error)
    }
  }

  async getOpenPositions(walletAddress: string): Promise<Position[]> {
    return this.withRetry(async () => {
      const state = await this.publicClient.clearinghouseState({
        user: walletAddress as `0x${string}`
      })

      return state.assetPositions
        .filter((pos: AssetPosition) => parseFloat(pos.position.szi) !== 0)
        .map((pos: AssetPosition) => {
          const size = parseFloat(pos.position.szi)
          const markPrice = parseFloat(pos.position.positionValue) / Math.abs(size)
          return {
            coin: pos.position.coin,
            size: Math.abs(size),
            entryPrice: parseFloat(pos.position.entryPx || '0'),
            markPrice,
            unrealizedPnl: parseFloat(pos.position.unrealizedPnl),
            leverage: typeof pos.position.leverage.value === 'number'
              ? pos.position.leverage.value
              : parseFloat(pos.position.leverage.value),
            marginUsed: parseFloat(pos.position.marginUsed),
            liquidationPrice: parseFloat(pos.position.liquidationPx || '0'),
            side: size > 0 ? 'long' : 'short',
            notionalValue: Math.abs(size) * markPrice
          } as Position
        })
    }, `getOpenPositions(${walletAddress.slice(0, 6)}...)`)
  }

  async getAccountBalance(walletAddress: string): Promise<Balance> {
    return this.withRetry(async () => {
      const state = await this.publicClient.clearinghouseState({
        user: walletAddress as `0x${string}`
      })

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
      }
    }, `getAccountBalance(${walletAddress.slice(0, 6)}...)`)
  }

  private getCoinIndex(coin: string): number {
    const meta = this.metaCache.get(coin)
    if (!meta) throw new Error(`Coin ${coin} not found in meta cache`)
    return meta.index
  }

  private getSizeDecimals(coin: string): number {
    const meta = this.metaCache.get(coin)
    if (!meta) throw new Error(`Coin ${coin} size decimals not found`)
    return meta.szDecimals
  }

  private async getTickSize(coin: string): Promise<number> {
    if (this.tickSizeCache.has(coin)) {
      return this.tickSizeCache.get(coin)!
    }

    const book = await this.publicClient.l2Book({ coin })
    const bids = book.levels[0]
    let tickSize = 0.01

    if (bids && bids.length >= 2) {
      const price1 = parseFloat(bids[0].px)
      const price2 = parseFloat(bids[1].px)
      let diff = Math.abs(price1 - price2)

      if (diff === 0 && bids.length >= 3) {
        diff = Math.abs(price1 - parseFloat(bids[2].px))
      }

      if (diff > 0) {
        const isCloseTo = (value: number, target: number): boolean => Math.abs(value - target) < target * 0.1
        if (diff >= 10 || isCloseTo(diff, 10)) tickSize = 10
        else if (diff >= 5 || isCloseTo(diff, 5)) tickSize = 5
        else if (diff >= 1 || isCloseTo(diff, 1)) tickSize = 1
        else if (diff >= 0.5 || isCloseTo(diff, 0.5)) tickSize = 0.5
        else if (diff >= 0.1 || isCloseTo(diff, 0.1)) tickSize = 0.1
        else if (diff >= 0.05 || isCloseTo(diff, 0.05)) tickSize = 0.05
        else if (diff >= 0.01 || isCloseTo(diff, 0.01)) tickSize = 0.01
        else if (diff >= 0.005 || isCloseTo(diff, 0.005)) tickSize = 0.005
        else if (diff >= 0.001 || isCloseTo(diff, 0.001)) tickSize = 0.001
        else if (diff >= 0.0005 || isCloseTo(diff, 0.0005)) tickSize = 0.0005
        else if (diff >= 0.0001 || isCloseTo(diff, 0.0001)) tickSize = 0.0001
        else if (diff >= 0.00005 || isCloseTo(diff, 0.00005)) tickSize = 0.00005
        else if (diff >= 0.00001 || isCloseTo(diff, 0.00001)) tickSize = 0.00001
        else tickSize = 0.00001
      }
    }

    this.tickSizeCache.set(coin, tickSize)
    this.saveTickSizeCache()
    return tickSize
  }

  private roundToTickSize(price: number, tickSize: number): number {
    const rounded = Math.round(price / tickSize) * tickSize
    const decimals = this.getDecimalsFromTickSize(tickSize)
    return parseFloat(rounded.toFixed(decimals))
  }

  private getDecimalsFromTickSize(tickSize: number): number {
    if (tickSize >= 1) return 0
    if (tickSize >= 0.1) return 1
    if (tickSize >= 0.01) return 2
    if (tickSize >= 0.001) return 3
    if (tickSize >= 0.0001) return 4
    if (tickSize >= 0.00001) return 5
    return 6
  }

  async formatPrice(price: number, coin: string): Promise<string> {
    const tickSize = await this.getTickSize(coin)
    const rounded = this.roundToTickSize(price, tickSize)
    const decimals = this.getDecimalsFromTickSize(tickSize)
    return rounded.toFixed(decimals)
  }

  formatSize(size: number, coin: string): string {
    const decimals = this.getSizeDecimals(coin)
    return size.toFixed(decimals)
  }

  private validateOrderSize(size: number, coin: string, price: number, minOrderValue?: number): { size: number; formattedSize: string } {
    const decimals = this.getSizeDecimals(coin)
    let formattedSize = size.toFixed(decimals)
    let parsedSize = parseFloat(formattedSize)
    const orderValue = parsedSize * price
    const minValue = minOrderValue ?? this.globalMinOrderValue

    if (orderValue < minValue) {
      const minSize = minValue / price
      const step = Math.pow(10, -decimals)
      parsedSize = Math.ceil(minSize / step) * step
      formattedSize = parsedSize.toFixed(decimals)
      console.log(`   ⚠️  Adjusted ${coin}: ${size.toFixed(decimals)} → ${formattedSize} ($${orderValue.toFixed(2)} → $${(parsedSize * price).toFixed(2)})`)
    }

    return { size: parsedSize, formattedSize }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private async withRetry<T>(operation: () => Promise<T>, operationName: string, maxRetries: number = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error) {
        const isLastAttempt = attempt === maxRetries
        const errorMessage = error instanceof Error ? error.message : String(error)

        if (isLastAttempt) {
          throw error
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
        console.log(`   🔄 ${operationName} failed (attempt ${attempt}/${maxRetries}): ${errorMessage}, retrying in ${delay}ms...`)
        await this.sleep(delay)
      }
    }
    throw new Error(`${operationName} failed after ${maxRetries} attempts`)
  }

  private async placeMarketBuy(
    coin: string,
    size: number,
    fillPrice: number,
    reduceOnly: boolean = false,
    vaultAddress?: string,
    minOrderValue?: number
  ): Promise<OrderResponse> {
    if (!this.walletClient) throw new Error('Wallet client not initialized')

    const coinIndex = this.getCoinIndex(coin)
    const validated = this.validateOrderSize(size, coin, fillPrice, minOrderValue)

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      const slippagePercent = this.BASE_SLIPPAGE_PERCENT + (this.SLIPPAGE_INCREMENT * (attempt - 1))
      const orderPrice = fillPrice * (1 + slippagePercent / 100)
      const priceString = await this.formatPrice(orderPrice, coin)

      try {
        const orderParams: Parameters<typeof this.walletClient.order>[0] = {
          orders: [{
            a: coinIndex,
            b: true,
            p: priceString,
            s: validated.formattedSize,
            r: reduceOnly,
            t: { limit: { tif: reduceOnly ? 'FrontendMarket' : 'Ioc' } }
          }],
          grouping: 'na'
        }

        if (vaultAddress) {
          orderParams.vaultAddress = vaultAddress as `0x${string}`
        }

        const response = await this.walletClient.order(orderParams)

        const status = response.response.data.statuses[0]
        if (status && 'error' in status) {
          if (status.error.toLowerCase().includes('could not immediately match') && attempt < this.MAX_RETRIES) {
            console.log(`   🔄 IOC failed for ${coin}, retry ${attempt}/${this.MAX_RETRIES}`)
            await this.sleep(100)
            continue
          }
          throw new Error(status.error)
        }
        return response
      } catch (error) {
        if (attempt === this.MAX_RETRIES) {
          const maxPrice = fillPrice * (1 + this.MAX_SLIPPAGE_PERCENT / 100)
          const maxPriceString = await this.formatPrice(maxPrice, coin)
          const fallbackParams: Parameters<typeof this.walletClient.order>[0] = {
            orders: [{
              a: coinIndex,
              b: true,
              p: maxPriceString,
              s: validated.formattedSize,
              r: reduceOnly,
              t: { limit: { tif: 'FrontendMarket' } }
            }],
            grouping: 'na'
          }
          if (vaultAddress) {
            fallbackParams.vaultAddress = vaultAddress as `0x${string}`
          }
          return await this.walletClient.order(fallbackParams)
        }
        throw error
      }
    }

    throw new Error(`Order failed after ${this.MAX_RETRIES} attempts`)
  }

  private async placeMarketSell(
    coin: string,
    size: number,
    fillPrice: number,
    reduceOnly: boolean = false,
    vaultAddress?: string,
    minOrderValue?: number
  ): Promise<OrderResponse> {
    if (!this.walletClient) throw new Error('Wallet client not initialized')

    const coinIndex = this.getCoinIndex(coin)
    const validated = this.validateOrderSize(size, coin, fillPrice, minOrderValue)

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      const slippagePercent = this.BASE_SLIPPAGE_PERCENT + (this.SLIPPAGE_INCREMENT * (attempt - 1))
      const orderPrice = fillPrice * (1 - slippagePercent / 100)
      const priceString = await this.formatPrice(orderPrice, coin)

      try {
        const orderParams: Parameters<typeof this.walletClient.order>[0] = {
          orders: [{
            a: coinIndex,
            b: false,
            p: priceString,
            s: validated.formattedSize,
            r: reduceOnly,
            t: { limit: { tif: reduceOnly ? 'FrontendMarket' : 'Ioc' } }
          }],
          grouping: 'na'
        }

        if (vaultAddress) {
          orderParams.vaultAddress = vaultAddress as `0x${string}`
        }

        const response = await this.walletClient.order(orderParams)

        const status = response.response.data.statuses[0]
        if (status && 'error' in status) {
          if (status.error.toLowerCase().includes('could not immediately match') && attempt < this.MAX_RETRIES) {
            console.log(`   🔄 IOC failed for ${coin}, retry ${attempt}/${this.MAX_RETRIES}`)
            await this.sleep(100)
            continue
          }
          throw new Error(status.error)
        }
        return response
      } catch (error) {
        if (attempt === this.MAX_RETRIES) {
          const maxPrice = fillPrice * (1 - this.MAX_SLIPPAGE_PERCENT / 100)
          const maxPriceString = await this.formatPrice(maxPrice, coin)
          const fallbackParams: Parameters<typeof this.walletClient.order>[0] = {
            orders: [{
              a: coinIndex,
              b: false,
              p: maxPriceString,
              s: validated.formattedSize,
              r: reduceOnly,
              t: { limit: { tif: 'FrontendMarket' } }
            }],
            grouping: 'na'
          }
          if (vaultAddress) {
            fallbackParams.vaultAddress = vaultAddress as `0x${string}`
          }
          return await this.walletClient.order(fallbackParams)
        }
        throw error
      }
    }

    throw new Error(`Order failed after ${this.MAX_RETRIES} attempts`)
  }

  async openLong(coin: string, size: number, price: number, vaultAddress?: string, minOrderValue?: number): Promise<OrderResponse> {
    return await this.placeMarketBuy(coin, size, price, false, vaultAddress, minOrderValue)
  }

  async openShort(coin: string, size: number, price: number, vaultAddress?: string, minOrderValue?: number): Promise<OrderResponse> {
    return await this.placeMarketSell(coin, size, price, false, vaultAddress, minOrderValue)
  }

  async closePosition(coin: string, price: number, userWallet: string, size?: number, vaultAddress?: string, minOrderValue?: number): Promise<OrderResponse> {
    if (!this.walletClient) throw new Error('Wallet client not initialized')

    const positionWallet = vaultAddress || userWallet
    const positions = await this.getOpenPositions(positionWallet)
    const position = positions.find(p => p.coin === coin)
    if (!position) throw new Error(`No open position for ${coin}`)

    const closeSize = size ? Math.min(size, position.size) : position.size

    if (position.side === 'long') {
      return await this.placeMarketSell(coin, closeSize, price, true, vaultAddress, minOrderValue)
    } else {
      return await this.placeMarketBuy(coin, closeSize, price, true, vaultAddress, minOrderValue)
    }
  }

  async reducePosition(coin: string, reduceSize: number, price: number, userWallet: string, vaultAddress?: string, minOrderValue?: number): Promise<OrderResponse> {
    return await this.closePosition(coin, price, userWallet, reduceSize, vaultAddress, minOrderValue)
  }

  async addToPosition(coin: string, size: number, price: number, side: 'long' | 'short', vaultAddress?: string, minOrderValue?: number): Promise<OrderResponse> {
    if (side === 'long') {
      return await this.placeMarketBuy(coin, size, price, false, vaultAddress, minOrderValue)
    } else {
      return await this.placeMarketSell(coin, size, price, false, vaultAddress, minOrderValue)
    }
  }

  canExecuteTrades(): boolean {
    return this.walletClient !== null
  }
}
