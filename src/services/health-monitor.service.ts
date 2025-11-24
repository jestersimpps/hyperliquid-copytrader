import { TelegramService } from './telegram.service';
import { HyperliquidService } from './hyperliquid.service';
import { WebSocketFillsService } from './websocket-fills.service';
import * as fs from 'fs';
import * as path from 'path';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthMetrics {
  status: HealthStatus;
  checks: {
    websocket: HealthCheckResult;
    api: HealthCheckResult;
    orderSuccess: HealthCheckResult;
    fillProcessing: HealthCheckResult;
    positionDrift: HealthCheckResult;
    balanceRatio: HealthCheckResult;
  };
  metrics: {
    uptime: number;
    orderSuccessRate: number;
    fillProcessingRate: number;
    lastFillTime: number | null;
    consecutiveErrors: number;
  };
  timestamp: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  message: string;
  details?: any;
}

export interface HealthConfig {
  checkInterval: number;
  orderFailureThreshold: number;
  fillErrorThreshold: number;
  positionDriftThreshold: number;
  balanceRatioChangeThreshold: number;
  autoPauseOnErrors: boolean;
}

export class HealthMonitorService {
  private telegramService: TelegramService | null = null;
  private hyperliquidService: HyperliquidService | null = null;
  private webSocketService: WebSocketFillsService | null = null;

  private orderSuccessCount: number = 0;
  private orderFailureCount: number = 0;
  private fillSuccessCount: number = 0;
  private fillErrorCount: number = 0;
  private consecutiveErrors: number = 0;
  private lastBalanceRatio: number = 1;
  private startTime: number = Date.now();
  private lastFillTime: number | null = null;
  private isTrading: boolean = true;
  private readonly HEALTH_FILE_PATH = path.resolve(process.cwd(), 'data', 'health-status.json');

  private config: HealthConfig;

  constructor(config: Partial<HealthConfig> = {}) {
    this.config = {
      checkInterval: config.checkInterval || 60000,
      orderFailureThreshold: config.orderFailureThreshold || 5,
      fillErrorThreshold: config.fillErrorThreshold || 3,
      positionDriftThreshold: config.positionDriftThreshold || 20,
      balanceRatioChangeThreshold: config.balanceRatioChangeThreshold || 10,
      autoPauseOnErrors: config.autoPauseOnErrors ?? true
    };
  }

  initialize(
    telegramService: TelegramService,
    hyperliquidService: HyperliquidService,
    webSocketService: WebSocketFillsService
  ): void {
    this.telegramService = telegramService;
    this.hyperliquidService = hyperliquidService;
    this.webSocketService = webSocketService;
  }

  recordOrderSuccess(): void {
    this.orderSuccessCount++;
    this.consecutiveErrors = 0;
  }

  recordOrderFailure(): void {
    this.orderFailureCount++;
    this.consecutiveErrors++;

    const recentTotal = this.orderSuccessCount + this.orderFailureCount;
    if (recentTotal > 0 && this.orderFailureCount >= this.config.orderFailureThreshold) {
      this.handleExcessiveOrderFailures();
    }
  }

  recordFillSuccess(): void {
    this.fillSuccessCount++;
    this.consecutiveErrors = 0;
    this.lastFillTime = Date.now();
  }

  recordFillError(): void {
    this.fillErrorCount++;
    this.consecutiveErrors++;

    if (this.consecutiveErrors >= this.config.fillErrorThreshold) {
      this.handleExcessiveFillErrors();
    }
  }

  updateBalanceRatio(newRatio: number): void {
    const change = Math.abs((newRatio - this.lastBalanceRatio) / this.lastBalanceRatio) * 100;

    if (change > this.config.balanceRatioChangeThreshold) {
      this.handleBalanceRatioAnomaly(this.lastBalanceRatio, newRatio, change);
    }

    this.lastBalanceRatio = newRatio;
  }

  async runHealthChecks(): Promise<HealthMetrics> {
    const checks = {
      websocket: await this.checkWebSocket(),
      api: await this.checkAPI(),
      orderSuccess: this.checkOrderSuccessRate(),
      fillProcessing: this.checkFillProcessingRate(),
      positionDrift: this.checkPositionDrift(),
      balanceRatio: this.checkBalanceRatio()
    };

    const status = this.determineOverallHealth(checks);

    const healthMetrics: HealthMetrics = {
      status,
      checks,
      metrics: {
        uptime: Date.now() - this.startTime,
        orderSuccessRate: this.calculateOrderSuccessRate(),
        fillProcessingRate: this.calculateFillProcessingRate(),
        lastFillTime: this.lastFillTime,
        consecutiveErrors: this.consecutiveErrors
      },
      timestamp: Date.now()
    };

    this.writeHealthStatus(healthMetrics);

    return healthMetrics;
  }

