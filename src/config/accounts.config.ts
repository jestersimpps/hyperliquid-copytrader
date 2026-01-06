import fs from 'fs'
import path from 'path'
import { MultiAccountConfig, SubAccountConfig } from '../models'

const CONFIG_PATH = path.resolve(__dirname, '../../accounts.json')

export function loadMultiAccountConfig(): MultiAccountConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('accounts.json not found. Please create it from accounts.example.json')
    process.exit(1)
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
  const config = JSON.parse(raw) as MultiAccountConfig

  if (!config.accounts || config.accounts.length === 0) {
    console.error('At least one account is required in accounts.json')
    process.exit(1)
  }

  for (const account of config.accounts) {
    if (!account.id || !account.trackedWallet || !account.userWallet) {
      console.error(`Account ${account.id || 'unknown'} is missing required fields (id, trackedWallet, userWallet)`)
      process.exit(1)
    }
    if (!account.privateKey) {
      console.error(`Account ${account.id} is missing required field: privateKey`)
      process.exit(1)
    }
  }

  return {
    isTestnet: config.isTestnet ?? false,
    accounts: config.accounts,
    telegram: config.telegram ?? null,
    dashboardPort: config.dashboardPort ?? 3000,
    globalMinOrderValue: config.globalMinOrderValue ?? 11,
    globalDriftThresholdPercent: config.globalDriftThresholdPercent ?? 1
  }
}

export function getAccountMinOrderValue(account: SubAccountConfig, globalConfig: MultiAccountConfig): number {
  return account.minOrderValue ?? globalConfig.globalMinOrderValue
}

export function getAccountDriftThreshold(account: SubAccountConfig, globalConfig: MultiAccountConfig): number {
  return account.driftThresholdPercent ?? globalConfig.globalDriftThresholdPercent
}
