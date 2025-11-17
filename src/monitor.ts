import './setup';
import { HyperliquidService } from './services/hyperliquid.service';
import { MonitoringService } from './services/monitoring.service';
import { IgnoreListService } from './services/ignore-list.service';
import { ActionCopyService } from './services/action-copy.service';
import {
  displayPositionChange,
  displayActionRecommendation,
  displayMonitoringHeader,
  displayIgnoreListInit,
  formatTimestamp
} from './utils/display.utils';
import { calculateBalanceRatio } from './utils/scaling.utils';
import { loadConfig } from './config';

const DEFAULT_POLL_INTERVAL = 1000;

const monitorTrackedWallet = async (
  trackedWallet: string,
  userWallet: string | null,
  pollInterval: number,
  isTestnet: boolean
): Promise<void> => {
  const service = new HyperliquidService(null, null, isTestnet);
  await service.initialize();

  const monitoringService = new MonitoringService();
  const ignoreListService = new IgnoreListService();

  let actionCopyService: ActionCopyService | null = null;
  let balanceRatio = 1;

  displayMonitoringHeader(trackedWallet, userWallet, pollInterval);

  let isFirstRun = true;

  const poll = async (): Promise<void> => {
    try {
      const [trackedPositions, trackedBalance] = await Promise.all([
        service.getOpenPositions(trackedWallet),
        service.getAccountBalance(trackedWallet)
      ]);

      let userPositions = [];
      let userBalance = null;

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
          actionCopyService = new ActionCopyService(ignoreListService, balanceRatio);
        }
      }

      const snapshot = monitoringService.createSnapshot(
        trackedPositions,
        parseFloat(trackedBalance.withdrawable)
      );

      const changes = monitoringService.detectChanges(snapshot);

      if (isFirstRun) {
        ignoreListService.initialize(trackedPositions);

        console.log(`[${formatTimestamp(new Date())}] 📊 Initial snapshot captured`);
        console.log(`  Tracked Positions: ${trackedPositions.length}`);
        console.log(`  Tracked Balance (withdrawable): $${parseFloat(trackedBalance.withdrawable).toFixed(2)}`);

        if (userWallet && userBalance) {
          console.log(`  Your Positions: ${userPositions.length}`);
          console.log(`  Your Balance (withdrawable): $${parseFloat(userBalance.withdrawable).toFixed(2)}`);
          console.log(`  Balance Ratio: 1:${balanceRatio.toFixed(4)}`);
        }

        displayIgnoreListInit(ignoreListService.getIgnoreList());

        isFirstRun = false;
      } else if (changes.length > 0) {
        for (const change of changes) {
          displayPositionChange(change);

          if (userWallet && actionCopyService) {
            const recommendation = actionCopyService.getRecommendation(
              change,
              userPositions
            );

            if (recommendation) {
              displayActionRecommendation(recommendation);
            }
          }
        }
      } else {
        const time = formatTimestamp(new Date());
        process.stdout.write(`\r[${time}] ✓ No changes detected - monitoring...`);
      }
    } catch (error) {
      console.error(`\n[${formatTimestamp(new Date())}] ❌ Error:`, error instanceof Error ? error.message : error);
    }
  };

  await poll();

  const intervalId = setInterval(poll, pollInterval);

  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Monitoring stopped by user');
    clearInterval(intervalId);
    await service.cleanup();
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

  await monitorTrackedWallet(config.trackedWallet, config.userWallet, pollInterval, config.isTestnet);
};

main();
