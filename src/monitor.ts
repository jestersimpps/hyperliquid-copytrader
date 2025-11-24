import './setup';
import { HyperliquidService } from './services/hyperliquid.service';
import { TradeHistoryService } from './services/trade-history.service';
import { FillQueueService } from './services/fill-queue.service';
import { WebSocketPoolService } from './services/websocket-pool.service';
import { TelegramService } from './services/telegram.service';
import { PositionMonitorService } from './services/position-monitor.service';
import { SnapshotLoggerService } from './services/snapshot-logger.service';
import { RiskMonitorService } from './services/risk-monitor.service';
import { TradeLoggerService } from './services/trade-logger.service';
import { HealthMonitorService } from './services/health-monitor.service';
import { calculateBalanceRatio, scalePositionSize, formatScaledSize } from './utils/scaling.utils';
import { loadConfig } from './config';
import { Position } from './models/position.model';

const DEFAULT_POLL_INTERVAL = 1000;

const formatTimestamp = (date: Date): string => {
  return date.toLocaleTimeString('en-US', { hour12: false });
};

interface FillProcessingResult {
  success: boolean;
  coin: string;
  action?: string;
  error?: string;
}

const processFill = async (
  fill: any,
  service: HyperliquidService,
  tradeHistoryService: TradeHistoryService,
  userWallet: string,
  telegramService: TelegramService,
  startTime: number,
  lastTradeTimes: Map<string, number>,
  tradeLogger: TradeLoggerService,
  balanceRatio: number,
  updateLastFillTime: () => void,
  healthMonitor: HealthMonitorService | null = null
): Promise<FillProcessingResult> => {
  try {
    updateLastFillTime();
    healthMonitor?.recordFillSuccess();

    const action = tradeHistoryService.determineAction(fill);
    if (!action) return { success: true, coin: fill.coin };

    if (!service.canExecuteTrades() || (healthMonitor && !healthMonitor.canExecuteTrades())) {
      return { success: true, coin: fill.coin, action: action.action };
    }

    // Log async to avoid blocking
    setImmediate(() => {
      console.log(`📈 ${action.action.toUpperCase()} ${action.side.toUpperCase()} ${fill.coin} | ${parseFloat(fill.sz).toFixed(4)} @ $${parseFloat(fill.px).toFixed(4)}`);
    });

    const fillPrice = parseFloat(fill.px);
    let orderResponse;

    switch (action.action) {
      case 'open':
        orderResponse = await (action.side === 'long' ? service.openLong(action.coin, action.size, fillPrice) : service.openShort(action.coin, action.size, fillPrice));
        break;

      case 'close':
        orderResponse = await service.closePosition(action.coin, fillPrice);
        break;

      case 'add':
        orderResponse = await (action.side === 'long' ? service.openLong(action.coin, action.size, fillPrice) : service.openShort(action.coin, action.size, fillPrice));
        break;

      case 'reduce':
        orderResponse = await service.reducePosition(action.coin, action.size, fillPrice);
        break;

      case 'reverse':
        try {
          await service.closePosition(action.coin, fillPrice);
        } catch (error) {
          // Position doesn't exist, continue
        }
        orderResponse = await (action.side === 'long' ? service.openLong(action.coin, action.size, fillPrice) : service.openShort(action.coin, action.size, fillPrice));
        break;
    }

    // Log async to avoid blocking
    const executionTime = Date.now() - startTime;
    setImmediate(() => {
      console.log(`✓ ${action.action.toUpperCase()} ${action.size.toFixed(4)} ${action.coin} in ${executionTime}ms\n`);
    });

    // Log closed trades with realized PNL (scaled by balance ratio)
    if (action.action === 'close' || action.action === 'reduce' || action.action === 'reverse') {
      let orderId = 0;
      const status = orderResponse?.response?.data?.statuses?.[0];
      if (status && 'filled' in status) {
        orderId = status.filled.oid;
      } else if (status && 'resting' in status) {
        orderId = status.resting.oid;
      }

      const trackedPnl = parseFloat(fill.closedPnl || '0');
      const userEstimatedPnl = trackedPnl * balanceRatio;

      tradeLogger.logClosedTrade({
        timestamp: Date.now(),
        date: new Date().toISOString(),
        coin: action.coin,
        side: action.side === 'long' ? 'sell' : 'buy',
        size: action.size,
        price: fillPrice,
        action: action.action as 'close' | 'reduce' | 'reverse',
        orderId,
        realizedPnl: userEstimatedPnl,
        fee: fill.fee || '0',
        executionMs: executionTime
      });
    }

    lastTradeTimes.set(action.coin, Date.now());
    healthMonitor?.recordOrderSuccess();

    return { success: true, coin: action.coin, action: action.action };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setImmediate(() => console.error(`✗ ${fill.coin} failed: ${errorMessage}`));

    healthMonitor?.recordOrderFailure();
    healthMonitor?.recordFillError();

    const isCriticalError = !errorMessage.toLowerCase().includes('position') &&
                           !errorMessage.toLowerCase().includes('reduce') &&
                           !errorMessage.toLowerCase().includes('close') &&
                           !errorMessage.toLowerCase().includes('not found');

    if (telegramService.isEnabled() && isCriticalError) {
      telegramService.sendError(`Order failed for ${fill.coin}: ${errorMessage}`).catch(() => {});
    }
    return { success: false, coin: fill.coin, error: errorMessage };
  }
};

