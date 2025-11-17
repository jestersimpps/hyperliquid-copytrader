import '../../src/setup';
import * as fs from 'fs';
import * as path from 'path';
import type { OHLCCandle, TimeFrame } from '../../src/models/ohlc.model';
import type { ActualTrade } from '../models/backtest.model';
import { StrategyOptimizerService } from '../services/strategy-optimizer.service';

const TESTING_DIR = path.resolve(process.cwd(), 'testing');

const loadOHLCData = (coin: string, timeframe: TimeFrame): OHLCCandle[] => {
  const filename = `${coin.toLowerCase()}-ohlc-${timeframe}.json`;
  const filepath = path.join(TESTING_DIR, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(`OHLC file not found: ${filepath}`);
  }

  const data = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(data);
};

const loadTradeHistory = (coin: string): ActualTrade[] => {
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

const main = async (): Promise<void> => {
  console.log('\n🚀 Strategy Reverse-Engineering Backtester\n');

  const coins = ['ASTER', 'ZEC', 'STRK', 'MET'];
  const timeframes: TimeFrame[] = ['1m', '5m', '15m', '1h'];

  const optimizer = new StrategyOptimizerService();
  const allResults: Record<string, any> = {};

  for (const coin of coins) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 Analyzing ${coin}`);
    console.log('='.repeat(60));

    const actualTrades = loadTradeHistory(coin);

    if (actualTrades.length === 0) {
      console.log(`⚠️  No trades found for ${coin}, skipping...`);
      continue;
    }

    console.log(`✓ Loaded ${actualTrades.length} actual trades for ${coin}`);

    let bestResult = null;
    let bestTimeframe = null;

    for (const timeframe of timeframes) {
      try {
        const candles = loadOHLCData(coin, timeframe);
        console.log(`\n📈 Testing ${timeframe} timeframe (${candles.length} candles)`);

        const result = optimizer.optimize(coin, candles, actualTrades, [timeframe]);

        if (!bestResult || result.bestScore > bestResult.bestScore) {
          bestResult = result;
          bestTimeframe = timeframe;
        }
      } catch (error) {
        console.error(`   ✗ Error testing ${timeframe}:`, error instanceof Error ? error.message : error);
      }
    }

    if (bestResult && bestTimeframe) {
      allResults[coin] = {
        coin,
        bestTimeframe,
        bestScore: bestResult.bestScore,
        bestConfig: bestResult.bestConfig,
        topConfigs: bestResult.topResults.map(r => ({
          config: r.config,
          score: r.overallScore,
          matchAccuracy: r.matchAccuracy,
          timingAccuracy: r.timingAccuracy,
          directionAccuracy: r.directionAccuracy,
          priceAccuracy: r.priceAccuracy,
          pyramidAccuracy: r.pyramidAccuracy
        }))
      };

      console.log(`\n✅ Best match for ${coin}:`);
      console.log(`   Timeframe: ${bestTimeframe}`);
      console.log(`   Overall Score: ${(bestResult.bestScore * 100).toFixed(2)}%`);
      console.log(`   RSI Period: ${bestResult.bestConfig.rsiPeriod}`);
      console.log(`   RSI Overbought: ${bestResult.bestConfig.rsiOverbought}`);
      console.log(`   RSI Oversold: ${bestResult.bestConfig.rsiOversold}`);
      console.log(`   BB Period: ${bestResult.bestConfig.bbPeriod}`);
      console.log(`   BB StdDev: ${bestResult.bestConfig.bbStdDev}`);
      console.log(`   Max Pyramid: ${bestResult.bestConfig.maxPyramidCount}`);
      console.log(`   Use BB: ${bestResult.bestConfig.useBollingerBands}`);
      console.log(`   Use Stoch: ${bestResult.bestConfig.useStochastic}`);
      console.log(`   Use VWAP: ${bestResult.bestConfig.useVWAP}`);
    }
  }

  const resultsPath = path.join(TESTING_DIR, 'backtest-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));

  Object.entries(allResults).forEach(([coin, result]: [string, any]) => {
    console.log(`\n${coin}:`);
    console.log(`  Best Timeframe: ${result.bestTimeframe}`);
    console.log(`  Match Score: ${(result.bestScore * 100).toFixed(2)}%`);
    console.log(`  RSI(${result.bestConfig.rsiPeriod}): ${result.bestConfig.rsiOversold}/${result.bestConfig.rsiOverbought}`);
  });

  console.log(`\n✅ Results saved to: ${resultsPath}\n`);
};

main().catch(error => {
  console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
