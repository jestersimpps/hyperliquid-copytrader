import * as fs from 'fs'
import * as path from 'path'
import { TradeAction } from '@/models'
import { MonitorSnapshot } from './balance-monitor.service'

export interface TradeLogEntry {
  coin: string
  action: TradeAction
  side: 'long' | 'short'
  size: number
  price: number
  timestamp: number
  executionMs: number
  connectionId: number
  syncReason?: string
  realizedPnl?: number
  fee?: string
  orderId?: number
  source?: string
}

export interface TrackedFillEntry {
  coin: string
  side: string
  size: number
  price: number
  timestamp: number
  closedPnl: number
  fee: number
}

export class LoggerService {
  private readonly dataDir: string

  constructor() {
    this.dataDir = path.resolve(process.cwd(), 'data')
    this.ensureDataDir()
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
    }
  }

  logSnapshot(snapshot: MonitorSnapshot): void {
    const date = new Date().toISOString().split('T')[0]
    const filePath = path.join(this.dataDir, `snapshots-${date}.jsonl`)

    const entry = {
      timestamp: snapshot.timestamp,
      date: new Date(snapshot.timestamp).toISOString(),
      tracked: {
        accountValue: parseFloat(snapshot.trackedBalance.accountValue),
        withdrawable: parseFloat(snapshot.trackedBalance.withdrawable),
        positionCount: snapshot.trackedPositions.length,
        positions: snapshot.trackedPositions
      },
      user: {
        accountValue: parseFloat(snapshot.userBalance.accountValue),
        withdrawable: parseFloat(snapshot.userBalance.withdrawable),
        positionCount: snapshot.userPositions.length,
        positions: snapshot.userPositions
      },
      balanceRatio: snapshot.balanceRatio
    }

    this.appendLine(filePath, JSON.stringify(entry))
  }

  logTrade(entry: TradeLogEntry): void {
    const date = new Date(entry.timestamp).toISOString().split('T')[0]
    const filePath = path.join(this.dataDir, `trades-${date}.jsonl`)
    this.appendLine(filePath, JSON.stringify({
      timestamp: entry.timestamp,
      date: new Date(entry.timestamp).toISOString(),
      coin: entry.coin,
      side: entry.side === 'long' ? 'sell' : 'buy',
      size: entry.size,
      price: entry.price,
      action: entry.action,
      orderId: entry.orderId || 0,
      realizedPnl: entry.realizedPnl || 0,
      fee: entry.fee || '0',
      executionMs: entry.executionMs,
      source: entry.source || 'auto'
    }))
  }

  logTrackedFill(entry: TrackedFillEntry): void {
    const date = new Date(entry.timestamp).toISOString().split('T')[0]
    const filePath = path.join(this.dataDir, `tracked-fills-${date}.jsonl`)
    this.appendLine(filePath, JSON.stringify({
      timestamp: entry.timestamp,
      date: new Date(entry.timestamp).toISOString(),
      coin: entry.coin,
      side: entry.side,
      size: entry.size,
      price: entry.price,
      closedPnl: entry.closedPnl,
      fee: entry.fee
    }))
  }

  private appendLine(filePath: string, line: string): void {
    try {
      fs.appendFileSync(filePath, line + '\n')
    } catch (error) {
      console.error('Failed to write log:', error instanceof Error ? error.message : error)
    }
  }

  readSnapshots(date?: string): Array<Record<string, unknown>> {
    const targetDate = date || new Date().toISOString().split('T')[0]
    const filePath = path.join(this.dataDir, `snapshots-${targetDate}.jsonl`)

    if (!fs.existsSync(filePath)) return []

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return content
        .trim()
        .split('\n')
        .filter(line => line)
        .map(line => JSON.parse(line))
    } catch (error) {
      console.error('Failed to read snapshots:', error instanceof Error ? error.message : error)
      return []
    }
  }

  readTrades(limit: number = 100): TradeLogEntry[] {
    const filePath = path.join(this.dataDir, 'trades.jsonl')

    if (!fs.existsSync(filePath)) return []

    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(line => line)
      return lines
        .slice(-limit)
        .map(line => JSON.parse(line))
    } catch (error) {
      console.error('Failed to read trades:', error instanceof Error ? error.message : error)
      return []
    }
  }
}
