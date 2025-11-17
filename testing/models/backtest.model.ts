import type { TimeFrame } from './ohlc.model';

export interface BacktestConfig {
  coin: string;
  timeframe: TimeFrame;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  bbPeriod: number;
  bbStdDev: number;
  stochPeriod: number;
  stochOverbought: number;
  stochOversold: number;
  maxPyramidCount: number;
  useVWAP: boolean;
  useBollingerBands: boolean;
  useStochastic: boolean;
}

export interface SimulatedTrade {
  timestamp: number;
  coin: string;
  direction: 'long' | 'short';
  action: 'open' | 'add' | 'close' | 'reduce';
  price: number;
  size: number;
  reason: string;
}

export interface BacktestResult {
  config: BacktestConfig;
  simulatedTrades: SimulatedTrade[];
  totalTrades: number;
  matchAccuracy: number;
  timingAccuracy: number;
  directionAccuracy: number;
  priceAccuracy: number;
  pyramidAccuracy: number;
  overallScore: number;
}

export interface ActualTrade {
  time: number;
  coin: string;
  dir: string;
  px: number;
  sz: number;
  ntl: number;
  fee: number;
  closedPnl: number;
}

export interface TradeMatch {
  actual: ActualTrade;
  simulated: SimulatedTrade | null;
  timeDiff: number;
  priceDiff: number;
  directionMatch: boolean;
  matched: boolean;
}

export interface OptimizationResult {
  bestConfig: BacktestConfig;
  bestScore: number;
  allResults: BacktestResult[];
  topResults: BacktestResult[];
}
