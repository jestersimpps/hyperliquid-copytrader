import './setup';
import { HyperliquidService } from './services/hyperliquid.service';
import { CopyTradingService } from './services/copy-trading.service';
import type { Position, Balance } from './models';
import type { WalletComparison, PositionComparison } from './models/comparison.model';
import { loadConfig } from './config';

const displayBalance = (balance: Balance, walletAddress: string, label: string): void => {
  console.log(`\n  ${label}:`);
  console.log(`    Wallet:           ${walletAddress}`);
  console.log(`    Account Value:    $${parseFloat(balance.accountValue).toFixed(2)}`);
  console.log(`    Withdrawable:     $${parseFloat(balance.withdrawable).toFixed(2)} (used for scaling)`);
  console.log(`    Margin Used:      $${parseFloat(balance.marginUsed).toFixed(2)}`);
};

const displayWalletComparison = (comparison: WalletComparison): void => {
  console.log('\n========================================');
  console.log('        WALLET COMPARISON');
  console.log('========================================');
  console.log(`\n  Balance Ratio: 1:${comparison.balanceRatio.toFixed(4)}`);
  console.log(`  (For every $1 they trade, you trade $${comparison.balanceRatio.toFixed(4)})`);
  console.log('');
};

const displayPositionComparisons = (comparisons: PositionComparison[]): void => {
  console.log('========================================');
  console.log('       POSITION COMPARISON');
  console.log('========================================\n');

  comparisons.forEach((comp) => {
    console.log(`\n--- ${comp.coin} ---`);

    if (comp.trackedPosition) {
      console.log(`  Tracked: ${comp.trackedPosition.side.toUpperCase()} ${comp.trackedPosition.size.toFixed(4)} @ $${comp.trackedPosition.entryPrice.toFixed(4)} (${comp.trackedPosition.accountPercentage.toFixed(2)}% of account)`);
    } else {
      console.log(`  Tracked: No position`);
    }

    if (comp.userPosition) {
      console.log(`  Your:    ${comp.userPosition.side.toUpperCase()} ${comp.userPosition.size.toFixed(4)} @ $${comp.userPosition.entryPrice.toFixed(4)} (${comp.userPosition.accountPercentage.toFixed(2)}% of account)`);
    } else {
      console.log(`  Your:    No position`);
    }

    if (comp.recommendation) {
      const rec = comp.recommendation;
      console.log(`\n  📋 RECOMMENDATION: ${rec.action.toUpperCase()}`);

      switch (rec.action) {
        case 'open':
          console.log(`     Open ${rec.side.toUpperCase()} position: ${rec.targetSize.toFixed(4)} ${rec.coin}`);
          console.log(`     Estimated value: $${rec.estimatedValue.toFixed(2)} (${rec.targetPercentage.toFixed(2)}% of account)`);
          break;
        case 'close':
          console.log(`     Close ${rec.side.toUpperCase()} position: ${rec.currentSize.toFixed(4)} ${rec.coin}`);
          console.log(`     Estimated value: $${rec.estimatedValue.toFixed(2)}`);
          break;
        case 'increase':
          console.log(`     Increase ${rec.side.toUpperCase()} position by: ${rec.tradeSize.toFixed(4)} ${rec.coin}`);
          console.log(`     Current: ${rec.currentSize.toFixed(4)} → Target: ${rec.targetSize.toFixed(4)}`);
          console.log(`     Target value: $${rec.estimatedValue.toFixed(2)} (${rec.targetPercentage.toFixed(2)}% of account)`);
          break;
        case 'decrease':
          console.log(`     Decrease ${rec.side.toUpperCase()} position by: ${rec.tradeSize.toFixed(4)} ${rec.coin}`);
          console.log(`     Current: ${rec.currentSize.toFixed(4)} → Target: ${rec.targetSize.toFixed(4)}`);
          console.log(`     Target value: $${rec.estimatedValue.toFixed(2)} (${rec.targetPercentage.toFixed(2)}% of account)`);
          break;
        case 'reverse':
          console.log(`     Close current ${comp.userPosition?.side.toUpperCase()} and open ${rec.side.toUpperCase()}: ${rec.targetSize.toFixed(4)} ${rec.coin}`);
          console.log(`     Total trade size: ${rec.tradeSize.toFixed(4)} ${rec.coin}`);
          console.log(`     Target value: $${rec.estimatedValue.toFixed(2)} (${rec.targetPercentage.toFixed(2)}% of account)`);
          break;
        case 'hold':
          console.log(`     Position is perfectly aligned - no action needed`);
          console.log(`     Current: ${rec.currentSize.toFixed(4)} = Target: ${rec.targetSize.toFixed(4)}`);
          break;
      }
    }
  });
};

