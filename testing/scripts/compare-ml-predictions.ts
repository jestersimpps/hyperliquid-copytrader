import '../../src/setup';
import * as fs from 'fs';
import * as path from 'path';

const TESTING_DIR = path.resolve(process.cwd(), 'testing');

interface PredictedTrade {
  timestamp: number;
  datetime: string;
  action: string;
  direction: string;
  price: number;
  confidence: number;
}

interface ActualTrade {
  time: number;
  coin: string;
  dir: string;
  px: number;
  sz: number;
  ntl: number;
  fee: number;
  closedPnl: number;
}

interface ComparisonResult {
  coin: string;
  totalActualTrades: number;
  totalPredictedTrades: number;
  matchedTrades: number;
  matchAccuracy: number;
  timingAccuracy: number;
  actionAccuracy: number;
  avgTimeDiff: number;
  avgPriceDiff: number;
}

const loadPredictedTrades = (coin: string): PredictedTrade[] => {
  const filepath = path.join(TESTING_DIR, `predicted-trades-${coin.toLowerCase()}.csv`);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Predicted trades not found: ${filepath}`);
  }

  const data = fs.readFileSync(filepath, 'utf-8');
  const lines = data.split('\n');
  const trades: PredictedTrade[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 6) continue;

    trades.push({
      timestamp: parseInt(parts[0]),
      datetime: parts[1],
      action: parts[2],
      direction: parts[3],
      price: parseFloat(parts[4]),
      confidence: parseFloat(parts[5])
    });
  }

  return trades;
};

const loadActualTrades = (coin: string): ActualTrade[] => {
  const filepath = path.join(TESTING_DIR, 'trade_history.csv');

  if (!fs.existsSync(filepath)) {
    throw new Error(`Trade history not found: ${filepath}`);
  }

  const data = fs.readFileSync(filepath, 'utf-8');
  const lines = data.split('\n');
  const trades: ActualTrade[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 8) continue;

    const tradeCoin = parts[1].trim();
    if (tradeCoin !== coin) continue;

    trades.push({
      time: new Date(parts[0]).getTime(),
      coin: parts[1],
      dir: parts[2],
      px: parseFloat(parts[3]),
      sz: parseFloat(parts[4]),
      ntl: parseFloat(parts[5]),
      fee: parseFloat(parts[6]),
      closedPnl: parseFloat(parts[7])
    });
  }

  return trades;
};

const compareActions = (predicted: string, actual: string): boolean => {
  const actualLower = actual.toLowerCase();
  const predictedLower = predicted.toLowerCase();

  if (predictedLower === 'open_long' && (actualLower.includes('long') || actualLower.includes('buy'))) return true;
  if (predictedLower === 'open_short' && (actualLower.includes('short') || actualLower.includes('sell'))) return true;
  if (predictedLower === 'close' && actualLower.includes('close')) return true;
  if (predictedLower === 'add' && actualLower.includes('add')) return true;

  return false;
};

const compareTrades = (predicted: PredictedTrade[], actual: ActualTrade[]): ComparisonResult => {
  const TIME_TOLERANCE_MS = 5 * 60 * 1000;
  const PRICE_TOLERANCE_PERCENT = 0.5;

  let matchedTrades = 0;
  let timingMatches = 0;
  let actionMatches = 0;
  let totalTimeDiff = 0;
  let totalPriceDiff = 0;

  const usedActual = new Set<number>();

  for (const pred of predicted) {
    let bestMatch: { index: number; timeDiff: number; priceDiff: number; actualTrade: ActualTrade } | null = null;

    for (let i = 0; i < actual.length; i++) {
      if (usedActual.has(i)) continue;

      const actualTrade = actual[i];
      const timeDiff = Math.abs(pred.timestamp - actualTrade.time);

      if (timeDiff > TIME_TOLERANCE_MS) continue;

      const priceDiff = Math.abs((pred.price - actualTrade.px) / actualTrade.px) * 100;

      if (!bestMatch || timeDiff < bestMatch.timeDiff) {
        bestMatch = { index: i, timeDiff, priceDiff, actualTrade };
      }
    }

    if (bestMatch) {
      usedActual.add(bestMatch.index);
      matchedTrades++;
      totalTimeDiff += bestMatch.timeDiff;
      totalPriceDiff += bestMatch.priceDiff;

      if (bestMatch.timeDiff < TIME_TOLERANCE_MS) {
        timingMatches++;
      }

      if (compareActions(pred.action, bestMatch.actualTrade.dir)) {
        actionMatches++;
      }
    }
  }

  const matchAccuracy = actual.length > 0 ? matchedTrades / actual.length : 0;
  const timingAccuracy = matchedTrades > 0 ? timingMatches / matchedTrades : 0;
  const actionAccuracy = matchedTrades > 0 ? actionMatches / matchedTrades : 0;
  const avgTimeDiff = matchedTrades > 0 ? totalTimeDiff / matchedTrades : 0;
  const avgPriceDiff = matchedTrades > 0 ? totalPriceDiff / matchedTrades : 0;

  return {
    coin: '',
    totalActualTrades: actual.length,
    totalPredictedTrades: predicted.length,
    matchedTrades,
    matchAccuracy,
    timingAccuracy,
    actionAccuracy,
    avgTimeDiff,
    avgPriceDiff
  };
};

const main = async (): Promise<void> => {
  console.log('\n🚀 Comparing ML Predictions vs Actual Trades\n');

  const coins = ['ASTER', 'ZEC', 'STRK', 'MET'];
  const results: Record<string, ComparisonResult> = {};

  for (const coin of coins) {
    console.log(`${'='.repeat(60)}`);
    console.log(`📊 Analyzing ${coin}`);
    console.log('='.repeat(60));

    try {
      const predicted = loadPredictedTrades(coin);
      const actual = loadActualTrades(coin);

      console.log(`✓ Loaded ${predicted.length} predicted trades`);
      console.log(`✓ Loaded ${actual.length} actual trades`);

      const comparison = compareTrades(predicted, actual);
      comparison.coin = coin;
      results[coin] = comparison;

      console.log(`\n📈 Results:`);
      console.log(`  Match Accuracy: ${(comparison.matchAccuracy * 100).toFixed(2)}%`);
      console.log(`  Timing Accuracy: ${(comparison.timingAccuracy * 100).toFixed(2)}%`);
      console.log(`  Action Accuracy: ${(comparison.actionAccuracy * 100).toFixed(2)}%`);
      console.log(`  Matched Trades: ${comparison.matchedTrades}/${comparison.totalActualTrades}`);
      console.log(`  Avg Time Diff: ${(comparison.avgTimeDiff / 1000 / 60).toFixed(2)} minutes`);
      console.log(`  Avg Price Diff: ${comparison.avgPriceDiff.toFixed(2)}%`);

    } catch (error) {
      console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
    }
  }

  const reportPath = path.join(TESTING_DIR, 'prediction-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));

  Object.entries(results).forEach(([coin, result]) => {
    console.log(`\n${coin}:`);
    console.log(`  Match Accuracy: ${(result.matchAccuracy * 100).toFixed(2)}%`);
    console.log(`  Action Accuracy: ${(result.actionAccuracy * 100).toFixed(2)}%`);
  });

  console.log(`\n✅ Report saved to: ${reportPath}\n`);
};

main();
