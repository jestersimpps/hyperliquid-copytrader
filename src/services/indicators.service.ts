import type { OHLCCandle } from '../models/ohlc.model';

export interface IndicatorValues {
  rsi: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  stochK: number | null;
  stochD: number | null;
  vwap: number | null;
}

export class IndicatorsService {
  calculateRSI(candles: OHLCCandle[], period: number): (number | null)[] {
    const rsiValues: (number | null)[] = [];

    if (candles.length < period + 1) {
      return candles.map(() => null);
    }

    const changes = candles.map((candle, i) => {
      if (i === 0) return 0;
      return candle.close - candles[i - 1].close;
    });

    for (let i = 0; i < candles.length; i++) {
      if (i < period) {
        rsiValues.push(null);
        continue;
      }

      const recentChanges = changes.slice(i - period + 1, i + 1);
      const gains = recentChanges.map(c => c > 0 ? c : 0);
      const losses = recentChanges.map(c => c < 0 ? Math.abs(c) : 0);

      const avgGain = gains.reduce((a, b) => a + b, 0) / period;
      const avgLoss = losses.reduce((a, b) => a + b, 0) / period;

      if (avgLoss === 0) {
        rsiValues.push(100);
        continue;
      }

      const rs = avgGain / avgLoss;
      const rsi = 100 - (100 / (1 + rs));
      rsiValues.push(rsi);
    }

    return rsiValues;
  }

  calculateBollingerBands(candles: OHLCCandle[], period: number, stdDev: number): {
    upper: (number | null)[];
    middle: (number | null)[];
    lower: (number | null)[];
  } {
    const upper: (number | null)[] = [];
    const middle: (number | null)[] = [];
    const lower: (number | null)[] = [];

    for (let i = 0; i < candles.length; i++) {
      if (i < period - 1) {
        upper.push(null);
        middle.push(null);
        lower.push(null);
        continue;
      }

      const slice = candles.slice(i - period + 1, i + 1);
      const closes = slice.map(c => c.close);
      const sma = closes.reduce((a, b) => a + b, 0) / period;

      const variance = closes.reduce((sum, close) => sum + Math.pow(close - sma, 2), 0) / period;
      const std = Math.sqrt(variance);

      upper.push(sma + (stdDev * std));
      middle.push(sma);
      lower.push(sma - (stdDev * std));
    }

    return { upper, middle, lower };
  }

  calculateStochastic(candles: OHLCCandle[], kPeriod: number, dPeriod: number = 3): {
    k: (number | null)[];
    d: (number | null)[];
  } {
    const k: (number | null)[] = [];

    for (let i = 0; i < candles.length; i++) {
      if (i < kPeriod - 1) {
        k.push(null);
        continue;
      }

      const slice = candles.slice(i - kPeriod + 1, i + 1);
      const high = Math.max(...slice.map(c => c.high));
      const low = Math.min(...slice.map(c => c.low));
      const close = candles[i].close;

      if (high === low) {
        k.push(50);
        continue;
      }

      const stochK = ((close - low) / (high - low)) * 100;
      k.push(stochK);
    }

    const d: (number | null)[] = [];
    for (let i = 0; i < k.length; i++) {
      if (i < dPeriod - 1 || k[i] === null) {
        d.push(null);
        continue;
      }

      const slice = k.slice(i - dPeriod + 1, i + 1);
      const validValues = slice.filter(v => v !== null) as number[];

      if (validValues.length === 0) {
        d.push(null);
        continue;
      }

      const avg = validValues.reduce((a, b) => a + b, 0) / validValues.length;
      d.push(avg);
    }

    return { k, d };
  }

  calculateVWAP(candles: OHLCCandle[]): (number | null)[] {
    const vwap: (number | null)[] = [];
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    for (let i = 0; i < candles.length; i++) {
      const typicalPrice = (candles[i].high + candles[i].low + candles[i].close) / 3;
      const tpv = typicalPrice * candles[i].volume;

      cumulativeTPV += tpv;
      cumulativeVolume += candles[i].volume;

      if (cumulativeVolume === 0) {
        vwap.push(null);
      } else {
        vwap.push(cumulativeTPV / cumulativeVolume);
      }
    }

    return vwap;
  }

  calculateAllIndicators(
    candles: OHLCCandle[],
    rsiPeriod: number,
    bbPeriod: number,
    bbStdDev: number,
    stochPeriod: number
  ): IndicatorValues[] {
    const rsi = this.calculateRSI(candles, rsiPeriod);
    const bb = this.calculateBollingerBands(candles, bbPeriod, bbStdDev);
    const stoch = this.calculateStochastic(candles, stochPeriod);
    const vwap = this.calculateVWAP(candles);

    return candles.map((_, i) => ({
      rsi: rsi[i],
      bbUpper: bb.upper[i],
      bbMiddle: bb.middle[i],
      bbLower: bb.lower[i],
      stochK: stoch.k[i],
      stochD: stoch.d[i],
      vwap: vwap[i]
    }));
  }
}
