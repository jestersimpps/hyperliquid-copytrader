export interface Order {
  coin: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  orderType: string;
  orderId: number;
  timestamp: number;
  isTrigger: boolean;
  triggerPrice?: number;
  reduceOnly: boolean;
}
