import '../../src/setup';
import { HyperliquidService } from '../../src/services/hyperliquid.service';
import { ChartDataService } from '../../src/services/chart-data.service';
import type { TimeFrame } from '../../src/models/ohlc.model';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../../src/config';

const TESTING_DIR = path.resolve(process.cwd(), 'testing');

const main = async (): Promise<void> => {
  const config = loadConfig();

  const coins = ['ASTER', 'ZEC', 'STRK', 'MET'];
  const timeframes: TimeFrame[] = ['1m', '5m', '15m', '1h'];
  const startDate = new Date('2025-11-12T16:54:01');
  const startTime = startDate.getTime();
  const endTime = Date.now();

  console.log('\n🚀 Fetching OHLC Data\n');
  console.log(`📅 Start: ${startDate.toLocaleString()}`);
  console.log(`📅 End:   ${new Date(endTime).toLocaleString()}`);
  console.log(`📊 Coins: ${coins.join(', ')}`);
  console.log(`⏱️  Timeframes: ${timeframes.join(', ')}\n`);

  const service = new HyperliquidService(null, null, config.isTestnet);
  await service.initialize();

  const chartService = new ChartDataService(service.publicClient);

  if (!fs.existsSync(TESTING_DIR)) {
    fs.mkdirSync(TESTING_DIR, { recursive: true });
  }

  try {
    for (const coin of coins) {
      console.log(`\n📈 Fetching ${coin}...`);

      for (const timeframe of timeframes) {
        const data = await chartService.getOHLC(coin, timeframe, startTime, endTime);
        const filename = `${coin.toLowerCase()}-ohlc-${timeframe}.json`;
        const filepath = path.join(TESTING_DIR, filename);

        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

        console.log(`   ✓ ${timeframe.padEnd(3)} | ${data.length.toString().padStart(4)} candles | ${filename}`);
      }
    }

    console.log(`\n✅ All OHLC data saved to ${TESTING_DIR}\n`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Error fetching OHLC data: ${errorMessage}\n`);
    process.exit(1);
  } finally {
    await service.cleanup();
  }
};

main();
