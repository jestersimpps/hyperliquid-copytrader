export interface OHLCCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

export type TimeFrame = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
