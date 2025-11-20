import { Config } from '@/config';
import { Balance } from '@/models/balance.model';
import { Position } from '@/models/position.model';

interface RiskMetrics {
  dailyStartBalance: number;
  dailyHighBalance: number;
  lastDailyLossAlert: Map<number, number>;
  lastBalanceDropAlert: Map<number, number>;
  lastMarginAlert: number;
  lastPositionSizeAlert: Map<string, number>;
  lastMidnightReset: number;
}

export class RiskMonitorService {
  private config: Config;
  private metrics: RiskMetrics;

  constructor(config: Config) {
    this.config = config;
    this.metrics = {
      dailyStartBalance: 0,
      dailyHighBalance: 0,
      lastDailyLossAlert: new Map(),
      lastBalanceDropAlert: new Map(),
      lastMarginAlert: 0,
      lastPositionSizeAlert: new Map(),
      lastMidnightReset: Date.now()
    };
  }

  initializeDailyTracking(currentBalance: number): void {
    this.metrics.dailyStartBalance = currentBalance;
    this.metrics.dailyHighBalance = currentBalance;
    this.metrics.lastMidnightReset = Date.now();
  }

  checkDailyReset(): boolean {
    const now = new Date();
    const lastReset = new Date(this.metrics.lastMidnightReset);

    if (now.getUTCDate() !== lastReset.getUTCDate()) {
      this.metrics.lastDailyLossAlert.clear();
      this.metrics.lastBalanceDropAlert.clear();
      this.metrics.lastMidnightReset = Date.now();
      return true;
    }

    return false;
  }

  checkDailyLoss(currentBalance: number): { threshold: number; lossPercent: number; lossAmount: number } | null {
    if (this.metrics.dailyStartBalance === 0) {
      return null;
    }

    const lossAmount = this.metrics.dailyStartBalance - currentBalance;
    const lossPercent = (lossAmount / this.metrics.dailyStartBalance) * 100;

    if (lossPercent <= 0) {
      return null;
    }

    for (const threshold of this.config.dailyLossThresholds.sort((a, b) => b - a)) {
      if (lossPercent >= threshold) {
        const lastAlert = this.metrics.lastDailyLossAlert.get(threshold) || 0;
        const now = Date.now();

        if (now - lastAlert >= this.config.riskAlertCooldownMs) {
          this.metrics.lastDailyLossAlert.set(threshold, now);
          return { threshold, lossPercent, lossAmount };
        }
        break;
      }
    }

    return null;
  }

  checkBalanceDrop(currentBalance: number): { threshold: number; dropPercent: number; dropAmount: number; peakBalance: number } | null {
    if (currentBalance > this.metrics.dailyHighBalance) {
      this.metrics.dailyHighBalance = currentBalance;
    }

    if (this.metrics.dailyHighBalance === 0) {
      return null;
    }

    const dropAmount = this.metrics.dailyHighBalance - currentBalance;
    const dropPercent = (dropAmount / this.metrics.dailyHighBalance) * 100;

    if (dropPercent <= 0) {
      return null;
    }

    for (const threshold of this.config.balanceDropThresholds.sort((a, b) => b - a)) {
      if (dropPercent >= threshold) {
        const lastAlert = this.metrics.lastBalanceDropAlert.get(threshold) || 0;
        const now = Date.now();

        if (now - lastAlert >= this.config.riskAlertCooldownMs) {
          this.metrics.lastBalanceDropAlert.set(threshold, now);
          return {
            threshold,
            dropPercent,
            dropAmount,
            peakBalance: this.metrics.dailyHighBalance
          };
        }
        break;
      }
    }

    return null;
  }

  checkMarginUsage(balance: Balance): { marginRatio: number; marginUsed: number; accountValue: number } | null {
    const accountValue = parseFloat(balance.crossMarginSummary.accountValue);
    const marginUsed = parseFloat(balance.crossMaintenanceMarginUsed);

    const marginRatio = accountValue > 0
      ? (marginUsed / accountValue) * 100
      : 0;

    if (marginRatio > this.config.marginWarningThreshold) {
      const now = Date.now();
      const lastAlert = this.metrics.lastMarginAlert;

      if (now - lastAlert >= this.config.riskAlertCooldownMs) {
        this.metrics.lastMarginAlert = now;
        return {
          marginRatio,
          marginUsed,
          accountValue
        };
      }
    }

    return null;
  }

  checkPositionSize(
    positions: Position[],
    accountValue: number
  ): { coin: string; notionalValue: number; percentOfAccount: number } | null {
    for (const position of positions) {
      const percentOfAccount = (position.notionalValue / accountValue) * 100;

      if (percentOfAccount > this.config.positionSizeInfoThreshold) {
        const lastAlert = this.metrics.lastPositionSizeAlert.get(position.coin) || 0;
        const now = Date.now();

        if (now - lastAlert >= this.config.riskAlertCooldownMs) {
          this.metrics.lastPositionSizeAlert.set(position.coin, now);
          return {
            coin: position.coin,
            notionalValue: position.notionalValue,
            percentOfAccount
          };
        }
      }
    }

    return null;
  }

  getDailyPnl(currentBalance: number): { pnlAmount: number; pnlPercent: number } {
    if (this.metrics.dailyStartBalance === 0) {
      return { pnlAmount: 0, pnlPercent: 0 };
    }

    const pnlAmount = currentBalance - this.metrics.dailyStartBalance;
    const pnlPercent = (pnlAmount / this.metrics.dailyStartBalance) * 100;

    return { pnlAmount, pnlPercent };
  }

  getDistanceFromDailyHigh(currentBalance: number): { dropAmount: number; dropPercent: number } {
    if (this.metrics.dailyHighBalance === 0) {
      return { dropAmount: 0, dropPercent: 0 };
    }

    const dropAmount = this.metrics.dailyHighBalance - currentBalance;
    const dropPercent = (dropAmount / this.metrics.dailyHighBalance) * 100;

    return { dropAmount, dropPercent };
  }
}
