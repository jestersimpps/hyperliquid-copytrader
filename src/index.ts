import '@/setup'
import { loadMultiAccountConfig, getAccountMinOrderValue, getAccountDriftThreshold } from '@/config/accounts.config'
import { SubAccountState } from '@/models'
import { HyperliquidService } from '@/services/hyperliquid.service'
import { FillProcessorService } from '@/services/fill-processor.service'
import { BalanceMonitorService } from '@/services/balance-monitor.service'
import { DriftDetectorService } from '@/services/drift-detector.service'
import { SyncService } from '@/services/sync.service'
import { TelegramService } from '@/services/telegram.service'
import { LoggerService } from '@/services/logger.service'
import { RiskMonitorService } from '@/services/risk-monitor.service'
import { TrackedWalletManager } from '@/services/tracked-wallet-manager.service'
import { startServer } from '@/api/server'
import { loadState } from '@/services/state-persistence.service'

interface AccountContext {
  id: string
  state: SubAccountState
  loggerService: LoggerService
  fillProcessor: FillProcessorService
  balanceMonitor: BalanceMonitorService
  riskMonitor: RiskMonitorService
  syncService: SyncService
}

async function main(): Promise<void> {
  console.log('\n🚀 Hyperscalper Multi-Account Starting...\n')

  const globalConfig = loadMultiAccountConfig()
  const enabledAccounts = globalConfig.accounts.filter(a => a.enabled)

  console.log('📝 Configuration:')
  console.log(`   Network: ${globalConfig.isTestnet ? 'TESTNET' : 'MAINNET'}`)
  console.log(`   Accounts: ${enabledAccounts.length}`)
  console.log(`   Global Min Order: $${globalConfig.globalMinOrderValue}`)
  console.log(`   Global Drift Threshold: ${globalConfig.globalDriftThresholdPercent}%`)
  console.log('')

  for (const account of enabledAccounts) {
    console.log(`   [${account.id}] ${account.name}`)
    console.log(`      Tracked: ${account.trackedWallet.slice(0, 6)}...${account.trackedWallet.slice(-4)}`)
    console.log(`      User: ${account.userWallet.slice(0, 6)}...${account.userWallet.slice(-4)}`)
  }
  console.log('')

  const hyperliquidService = new HyperliquidService(globalConfig)
  await hyperliquidService.initialize()

  for (const account of enabledAccounts) {
    hyperliquidService.initializeWalletClient(account.id, account.privateKey)
    console.log(`   ✓ Wallet client initialized for account ${account.id}`)
  }
  console.log('')

  const telegramService = new TelegramService(globalConfig.telegram)
  telegramService.setHyperliquidService(hyperliquidService)

  const trackedWalletManager = new TrackedWalletManager()
  const accountContexts: Map<string, AccountContext> = new Map()

  for (const accountConfig of enabledAccounts) {
    const accountId = accountConfig.id
    const minOrderValue = getAccountMinOrderValue(accountConfig, globalConfig)
    const driftThreshold = getAccountDriftThreshold(accountConfig, globalConfig)

    const savedState = loadState(accountId)
    const state: SubAccountState = {
      id: accountId,
      name: accountConfig.name,
      tradingPaused: savedState?.tradingPaused ?? false,
      hrefThreshold: savedState?.hrefThreshold ?? 0,
      pausedSymbols: savedState?.pausedSymbols ?? new Map(),
      drawdownPausedSymbols: savedState?.drawdownPausedSymbols ?? new Map(),
      takeProfitThreshold: savedState?.takeProfitThreshold ?? 0,
      positionSizeMultiplier: savedState?.positionSizeMultiplier ?? 1,
      orderType: savedState?.orderType ?? 'market',
      positionPeaks: savedState?.positionPeaks ?? new Map()
    }

    if (savedState) {
      console.log(`   [${accountId}] Restored state: HREF=${state.hrefThreshold}%, TP=${state.takeProfitThreshold}%, Size=${state.positionSizeMultiplier}x`)
    }

    const loggerService = new LoggerService(accountId)
    const riskMonitor = new RiskMonitorService(accountId, telegramService)
    const driftDetector = new DriftDetectorService(driftThreshold)

    const fillProcessor = new FillProcessorService(
      accountId,
      accountConfig,
      state,
      hyperliquidService,
      loggerService,
      telegramService,
      minOrderValue
    )

    const syncService = new SyncService(
      accountId,
      accountConfig,
      state,
      hyperliquidService,
      telegramService,
      loggerService,
      minOrderValue
    )

    const balanceMonitor = new BalanceMonitorService(
      accountId,
      accountConfig,
      hyperliquidService,
      driftDetector,
      syncService,
      telegramService,
      loggerService,
      fillProcessor,
      riskMonitor
    )

    telegramService.registerAccount(accountId, accountConfig, state, loggerService)

    await trackedWalletManager.subscribeAccount(
      accountConfig.trackedWallet,
      accountId,
      (fill, connectionId) => fillProcessor.processFill(fill, connectionId),
      riskMonitor
    )

    accountContexts.set(accountId, {
      id: accountId,
      state,
      loggerService,
      fillProcessor,
      balanceMonitor,
      riskMonitor,
      syncService
    })

    console.log(`✓ Account ${accountId} initialized`)
  }

  startServer(accountContexts)

  for (const context of accountContexts.values()) {
    context.balanceMonitor.start()
  }

  await telegramService.sendMonitoringStarted(enabledAccounts.length)

  console.log(`\n✓ Hyperscalper running with ${enabledAccounts.length} account(s)\n`)

  const shutdown = async (): Promise<void> => {
    console.log('\n🛑 Shutting down...')

    for (const context of accountContexts.values()) {
      context.balanceMonitor.stop()
    }

    await trackedWalletManager.closeAll()
    await telegramService.stop()

    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(error => {
  console.error('❌ Fatal error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
