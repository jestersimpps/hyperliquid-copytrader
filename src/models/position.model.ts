export interface Position {
  coin: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginUsed: number;
  liquidationPrice: number;
  side: 'long' | 'short';
  notionalValue: number;
}
