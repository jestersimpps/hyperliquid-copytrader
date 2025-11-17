import type { Position } from '../models';
import type { PositionChange, MonitoringSnapshot } from '../models/change.model';

export class MonitoringService {
  private previousSnapshot: MonitoringSnapshot | null = null;

  createSnapshot(positions: Position[], balance: number): MonitoringSnapshot {
    const positionMap = new Map<string, { size: number; side: 'long' | 'short'; price: number }>();

    positions.forEach(pos => {
      positionMap.set(pos.coin, {
        size: pos.size,
        side: pos.side,
        price: pos.markPrice
      });
    });

    return {
      timestamp: new Date(),
      positions: positionMap,
      balance
    };
  }

  detectChanges(currentSnapshot: MonitoringSnapshot): PositionChange[] {
    if (!this.previousSnapshot) {
      this.previousSnapshot = currentSnapshot;
      return [];
    }

    const changes: PositionChange[] = [];
    const previousPositions = this.previousSnapshot.positions;
    const currentPositions = currentSnapshot.positions;

    const allCoins = new Set([
      ...Array.from(previousPositions.keys()),
      ...Array.from(currentPositions.keys())
    ]);

    allCoins.forEach(coin => {
      const previous = previousPositions.get(coin);
      const current = currentPositions.get(coin);

      if (!previous && current) {
        changes.push({
          type: 'opened',
          coin,
          previousSize: 0,
          newSize: current.size,
          newSide: current.side,
          timestamp: currentSnapshot.timestamp
        });
      } else if (previous && !current) {
        changes.push({
          type: 'closed',
          coin,
          previousSize: previous.size,
          newSize: 0,
          previousSide: previous.side,
          newSide: previous.side,
          timestamp: currentSnapshot.timestamp
        });
      } else if (previous && current) {
        if (previous.side !== current.side) {
          changes.push({
            type: 'reversed',
            coin,
            previousSize: previous.size,
            newSize: current.size,
            previousSide: previous.side,
            newSide: current.side,
            timestamp: currentSnapshot.timestamp
          });
        } else if (current.size !== previous.size) {
          if (current.size > previous.size) {
            changes.push({
              type: 'increased',
              coin,
              previousSize: previous.size,
              newSize: current.size,
              newSide: current.side,
              timestamp: currentSnapshot.timestamp
            });
          } else {
            changes.push({
              type: 'decreased',
              coin,
              previousSize: previous.size,
              newSize: current.size,
              newSide: current.side,
              timestamp: currentSnapshot.timestamp
            });
          }
        }
      }
    });

    this.previousSnapshot = currentSnapshot;
    return changes;
  }

  reset(): void {
    this.previousSnapshot = null;
  }
}
