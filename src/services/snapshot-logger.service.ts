import * as fs from 'fs';
import * as path from 'path';
import type { Position, Balance } from '../models';

interface BalanceSnapshot {
  timestamp: number;
  date: string;
  tracked: {
    address: string;
    accountValue: number;
    withdrawable: number;
    totalMarginUsed: number;
    crossMaintenanceMarginUsed: number;
    totalNtlPos: number;
    totalRawUsd: number;
    totalUnrealizedPnl: number;
    crossMarginSummary: {
      accountValue: number;
      totalNtlPos: number;
      totalRawUsd: number;
      totalMarginUsed: number;
    };
    positions: PositionSnapshot[];
    positionCount: number;
    crossMarginRatio: number;
    averageLeverage: number;
  };
  user: {
    address: string;
    accountValue: number;
    withdrawable: number;
    totalMarginUsed: number;
    crossMaintenanceMarginUsed: number;
    totalNtlPos: number;
    totalRawUsd: number;
    totalUnrealizedPnl: number;
    crossMarginSummary: {
      accountValue: number;
      totalNtlPos: number;
      totalRawUsd: number;
      totalMarginUsed: number;
    };
    positions: PositionSnapshot[];
    positionCount: number;
    crossMarginRatio: number;
    averageLeverage: number;
  };
  balanceRatio: number;
}

interface PositionSnapshot {
  coin: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  notionalValue: number;
  unrealizedPnl: number;
  leverage: number;
}

export class SnapshotLoggerService {
  private readonly dataDir: string;

  constructor() {
    this.dataDir = path.resolve(process.cwd(), 'data');
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private getFilePath(): string {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.dataDir, `snapshots-${date}.jsonl`);
  }

  private formatPositions(positions: Position[]): PositionSnapshot[] {
    return positions.map(p => ({
      coin: p.coin,
      side: p.side,
      size: p.size,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      notionalValue: p.size * p.markPrice,
      unrealizedPnl: p.unrealizedPnl,
      leverage: p.leverage
    }));
  }

  private calculateTotalPnl(positions: Position[]): number {
    return positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  }

  private calculateAverageLeverage(positions: Position[]): number {
    if (positions.length === 0) return 0;
    const totalLeverage = positions.reduce((sum, p) => sum + p.leverage, 0);
    return totalLeverage / positions.length;
  }

  private calculateCrossMarginRatio(balance: Balance): number {
    const maintMargin = parseFloat(balance.crossMaintenanceMarginUsed);
    const accountValue = parseFloat(balance.crossMarginSummary.accountValue);
    return accountValue > 0 ? (maintMargin / accountValue) * 100 : 0;
  }

  logSnapshot(
    trackedWallet: string,
    trackedBalance: Balance,
    trackedPositions: Position[],
    userWallet: string,
    userBalance: Balance,
    userPositions: Position[],
    balanceRatio: number
  ): void {
    const snapshot: BalanceSnapshot = {
      timestamp: Date.now(),
      date: new Date().toISOString(),
      tracked: {
        address: trackedWallet,
        accountValue: parseFloat(trackedBalance.accountValue),
        withdrawable: parseFloat(trackedBalance.withdrawable),
        totalMarginUsed: parseFloat(trackedBalance.totalMarginUsed),
        crossMaintenanceMarginUsed: parseFloat(trackedBalance.crossMaintenanceMarginUsed),
        totalNtlPos: parseFloat(trackedBalance.totalNtlPos),
        totalRawUsd: parseFloat(trackedBalance.totalRawUsd),
        totalUnrealizedPnl: this.calculateTotalPnl(trackedPositions),
        crossMarginSummary: {
          accountValue: parseFloat(trackedBalance.crossMarginSummary.accountValue),
          totalNtlPos: parseFloat(trackedBalance.crossMarginSummary.totalNtlPos),
          totalRawUsd: parseFloat(trackedBalance.crossMarginSummary.totalRawUsd),
          totalMarginUsed: parseFloat(trackedBalance.crossMarginSummary.totalMarginUsed)
        },
        positions: this.formatPositions(trackedPositions),
        positionCount: trackedPositions.length,
        crossMarginRatio: this.calculateCrossMarginRatio(trackedBalance),
        averageLeverage: this.calculateAverageLeverage(trackedPositions)
      },
      user: {
        address: userWallet,
        accountValue: parseFloat(userBalance.accountValue),
        withdrawable: parseFloat(userBalance.withdrawable),
        totalMarginUsed: parseFloat(userBalance.totalMarginUsed),
        crossMaintenanceMarginUsed: parseFloat(userBalance.crossMaintenanceMarginUsed),
        totalNtlPos: parseFloat(userBalance.totalNtlPos),
        totalRawUsd: parseFloat(userBalance.totalRawUsd),
        totalUnrealizedPnl: this.calculateTotalPnl(userPositions),
        crossMarginSummary: {
          accountValue: parseFloat(userBalance.crossMarginSummary.accountValue),
          totalNtlPos: parseFloat(userBalance.crossMarginSummary.totalNtlPos),
          totalRawUsd: parseFloat(userBalance.crossMarginSummary.totalRawUsd),
          totalMarginUsed: parseFloat(userBalance.crossMarginSummary.totalMarginUsed)
        },
        positions: this.formatPositions(userPositions),
        positionCount: userPositions.length,
        crossMarginRatio: this.calculateCrossMarginRatio(userBalance),
        averageLeverage: this.calculateAverageLeverage(userPositions)
      },
      balanceRatio
    };

    try {
      const filePath = this.getFilePath();
      const jsonLine = JSON.stringify(snapshot) + '\n';
      fs.appendFileSync(filePath, jsonLine, 'utf-8');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to write snapshot: ${errorMessage}`);
    }
  }
}
