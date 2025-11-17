import type { PositionChange } from '../models/change.model';
import type { TradeRecommendation } from '../models/comparison.model';
import type { ActionRecommendation } from '../services/action-copy.service';

export const formatTimestamp = (date: Date): string => {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

export const displayPositionChange = (change: PositionChange): void => {
  const time = formatTimestamp(change.timestamp);

  console.log(`\n[${time}] 🔔 POSITION CHANGE DETECTED`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  switch (change.type) {
    case 'opened':
      console.log(`  ✅ OPENED ${change.newSide.toUpperCase()} ${change.coin}`);
      console.log(`     Size: ${change.newSize.toFixed(4)}`);
      break;

    case 'closed':
      console.log(`  ❌ CLOSED ${change.previousSide?.toUpperCase()} ${change.coin}`);
      console.log(`     Previous Size: ${change.previousSize.toFixed(4)}`);
      break;

    case 'increased':
      console.log(`  📈 INCREASED ${change.newSide.toUpperCase()} ${change.coin}`);
      console.log(`     ${change.previousSize.toFixed(4)} → ${change.newSize.toFixed(4)} (+${(change.newSize - change.previousSize).toFixed(4)})`);
      break;

    case 'decreased':
      console.log(`  📉 DECREASED ${change.newSide.toUpperCase()} ${change.coin}`);
      console.log(`     ${change.previousSize.toFixed(4)} → ${change.newSize.toFixed(4)} (-${(change.previousSize - change.newSize).toFixed(4)})`);
      break;

    case 'reversed':
      console.log(`  🔄 REVERSED ${change.coin}`);
      console.log(`     ${change.previousSide?.toUpperCase()} ${change.previousSize.toFixed(4)} → ${change.newSide.toUpperCase()} ${change.newSize.toFixed(4)}`);
      break;
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
};

export const displayRecommendationForChange = (rec: TradeRecommendation): void => {
  console.log('  💡 YOUR ACTION:');

  switch (rec.action) {
    case 'open':
      console.log(`     ➡️  Open ${rec.side.toUpperCase()} position: ${rec.targetSize.toFixed(4)} ${rec.coin}`);
      console.log(`     💰 Estimated value: $${rec.estimatedValue.toFixed(2)} (${rec.targetPercentage.toFixed(2)}% of account)`);
      break;

    case 'close':
      console.log(`     ➡️  Close ${rec.side.toUpperCase()} position: ${rec.currentSize.toFixed(4)} ${rec.coin}`);
      console.log(`     💰 Estimated value: $${rec.estimatedValue.toFixed(2)}`);
      break;

    case 'increase':
      console.log(`     ➡️  Increase ${rec.side.toUpperCase()} by: ${rec.tradeSize.toFixed(4)} ${rec.coin}`);
      console.log(`     📊 ${rec.currentSize.toFixed(4)} → ${rec.targetSize.toFixed(4)}`);
      console.log(`     💰 Target value: $${rec.estimatedValue.toFixed(2)} (${rec.targetPercentage.toFixed(2)}% of account)`);
      break;

    case 'decrease':
      console.log(`     ➡️  Decrease ${rec.side.toUpperCase()} by: ${rec.tradeSize.toFixed(4)} ${rec.coin}`);
      console.log(`     📊 ${rec.currentSize.toFixed(4)} → ${rec.targetSize.toFixed(4)}`);
      console.log(`     💰 Target value: $${rec.estimatedValue.toFixed(2)} (${rec.targetPercentage.toFixed(2)}% of account)`);
      break;

    case 'reverse':
      console.log(`     ➡️  Close ${rec.currentSize.toFixed(4)} ${rec.coin} and open ${rec.side.toUpperCase()} ${rec.targetSize.toFixed(4)}`);
      console.log(`     📊 Total trade: ${rec.tradeSize.toFixed(4)} ${rec.coin}`);
      console.log(`     💰 Target value: $${rec.estimatedValue.toFixed(2)} (${rec.targetPercentage.toFixed(2)}% of account)`);
      break;

    case 'hold':
      console.log(`     ✅ Position already aligned - no action needed`);
      break;
  }
  console.log('');
};

export const clearConsole = (): void => {
  console.clear();
};

export const displayMonitoringHeader = (trackedWallet: string, userWallet: string | null, interval: number): void => {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║           COPYSCALPER - MONITORING MODE                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  console.log(`  Tracking: ${trackedWallet}`);

  if (userWallet) {
    console.log(`  Your Wallet: ${userWallet}`);
  }

  console.log(`  Update Interval: ${interval / 1000}s`);
  console.log(`  Started: ${new Date().toLocaleString()}`);
  console.log('\n  Press Ctrl+C to stop monitoring...\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
};

export const displayIgnoreListInit = (ignoreList: Array<{ coin: string; side: 'long' | 'short' }>): void => {
  if (ignoreList.length === 0) {
    console.log('  🟢 No pre-existing positions - tracking all changes from start\n');
    return;
  }

  console.log(`  🔸 Ignoring ${ignoreList.length} pre-existing position${ignoreList.length > 1 ? 's' : ''}:`);
  ignoreList.forEach(pos => {
    console.log(`     - ${pos.coin} ${pos.side.toUpperCase()}`);
  });
  console.log('  ℹ️  Will start tracking when these are closed/reversed or new positions open\n');
};

export const displayActionRecommendation = (rec: ActionRecommendation): void => {
  if (rec.isIgnored) {
    console.log(`  🔸 ${rec.reason}`);
    console.log('');
    return;
  }

  console.log('  💡 YOUR ACTION:');

  switch (rec.action) {
    case 'open':
      console.log(`     ➡️  Open ${rec.side.toUpperCase()} position: ${rec.size.toFixed(4)} ${rec.coin} @ market`);
      console.log(`     📝 ${rec.reason}`);
      break;

    case 'close':
      console.log(`     ➡️  Close ${rec.side.toUpperCase()} position: ${rec.size.toFixed(4)} ${rec.coin}`);
      console.log(`     📝 ${rec.reason}`);
      break;

    case 'add':
      console.log(`     ➡️  Add to ${rec.side.toUpperCase()} position: ${rec.size.toFixed(4)} ${rec.coin} @ market`);
      console.log(`     📝 ${rec.reason}`);
      break;

    case 'reduce':
      console.log(`     ➡️  Reduce ${rec.side.toUpperCase()} position by: ${rec.size.toFixed(4)} ${rec.coin}`);
      console.log(`     📝 ${rec.reason}`);
      break;

    case 'reverse':
      console.log(`     ➡️  Close current position and open ${rec.side.toUpperCase()}: ${rec.size.toFixed(4)} ${rec.coin}`);
      console.log(`     📝 ${rec.reason}`);
      break;

    case 'ignore':
      console.log(`     ⏭️  No action needed`);
      console.log(`     📝 ${rec.reason}`);
      break;
  }

  console.log('');
};
