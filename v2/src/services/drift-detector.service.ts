import { Position, DriftReport, PositionDrift, DriftType } from '@/models'
import { config } from '@/config'

export class DriftDetectorService {
  detect(
    trackedPositions: Position[],
    userPositions: Position[],
    balanceRatio: number
  ): DriftReport {
    const drifts: PositionDrift[] = []
    const userCoins = new Map(userPositions.map(p => [p.coin, p]))
    const trackedCoins = new Map(trackedPositions.map(p => [p.coin, p]))

    for (const tracked of trackedPositions) {
      const scaledTargetSize = tracked.size * balanceRatio
      const notionalValue = scaledTargetSize * tracked.markPrice

      if (notionalValue < config.minOrderValue) continue

      const userPos = userCoins.get(tracked.coin)

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
          sizeDiffPercent: 100
        })
      } else {
        const sizeDiffPercent = Math.abs(userPos.size - scaledTargetSize) / scaledTargetSize * 100

        if (sizeDiffPercent > config.driftThresholdPercent) {
          const isFavorable = this.checkSizeDriftFavorability(
            tracked,
            userPos,
            scaledTargetSize
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
        drifts.push({
          coin: userPos.coin,
          trackedPosition: null,
          userPosition: userPos,
          driftType: 'extra',
          isFavorable: true,
          priceImprovement: 0,
          scaledTargetSize: 0,
          currentPrice: userPos.markPrice,
          sizeDiffPercent: 100
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
      return currentPrice <= entryPrice * (1 - config.minImprovement)
    } else {
      return currentPrice >= entryPrice * (1 + config.minImprovement)
    }
  }

  private checkSizeDriftFavorability(
    tracked: Position,
    userPos: Position,
    scaledTargetSize: number
  ): boolean {
    if (userPos.size < scaledTargetSize) {
      return this.checkOpenFavorability(
        tracked.side,
        tracked.markPrice,
        tracked.entryPrice
      )
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
