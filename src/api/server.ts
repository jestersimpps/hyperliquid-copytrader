import express, { Request, Response } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import { loadMultiAccountConfig } from '@/config/accounts.config'
import { BalanceMonitorService } from '@/services/balance-monitor.service'
import { LoggerService } from '@/services/logger.service'
import { SubAccountState } from '@/models'
import { FillProcessorService } from '@/services/fill-processor.service'
import { RiskMonitorService } from '@/services/risk-monitor.service'
import { SyncService } from '@/services/sync.service'

interface AccountContext {
  id: string
  state: SubAccountState
  loggerService: LoggerService
  fillProcessor: FillProcessorService
  balanceMonitor: BalanceMonitorService
  riskMonitor: RiskMonitorService
  syncService: SyncService
}

const app = express()
const globalConfig = loadMultiAccountConfig()
const PORT = globalConfig.dashboardPort
const HOST = '0.0.0.0'
const DATA_DIR = path.join(__dirname, '../../data')
const FRONTEND_DIR = path.join(__dirname, '../../frontend')

let accountContexts: Map<string, AccountContext> = new Map()

app.use(express.static(FRONTEND_DIR))

app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'))
})

app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    version: 'v2-multi'
  })
})

app.get('/api/accounts', (req: Request, res: Response) => {
  if (accountContexts.size > 0) {
    const accounts = Array.from(accountContexts.values()).map(ctx => {
      const configAccount = globalConfig.accounts.find(a => a.id === ctx.id)
      return {
        id: ctx.id,
        name: ctx.state.name,
        tradingPaused: ctx.state.tradingPaused,
        hrefModeEnabled: ctx.state.hrefModeEnabled,
        trackedWallet: configAccount?.trackedWallet || '',
        userWallet: configAccount?.vaultAddress || configAccount?.userWallet || ''
      }
    })
    res.json({ accounts, count: accounts.length })
  } else {
    const accounts = globalConfig.accounts.filter(a => a.enabled).map(a => ({
      id: a.id,
      name: a.name,
      tradingPaused: false,
      hrefModeEnabled: false,
      trackedWallet: a.trackedWallet,
      userWallet: a.vaultAddress || a.userWallet
    }))
    res.json({ accounts, count: accounts.length })
  }
})

