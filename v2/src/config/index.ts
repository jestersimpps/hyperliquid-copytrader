import dotenv from 'dotenv'
import path from 'path'
import { Config } from './config.model'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

function getEnvVar(key: string, required: boolean = false): string | null {
  const value = process.env[key]
  if (required && !value) {
    console.error(`Missing required environment variable: ${key}`)
    process.exit(1)
  }
  return value || null
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key]
  if (!value) return defaultValue
  const parsed = parseFloat(value)
  return isNaN(parsed) ? defaultValue : parsed
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (!value) return defaultValue
  return value.toLowerCase() === 'true'
}

export const config: Config = {
  privateKey: getEnvVar('PRIVATE_KEY', true)!,
  userWallet: getEnvVar('USER_WALLET', true)!,
  trackedWallet: getEnvVar('TRACKED_WALLET', true)!,
  isTestnet: getEnvBoolean('IS_TESTNET', false),
  telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
  telegramChatId: getEnvVar('TELEGRAM_CHAT_ID'),
  telegramPolling: getEnvBoolean('TELEGRAM_POLLING', true),
  dashboardPort: getEnvNumber('DASHBOARD_PORT', 3000),
  minOrderValue: getEnvNumber('MIN_ORDER_VALUE', 11),
  driftThresholdPercent: getEnvNumber('DRIFT_THRESHOLD_PERCENT', 1)
}
