export interface TradeLog {
  timestamp: number;
  date: string;
  coin: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  action: 'close' | 'reduce' | 'reverse';
  orderId: number;
  realizedPnl: number;
  fee: string;
  executionMs: number;
}
