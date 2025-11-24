export interface UserFillData {
  coin: string;
  tid: number | string;
  px: string;
  side: string;
  time: number;
  sz?: string;
  dir?: string;
  closedPnl?: string;
  hash?: string;
  oid?: number;
  crossed?: boolean;
  fee?: string;
  liquidation?: boolean;
}
