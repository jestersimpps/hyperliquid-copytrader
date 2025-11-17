import type { Position } from '../models';
import type { WalletComparison, PositionComparison, TradeRecommendation } from '../models/comparison.model';

export class CopyTradingService {
  private readonly COPY_PERCENTAGE: number = 1.0;
  private readonly MIN_POSITION_VALUE: number = 10;

  compareWallets(
    trackedWallet: string,
    userWallet: string,
    trackedBalance: number,
    userBalance: number
  ): WalletComparison {
    return {
      trackedWallet,
      userWallet,
      trackedBalance,
      userBalance,
      balanceRatio: userBalance / trackedBalance
    };
  }

  comparePositions(
    trackedPositions: Position[],
    userPositions: Position[],
    walletComparison: WalletComparison,
    currentPrices: Map<string, number>
  ): PositionComparison[] {
    const allCoins = new Set([
      ...trackedPositions.map(p => p.coin),
      ...userPositions.map(p => p.coin)
    ]);

    const comparisons: PositionComparison[] = [];

    allCoins.forEach(coin => {
      const trackedPos = trackedPositions.find(p => p.coin === coin);
      const userPos = userPositions.find(p => p.coin === coin);

      const comparison = this.comparePosition(
        coin,
        trackedPos,
        userPos,
        walletComparison,
        currentPrices.get(coin) || trackedPos?.markPrice || userPos?.markPrice || 0
      );

      comparisons.push(comparison);
    });

    return comparisons;
  }

  private comparePosition(
    coin: string,
    trackedPos: Position | undefined,
    userPos: Position | undefined,
    walletComparison: WalletComparison,
    currentPrice: number
  ): PositionComparison {
    const trackedData = trackedPos ? {
      size: trackedPos.size,
      side: trackedPos.side,
      entryPrice: trackedPos.entryPrice,
      accountPercentage: (trackedPos.size * trackedPos.markPrice / walletComparison.trackedBalance) * 100
    } : null;

    const userData = userPos ? {
      size: userPos.size,
      side: userPos.side,
      entryPrice: userPos.entryPrice,
      accountPercentage: (userPos.size * userPos.markPrice / walletComparison.userBalance) * 100
    } : null;

    const recommendation = this.calculateRecommendation(
      coin,
      trackedData,
      userData,
      walletComparison,
      currentPrice
    );

    return {
      coin,
      trackedPosition: trackedData,
      userPosition: userData,
      recommendation
    };
  }

  private calculateRecommendation(
    coin: string,
    trackedPos: { size: number; side: 'long' | 'short'; accountPercentage: number } | null,
    userPos: { size: number; side: 'long' | 'short'; accountPercentage: number } | null,
    walletComparison: WalletComparison,
    currentPrice: number
  ): TradeRecommendation | null {
    if (!trackedPos && !userPos) {
      return null;
    }

    if (!trackedPos && userPos) {
      return {
        action: 'close',
        coin,
        side: userPos.side,
        currentSize: userPos.size,
        targetSize: 0,
        tradeSize: userPos.size,
        targetPercentage: 0,
        estimatedValue: userPos.size * currentPrice
      };
    }

    const targetPercentage = trackedPos!.accountPercentage * this.COPY_PERCENTAGE;
    const targetValue = (walletComparison.userBalance * targetPercentage) / 100;
    const targetSize = targetValue / currentPrice;

    if (targetValue < this.MIN_POSITION_VALUE) {
      if (userPos) {
        return {
          action: 'close',
          coin,
          side: userPos.side,
          currentSize: userPos.size,
          targetSize: 0,
          tradeSize: userPos.size,
          targetPercentage: 0,
          estimatedValue: userPos.size * currentPrice
        };
      }
      return null;
    }

    if (!userPos) {
      return {
        action: 'open',
        coin,
        side: trackedPos!.side,
        currentSize: 0,
        targetSize,
        tradeSize: targetSize,
        targetPercentage,
        estimatedValue: targetValue
      };
    }

    if (userPos.side !== trackedPos!.side) {
      return {
        action: 'reverse',
        coin,
        side: trackedPos!.side,
        currentSize: userPos.size,
        targetSize,
        tradeSize: userPos.size + targetSize,
        targetPercentage,
        estimatedValue: targetValue
      };
    }

    const sizeDiff = targetSize - userPos.size;

    if (sizeDiff === 0) {
      return {
        action: 'hold',
        coin,
        side: userPos.side,
        currentSize: userPos.size,
        targetSize,
        tradeSize: 0,
        targetPercentage,
        estimatedValue: targetValue
      };
    }

    if (sizeDiff > 0) {
      return {
        action: 'increase',
        coin,
        side: userPos.side,
        currentSize: userPos.size,
        targetSize,
        tradeSize: sizeDiff,
        targetPercentage,
        estimatedValue: targetValue
      };
    }

    return {
      action: 'decrease',
      coin,
      side: userPos.side,
      currentSize: userPos.size,
      targetSize,
      tradeSize: Math.abs(sizeDiff),
      targetPercentage,
      estimatedValue: targetValue
    };
  }
}
