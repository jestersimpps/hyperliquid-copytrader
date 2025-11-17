import type { PositionChange } from '../models/change.model';
import type { Position } from '../models';
import { IgnoreListService } from './ignore-list.service';
import { scaleChangeAmount, formatScaledSize } from '../utils/scaling.utils';

export interface ActionRecommendation {
  action: 'open' | 'close' | 'add' | 'reduce' | 'reverse' | 'ignore';
  coin: string;
  side: 'long' | 'short';
  size: number;
  reason: string;
  isIgnored: boolean;
}

export class ActionCopyService {
  constructor(
    private ignoreListService: IgnoreListService,
    private balanceRatio: number
  ) {}

  getRecommendation(
    change: PositionChange,
    userPositions: Position[]
  ): ActionRecommendation | null {
    const userPosition = userPositions.find(p => p.coin === change.coin);
    const isIgnored = this.ignoreListService.isIgnored(change.coin);
    const ignoredSide = this.ignoreListService.getIgnoredSide(change.coin);

    if (isIgnored) {
      return this.handleIgnoredPosition(change, userPosition, ignoredSide);
    } else {
      return this.handleTrackedPosition(change, userPosition);
    }
  }

  private handleIgnoredPosition(
    change: PositionChange,
    userPosition: Position | undefined,
    ignoredSide: 'long' | 'short' | null
  ): ActionRecommendation | null {
    if (change.type === 'reversed') {
      this.ignoreListService.removeFromIgnoreList(change.coin);
      const scaledSize = formatScaledSize(scaleChangeAmount(change.newSize, this.balanceRatio));

      return {
        action: 'open',
        coin: change.coin,
        side: change.newSide,
        size: scaledSize,
        reason: `Tracked wallet reversed ${change.coin} from ${change.previousSide?.toUpperCase()} to ${change.newSide.toUpperCase()}. Removed from ignore list and opening new side.`,
        isIgnored: false
      };
    }

    if (change.type === 'closed') {
      this.ignoreListService.removeFromIgnoreList(change.coin);

      return {
        action: 'ignore',
        coin: change.coin,
        side: ignoredSide || change.newSide,
        size: 0,
        reason: `Tracked wallet closed pre-existing ${change.coin} position. Removed from ignore list.`,
        isIgnored: true
      };
    }

    return {
      action: 'ignore',
      coin: change.coin,
      side: change.newSide,
      size: 0,
      reason: `${change.coin} is a pre-existing position. Ignoring ${change.type} action.`,
      isIgnored: true
    };
  }

  private handleTrackedPosition(
    change: PositionChange,
    userPosition: Position | undefined
  ): ActionRecommendation | null {
    switch (change.type) {
      case 'opened':
        return this.handleOpened(change);

      case 'closed':
        return this.handleClosed(change, userPosition);

      case 'reversed':
        return this.handleReversed(change, userPosition);

      case 'increased':
        return this.handleIncreased(change, userPosition);

      case 'decreased':
        return this.handleDecreased(change, userPosition);

      default:
        return null;
    }
  }

  private handleOpened(change: PositionChange): ActionRecommendation {
    const scaledSize = formatScaledSize(scaleChangeAmount(change.newSize, this.balanceRatio));

    return {
      action: 'open',
      coin: change.coin,
      side: change.newSide,
      size: scaledSize,
      reason: `Tracked wallet opened new ${change.newSide.toUpperCase()} position in ${change.coin}.`,
      isIgnored: false
    };
  }

  private handleClosed(
    change: PositionChange,
    userPosition: Position | undefined
  ): ActionRecommendation {
    if (!userPosition) {
      return {
        action: 'ignore',
        coin: change.coin,
        side: change.newSide,
        size: 0,
        reason: `Tracked wallet closed ${change.coin} but you don't have this position.`,
        isIgnored: false
      };
    }

    return {
      action: 'close',
      coin: change.coin,
      side: userPosition.side,
      size: userPosition.size,
      reason: `Tracked wallet closed ${change.coin} ${userPosition.side.toUpperCase()} position.`,
      isIgnored: false
    };
  }

  private handleReversed(
    change: PositionChange,
    userPosition: Position | undefined
  ): ActionRecommendation {
    const scaledNewSize = formatScaledSize(scaleChangeAmount(change.newSize, this.balanceRatio));

    if (!userPosition) {
      return {
        action: 'open',
        coin: change.coin,
        side: change.newSide,
        size: scaledNewSize,
        reason: `Tracked wallet reversed ${change.coin} to ${change.newSide.toUpperCase()}. Opening new position.`,
        isIgnored: false
      };
    }

    return {
      action: 'reverse',
      coin: change.coin,
      side: change.newSide,
      size: scaledNewSize,
      reason: `Tracked wallet reversed ${change.coin} from ${change.previousSide?.toUpperCase()} to ${change.newSide.toUpperCase()}.`,
      isIgnored: false
    };
  }

  private handleIncreased(
    change: PositionChange,
    userPosition: Position | undefined
  ): ActionRecommendation {
    const changeAmount = change.newSize - change.previousSize;
    const scaledChangeAmount = formatScaledSize(scaleChangeAmount(changeAmount, this.balanceRatio));

    if (!userPosition) {
      const scaledTotalSize = formatScaledSize(scaleChangeAmount(change.newSize, this.balanceRatio));
      return {
        action: 'open',
        coin: change.coin,
        side: change.newSide,
        size: scaledTotalSize,
        reason: `Tracked wallet increased ${change.coin} but you don't have it yet. Opening new position.`,
        isIgnored: false
      };
    }

    return {
      action: 'add',
      coin: change.coin,
      side: change.newSide,
      size: scaledChangeAmount,
      reason: `Tracked wallet increased ${change.coin} ${change.newSide.toUpperCase()} by ${changeAmount.toFixed(4)}.`,
      isIgnored: false
    };
  }

  private handleDecreased(
    change: PositionChange,
    userPosition: Position | undefined
  ): ActionRecommendation {
    if (!userPosition) {
      return {
        action: 'ignore',
        coin: change.coin,
        side: change.newSide,
        size: 0,
        reason: `Tracked wallet decreased ${change.coin} but you don't have this position.`,
        isIgnored: false
      };
    }

    const changeAmount = change.previousSize - change.newSize;
    const scaledChangeAmount = formatScaledSize(scaleChangeAmount(changeAmount, this.balanceRatio));

    return {
      action: 'reduce',
      coin: change.coin,
      side: change.newSide,
      size: scaledChangeAmount,
      reason: `Tracked wallet decreased ${change.coin} ${change.newSide.toUpperCase()} by ${changeAmount.toFixed(4)}.`,
      isIgnored: false
    };
  }
}
