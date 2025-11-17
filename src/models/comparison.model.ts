export interface WalletComparison {
  trackedWallet: string;
  userWallet: string;
  trackedBalance: number;
  userBalance: number;
  balanceRatio: number;
}

export interface PositionComparison {
  coin: string;
  trackedPosition: {
    size: number;
    side: 'long' | 'short';
    entryPrice: number;
    accountPercentage: number;
  } | null;
  userPosition: {
    size: number;
    side: 'long' | 'short';
    entryPrice: number;
    accountPercentage: number;
  } | null;
  recommendation: TradeRecommendation | null;
}

export interface TradeRecommendation {
  action: 'open' | 'close' | 'increase' | 'decrease' | 'reverse' | 'hold';
  coin: string;
  side: 'long' | 'short';
  currentSize: number;
  targetSize: number;
  tradeSize: number;
  targetPercentage: number;
  estimatedValue: number;
}
