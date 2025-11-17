import type { OHLCCandle, TimeFrame } from '../../src/models/ohlc.model';
import type { BacktestConfig, BacktestResult, ActualTrade, OptimizationResult } from '../models/backtest.model';
import { BacktesterService } from './backtester.service';
import { TradeMatcherService } from './trade-matcher.service';

export class StrategyOptimizerService {
  private backtester: BacktesterService;
  private matcher: TradeMatcherService;

  constructor() {
    this.backtester = new BacktesterService();
    this.matcher = new TradeMatcherService();
  }

  optimize(
    coin: string,
    candles: OHLCCandle[],
    actualTrades: ActualTrade[],
    timeframes: TimeFrame[]
  ): OptimizationResult {
    const results: BacktestResult[] = [];
    const totalCombinations = this.calculateTotalCombinations(timeframes.length);
    let tested = 0;

    console.log(`\n🔍 Testing ${totalCombinations} parameter combinations for ${coin}...`);

    for (const timeframe of timeframes) {
      for (const rsiPeriod of [5, 7, 10, 14, 21]) {
        for (const rsiOverbought of [65, 70, 75, 80]) {
          for (const rsiOversold of [20, 25, 30, 35]) {
            for (const bbPeriod of [10, 15, 20, 25]) {
              for (const bbStdDev of [1.5, 2.0, 2.5]) {
                for (const stochPeriod of [5, 14, 21]) {
                  for (const maxPyramidCount of [10, 20, 30, 50]) {
                    for (const useBB of [true, false]) {
                      for (const useStoch of [true, false]) {
                        for (const useVWAP of [true, false]) {
                          tested++;

                          if (tested % 100 === 0) {
                            console.log(`   Progress: ${tested}/${totalCombinations} (${((tested / totalCombinations) * 100).toFixed(1)}%)`);
                          }

                          const config: BacktestConfig = {
                            coin,
                            timeframe,
                            rsiPeriod,
                            rsiOverbought,
                            rsiOversold,
                            bbPeriod,
                            bbStdDev,
                            stochPeriod,
                            stochOverbought: 80,
                            stochOversold: 20,
                            maxPyramidCount,
                            useVWAP: useVWAP,
                            useBollingerBands: useBB,
                            useStochastic: useStoch
                          };

                          const simulatedTrades = this.backtester.runBacktest(candles, config);

                          const matchResult = this.matcher.matchTrades(simulatedTrades, actualTrades);

                          const overallScore = this.matcher.calculateOverallScore(
                            matchResult.matchAccuracy,
                            matchResult.timingAccuracy,
                            matchResult.directionAccuracy,
                            matchResult.priceAccuracy,
                            matchResult.pyramidAccuracy
                          );

                          results.push({
                            config,
                            simulatedTrades,
                            totalTrades: simulatedTrades.length,
                            matchAccuracy: matchResult.matchAccuracy,
                            timingAccuracy: matchResult.timingAccuracy,
                            directionAccuracy: matchResult.directionAccuracy,
                            priceAccuracy: matchResult.priceAccuracy,
                            pyramidAccuracy: matchResult.pyramidAccuracy,
                            overallScore
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    results.sort((a, b) => b.overallScore - a.overallScore);

    const topResults = results.slice(0, 10);
    const bestConfig = results[0].config;
    const bestScore = results[0].overallScore;

    console.log(`\n✅ Optimization complete! Best score: ${(bestScore * 100).toFixed(2)}%`);

    return {
      bestConfig,
      bestScore,
      allResults: results,
      topResults
    };
  }

  private calculateTotalCombinations(timeframeCount: number): number {
    const rsiPeriods = 5;
    const rsiOverboughts = 4;
    const rsiOversolds = 4;
    const bbPeriods = 4;
    const bbStdDevs = 3;
    const stochPeriods = 3;
    const pyramidCounts = 4;
    const booleanCombos = 2 * 2 * 2;

    return (
      timeframeCount *
      rsiPeriods *
      rsiOverboughts *
      rsiOversolds *
      bbPeriods *
      bbStdDevs *
      stochPeriods *
      pyramidCounts *
      booleanCombos
    );
  }
}