const displayPositions = (positions: Position[], title: string): void => {
  console.log(`\n========================================`);
  console.log(`       ${title}`);
  console.log(`========================================\n`);

  if (positions.length === 0) {
    console.log('No open positions found.\n');
    return;
  }

  positions.forEach((pos, index) => {
    console.log(`Position #${index + 1}:`);
    console.log(`  Coin:              ${pos.coin}`);
    console.log(`  Side:              ${pos.side.toUpperCase()}`);
    console.log(`  Size:              ${pos.size}`);
    console.log(`  Entry Price:       $${pos.entryPrice.toFixed(4)}`);
    console.log(`  Mark Price:        $${pos.markPrice.toFixed(4)}`);
    console.log(`  Unrealized PnL:    $${pos.unrealizedPnl.toFixed(2)}`);
    console.log(`  Leverage:          ${pos.leverage}x`);
    console.log(`  Margin Used:       $${pos.marginUsed.toFixed(2)}`);
    console.log(`  Liquidation Price: $${pos.liquidationPrice.toFixed(4)}`);
    console.log('');
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

  const trackedWallet = config.trackedWallet;
  const userWallet = config.userWallet;

  console.log('\n🔍 Fetching data from Hyperliquid...\n');

  try {
    const service = new HyperliquidService(null, null, config.isTestnet);
    await service.initialize();

    if (!userWallet) {
      const [positions, balance] = await Promise.all([
        service.getOpenPositions(trackedWallet),
        service.getAccountBalance(trackedWallet)
      ]);

      console.log('========================================');
      console.log('          TRACKED WALLET');
      console.log('========================================');
      displayBalance(balance, trackedWallet, 'Account');
      displayPositions(positions, 'TRACKED POSITIONS');
      console.log('========================================\n');
    } else {
      const copyService = new CopyTradingService();

      const [
        trackedPositions,
        trackedBalance,
        userPositions,
        userBalance
      ] = await Promise.all([
        service.getOpenPositions(trackedWallet),
        service.getAccountBalance(trackedWallet),
        service.getOpenPositions(userWallet),
        service.getAccountBalance(userWallet)
      ]);

      const walletComparison = copyService.compareWallets(
        trackedWallet,
        userWallet,
        parseFloat(trackedBalance.withdrawable),
        parseFloat(userBalance.withdrawable)
      );

      const currentPrices = new Map<string, number>();
      [...trackedPositions, ...userPositions].forEach(pos => {
        currentPrices.set(pos.coin, pos.markPrice);
      });

      const positionComparisons = copyService.comparePositions(
        trackedPositions,
        userPositions,
        walletComparison,
        currentPrices
      );

      console.log('========================================');
      console.log('          ACCOUNT BALANCES');
      console.log('========================================');
      displayBalance(trackedBalance, trackedWallet, 'Tracked Wallet');
      displayBalance(userBalance, userWallet, 'Your Wallet');

      displayWalletComparison(walletComparison);
      displayPositionComparisons(positionComparisons);

      console.log('\n========================================');
      console.log('            DETAILED VIEW');
      console.log('========================================');
      displayPositions(trackedPositions, 'TRACKED POSITIONS');
      displayPositions(userPositions, 'YOUR POSITIONS');

      console.log('========================================\n');
    }

    await service.cleanup();
  } catch (error) {
    console.error('\n❌ Error fetching data:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

main();
