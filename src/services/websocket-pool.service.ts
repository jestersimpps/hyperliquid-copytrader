import { WebSocketConnectionService, type ConnectionStats } from './websocket-connection.service';
import type { FillQueueService } from './fill-queue.service';
import type { TelegramService } from './telegram.service';

export interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  totalFillsReceived: number;
  connections: ConnectionStats[];
  healthStatus: 'healthy' | 'degraded' | 'critical';
  lastCheckedAt: number;
}

export class WebSocketPoolService {
  private connections: WebSocketConnectionService[] = [];
  private readonly poolSize: number;
  private readonly fillQueue: FillQueueService;
  private readonly isTestnet: boolean;
  private readonly telegramService: TelegramService | null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private inactivityCheckInterval: NodeJS.Timeout | null = null;
  private trackedWallet: string | null = null;

  constructor(
    poolSize: number,
    fillQueue: FillQueueService,
    isTestnet: boolean = false,
    telegramService?: TelegramService
  ) {
    this.poolSize = poolSize;
    this.fillQueue = fillQueue;
    this.isTestnet = isTestnet;
    this.telegramService = telegramService || null;

    for (let i = 0; i < poolSize; i++) {
      const connection = new WebSocketConnectionService(
        i + 1,
        fillQueue,
        isTestnet,
        telegramService
      );
      this.connections.push(connection);
    }
  }