app.get('/api/snapshots', (req: Request, res: Response) => {
  try {
    const accountId = req.query.account as string
    const dateParam = req.query.date as string
    const targetDate = dateParam || new Date().toISOString().split('T')[0]

    const dataDir = accountId ? path.join(DATA_DIR, accountId) : DATA_DIR
    const filePath = path.join(dataDir, `snapshots-${targetDate}.jsonl`)

    if (!fs.existsSync(filePath)) {
      return res.json({ snapshots: [], count: 0, date: targetDate, accountId: accountId || 'default' })
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const snapshots = content
      .trim()
      .split('\n')
      .filter(line => line)
      .map(line => {
        const snapshot = JSON.parse(line)
        enrichSnapshot(snapshot)
        return snapshot
      })
      .sort((a, b) => a.timestamp - b.timestamp)

    res.json({ snapshots, count: snapshots.length, date: targetDate, accountId: accountId || 'default' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to read snapshots' })
  }
})

app.get('/api/user-snapshots', (req: Request, res: Response) => {
  try {
    const accountId = req.query.account as string
    const dateParam = req.query.date as string
    const targetDate = dateParam || new Date().toISOString().split('T')[0]

    const dataDir = accountId ? path.join(DATA_DIR, accountId) : DATA_DIR
    const filePath = path.join(dataDir, `snapshots-${targetDate}.jsonl`)

    if (!fs.existsSync(filePath)) {
      return res.json({ snapshots: [], count: 0, date: targetDate, accountId: accountId || 'default' })
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const snapshots = content
      .trim()
      .split('\n')
      .filter(line => line)
      .map(line => {
        const snapshot = JSON.parse(line)
        if (snapshot.user) {
          const positions = snapshot.user.positions || []
          const totalUnrealizedPnl = positions.reduce(
            (sum: number, p: { unrealizedPnl?: number }) => sum + (p.unrealizedPnl || 0),
            0
          )
          const totalMarginUsed = positions.reduce(
            (sum: number, p: { marginUsed?: number }) => sum + (p.marginUsed || 0),
            0
          )
          return {
            timestamp: snapshot.timestamp,
            date: snapshot.date,
            wallet: {
              ...snapshot.user,
              totalUnrealizedPnl,
              totalMarginUsed
            }
          }
        }
        return null
      })
      .filter(s => s !== null)
      .sort((a, b) => a.timestamp - b.timestamp)

    res.json({ snapshots, count: snapshots.length, date: targetDate, accountId: accountId || 'default' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to read user snapshots' })
  }
})

app.get('/api/trades', (req: Request, res: Response) => {
  try {
    const accountId = req.query.account as string
    const dateParam = req.query.date as string
    const targetDate = dateParam || new Date().toISOString().split('T')[0]

    let trades: Array<Record<string, unknown>> = []

    if (accountId === 'all') {
      const accountIds = accountContexts.size > 0
        ? Array.from(accountContexts.keys())
        : globalConfig.accounts.filter(a => a.enabled).map(a => a.id)

      for (const accId of accountIds) {
        const dailyFilePath = path.join(DATA_DIR, accId, `trades-${targetDate}.jsonl`)
        if (fs.existsSync(dailyFilePath)) {
          const content = fs.readFileSync(dailyFilePath, 'utf-8')
          const accTrades = content
            .trim()
            .split('\n')
            .filter(line => line)
            .map(line => ({ ...JSON.parse(line), accountId: accId }))
          trades.push(...accTrades)
        }
      }
    } else {
      const dataDir = accountId ? path.join(DATA_DIR, accountId) : DATA_DIR
      const dailyFilePath = path.join(dataDir, `trades-${targetDate}.jsonl`)
      const legacyFilePath = path.join(dataDir, 'trades.jsonl')

      if (fs.existsSync(dailyFilePath)) {
        const content = fs.readFileSync(dailyFilePath, 'utf-8')
        trades = content
          .trim()
          .split('\n')
          .filter(line => line)
          .map(line => JSON.parse(line))
      }

      if (trades.length === 0 && fs.existsSync(legacyFilePath)) {
        const content = fs.readFileSync(legacyFilePath, 'utf-8')
        const allTrades = content
          .trim()
          .split('\n')
          .filter(line => line)
          .map(line => JSON.parse(line))

        trades = allTrades.filter(t => {
          const tradeDate = new Date(t.timestamp).toISOString().split('T')[0]
          return tradeDate === targetDate
        })
      }
    }

    trades.sort((a, b) => (a.timestamp as number) - (b.timestamp as number))

    res.json({ trades, count: trades.length, date: targetDate, accountId: accountId || 'default' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to read trades' })
  }
})

app.get('/api/tracked-fills', (req: Request, res: Response) => {
  try {
    const accountId = req.query.account as string
    const dateParam = req.query.date as string
    const targetDate = dateParam || new Date().toISOString().split('T')[0]

    const dataDir = accountId ? path.join(DATA_DIR, accountId) : DATA_DIR
    const filePath = path.join(dataDir, `tracked-fills-${targetDate}.jsonl`)

    if (!fs.existsSync(filePath)) {
      return res.json({ fills: [], count: 0, date: targetDate, accountId: accountId || 'default' })
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const fills = content
      .trim()
      .split('\n')
      .filter(line => line)
      .map(line => JSON.parse(line))
      .sort((a, b) => a.timestamp - b.timestamp)

    res.json({ fills, count: fills.length, date: targetDate, accountId: accountId || 'default' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to read tracked fills' })
  }
})

app.get('/api/balance-history', (req: Request, res: Response) => {
  try {
    const accountId = req.query.account as string
    const daysParam = req.query.days as string
    const numDays = daysParam ? parseInt(daysParam) : 10
    const balanceHistory: Array<{ timestamp: number; balance: number }> = []
    const today = new Date()

    const dataDir = accountId ? path.join(DATA_DIR, accountId) : DATA_DIR

    for (let i = numDays - 1; i >= 0; i--) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().split('T')[0]
      const filePath = path.join(dataDir, `snapshots-${dateStr}.jsonl`)

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8')
        const lines = content.trim().split('\n').filter(line => line)

        for (const line of lines) {
          const snapshot = JSON.parse(line)
          balanceHistory.push({
            timestamp: snapshot.timestamp,
            balance: snapshot.user?.accountValue || 0
          })
        }
      }
    }

    balanceHistory.sort((a, b) => a.timestamp - b.timestamp)
    res.json({ history: balanceHistory, count: balanceHistory.length, accountId: accountId || 'default' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to read balance history' })
  }
})

app.get('/api/balance-history/all', (req: Request, res: Response) => {
  try {
    const daysParam = req.query.days as string
    const numDays = daysParam ? parseInt(daysParam) : 10
    const today = new Date()

    const result: Record<string, Array<{ timestamp: number; balance: number }>> = {}

    const accountIds = accountContexts.size > 0
      ? Array.from(accountContexts.keys())
      : globalConfig.accounts.filter(a => a.enabled).map(a => a.id)

    for (const accountId of accountIds) {
      const dataDir = path.join(DATA_DIR, accountId)
      const balanceHistory: Array<{ timestamp: number; balance: number }> = []

      for (let i = numDays - 1; i >= 0; i--) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)
        const dateStr = date.toISOString().split('T')[0]
        const filePath = path.join(dataDir, `snapshots-${dateStr}.jsonl`)

        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8')
          const lines = content.trim().split('\n').filter(line => line)

          for (const line of lines) {
            const snapshot = JSON.parse(line)
            balanceHistory.push({
              timestamp: snapshot.timestamp,
              balance: snapshot.user?.accountValue || 0
            })
          }
        }
      }

      balanceHistory.sort((a, b) => a.timestamp - b.timestamp)
      result[accountId] = balanceHistory
    }

    res.json({ accounts: result })
  } catch (error) {
    res.status(500).json({ error: 'Failed to read balance history' })
  }
})

app.get('/api/daily-summary', (req: Request, res: Response) => {
  try {
    const accountId = req.query.account as string
    const daysParam = req.query.days as string
    const numDays = daysParam ? parseInt(daysParam) : 7
    const dailySummary: Array<Record<string, unknown>> = []
    const today = new Date()

    const dataDir = accountId ? path.join(DATA_DIR, accountId) : DATA_DIR

    for (let i = 0; i < numDays; i++) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().split('T')[0]
      const filePath = path.join(dataDir, `snapshots-${dateStr}.jsonl`)

      let hasData = false
      let startBalance = 0
      let endBalance = 0
      let totalPnl = 0
      let pnlPercentage = 0

      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8')
        const lines = content.trim().split('\n').filter(line => line)

        if (lines.length > 0) {
          hasData = true
          const first = JSON.parse(lines[0])
          const last = JSON.parse(lines[lines.length - 1])

          startBalance = first.user?.accountValue || 0
          endBalance = last.user?.accountValue || 0
          totalPnl = endBalance - startBalance
          pnlPercentage = startBalance > 0 ? (totalPnl / startBalance) * 100 : 0
        }
      }

      dailySummary.push({
        date: dateStr,
        hasData,
        startBalance,
        endBalance,
        totalPnl,
        pnlPercentage
      })
    }

    res.json({ days: dailySummary, count: dailySummary.length, accountId: accountId || 'default' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to read daily summary' })
  }
})

interface PositionSummary {
  coin: string
  side: string
  size: number
  notionalValue: number
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  leverage: number
}

interface AccountSummary {
  accountId: string
  name: string
  trackedWallet: string
  balance: number
  unrealizedPnl: number
  positions: PositionSummary[]
  trackedPositions: PositionSummary[]
  tradingPaused: boolean
  tradesLast10Min: number
}

function getTradesLast10Min(accountId: string): number {
  const today = new Date().toISOString().split('T')[0]
  const filePath = path.join(DATA_DIR, accountId, `trades-${today}.jsonl`)

  if (!fs.existsSync(filePath)) {
    return 0
  }

  const tenMinutesAgo = Date.now() - 10 * 60 * 1000
  const content = fs.readFileSync(filePath, 'utf-8')
  const trades = content
    .trim()
    .split('\n')
    .filter(line => line)
    .map(line => JSON.parse(line))
    .filter(trade => trade.timestamp >= tenMinutesAgo)

  return trades.length
}

app.get('/api/summary', async (req: Request, res: Response) => {
  try {
    const summaries: AccountSummary[] = []

    if (accountContexts.size > 0) {
      for (const [accountId, ctx] of accountContexts) {
        const snapshot = await ctx.balanceMonitor.getSnapshot()
        const positions: PositionSummary[] = snapshot?.userPositions.map(p => ({
          coin: p.coin,
          side: p.side,
          size: p.size,
          notionalValue: p.notionalValue,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedPnl: p.unrealizedPnl,
          leverage: p.leverage
        })) || []
        const trackedPositions: PositionSummary[] = snapshot?.trackedPositions.map(p => ({
          coin: p.coin,
          side: p.side,
          size: p.size,
          notionalValue: p.notionalValue,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedPnl: p.unrealizedPnl,
          leverage: p.leverage
        })) || []
        const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
        const configAccount = globalConfig.accounts.find(a => a.id === accountId)
        summaries.push({
          accountId,
          name: ctx.state.name,
          trackedWallet: configAccount?.trackedWallet || '',
          balance: snapshot ? parseFloat(snapshot.userBalance.accountValue) : 0,
          unrealizedPnl,
          positions,
          trackedPositions,
          tradingPaused: ctx.state.tradingPaused,
          tradesLast10Min: getTradesLast10Min(accountId)
        })
      }
    } else {
      const today = new Date().toISOString().split('T')[0]
      for (const account of globalConfig.accounts.filter(a => a.enabled)) {
        const filePath = path.join(DATA_DIR, account.id, `snapshots-${today}.jsonl`)
        let balance = 0
        let positions: PositionSummary[] = []
        let trackedPositions: PositionSummary[] = []
        let unrealizedPnl = 0
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8')
          const lines = content.trim().split('\n').filter(line => line)
          if (lines.length > 0) {
            const lastSnapshot = JSON.parse(lines[lines.length - 1])
            balance = lastSnapshot.user?.accountValue || 0
            positions = (lastSnapshot.user?.positions || []).map((p: Record<string, unknown>) => ({
              coin: p.coin,
              side: p.side,
              size: p.size,
              notionalValue: p.notionalValue,
              entryPrice: p.entryPrice,
              markPrice: p.markPrice,
              unrealizedPnl: p.unrealizedPnl || 0,
              leverage: p.leverage
            }))
            trackedPositions = (lastSnapshot.tracked?.positions || []).map((p: Record<string, unknown>) => ({
              coin: p.coin,
              side: p.side,
              size: p.size,
              notionalValue: p.notionalValue,
              entryPrice: p.entryPrice,
              markPrice: p.markPrice,
              unrealizedPnl: p.unrealizedPnl || 0,
              leverage: p.leverage
            }))
            unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
          }
        }
        summaries.push({
          accountId: account.id,
          name: account.name,
          trackedWallet: account.trackedWallet,
          balance,
          unrealizedPnl,
          positions,
          trackedPositions,
          tradingPaused: false,
          tradesLast10Min: getTradesLast10Min(account.id)
        })
      }
    }

    const totalBalance = summaries.reduce((sum, s) => sum + s.balance, 0)
    const totalPositions = summaries.reduce((sum, s) => sum + s.positions.length, 0)
    const totalUnrealizedPnl = summaries.reduce((sum, s) => sum + s.unrealizedPnl, 0)
    const totalTradesLast10Min = summaries.reduce((sum, s) => sum + s.tradesLast10Min, 0)

    res.json({
      accounts: summaries,
      total: {
        balance: totalBalance,
        unrealizedPnl: totalUnrealizedPnl,
        positions: totalPositions,
        accountCount: summaries.length,
        tradesLast10Min: totalTradesLast10Min
      }
    })
  } catch (error) {
    res.status(500).json({ error: 'Failed to get summary' })
  }
})

function enrichSnapshot(snapshot: Record<string, unknown>): void {
  if (snapshot.user && typeof snapshot.user === 'object') {
    const user = snapshot.user as Record<string, unknown>
    const userPositions = (user.positions as Array<Record<string, unknown>>) || []
    user.totalUnrealizedPnl = userPositions.reduce(
      (sum: number, p) => sum + ((p.unrealizedPnl as number) || 0),
      0
    )
    user.totalMarginUsed = userPositions.reduce(
      (sum: number, p) => sum + ((p.marginUsed as number) || 0),
      0
    )
    user.averageLeverage = userPositions.length > 0
      ? userPositions.reduce((sum: number, p) => sum + ((p.leverage as number) || 0), 0) / userPositions.length
      : 0
    user.crossMarginRatio = (user.accountValue as number) > 0
      ? ((user.totalMarginUsed as number) / (user.accountValue as number)) * 100
      : 0
  }

  if (snapshot.tracked && typeof snapshot.tracked === 'object') {
    const tracked = snapshot.tracked as Record<string, unknown>
    const trackedPositions = (tracked.positions as Array<Record<string, unknown>>) || []
    tracked.totalUnrealizedPnl = trackedPositions.reduce(
      (sum: number, p) => sum + ((p.unrealizedPnl as number) || 0),
      0
    )
    tracked.totalMarginUsed = trackedPositions.reduce(
      (sum: number, p) => sum + ((p.marginUsed as number) || 0),
      0
    )
    tracked.averageLeverage = trackedPositions.length > 0
      ? trackedPositions.reduce((sum: number, p) => sum + ((p.leverage as number) || 0), 0) / trackedPositions.length
      : 0
    tracked.crossMarginRatio = (tracked.accountValue as number) > 0
      ? ((tracked.totalMarginUsed as number) / (tracked.accountValue as number)) * 100
      : 0
  }
}

export function startServer(contexts: Map<string, AccountContext>): void {
  accountContexts = contexts

  app.listen(PORT, HOST, () => {
    console.log(`📊 Dashboard API running on ${HOST}:${PORT}`)
  })
}

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`📊 Dashboard API running on ${HOST}:${PORT} (standalone mode)`)
  })
}
