import './setup';
import { HyperliquidService } from './services/hyperliquid.service';
import { TradeHistoryService } from './services/trade-history.service';
import { WebSocketFillsService } from './services/websocket-fills.service';
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
  userWallet: string,
  telegramService: TelegramService,
  startTime: number
): Promise<FillProcessingResult> => {
  try {
    const action = tradeHistoryService.determineAction(fill);
    if (!action) return { success: true, coin: fill.coin };
    if (!service.canExecuteTrades()) return { success: true, coin: fill.coin, action: action.action };

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

    // Telegram notification (fire and forget)
    if (telegramService.isEnabled() && orderResponse) {
      telegramService.sendMessage(`✅ Trade Executed\n\nCoin: ${action.coin}\nAction: ${action.action.toUpperCase()} ${action.side.toUpperCase()}\nSize: ${action.size.toFixed(4)}\nPrice: $${parseFloat(fill.px).toFixed(4)}\n\n${action.reason}`).catch(() => {});
    }

    return { success: true, coin: action.coin, action: action.action };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    setImmediate(() => console.error(`✗ ${fill.coin} failed: ${errorMessage}`));
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
  let webSocketFillsService: WebSocketFillsService | null = null;
  let lastBalanceUpdate = 0;
  const BALANCE_UPDATE_INTERVAL = 1 * 60 * 1000;

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

  const updateBalanceRatio = async (): Promise<void> => {
    if (!userWallet) return;

    const [trackedBalance, userBalance, userPositions] = await Promise.all([
      service.getAccountBalance(trackedWallet),
      service.getAccountBalance(userWallet),
      service.getOpenPositions(userWallet)
    ]);

    const oldRatio = balanceRatio;
    const newRatio = calculateBalanceRatio(
      parseFloat(userBalance.accountValue),
      parseFloat(trackedBalance.accountValue)
    );

    balanceRatio = newRatio;

    if (tradeHistoryService) {
      tradeHistoryService = new TradeHistoryService(service.publicClient, newRatio);
    }

    const ratioChangePercent = oldRatio !== 0 ? ((newRatio - oldRatio) / oldRatio) * 100 : 0;

    console.log(`\n💰 Balance Update [${formatTimestamp(new Date())}]`);
    console.log(`  Tracked Account: $${parseFloat(trackedBalance.accountValue).toFixed(2)}`);
    console.log(`  Your Account: $${parseFloat(userBalance.accountValue).toFixed(2)}`);
    console.log(`  Balance Ratio: 1:${newRatio.toFixed(4)} ${ratioChangePercent !== 0 ? `(${ratioChangePercent > 0 ? '+' : ''}${ratioChangePercent.toFixed(2)}%)` : ''}`);
    console.log(`  Your Positions: ${userPositions.length}\n`);

    if (telegramService.isEnabled()) {
      telegramService.updateStats({
        trackedWallet,
        userWallet,
        trackedPositions: 0,
        trackedBalance: parseFloat(trackedBalance.accountValue),
        userPositions: userPositions.length,
        userBalance: parseFloat(userBalance.accountValue),
        balanceRatio: newRatio,
        ignoredCoins: [],
        uptime: Date.now() - startTime
      });
    }

    lastBalanceUpdate = Date.now();
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

            webSocketFillsService = new WebSocketFillsService(isTestnet);
            await webSocketFillsService.initialize(trackedWallet, async (fill) => {
              await processFill(fill, service, tradeHistoryService!, userWallet, telegramService, Date.now());
            });
            console.log('✓ Real-time WebSocket monitoring active\n');
          }
          isFirstRun = false;
        }
      }

      // WebSocket handles fill detection in real-time, no need to poll for fills
      // Just show we're monitoring if balance was updated
      if (shouldUpdateBalance && !isFirstRun) {
        console.log(`[${formatTimestamp(new Date())}] ✓ Balance updated - WebSocket monitoring active`);
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
    if (webSocketFillsService) {
      await webSocketFillsService.close();
    }
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
