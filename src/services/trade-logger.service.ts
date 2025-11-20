import * as fs from 'fs';
import * as path from 'path';
import type { TradeLog } from '@/models/trade-log.model';

export class TradeLoggerService {
  private readonly dataDir: string;

  constructor() {
    this.dataDir = path.resolve(process.cwd(), 'data');
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private getFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.dataDir, `trades-${date}.jsonl`);
  }

  logClosedTrade(tradeData: TradeLog): void {
    setImmediate(() => {
      try {
        const filePath = this.getFilePath();
        const jsonLine = JSON.stringify(tradeData) + '\n';
        fs.appendFileSync(filePath, jsonLine, 'utf-8');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Failed to write trade log: ${errorMessage}`);
      }
    });
  }
}
