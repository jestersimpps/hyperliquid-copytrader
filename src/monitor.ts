import './setup';
import { HyperliquidService } from './services/hyperliquid.service';
import { TradeHistoryService } from './services/trade-history.service';
import { TelegramService } from './services/telegram.service';
import { calculateBalanceRatio } from './utils/scaling.utils';
import { loadConfig } from './config';

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
  userPositions: any[],
  telegramService: TelegramService
): Promise<FillProcessingResult> => {
  try {
    const action = tradeHistoryService.determineAction(fill);

    if (!action) {
      console.log(`[Monitor] Fill ignored - determineAction returned null for ${fill.coin} tid=${fill.tid}`);
      return { success: true, coin: fill.coin };
    }

    console.log(`\n📈 Tracked Wallet: ${action.action.toUpperCase()} ${action.side.toUpperCase()} ${fill.coin}`);
    console.log(`   Size: ${parseFloat(fill.sz).toFixed(4)} @ $${parseFloat(fill.px).toFixed(4)}`);
    console.log(`\n💡 YOUR ACTION:`);
    console.log(`   ${action.action.toUpperCase()} ${action.side.toUpperCase()} ${action.size.toFixed(4)} ${fill.coin}`);
    console.log(`   ${action.reason}`);

    if (!service.canExecuteTrades()) {
      return { success: true, coin: fill.coin, action: action.action };
    }

    let orderResponse;

    switch (action.action) {
      case 'open':
        if (action.side === 'long') {
          orderResponse = await service.openLong(action.coin, action.size);
        } else {
          orderResponse = await service.openShort(action.coin, action.size);
        }
        console.log(`   ✓ Executed: OPENED ${action.side.toUpperCase()} ${action.size.toFixed(4)} ${action.coin}`);
        break;

      case 'close':
        const posToClose = userPositions.find(p => p.coin === action.coin);

        if (!posToClose) {
          console.log(`   ⚠️  Skipping CLOSE - you don't have ${action.coin} position`);
          return { success: true, coin: action.coin, action: 'close-skipped' };
        }

        orderResponse = await service.closePosition(action.coin);
        console.log(`   ✓ Executed: CLOSED ${posToClose.size.toFixed(4)} ${action.coin}`);
        break;

      case 'add':
        if (action.side === 'long') {
          orderResponse = await service.openLong(action.coin, action.size);
        } else {
          orderResponse = await service.openShort(action.coin, action.size);
        }
        console.log(`   ✓ Executed: ADDED ${action.size.toFixed(4)} ${action.coin}`);
        break;

      case 'reduce':
        const currentPosition = userPositions.find(p => p.coin === action.coin);

        if (!currentPosition) {
          console.log(`   ⚠️  Skipping REDUCE - you don't have ${action.coin} position`);
          return { success: true, coin: action.coin, action: 'reduce-skipped' };
        }

        if (action.size >= currentPosition.size) {
          console.log(`   ⚠️  Reduce amount (${action.size.toFixed(4)}) >= position size (${currentPosition.size.toFixed(4)})`);
          console.log(`   → Closing 100% instead`);
          orderResponse = await service.closePosition(action.coin);
          console.log(`   ✓ Executed: CLOSED ${currentPosition.size.toFixed(4)} ${action.coin}`);
        } else {
          orderResponse = await service.reducePosition(action.coin, action.size);
          console.log(`   ✓ Executed: REDUCED ${action.size.toFixed(4)} ${action.coin}`);
        }
        break;

      case 'reverse':
        const oldPosition = userPositions.find(p => p.coin === action.coin);
        if (oldPosition) {
          await service.closePosition(action.coin);
          console.log(`   ✓ Closed old ${oldPosition.side.toUpperCase()} position`);
        }
        if (action.side === 'long') {
          orderResponse = await service.openLong(action.coin, action.size);
        } else {
          orderResponse = await service.openShort(action.coin, action.size);
        }
        console.log(`   ✓ Executed: OPENED new ${action.side.toUpperCase()} ${action.size.toFixed(4)} ${action.coin}`);
        break;
    }

    if (telegramService.isEnabled() && orderResponse) {
      telegramService.sendMessage(`✅ Trade Executed\n\nCoin: ${action.coin}\nAction: ${action.action.toUpperCase()} ${action.side.toUpperCase()}\nSize: ${action.size.toFixed(4)}\nPrice: $${parseFloat(fill.px).toFixed(4)}\n\n${action.reason}`).catch(() => {});
    }

    return { success: true, coin: action.coin, action: action.action };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ✗ Trade execution failed for ${fill.coin}: ${errorMessage}`);

    if (telegramService.isEnabled()) {
      telegramService.sendError(`Trade execution failed for ${fill.coin}: ${errorMessage}`).catch(() => {});
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
  const service = new HyperliquidService(privateKey, userWallet, isTestnet);
  await service.initialize();

  const startTime = Date.now();
  let balanceRatio = 1;
  let tradeHistoryService: TradeHistoryService | null = null;

  console.log('\n🚀 Copy Trading Bot Started\n');
  console.log(`📊 Tracked Wallet: ${trackedWallet}`);
  if (userWallet) {
    console.log(`👤 Your Wallet: ${userWallet}`);
  }
  console.log(`⏱️  Poll Interval: ${pollInterval}ms\n`);

  if (telegramService.isEnabled()) {
    await telegramService.sendMonitoringStarted(trackedWallet, userWallet);
  }

  let isFirstRun = true;

  const poll = async (): Promise<void> => {
    try {
      const [trackedBalance] = await Promise.all([
        service.getAccountBalance(trackedWallet)
      ]);

      let userBalance = null;
      let userPositions: any[] = [];

      if (userWallet) {
        [userPositions, userBalance] = await Promise.all([
          service.getOpenPositions(userWallet),
          service.getAccountBalance(userWallet)
        ]);

        balanceRatio = calculateBalanceRatio(
          parseFloat(userBalance.withdrawable),
          parseFloat(trackedBalance.withdrawable)
        );

        if (isFirstRun) {
          tradeHistoryService = new TradeHistoryService(service.publicClient, balanceRatio);
        }
      }

      if (isFirstRun) {
        console.log(`[${formatTimestamp(new Date())}] 📊 Initial State`);
        console.log(`  Tracked Balance: $${parseFloat(trackedBalance.withdrawable).toFixed(2)}`);

        if (userWallet && userBalance) {
          console.log(`  Your Balance: $${parseFloat(userBalance.withdrawable).toFixed(2)}`);
          console.log(`  Balance Ratio: 1:${balanceRatio.toFixed(4)}`);
          console.log(`  Your Positions: ${userPositions.length}`);
        }

        console.log(`\n✅ Monitoring started - watching for trades...\n`);

        if (telegramService.isEnabled()) {
          telegramService.updateStats({
            trackedWallet,
            userWallet,
            trackedPositions: 0,
            trackedBalance: parseFloat(trackedBalance.withdrawable),
            userPositions: userPositions.length,
            userBalance: userBalance ? parseFloat(userBalance.withdrawable) : 0,
            balanceRatio,
            ignoredCoins: [],
            uptime: Date.now() - startTime
          });
        }

        isFirstRun = false;
      } else if (userWallet && tradeHistoryService) {
        // Fetch new fills/trades
        const newFills = await tradeHistoryService.getNewFills(trackedWallet);

        if (newFills.length > 0) {
          console.log(`\n[${formatTimestamp(new Date())}] 🔔 ${newFills.length} NEW TRADE(S) DETECTED`);
          console.log('━'.repeat(50));

          // Process all fills in parallel
          const fillPromises = newFills.map(fill =>
            processFill(fill, service, tradeHistoryService!, userPositions, telegramService)
          );

          const results = await Promise.allSettled(fillPromises);

          // Log results summary
          const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
          const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;

          if (failed > 0) {
            console.log(`\n⚠️  Summary: ${successful} successful, ${failed} failed`);
          }

          console.log('\n' + '━'.repeat(50) + '\n');
        } else {
          process.stdout.write(`\r[${formatTimestamp(new Date())}] ✓ No new trades - monitoring...`);
        }

        // Update telegram stats periodically
        if (telegramService.isEnabled()) {
          telegramService.updateStats({
            trackedWallet,
            userWallet,
            trackedPositions: 0,
            trackedBalance: parseFloat(trackedBalance.withdrawable),
            userPositions: userPositions.length,
            userBalance: userBalance ? parseFloat(userBalance.withdrawable) : 0,
            balanceRatio,
            ignoredCoins: [],
            uptime: Date.now() - startTime
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`\n[${formatTimestamp(new Date())}] ❌ Error:`, errorMessage);

      if (telegramService.isEnabled()) {
        await telegramService.sendError(errorMessage);
      }
    }
  };

  await poll();

  const intervalId = setInterval(poll, pollInterval);

  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Monitoring stopped by user');
    clearInterval(intervalId);
    await service.cleanup();
    await telegramService.stop();
    process.exit(0);
  });
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
