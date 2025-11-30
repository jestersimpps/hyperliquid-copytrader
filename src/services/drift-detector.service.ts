import { Position, DriftReport, PositionDrift } from '@/models'

export class DriftDetectorService {
  constructor(private driftThresholdPercent: number) {}

  detect(
    trackedPositions: Position[],
    userPositions: Position[],
    trackedBalance: number,
    userBalance: number
  ): DriftReport {
    const drifts: PositionDrift[] = []
    const userCoins = new Map(userPositions.map(p => [p.coin, p]))
    const trackedCoins = new Map(trackedPositions.map(p => [p.coin, p]))

    for (const tracked of trackedPositions) {
      const trackedAllocationPct = (tracked.notionalValue / trackedBalance) * 100

      if (tracked.notionalValue < 10) continue

      const userPos = userCoins.get(tracked.coin)
      const scaledTargetSize = (trackedAllocationPct / 100) * userBalance / tracked.markPrice

      if (!userPos) {
        const isFavorable = this.checkOpenFavorability(
          tracked.side,
          tracked.markPrice,
          tracked.entryPrice
        )

        drifts.push({
          coin: tracked.coin,
          trackedPosition: tracked,
          userPosition: null,
          driftType: 'missing',
          isFavorable,
          priceImprovement: this.calculatePriceImprovement(tracked),
          scaledTargetSize,
          currentPrice: tracked.markPrice,
          sizeDiffPercent: trackedAllocationPct
        })
      } else if (userPos.side !== tracked.side) {
        const isFavorable = this.checkOpenFavorability(
          tracked.side,
          tracked.markPrice,
          tracked.entryPrice
        )

        drifts.push({
          coin: tracked.coin,
          trackedPosition: tracked,
          userPosition: userPos,
          driftType: 'side_mismatch',
          isFavorable,
          priceImprovement: this.calculatePriceImprovement(tracked),
          scaledTargetSize,
          currentPrice: tracked.markPrice,
          sizeDiffPercent: 100
        })
      } else {
        const userAllocationPct = (userPos.notionalValue / userBalance) * 100
        const sizeDiffPercent = Math.abs(trackedAllocationPct - userAllocationPct)

        if (sizeDiffPercent > this.driftThresholdPercent) {
          const isFavorable = this.checkSizeDriftFavorability(
            tracked,
            userPos,
            trackedAllocationPct,
            userAllocationPct
          )

          drifts.push({
            coin: tracked.coin,
            trackedPosition: tracked,
            userPosition: userPos,
            driftType: 'size_mismatch',
            isFavorable,
            priceImprovement: this.calculatePriceImprovement(tracked),
            scaledTargetSize,
            currentPrice: tracked.markPrice,
            sizeDiffPercent
          })
        }
      }
    }

    for (const userPos of userPositions) {
      if (!trackedCoins.has(userPos.coin)) {
        const userAllocationPct = (userPos.notionalValue / userBalance) * 100

        drifts.push({
          coin: userPos.coin,
          trackedPosition: null,
          userPosition: userPos,
          driftType: 'extra',
          isFavorable: true,
          priceImprovement: 0,
          scaledTargetSize: 0,
          currentPrice: userPos.markPrice,
          sizeDiffPercent: userAllocationPct
        })
      }
    }

    return {
      hasDrift: drifts.length > 0,
      drifts,
      timestamp: Date.now()
    }
  }

  private checkOpenFavorability(
    side: 'long' | 'short',
    currentPrice: number,
    entryPrice: number
  ): boolean {
    if (side === 'long') {
      return currentPrice <= entryPrice
    } else {
      return currentPrice >= entryPrice
    }
  }

  private checkSizeDriftFavorability(
    tracked: Position,
    userPos: Position,
    trackedAllocationPct: number,
    userAllocationPct: number
  ): boolean {
    if (userAllocationPct < trackedAllocationPct) {
      if (tracked.side === 'long') {
        return tracked.markPrice <= tracked.entryPrice
      } else {
        return tracked.markPrice >= tracked.entryPrice
      }
    } else {
      if (userPos.side === 'long') {
        return userPos.markPrice > userPos.entryPrice
      } else {
        return userPos.markPrice < userPos.entryPrice
      }
    }
  }

  private calculatePriceImprovement(tracked: Position): number {
    const { side, markPrice, entryPrice } = tracked
    if (side === 'long') {
      return ((entryPrice - markPrice) / entryPrice) * 100
    } else {
      return ((markPrice - entryPrice) / entryPrice) * 100
    }
  }
}
