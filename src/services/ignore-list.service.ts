import type { Position } from '../models';

interface IgnoredPosition {
  coin: string;
  side: 'long' | 'short';
}

export class IgnoreListService {
  private ignoreList: Map<string, 'long' | 'short'> = new Map();

  initialize(positions: Position[]): void {
    this.ignoreList.clear();
    positions.forEach(pos => {
      this.ignoreList.set(pos.coin, pos.side);
    });
  }

  isIgnored(coin: string): boolean {
    return this.ignoreList.has(coin);
  }

  getIgnoredSide(coin: string): 'long' | 'short' | null {
    return this.ignoreList.get(coin) || null;
  }

  removeFromIgnoreList(coin: string): void {
    this.ignoreList.delete(coin);
  }

  getIgnoreList(): IgnoredPosition[] {
    return Array.from(this.ignoreList.entries()).map(([coin, side]) => ({
      coin,
      side
    }));
  }

  getIgnoreCount(): number {
    return this.ignoreList.size;
  }

  clear(): void {
    this.ignoreList.clear();
  }
}
