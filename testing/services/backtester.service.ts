import type { OHLCCandle } from '../../src/models/ohlc.model';
import type { BacktestConfig, SimulatedTrade } from '../models/backtest.model';
import { IndicatorsService, type IndicatorValues } from '../../src/services/indicators.service';

interface Position {
  direction: 'long' | 'short';
  entryPrice: number;
  size: number;
  entryCount: number;
  openTimestamp: number;
}

export class BacktesterService {
  private indicatorsService: IndicatorsService;

  constructor() {
    this.indicatorsService = new IndicatorsService();
  }

  runBacktest(candles: OHLCCandle[], config: BacktestConfig): SimulatedTrade[] {
    const indicators = this.indicatorsService.calculateAllIndicators(
      candles,
      config.rsiPeriod,
      config.bbPeriod,
      config.bbStdDev,
      config.stochPeriod
    );

    const trades: SimulatedTrade[] = [];
    let position: Position | null = null;

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const indicator = indicators[i];

      if (!this.hasValidIndicators(indicator, config)) {
        continue;
      }

      const signal = this.getSignal(candle, indicator, config, position);

      if (signal.action === 'open_long') {
        if (position?.direction === 'short') {
          trades.push(this.createTrade(candle, position, 'close', 'Exit short before reversing'));
          position = null;
        }

        if (!position) {
          position = {
            direction: 'long',
            entryPrice: candle.close,
            size: 100,
            entryCount: 1,
            openTimestamp: candle.timestamp
          };
          trades.push(this.createTrade(candle, position, 'open', signal.reason));
        } else if (position.direction === 'long' && position.entryCount < config.maxPyramidCount) {
          position.entryCount++;
          position.size += 100;
          trades.push(this.createTrade(candle, position, 'add', signal.reason));
        }
      }

      if (signal.action === 'open_short') {
        if (position?.direction === 'long') {
          trades.push(this.createTrade(candle, position, 'close', 'Exit long before reversing'));
          position = null;
        }

        if (!position) {
          position = {
            direction: 'short',
            entryPrice: candle.close,
            size: 100,
            entryCount: 1,
            openTimestamp: candle.timestamp
          };
          trades.push(this.createTrade(candle, position, 'open', signal.reason));
        } else if (position.direction === 'short' && position.entryCount < config.maxPyramidCount) {
          position.entryCount++;
          position.size += 100;
          trades.push(this.createTrade(candle, position, 'add', signal.reason));
        }
      }

      if (signal.action === 'close' && position) {
        trades.push(this.createTrade(candle, position, 'close', signal.reason));
        position = null;
      }
    }

    if (position) {
      const lastCandle = candles[candles.length - 1];
      trades.push(this.createTrade(lastCandle, position, 'close', 'End of backtest'));
    }

    return trades;
  }

  private hasValidIndicators(indicator: IndicatorValues, config: BacktestConfig): boolean {
    if (indicator.rsi === null) return false;
    if (config.useBollingerBands && (indicator.bbUpper === null || indicator.bbLower === null)) return false;
    if (config.useStochastic && (indicator.stochK === null || indicator.stochD === null)) return false;
    if (config.useVWAP && indicator.vwap === null) return false;
    return true;
  }

  private getSignal(
    candle: OHLCCandle,
    indicator: IndicatorValues,
    config: BacktestConfig,
    position: Position | null
  ): { action: 'open_long' | 'open_short' | 'close' | 'none'; reason: string } {
    const price = candle.close;
    const rsi = indicator.rsi!;

    const isOverbought = rsi >= config.rsiOverbought;
    const isOversold = rsi <= config.rsiOversold;
    const isNeutral = rsi > config.rsiOversold && rsi < config.rsiOverbought;

    let bbSignal = 0;
    if (config.useBollingerBands && indicator.bbUpper && indicator.bbLower) {
      if (price >= indicator.bbUpper) bbSignal = -1;
      if (price <= indicator.bbLower) bbSignal = 1;
    }

    let stochSignal = 0;
    if (config.useStochastic && indicator.stochK !== null) {
      if (indicator.stochK >= config.stochOverbought) stochSignal = -1;
      if (indicator.stochK <= config.stochOversold) stochSignal = 1;
    }

    let vwapSignal = 0;
    if (config.useVWAP && indicator.vwap) {
      if (price > indicator.vwap) vwapSignal = -1;
      if (price < indicator.vwap) vwapSignal = 1;
    }

    if (!position) {
      if (isOverbought) {
        const confirmations = [bbSignal === -1, stochSignal === -1, vwapSignal === -1].filter(Boolean).length;
        if (!config.useBollingerBands && !config.useStochastic && !config.useVWAP) {
          return { action: 'open_short', reason: `RSI ${rsi.toFixed(2)} > ${config.rsiOverbought}` };
        }
        if (confirmations > 0) {
          return { action: 'open_short', reason: `RSI ${rsi.toFixed(2)} + ${confirmations} confirmations` };
        }
      }

      if (isOversold) {
        const confirmations = [bbSignal === 1, stochSignal === 1, vwapSignal === 1].filter(Boolean).length;
        if (!config.useBollingerBands && !config.useStochastic && !config.useVWAP) {
          return { action: 'open_long', reason: `RSI ${rsi.toFixed(2)} < ${config.rsiOversold}` };
        }
        if (confirmations > 0) {
          return { action: 'open_long', reason: `RSI ${rsi.toFixed(2)} + ${confirmations} confirmations` };
        }
      }
    }

    if (position) {
      if (position.direction === 'long' && isOverbought) {
        return { action: 'open_long', reason: `Pyramid long - RSI ${rsi.toFixed(2)}` };
      }

      if (position.direction === 'short' && isOversold) {
        return { action: 'open_short', reason: `Pyramid short - RSI ${rsi.toFixed(2)}` };
      }

      if (position.direction === 'long' && isNeutral) {
        return { action: 'close', reason: `Exit long - RSI normalized to ${rsi.toFixed(2)}` };
      }

      if (position.direction === 'short' && isNeutral) {
        return { action: 'close', reason: `Exit short - RSI normalized to ${rsi.toFixed(2)}` };
      }
    }

    return { action: 'none', reason: '' };
  }

  private createTrade(
    candle: OHLCCandle,
    position: Position,
    action: 'open' | 'add' | 'close' | 'reduce',
    reason: string
  ): SimulatedTrade {
    return {
      timestamp: candle.timestamp,
      coin: '',
      direction: position.direction,
      action,
      price: candle.close,
      size: 100,
      reason
    };
  }
}