const monitorTrackedWallet = async (
  trackedWallet: string,
  userWallet: string | null,
  privateKey: string | null,
  pollInterval: number,
  isTestnet: boolean,
  telegramService: TelegramService
): Promise<void> => {
  const service = new HyperliquidService(privateKey, userWallet, isTestnet, telegramService);

  try {
    await service.initialize();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ CRITICAL: Service initialization failed after all retries`);
    console.error(`Error: ${errorMessage}`);
    console.error(`\nThe application will exit. PM2 will restart it automatically.\n`);

    if (telegramService.isEnabled()) {
      await telegramService.sendError(`Service initialization failed: ${errorMessage}. App will restart.`).catch(() => {});
    }

    process.exit(1);
  }

  const startTime = Date.now();
  let balanceRatio = 1;
  let tradeHistoryService: TradeHistoryService | null = null;
  let fillQueue: FillQueueService | null = null;
  let webSocketPool: WebSocketPoolService | null = null;
  let lastBalanceUpdate = 0;
  const BALANCE_UPDATE_INTERVAL = 1 * 60 * 1000;
  const lastTradeTimes = new Map<string, number>();
  const positionMonitor = new PositionMonitorService();
  const snapshotLogger = new SnapshotLoggerService();
  const tradeLogger = new TradeLoggerService();
  const config = loadConfig();
  const riskMonitor = new RiskMonitorService(config);
  const healthMonitor = new HealthMonitorService();
  let lastFillReceivedTime: number = Date.now();
  let isUpdatingBalance: boolean = false;

  console.log('\n🚀 Copy Trading Bot Started\n');
  console.log(`📊 Tracked Wallet: ${trackedWallet}`);
  if (userWallet) {
    console.log(`👤 Your Wallet: ${userWallet}`);
  }
  console.log(`⚡ Mode: Real-time WebSocket (Balance updates every 1min)\n`);

  if (telegramService.isEnabled()) {
    await telegramService.sendMonitoringStarted(trackedWallet, userWallet);
  }

  let isFirstRun = true;

  const syncMissingPositions = async (
    trackedPositions: Position[],
    userPositions: Position[],
    balanceRatio: number,
    service: HyperliquidService,
    telegramService: TelegramService,
    minOrderValue: number,
    lastTradeTimes: Map<string, number>
  ): Promise<void> => {
    const userCoins = new Set(userPositions.map(p => p.coin));
    const missingPositions = trackedPositions.filter(p => !userCoins.has(p.coin));

    if (missingPositions.length === 0) {
      return;
    }

    console.log(`\n🔍 Checking ${missingPositions.length} missing position(s) for sync opportunities...`);

    for (const trackedPosition of missingPositions) {
      const scaledSize = formatScaledSize(scalePositionSize(trackedPosition.size, balanceRatio));
      const scaledNotionalValue = scaledSize * trackedPosition.markPrice;

      if (scaledNotionalValue < minOrderValue) {
        console.log(`  ⊘ ${trackedPosition.coin} ${trackedPosition.side}: Too small ($${scaledNotionalValue.toFixed(2)} < $${minOrderValue})`);
        continue;
      }

      const currentPrice = trackedPosition.markPrice;
      const trackedEntry = trackedPosition.entryPrice;
      const side = trackedPosition.side;

      let shouldSync = false;
      let reason = '';
      if (side === 'long') {
        if (currentPrice < trackedEntry) {
          shouldSync = true;
        } else {
          reason = `Current $${currentPrice.toFixed(2)} >= Entry $${trackedEntry.toFixed(2)}`;
        }
      } else if (side === 'short') {
        if (currentPrice > trackedEntry) {
          shouldSync = true;
        } else {
          reason = `Current $${currentPrice.toFixed(2)} <= Entry $${trackedEntry.toFixed(2)}`;
        }
      }

      if (!shouldSync) {
        console.log(`  ⊘ ${trackedPosition.coin} ${trackedPosition.side}: Price not favorable (${reason})`);
        continue;
      }

      const priceImprovement = side === 'long'
        ? ((trackedEntry - currentPrice) / trackedEntry) * 100
        : ((currentPrice - trackedEntry) / trackedEntry) * 100;

      try {
        console.log(`🔄 SYNC ${side.toUpperCase()} ${trackedPosition.coin} | ${scaledSize.toFixed(4)} @ $${currentPrice.toFixed(4)} (tracked: $${trackedEntry.toFixed(4)}, improvement: ${priceImprovement.toFixed(2)}%)`);

        if (side === 'long') {
          await service.openLong(trackedPosition.coin, scaledSize, currentPrice);
        } else {
          await service.openShort(trackedPosition.coin, scaledSize, currentPrice);
        }

        console.log(`✓ Synced ${side} position: ${trackedPosition.coin}\n`);

        lastTradeTimes.set(trackedPosition.coin, Date.now());

        if (telegramService.isEnabled()) {
          await telegramService.sendMessage(
            `🔄 Position synced:\n` +
            `${trackedPosition.coin} ${side.toUpperCase()}\n` +
            `Size: ${scaledSize.toFixed(4)}\n` +
            `Tracked entry: $${trackedEntry.toFixed(4)}\n` +
            `Your entry: $${currentPrice.toFixed(4)}\n` +
            `Price improvement: ${priceImprovement.toFixed(2)}%\n` +
            `Notional: $${scaledNotionalValue.toFixed(2)}`
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`✗ Failed to sync position ${trackedPosition.coin}: ${errorMessage}`);

        if (telegramService.isEnabled()) {
          await telegramService.sendError(
            `Failed to sync position ${trackedPosition.coin}: ${errorMessage}`
          );
        }
      }
    }
  };

  const updateBalanceRatio = async (): Promise<void> => {
    if (!userWallet) return;

    isUpdatingBalance = true;
    try {
      const results = await Promise.allSettled([
        service.getAccountBalance(trackedWallet),
        service.getAccountBalance(userWallet),
        service.getOpenPositions(userWallet),
        service.getOpenPositions(trackedWallet)
      ]);

      if (results.some(r => r.status === 'rejected')) {
        const errors = results.map((r, i) => r.status === 'rejected' ? `${['trackedBalance', 'userBalance', 'userPositions', 'trackedPositions'][i]}: ${r.reason}` : null).filter(Boolean);
        console.error(`⚠️  Balance update failed partially: ${errors.join(', ')}`);

        if (results.every(r => r.status === 'rejected')) {
          throw new Error('All balance update API calls failed');
        }
      }

      const trackedBalance = results[0].status === 'fulfilled' ? results[0].value : null;
      const userBalance = results[1].status === 'fulfilled' ? results[1].value : null;
      const userPositions = results[2].status === 'fulfilled' ? results[2].value : [];
      const trackedPositions = results[3].status === 'fulfilled' ? results[3].value : [];

      if (!trackedBalance || !userBalance) {
        console.error('⚠️  Cannot update balance ratio without account balances, skipping...');
        return;
      }

      const coins = trackedPositions.map(p => p.coin);
      if (coins.length > 0) {
        await service.preCacheTickSizes(coins);
      }

      const oldRatio = balanceRatio;
    const newRatio = calculateBalanceRatio(
      parseFloat(userBalance.accountValue),
      parseFloat(trackedBalance.accountValue)
    );

    balanceRatio = newRatio;
    healthMonitor.updateBalanceRatio(newRatio);

    if (tradeHistoryService) {
      tradeHistoryService = new TradeHistoryService(service.publicClient, newRatio);
    }

    const ratioChangePercent = oldRatio !== 0 ? ((newRatio - oldRatio) / oldRatio) * 100 : 0;

    snapshotLogger.logSnapshot(
      trackedWallet,
      trackedBalance,
      trackedPositions,
      userWallet,
      userBalance,
      userPositions,
      newRatio
    );

    console.log(`\n💰 Balance Update [${formatTimestamp(new Date())}]`);
    console.log(`  Tracked Account: $${parseFloat(trackedBalance.accountValue).toFixed(2)}`);
    console.log(`  Your Account: $${parseFloat(userBalance.accountValue).toFixed(2)}`);
    console.log(`  Balance Ratio: 1:${newRatio.toFixed(4)} ${ratioChangePercent !== 0 ? `(${ratioChangePercent > 0 ? '+' : ''}${ratioChangePercent.toFixed(2)}%)` : ''}`);
    console.log(`  Your Positions: ${userPositions.length}\n`);

    if (telegramService.isEnabled()) {
      telegramService.updateStats({
        trackedWallet,
        userWallet,
        trackedPositions,
        trackedBalance,
        userPositions,
        userBalance,
        balanceRatio: newRatio,
        ignoredCoins: [],
        uptime: Date.now() - startTime
      });

      const underwaterPositions = positionMonitor.checkPositions(
        userPositions,
        parseFloat(userBalance.accountValue),
        lastTradeTimes
      );

      for (const { position, percentOfAccount, lastTradeTime } of underwaterPositions) {
        await telegramService.sendUnderwaterPositionAlert(
          position.coin,
          position.side,
          position.leverage,
          position.size,
          position.entryPrice,
          position.markPrice,
          position.unrealizedPnl,
          percentOfAccount,
          lastTradeTime
        );
      }

      if (isFirstRun) {
        riskMonitor.initializeDailyTracking(parseFloat(userBalance.accountValue));
      }

      if (riskMonitor.checkDailyReset()) {
        riskMonitor.initializeDailyTracking(parseFloat(userBalance.accountValue));
      }

      const dailyLoss = riskMonitor.checkDailyLoss(parseFloat(userBalance.accountValue));
      if (dailyLoss) {
        await telegramService.sendDailyLossWarning(
          dailyLoss.threshold,
          dailyLoss.lossPercent,
          dailyLoss.lossAmount,
          parseFloat(userBalance.accountValue)
        );
      }

      const balanceDrop = riskMonitor.checkBalanceDrop(parseFloat(userBalance.accountValue));
      if (balanceDrop) {
        await telegramService.sendBalanceDropAlert(
          balanceDrop.threshold,
          balanceDrop.dropPercent,
          balanceDrop.dropAmount,
          balanceDrop.peakBalance,
          parseFloat(userBalance.accountValue)
        );
      }

      const marginWarning = riskMonitor.checkMarginUsage(userBalance);
      if (marginWarning) {
        await telegramService.sendMarginUsageWarning(
          marginWarning.marginRatio,
          marginWarning.marginUsed,
          marginWarning.accountValue
        );
      }

      const positionSizeInfo = riskMonitor.checkPositionSize(
        userPositions,
        parseFloat(userBalance.accountValue)
      );
      if (positionSizeInfo) {
        await telegramService.sendPositionSizeInfo(
          positionSizeInfo.coin,
          positionSizeInfo.notionalValue,
          positionSizeInfo.percentOfAccount,
          parseFloat(userBalance.accountValue)
        );
      }
    }

    const trackedCoins = new Set(trackedPositions.map(p => p.coin));

    for (const position of userPositions) {
      if (trackedCoins.has(position.coin)) {
        continue;
      }

      if (service.canExecuteTrades()) {
        try {
          const notionalValue = position.size * position.markPrice;
          console.log(`🧹 Auto-closing orphan position: ${position.coin} (${position.side}) - Tracked wallet has no position`);
          console.log(`   Size: ${position.size.toFixed(4)}, Notional: $${notionalValue.toFixed(2)}, PnL: $${position.unrealizedPnl.toFixed(2)}`);

          await service.closePosition(position.coin, position.markPrice);

          console.log(`✓ Closed orphan position: ${position.coin}\n`);

          lastTradeTimes.set(position.coin, Date.now());

          if (telegramService.isEnabled()) {
            await telegramService.sendMessage(
              `🧹 Auto-closed orphan position:\n` +
              `${position.coin} ${position.side.toUpperCase()}\n` +
              `Reason: Tracked wallet has no position\n` +
              `Size: ${position.size.toFixed(4)}\n` +
              `Notional: $${notionalValue.toFixed(2)}\n` +
              `PnL: $${position.unrealizedPnl.toFixed(2)}`
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`✗ Failed to close orphan position ${position.coin}: ${errorMessage}`);

          if (telegramService.isEnabled()) {
            await telegramService.sendError(
              `Failed to auto-close orphan position ${position.coin}: ${errorMessage}`
            );
          }
        }
      }
    }

    if (isFirstRun && service.canExecuteTrades()) {
      await syncMissingPositions(
        trackedPositions,
        userPositions,
        balanceRatio,
        service,
        telegramService,
        config.minOrderValue,
        lastTradeTimes
      );
    }

    const MIN_POSITION_VALUE = 10;
    for (const position of userPositions) {
      const notionalValue = position.size * position.markPrice;

      if (notionalValue < MIN_POSITION_VALUE && service.canExecuteTrades()) {
        try {
          console.log(`🧹 Auto-closing small position: ${position.coin} (${position.side}) - $${notionalValue.toFixed(2)} notional value`);

          await service.closePosition(position.coin, position.markPrice);

          console.log(`✓ Closed small position: ${position.coin}\n`);

          if (telegramService.isEnabled()) {
            await telegramService.sendMessage(
              `🧹 Auto-closed small position:\n` +
              `${position.coin} ${position.side.toUpperCase()}\n` +
              `Size: ${position.size.toFixed(4)}\n` +
              `Notional: $${notionalValue.toFixed(2)}\n` +
              `PnL: $${position.unrealizedPnl.toFixed(2)}`
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`✗ Failed to close small position ${position.coin}: ${errorMessage}`);

          if (telegramService.isEnabled()) {
            await telegramService.sendError(
              `Failed to auto-close small position ${position.coin}: ${errorMessage}`
            );
          }
        }
      }
    }

      lastBalanceUpdate = Date.now();
    } finally {
      isUpdatingBalance = false;
    }
  };

  const poll = async (): Promise<void> => {
    try {
      const now = Date.now();
      const shouldUpdateBalance = isFirstRun || (now - lastBalanceUpdate) >= BALANCE_UPDATE_INTERVAL;

      if (shouldUpdateBalance) {
        await updateBalanceRatio();

        if (isFirstRun) {
          console.log(`\n✅ Monitoring started - watching for trades...`);
          if (userWallet) {
            tradeHistoryService = new TradeHistoryService(service.publicClient, balanceRatio);

            fillQueue = new FillQueueService();
            fillQueue.setFillProcessor(async (fill, connectionId) => {
              if (!tradeHistoryService) {
                console.warn(`⚠️  Received fill for ${fill.coin} but TradeHistoryService not ready yet, skipping...`);
                return;
              }

              if (isUpdatingBalance) {
                console.warn(`⚠️  Received fill for ${fill.coin} during balance update, skipping to avoid race condition...`);
                return;
              }

              await processFill(
                fill,
                service,
                tradeHistoryService,
                userWallet,
                telegramService,
                Date.now(),
                lastTradeTimes,
                tradeLogger,
                balanceRatio,
                () => { lastFillReceivedTime = Date.now(); },
                healthMonitor
              ).catch((error) => {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`✗ Fatal error processing fill from Connection ${connectionId}: ${errorMessage}`);

                if (telegramService.isEnabled()) {
                  telegramService.sendError(`Fatal error processing fill for ${fill.coin}: ${errorMessage}`).catch(() => {});
                }
              });
            });

            webSocketPool = new WebSocketPoolService(3, fillQueue, isTestnet, telegramService);
            try {
              await webSocketPool.initializeAll(trackedWallet);
              console.log('✓ Real-time WebSocket monitoring active (3 connections)\n');

              healthMonitor.initialize(telegramService, service, webSocketPool);
              console.log('✓ Health monitoring initialized\n');

              if (telegramService.isEnabled()) {
                await telegramService.sendMessage(`✓ WebSocket pool connected - monitoring ${trackedWallet}\n3 redundant connections active`);
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.error(`✗ Failed to initialize WebSocket pool: ${errorMessage}`);

              if (telegramService.isEnabled()) {
                await telegramService.sendError(`Failed to initialize WebSocket pool: ${errorMessage}`);
              }
            }
          }
          isFirstRun = false;
        }
      }

      if (webSocketPool && !isFirstRun) {
        const stats = webSocketPool.getPoolStats();

        if (stats.healthStatus === 'critical') {
          console.warn(`⚠️  WebSocket pool: CRITICAL - ${stats.activeConnections}/${stats.totalConnections} connections active`);
        } else if (stats.healthStatus === 'degraded') {
          console.warn(`⚠️  WebSocket pool: DEGRADED - ${stats.activeConnections}/${stats.totalConnections} connections active`);
        }
      }

      if (shouldUpdateBalance && !isFirstRun) {
        const stats = webSocketPool?.getPoolStats();
        const wsStatus = stats
          ? `${stats.activeConnections}/${stats.totalConnections} connections (${stats.healthStatus})`
          : 'not initialized';
        console.log(`[${formatTimestamp(new Date())}] ✓ Balance updated - WebSocket: ${wsStatus}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`\n[${formatTimestamp(new Date())}] ❌ Error:`, errorMessage);

      const isCriticalError = !errorMessage.toLowerCase().includes('position') &&
                             !errorMessage.toLowerCase().includes('not found') &&
                             !errorMessage.toLowerCase().includes('balance');

      if (telegramService.isEnabled() && isCriticalError) {
        await telegramService.sendError(errorMessage);
      }
    }
  };

  await poll();

  const intervalId = setInterval(poll, pollInterval);

  // Heartbeat check: Warning if no fills for 5 minutes
  const warningCheckInterval = 5 * 60 * 1000;
  const warningThreshold = 5 * 60 * 1000;
  let lastWarningTime = 0;
  const warningCheckId = setInterval(async () => {
    if (!webSocketPool || !userWallet) return;

    const now = Date.now();
    const timeSinceLastFill = now - lastFillReceivedTime;

    if (timeSinceLastFill > warningThreshold && (now - lastWarningTime) > warningThreshold) {
      console.warn(`⚠️  No fills received for ${Math.floor(timeSinceLastFill / 60000)} minutes`);

      if (telegramService.isEnabled()) {
        await telegramService.sendMessage(`⚠️ No fills for ${Math.floor(timeSinceLastFill / 60000)} min - may indicate low trading activity`);
      }
      lastWarningTime = now;
    }
  }, warningCheckInterval);

  const healthCheckInterval = 1 * 60 * 1000;
  const healthCheckId = setInterval(async () => {
    if (!webSocketPool || !userWallet) return;

    try {
      const health = await healthMonitor.runHealthChecks();

      if (health.status === 'unhealthy') {
        console.error(`❌ Health check FAILED: System unhealthy`);
        if (telegramService.isEnabled()) {
          const unhealthyChecks = Object.entries(health.checks)
            .filter(([_, check]) => !check.healthy)
            .map(([name, check]) => `${name}: ${check.message}`)
            .join('\n');

          await telegramService.sendError(`⚠️ Health Check Failed:\n${unhealthyChecks}`);
        }
      } else if (health.status === 'degraded') {
        console.warn(`⚠️  Health check: System degraded`);
      }
    } catch (error) {
      console.error(`✗ Health check error:`, error);
    }
  }, healthCheckInterval);

  const restart = async () => {
    console.log(`\n\n🔄 Bot restarting (Telegram command)`);
    clearInterval(intervalId);
    clearInterval(warningCheckId);
    clearInterval(healthCheckId);

    try {
      if (webSocketPool) {
        await Promise.race([
          webSocketPool.closeAll(),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
      }
      if (fillQueue) {
        fillQueue.clear();
      }
      await Promise.race([
        service.cleanup(),
        new Promise(resolve => setTimeout(resolve, 1000))
      ]);
      await Promise.race([
        telegramService.stop(),
        new Promise(resolve => setTimeout(resolve, 1000))
      ]);
    } catch (error) {
      console.error('Error during restart:', error);
    }

    process.exit(0);
  };

  const shutdown = async (signal: string) => {
    console.log(`\n\n🛑 Monitoring stopped (${signal})`);
    clearInterval(intervalId);
    clearInterval(warningCheckId);
    clearInterval(healthCheckId);

    try {
      if (webSocketPool) {
        await Promise.race([
          webSocketPool.closeAll(),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
      }
      if (fillQueue) {
        fillQueue.clear();
      }
      await Promise.race([
        service.cleanup(),
        new Promise(resolve => setTimeout(resolve, 1000))
      ]);
      await Promise.race([
        telegramService.stop(),
        new Promise(resolve => setTimeout(resolve, 1000))
      ]);
    } catch (error) {
      console.error('Error during shutdown:', error);
    }

    process.exit(0);
  };

  telegramService.setRestartCallback(restart);

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

const main = async (): Promise<void> => {
  const config = loadConfig();

  if (!config.trackedWallet) {
    console.error('\nError: TRACKED_WALLET not configured in .env file');
    console.log('Please create a .env file with TRACKED_WALLET\n');
    console.log('Example .env:');
    console.log('  TRACKED_WALLET=0x1234...5678');
    console.log('  USER_WALLET=0xabcd...ef01');
    console.log('  PRIVATE_KEY=0x...');
    console.log('  IS_TESTNET=false\n');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const intervalArg = args.find(arg => arg.startsWith('--interval='));

  let pollInterval = DEFAULT_POLL_INTERVAL;
  if (intervalArg) {
    const interval = parseInt(intervalArg.split('=')[1], 10);
    if (!isNaN(interval) && interval >= 1000) {
      pollInterval = interval;
    } else {
      console.error('\nError: Invalid interval value (minimum 1000ms)\n');
      process.exit(1);
    }
  }

  // Initialize Telegram service
  const telegramService = new TelegramService(config.telegramBotToken, config.telegramChatId);
  if (telegramService.isEnabled()) {
    console.log('✓ Telegram notifications enabled');
  }

  await monitorTrackedWallet(config.trackedWallet, config.userWallet, config.privateKey, pollInterval, config.isTestnet, telegramService);
};

main();
