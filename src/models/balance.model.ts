export interface Balance {
  accountValue: string;
  withdrawable: string;
  totalMarginUsed: string;
  crossMaintenanceMarginUsed: string;
  totalNtlPos: string;
  totalRawUsd: string;
  crossMarginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  timestamp: number;
}
