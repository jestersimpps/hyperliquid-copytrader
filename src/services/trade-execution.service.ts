import type { HyperliquidService } from './hyperliquid.service';
import type { ActionRecommendation } from './action-copy.service';
import { OrderResponse } from '@nktkas/hyperliquid';

export interface ExecutionResult {
  success: boolean;
  message: string;
  orderResponse?: OrderResponse;
  error?: string;
}

export class TradeExecutionService {
  constructor(private hyperliquidService: HyperliquidService) {
    if (!hyperliquidService.canExecuteTrades()) {
      throw new Error('HyperliquidService must be initialized with private key for trade execution');
    }
  }

  async executeRecommendation(recommendation: ActionRecommendation): Promise<ExecutionResult> {
    if (recommendation.action === 'ignore' || recommendation.isIgnored) {
      return {
        success: true,
        message: 'No action needed - position ignored or no trade required'
      };
    }

    try {
      let orderResponse: OrderResponse;

      switch (recommendation.action) {
        case 'open':
          orderResponse = await this.executeOpen(recommendation);
          break;

        case 'close':
          orderResponse = await this.executeClose(recommendation);
          break;

        case 'add':
          orderResponse = await this.executeAdd(recommendation);
          break;

        case 'reduce':
          orderResponse = await this.executeReduce(recommendation);
          break;

        case 'reverse':
          orderResponse = await this.executeReverse(recommendation);
          break;

        default:
          return {
            success: false,
            message: `Unknown action: ${recommendation.action}`,
            error: `Unknown action type: ${recommendation.action}`
          };
      }

      return {
        success: orderResponse.status === 'ok',
        message: `${recommendation.action.toUpperCase()} ${recommendation.coin} executed successfully`,
        orderResponse
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        message: `Failed to execute ${recommendation.action} for ${recommendation.coin}`,
        error: errorMessage
      };
    }
  }

  private async executeOpen(rec: ActionRecommendation): Promise<OrderResponse> {
    if (rec.side === 'long') {
      return await this.hyperliquidService.openLong(rec.coin, rec.size);
    } else {
      return await this.hyperliquidService.openShort(rec.coin, rec.size);
    }
  }

  private async executeClose(rec: ActionRecommendation): Promise<OrderResponse> {
    return await this.hyperliquidService.closePosition(rec.coin, rec.size);
  }

  private async executeAdd(rec: ActionRecommendation): Promise<OrderResponse> {
    if (rec.side === 'long') {
      return await this.hyperliquidService.openLong(rec.coin, rec.size);
    } else {
      return await this.hyperliquidService.openShort(rec.coin, rec.size);
    }
  }

  private async executeReduce(rec: ActionRecommendation): Promise<OrderResponse> {
    return await this.hyperliquidService.reducePosition(rec.coin, rec.size);
  }

  private async executeReverse(rec: ActionRecommendation): Promise<OrderResponse> {
    await this.hyperliquidService.closePosition(rec.coin);

    if (rec.side === 'long') {
      return await this.hyperliquidService.openLong(rec.coin, rec.size);
    } else {
      return await this.hyperliquidService.openShort(rec.coin, rec.size);
    }
  }
}
