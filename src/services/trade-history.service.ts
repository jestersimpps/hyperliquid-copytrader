import type { Fill } from '@nktkas/hyperliquid';
import type { PublicClient } from '@nktkas/hyperliquid';
import { scaleChangeAmount, formatScaledSize } from '../utils/scaling.utils';

export interface TradeAction {
  action: 'open' | 'close' | 'add' | 'reduce' | 'reverse';
  coin: string;
  side: 'long' | 'short';
  size: number;
  reason: string;
  isIgnored: boolean;
}

interface ProcessedTradesCache {
  tids: Set<number>;
  lastProcessedTime: number;
  lastCleanup: number;
}

export class TradeHistoryService {
  private processedTrades: Map<string, ProcessedTradesCache> = new Map();
  private readonly LOOKBACK_BUFFER_MS = 5000; // 5 seconds lookback to catch missed trades
  private readonly CLEANUP_INTERVAL_MS = 60000; // Clean up old tids every minute
  private readonly TID_RETENTION_MS = 300000; // Keep tids for 5 minutes

  constructor(
    private publicClient: PublicClient,
    private balanceRatio: number
  ) {}

  async getNewFills(trackedWallet: string): Promise<Fill[]> {
    const cache = this.getOrCreateCache(trackedWallet);

    // Calculate start time with buffer to catch any missed trades
    const startTime = cache.lastProcessedTime - this.LOOKBACK_BUFFER_MS;

    try {
      // Fetch fills since last poll
      const fills = await this.publicClient.userFillsByTime({
        user: trackedWallet as `0x${string}`,
        startTime
      });

      // Filter to only new fills
      const newFills = fills.filter(fill => {
        const isNew = fill.time > cache.lastProcessedTime && !cache.tids.has(fill.tid);
        return isNew;
      });

      // Mark fills as processed
      newFills.forEach(fill => {
        cache.tids.add(fill.tid);
      });

      // Update last processed time
      if (newFills.length > 0) {
        const latestTime = Math.max(...newFills.map(f => f.time));
        cache.lastProcessedTime = Math.max(cache.lastProcessedTime, latestTime);
      } else {
        cache.lastProcessedTime = Date.now();
      }

      // Cleanup old tids periodically
      if (Date.now() - cache.lastCleanup > this.CLEANUP_INTERVAL_MS) {
        this.cleanupOldTids(trackedWallet);
      }

      return newFills;
    } catch (error) {
      console.error(`Failed to fetch fills for ${trackedWallet}:`, error instanceof Error ? error.message : error);
      return [];
    }
  }

  determineAction(fill: Fill): TradeAction | null {
    const prevPosition = parseFloat(fill.startPosition);
    const tradeSize = parseFloat(fill.sz);
    const isBuy = fill.side === 'B';

    // Calculate final position after this fill
    const finalPosition = isBuy ? prevPosition + tradeSize : prevPosition - tradeSize;

    // Determine side based on final position
    const newSide = finalPosition > 0 ? 'long' : finalPosition < 0 ? 'short' : 'long'; // Default to long if closed
    const prevSide = prevPosition > 0 ? 'long' : prevPosition < 0 ? 'short' : 'long';

    // Scale the size by balance ratio
    const scaledSize = formatScaledSize(scaleChangeAmount(tradeSize, this.balanceRatio));

    // OPENED: Previous position was 0, now it's not
    if (prevPosition === 0 && finalPosition !== 0) {
      const totalScaledSize = formatScaledSize(scaleChangeAmount(Math.abs(finalPosition), this.balanceRatio));
      return {
        action: 'open',
        coin: fill.coin,
        side: newSide,
        size: totalScaledSize,
        reason: `Tracked wallet opened ${newSide.toUpperCase()} position in ${fill.coin} @ $${parseFloat(fill.px).toFixed(2)}.`,
        isIgnored: false
      };
    }

    // CLOSED: Previous position existed, now it's 0
    if (prevPosition !== 0 && finalPosition === 0) {
      return {
        action: 'close',
        coin: fill.coin,
        side: prevSide,
        size: scaledSize,
        reason: `Tracked wallet closed ${prevSide.toUpperCase()} position in ${fill.coin} @ $${parseFloat(fill.px).toFixed(2)}.`,
        isIgnored: false
      };
    }

    // REVERSED: Position changed from long to short or vice versa
    if (prevPosition !== 0 && finalPosition !== 0 && Math.sign(prevPosition) !== Math.sign(finalPosition)) {
      const totalScaledSize = formatScaledSize(scaleChangeAmount(Math.abs(finalPosition), this.balanceRatio));
      return {
        action: 'reverse',
        coin: fill.coin,
        side: newSide,
        size: totalScaledSize,
        reason: `Tracked wallet reversed ${fill.coin} from ${prevSide.toUpperCase()} to ${newSide.toUpperCase()} @ $${parseFloat(fill.px).toFixed(2)}.`,
        isIgnored: false
      };
    }

    // INCREASED: Position size increased (same direction)
    if (Math.abs(finalPosition) > Math.abs(prevPosition)) {
      return {
        action: 'add',
        coin: fill.coin,
        side: newSide,
        size: scaledSize,
        reason: `Tracked wallet increased ${newSide.toUpperCase()} position in ${fill.coin} by ${tradeSize.toFixed(4)} @ $${parseFloat(fill.px).toFixed(2)}.`,
        isIgnored: false
      };
    }

    // DECREASED: Position size decreased (partial close)
    if (Math.abs(finalPosition) < Math.abs(prevPosition)) {
      return {
        action: 'reduce',
        coin: fill.coin,
        side: prevSide,
        size: scaledSize,
        reason: `Tracked wallet decreased ${prevSide.toUpperCase()} position in ${fill.coin} by ${tradeSize.toFixed(4)} @ $${parseFloat(fill.px).toFixed(2)}.`,
        isIgnored: false
      };
    }

    // No significant change
    return null;
  }

  private getOrCreateCache(wallet: string): ProcessedTradesCache {
    if (!this.processedTrades.has(wallet)) {
      this.processedTrades.set(wallet, {
        tids: new Set(),
        lastProcessedTime: Date.now() - this.LOOKBACK_BUFFER_MS, // Start with a small lookback
        lastCleanup: Date.now()
      });
    }
    return this.processedTrades.get(wallet)!;
  }

  private cleanupOldTids(wallet: string): void {
    const cache = this.processedTrades.get(wallet);
    if (!cache) return;

    const cutoffTime = Date.now() - this.TID_RETENTION_MS;

    // Note: We can't easily determine tid timestamp, so we'll just clear the entire set
    // after retention period. In practice, this is fine since we track by lastProcessedTime.
    // A more sophisticated approach would map tid -> timestamp, but that adds complexity.

    // For simplicity, just limit the set size
    if (cache.tids.size > 1000) {
      // Keep only the most recent 500 tids (rough heuristic)
      const tidsArray = Array.from(cache.tids);
      cache.tids.clear();
      tidsArray.slice(-500).forEach(tid => cache.tids.add(tid));
    }

    cache.lastCleanup = Date.now();
  }

  reset(): void {
    this.processedTrades.clear();
  }
}
