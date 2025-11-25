import '@/setup'
import { config } from '@/config'
import { HyperliquidService } from '@/services/hyperliquid.service'
import { FillQueueService } from '@/services/fill-queue.service'
import { FillProcessorService } from '@/services/fill-processor.service'
import { WebSocketPoolService } from '@/services/websocket-pool.service'
import { BalanceMonitorService } from '@/services/balance-monitor.service'
import { DriftDetectorService } from '@/services/drift-detector.service'
import { SyncService } from '@/services/sync.service'
import { TelegramService } from '@/services/telegram.service'
import { LoggerService } from '@/services/logger.service'
import { RiskMonitorService } from '@/services/risk-monitor.service'
import { startServer } from '@/api/server'

async function main(): Promise<void> {
  console.log('\n🚀 Copyscalper v2 Starting...\n')

  console.log('📝 Configuration:')
  console.log(`   Tracked: ${config.trackedWallet.slice(0, 6)}...${config.trackedWallet.slice(-4)}`)
  console.log(`   User: ${config.userWallet.slice(0, 6)}...${config.userWallet.slice(-4)}`)
  console.log(`   Network: ${config.isTestnet ? 'TESTNET' : 'MAINNET'}`)
  console.log(`   Min Order: $${config.minOrderValue}`)
  console.log(`   Drift Threshold: ${config.driftThresholdPercent}%`)
  console.log('')

  const hyperliquidService = new HyperliquidService()
  await hyperliquidService.initialize()

  const telegramService = new TelegramService()
  telegramService.setHyperliquidService(hyperliquidService)
  const loggerService = new LoggerService()
  telegramService.setLoggerService(loggerService)
  const riskMonitor = new RiskMonitorService(telegramService)
  const fillQueue = new FillQueueService()
  fillQueue.setRiskMonitor(riskMonitor)
  const fillProcessor = new FillProcessorService(hyperliquidService, loggerService, telegramService)
  const webSocketPool = new WebSocketPoolService(fillQueue)
  const driftDetector = new DriftDetectorService()
  const syncService = new SyncService(
    hyperliquidService,
    webSocketPool,
    telegramService,
    loggerService
  )
  const balanceMonitor = new BalanceMonitorService(
    hyperliquidService,
    driftDetector,
    syncService,
    telegramService,
    loggerService,
    fillProcessor,
    riskMonitor
  )

  fillQueue.setFillProcessor((fill, connectionId) => fillProcessor.processFill(fill, connectionId))

  await webSocketPool.initializeAll(config.trackedWallet)

  startServer()

  balanceMonitor.start()

  await telegramService.sendMonitoringStarted()

  console.log('✓ Copyscalper v2 running\n')

  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...')
    balanceMonitor.stop()
    await webSocketPool.closeAll()
    await telegramService.stop()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down...')
    balanceMonitor.stop()
    await webSocketPool.closeAll()
    await telegramService.stop()
    process.exit(0)
  })
}

main().catch(error => {
  console.error('❌ Fatal error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