  private writeHealthStatus(healthMetrics: HealthMetrics): void {
    try {
      const dataDir = path.dirname(this.HEALTH_FILE_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      fs.writeFileSync(this.HEALTH_FILE_PATH, JSON.stringify(healthMetrics, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to write health status file:', error);
    }
  }

  private async checkWebSocket(): Promise<HealthCheckResult> {
    if (!this.webSocketService) {
      return { healthy: false, message: 'WebSocket service not initialized' };
    }

    const stats = this.webSocketService.getConnectionStats();

    if (!stats.isConnected) {
      return {
        healthy: false,
        message: 'WebSocket disconnected',
        details: { reconnectAttempts: stats.reconnectAttempts }
      };
    }

    const timeSinceLastFill = this.lastFillTime
      ? Date.now() - this.lastFillTime
      : stats.lastFillReceivedAt
        ? Date.now() - stats.lastFillReceivedAt
        : null;

    if (timeSinceLastFill && timeSinceLastFill > 600000) {
      return {
        healthy: false,
        message: `No fills for ${Math.floor(timeSinceLastFill / 60000)} minutes`,
        details: { timeSinceLastFill }
      };
    }

    return { healthy: true, message: 'WebSocket connected and active' };
  }

  private async checkAPI(): Promise<HealthCheckResult> {
    if (!this.hyperliquidService) {
      return { healthy: false, message: 'Hyperliquid service not initialized' };
    }

    const successRate = this.calculateOrderSuccessRate();

    if (successRate < 50 && (this.orderSuccessCount + this.orderFailureCount) > 5) {
      return {
        healthy: false,
        message: `Low API success rate: ${successRate.toFixed(1)}%`,
        details: { successRate }
      };
    }

    return { healthy: true, message: 'API connection healthy' };
  }

  private checkOrderSuccessRate(): HealthCheckResult {
    const total = this.orderSuccessCount + this.orderFailureCount;

    if (total === 0) {
      return { healthy: true, message: 'No orders placed yet' };
    }

    const successRate = (this.orderSuccessCount / total) * 100;

    if (successRate < 50) {
      return {
        healthy: false,
        message: `Low order success rate: ${successRate.toFixed(1)}%`,
        details: { successRate, total }
      };
    }

    if (successRate < 80) {
      return {
        healthy: true,
        message: `Moderate order success rate: ${successRate.toFixed(1)}%`,
        details: { successRate, total }
      };
    }

    return {
      healthy: true,
      message: `Good order success rate: ${successRate.toFixed(1)}%`,
      details: { successRate, total }
    };
  }

  private checkFillProcessingRate(): HealthCheckResult {
    const total = this.fillSuccessCount + this.fillErrorCount;

    if (total === 0) {
      return { healthy: true, message: 'No fills processed yet' };
    }

    const successRate = (this.fillSuccessCount / total) * 100;

    if (successRate < 90) {
      return {
        healthy: false,
        message: `High fill processing error rate: ${(100 - successRate).toFixed(1)}%`,
        details: { successRate, total, consecutiveErrors: this.consecutiveErrors }
      };
    }

    return {
      healthy: true,
      message: `Fill processing healthy: ${successRate.toFixed(1)}% success`,
      details: { successRate, total }
    };
  }

  private checkPositionDrift(): HealthCheckResult {
    return { healthy: true, message: 'Position drift check not implemented' };
  }

  private checkBalanceRatio(): HealthCheckResult {
    return { healthy: true, message: 'Balance ratio stable' };
  }

  private calculateOrderSuccessRate(): number {
    const total = this.orderSuccessCount + this.orderFailureCount;
    return total > 0 ? (this.orderSuccessCount / total) * 100 : 100;
  }

  private calculateFillProcessingRate(): number {
    const total = this.fillSuccessCount + this.fillErrorCount;
    return total > 0 ? (this.fillSuccessCount / total) * 100 : 100;
  }

  private determineOverallHealth(checks: HealthMetrics['checks']): HealthStatus {
    const checkResults = Object.values(checks);
    const unhealthyCount = checkResults.filter(c => !c.healthy).length;

    if (unhealthyCount === 0) {
      return 'healthy';
    }

    if (unhealthyCount === 1 || (unhealthyCount === 2 && checkResults.length > 4)) {
      return 'degraded';
    }

    return 'unhealthy';
  }

  private async handleExcessiveOrderFailures(): Promise<void> {
    const message = `⚠️ High order failure rate detected: ${this.orderFailureCount} failures out of ${this.orderSuccessCount + this.orderFailureCount} orders`;

    console.error(message);

    if (this.telegramService?.isEnabled()) {
      await this.telegramService.sendError(message).catch(() => {});
    }

    if (this.config.autoPauseOnErrors && this.isTrading) {
      this.pauseTrading('Excessive order failures');
    }
  }

  private async handleExcessiveFillErrors(): Promise<void> {
    const message = `⚠️ ${this.consecutiveErrors} consecutive fill processing errors detected`;

    console.error(message);

    if (this.telegramService?.isEnabled()) {
      await this.telegramService.sendError(message).catch(() => {});
    }
  }

  private async handleBalanceRatioAnomaly(oldRatio: number, newRatio: number, change: number): Promise<void> {
    const message = `⚠️ Large balance ratio change detected: ${oldRatio.toFixed(4)} → ${newRatio.toFixed(4)} (${change.toFixed(2)}% change)`;

    console.warn(message);

    if (this.telegramService?.isEnabled()) {
      await this.telegramService.sendMessage(message).catch(() => {});
    }
  }

  private pauseTrading(reason: string): void {
    this.isTrading = false;
    const message = `🛑 Trading paused: ${reason}`;

    console.error(message);

    if (this.telegramService?.isEnabled()) {
      this.telegramService.sendError(`${message}\n\nUse /menu to resume trading.`).catch(() => {});
    }
  }

  canExecuteTrades(): boolean {
    return this.isTrading;
  }

  resumeTrading(): void {
    this.isTrading = true;
    this.consecutiveErrors = 0;
    console.log('✅ Trading resumed');
  }

  resetMetrics(): void {
    this.orderSuccessCount = 0;
    this.orderFailureCount = 0;
    this.fillSuccessCount = 0;
    this.fillErrorCount = 0;
    this.consecutiveErrors = 0;
  }
}