  async initializeAll(trackedWallet: string): Promise<void> {
    this.trackedWallet = trackedWallet;
    console.log(`\n🔌 Initializing WebSocket connection pool (${this.poolSize} connections)...`);

    const initPromises = this.connections.map((connection, index) => {
      return connection.initialize(trackedWallet).catch(error => {
        console.error(`⚠️  Connection ${index + 1} failed to initialize:`, error.message);
        return null;
      });
    });

    await Promise.allSettled(initPromises);

    const activeCount = this.getActiveConnectionCount();
    console.log(`✓ WebSocket pool initialized: ${activeCount}/${this.poolSize} connections active\n`);

    if (activeCount === 0) {
      throw new Error('All WebSocket connections failed to initialize');
    }

    this.startHealthMonitoring();
  }

  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkPoolHealth();
    }, 30000);

    this.inactivityCheckInterval = setInterval(() => {
      this.checkInactivity();
    }, 60000);
  }

  private checkPoolHealth(): void {
    const stats = this.getPoolStats();

    if (stats.healthStatus === 'critical') {
      console.warn(`⚠️  WebSocket pool health: CRITICAL - ${stats.activeConnections}/${stats.totalConnections} connections active`);

      if (this.telegramService?.isEnabled()) {
        this.telegramService.sendError(
          `⚠️ WebSocket Pool Critical\n${stats.activeConnections}/${stats.totalConnections} connections active`
        ).catch(() => {});
      }

      if (stats.activeConnections === 0) {
        console.error('❌ All WebSocket connections lost. Restarting process...');
        if (this.telegramService?.isEnabled()) {
          this.telegramService.sendError('❌ All WebSocket connections lost. Process restarting...').catch(() => {});
        }
        process.exit(1);
      }
    } else if (stats.healthStatus === 'degraded') {
      console.warn(`⚠️  WebSocket pool health: DEGRADED - ${stats.activeConnections}/${stats.totalConnections} connections active`);
    }
  }

  private checkInactivity(): void {
    const now = Date.now();

    // Staggered thresholds to prevent simultaneous reconnects
    // Using prime numbers to avoid reconnection collisions
    // Connection 1: 71s (1m 11s) - fast detection
    // Connection 2: 181s (3m 1s) - medium detection
    // Connection 3: 307s (5m 7s) - conservative detection
    // LCM(71, 181, 307) = 3,943,837s (45.6 days) before first overlap
    const thresholds = [
      71 * 1000,          // Connection 1: 71 seconds (1m 11s)
      181 * 1000,         // Connection 2: 181 seconds (3m 1s)
      307 * 1000          // Connection 3: 307 seconds (5m 7s)
    ];

    // Staggered delays to ensure reconnections happen at least 10s apart
    const reconnectDelays = [
      0,                  // Connection 1: immediate
      10 * 1000,          // Connection 2: 10s delay
      20 * 1000           // Connection 3: 20s delay
    ];

    for (const connection of this.connections) {
      const stats = connection.getConnectionStats();

      if (!stats.isConnected) continue;

      const threshold = thresholds[stats.id - 1] || 5 * 60 * 1000;

      if (stats.lastFillReceivedAt) {
        const timeSinceLastFill = now - stats.lastFillReceivedAt;

        if (timeSinceLastFill > threshold) {
          const thresholdMinutes = threshold / 60000;
          const delay = reconnectDelays[stats.id - 1] || 0;

          if (delay > 0) {
            console.warn(`⚠️  Connection ${stats.id} inactive for ${Math.floor(timeSinceLastFill / 1000)}s (threshold: ${thresholdMinutes}m), scheduling reconnect in ${delay / 1000}s...`);
            setTimeout(() => {
              connection.forceReconnect().catch(error => {
                console.error(`Failed to force reconnect connection ${stats.id}:`, error.message);
              });
            }, delay);
          } else {
            console.warn(`⚠️  Connection ${stats.id} inactive for ${Math.floor(timeSinceLastFill / 1000)}s (threshold: ${thresholdMinutes}m), forcing reconnect...`);
            connection.forceReconnect().catch(error => {
              console.error(`Failed to force reconnect connection ${stats.id}:`, error.message);
            });
          }
        }
      }
    }
  }

  getActiveConnectionCount(): number {
    return this.connections.filter(conn => conn.isConnected()).length;
  }

  getPoolStats(): PoolStats {
    const connectionStats = this.connections.map(conn => conn.getConnectionStats());
    const activeConnections = connectionStats.filter(stat => stat.isConnected).length;
    const totalFillsReceived = connectionStats.reduce((sum, stat) => sum + stat.fillsReceived, 0);

    let healthStatus: 'healthy' | 'degraded' | 'critical';
    if (activeConnections === this.poolSize) {
      healthStatus = 'healthy';
    } else if (activeConnections >= Math.ceil(this.poolSize / 2)) {
      healthStatus = 'degraded';
    } else {
      healthStatus = 'critical';
    }

    return {
      totalConnections: this.poolSize,
      activeConnections,
      totalFillsReceived,
      connections: connectionStats,
      healthStatus,
      lastCheckedAt: Date.now()
    };
  }

  async forceReconnectAll(): Promise<void> {
    console.log('⟳ Force reconnecting all WebSocket connections...');

    const reconnectPromises = this.connections.map(connection => {
      return connection.forceReconnect().catch(error => {
        console.error(`Failed to reconnect connection:`, error.message);
      });
    });

    await Promise.allSettled(reconnectPromises);
  }

  async closeAll(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.inactivityCheckInterval) {
      clearInterval(this.inactivityCheckInterval);
      this.inactivityCheckInterval = null;
    }

    const closePromises = this.connections.map(connection => connection.close());
    await Promise.allSettled(closePromises);

    console.log('✓ All WebSocket connections closed');
  }

  printStatus(): void {
    const stats = this.getPoolStats();
    console.log('\n📊 WebSocket Pool Status:');
    console.log(`   Health: ${stats.healthStatus.toUpperCase()}`);
    console.log(`   Active: ${stats.activeConnections}/${stats.totalConnections}`);
    console.log(`   Total Fills: ${stats.totalFillsReceived}`);

    stats.connections.forEach(conn => {
      const status = conn.isConnected ? '✓' : '✗';
      const lastFill = conn.lastFillReceivedAt
        ? `${Math.floor((Date.now() - conn.lastFillReceivedAt) / 1000)}s ago`
        : 'never';
      console.log(`   ${status} Connection ${conn.id}: ${conn.fillsReceived} fills, last: ${lastFill}`);
    });
    console.log('');
  }
}
