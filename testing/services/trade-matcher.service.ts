import type { SimulatedTrade, ActualTrade, TradeMatch } from '../models/backtest.model';

export class TradeMatcherService {
  private readonly TIME_TOLERANCE_MS = 5 * 60 * 1000;
  private readonly PRICE_TOLERANCE_PERCENT = 0.5;

  matchTrades(simulated: SimulatedTrade[], actual: ActualTrade[]): {
    matches: TradeMatch[];
    matchAccuracy: number;
    timingAccuracy: number;
    directionAccuracy: number;
    priceAccuracy: number;
    pyramidAccuracy: number;
  } {
    const matches: TradeMatch[] = [];
    const usedSimulated = new Set<number>();

    for (const actualTrade of actual) {
      let bestMatch: { index: number; score: number; simTrade: SimulatedTrade } | null = null;

      for (let i = 0; i < simulated.length; i++) {
        if (usedSimulated.has(i)) continue;

        const simTrade = simulated[i];
        const score = this.calculateMatchScore(actualTrade, simTrade);

        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { index: i, score, simTrade };
        }
      }

      if (bestMatch && bestMatch.score > 0.3) {
        usedSimulated.add(bestMatch.index);
        matches.push({
          actual: actualTrade,
          simulated: bestMatch.simTrade,
          timeDiff: Math.abs(actualTrade.time - bestMatch.simTrade.timestamp),
          priceDiff: Math.abs((actualTrade.px - bestMatch.simTrade.price) / actualTrade.px) * 100,
          directionMatch: this.directionsMatch(actualTrade, bestMatch.simTrade),
          matched: true
        });
      } else {
        matches.push({
          actual: actualTrade,
          simulated: null,
          timeDiff: 0,
          priceDiff: 0,
          directionMatch: false,
          matched: false
        });
      }
    }

    const matchedCount = matches.filter(m => m.matched).length;
    const matchAccuracy = matchedCount / actual.length;

    const matchedTrades = matches.filter(m => m.matched);
    const timingAccuracy = matchedTrades.length > 0
      ? matchedTrades.filter(m => m.timeDiff < this.TIME_TOLERANCE_MS).length / matchedTrades.length
      : 0;

    const directionAccuracy = matchedTrades.length > 0
      ? matchedTrades.filter(m => m.directionMatch).length / matchedTrades.length
      : 0;

    const priceAccuracy = matchedTrades.length > 0
      ? matchedTrades.filter(m => m.priceDiff < this.PRICE_TOLERANCE_PERCENT).length / matchedTrades.length
      : 0;

    const pyramidAccuracy = this.calculatePyramidAccuracy(simulated, actual);

    return {
      matches,
      matchAccuracy,
      timingAccuracy,
      directionAccuracy,
      priceAccuracy,
      pyramidAccuracy
    };
  }

  private calculateMatchScore(actual: ActualTrade, simulated: SimulatedTrade): number {
    const timeDiff = Math.abs(actual.time - simulated.timestamp);
    const timeScore = Math.max(0, 1 - (timeDiff / this.TIME_TOLERANCE_MS));

    const priceDiff = Math.abs((actual.px - simulated.price) / actual.px);
    const priceScore = Math.max(0, 1 - (priceDiff / (this.PRICE_TOLERANCE_PERCENT / 100)));

    const directionMatch = this.directionsMatch(actual, simulated) ? 1 : 0;

    return (timeScore * 0.4) + (priceScore * 0.3) + (directionMatch * 0.3);
  }

  private directionsMatch(actual: ActualTrade, simulated: SimulatedTrade): boolean {
    const actualDir = actual.dir.toLowerCase();
    const simDir = simulated.direction.toLowerCase();

    if ((actualDir === 'long' || actualDir === 'buy') && simDir === 'long') return true;
    if ((actualDir === 'short' || actualDir === 'sell') && simDir === 'short') return true;

    return false;
  }

  private calculatePyramidAccuracy(simulated: SimulatedTrade[], actual: ActualTrade[]): number {
    const actualPyramids = this.countPyramidPatterns(actual);
    const simulatedPyramids = this.countPyramidPatterns(
      simulated.map(s => ({
        time: s.timestamp,
        coin: s.coin,
        dir: s.direction,
        px: s.price,
        sz: s.size,
        ntl: 0,
        fee: 0,
        closedPnl: 0
      }))
    );

    if (actualPyramids === 0 && simulatedPyramids === 0) return 1;
    if (actualPyramids === 0 || simulatedPyramids === 0) return 0;

    return 1 - Math.abs(actualPyramids - simulatedPyramids) / Math.max(actualPyramids, simulatedPyramids);
  }

  private countPyramidPatterns(trades: ActualTrade[]): number {
    let pyramidCount = 0;
    let consecutiveSameDirection = 0;
    let lastDirection = '';

    for (const trade of trades) {
      if (trade.dir === lastDirection) {
        consecutiveSameDirection++;
        if (consecutiveSameDirection >= 3) {
          pyramidCount++;
        }
      } else {
        consecutiveSameDirection = 1;
        lastDirection = trade.dir;
      }
    }

    return pyramidCount;
  }

  calculateOverallScore(
    matchAccuracy: number,
    timingAccuracy: number,
    directionAccuracy: number,
    priceAccuracy: number,
    pyramidAccuracy: number
  ): number {
    return (
      matchAccuracy * 0.3 +
      timingAccuracy * 0.2 +
      directionAccuracy * 0.25 +
      priceAccuracy * 0.15 +
      pyramidAccuracy * 0.1
    );
  }
}
