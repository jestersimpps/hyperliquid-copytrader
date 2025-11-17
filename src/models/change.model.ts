export interface PositionChange {
  type: 'opened' | 'closed' | 'increased' | 'decreased' | 'reversed';
  coin: string;
  previousSize: number;
  newSize: number;
  previousSide?: 'long' | 'short';
  newSide: 'long' | 'short';
  timestamp: Date;
}

export interface MonitoringSnapshot {
  timestamp: Date;
  positions: Map<string, { size: number; side: 'long' | 'short'; price: number }>;
  balance: number;
}
