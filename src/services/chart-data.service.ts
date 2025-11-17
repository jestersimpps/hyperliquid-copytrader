import { PublicClient } from '@nktkas/hyperliquid';
import type { OHLCCandle, TimeFrame } from '../models/ohlc.model';

export class ChartDataService {
  constructor(private publicClient: PublicClient) {}

  async getOHLC(
    coin: string,
    timeframe: TimeFrame,
    startTime: number,
    endTime?: number
  ): Promise<OHLCCandle[]> {
    const candles = await this.publicClient.candleSnapshot({
      coin,
      interval: timeframe,
      startTime,
      endTime
    });

    return candles.map(c => ({
      timestamp: c.t,
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
      trades: c.n
    }));
  }

  async getMultipleTimeframes(
    coin: string,
    timeframes: TimeFrame[],
    hours: number = 24
  ): Promise<Record<TimeFrame, OHLCCandle[]>> {
    const endTime = Date.now();
    const startTime = endTime - (hours * 60 * 60 * 1000);

    const results = await Promise.all(
      timeframes.map(async (tf) => ({
        timeframe: tf,
        data: await this.getOHLC(coin, tf, startTime, endTime)
      }))
    );

    return results.reduce((acc, { timeframe, data }) => {
      acc[timeframe] = data;
      return acc;
    }, {} as Record<TimeFrame, OHLCCandle[]>);
  }
}
