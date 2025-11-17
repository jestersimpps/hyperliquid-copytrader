import { Position } from '../models/position.model';
import { loadConfig } from '../config';

export interface UnderwaterPosition {
  position: Position;
  percentOfAccount: number;
  lastTradeTime: number;
}

export class PositionMonitorService {
  private lastAlertTimes: Map<string, number> = new Map();
  private config = loadConfig();

  checkPositions(
    positions: Position[],
    accountBalance: number,
    lastTradeTimes: Map<string, number>
  ): UnderwaterPosition[] {
    const underwaterPositions: UnderwaterPosition[] = [];
    const now = Date.now();

    for (const position of positions) {
      const lossPercent = this.calculateLossPercent(position, accountBalance);

      if (lossPercent > this.config.alertThresholdPercent) {
        const lastAlertTime = this.lastAlertTimes.get(position.coin) || 0;
        const timeSinceLastAlert = now - lastAlertTime;

        if (timeSinceLastAlert >= this.config.alertCooldownMs) {
          underwaterPositions.push({
            position,
            percentOfAccount: lossPercent,
            lastTradeTime: lastTradeTimes.get(position.coin) || now
          });

          this.lastAlertTimes.set(position.coin, now);
        }
      } else {
        this.lastAlertTimes.delete(position.coin);
      }
    }

    return underwaterPositions;
  }

  private calculateLossPercent(position: Position, accountBalance: number): number {
    if (accountBalance <= 0) return 0;
    if (position.unrealizedPnl >= 0) return 0;

    return (Math.abs(position.unrealizedPnl) / accountBalance) * 100;
  }
}
