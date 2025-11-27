export interface Config {
  privateKey: string
  userWallet: string
  trackedWallet: string
  isTestnet: boolean
  telegramBotToken: string | null
  telegramChatId: string | null
  telegramPolling: boolean
  dashboardPort: number
  minOrderValue: number
  driftThresholdPercent: number
}
