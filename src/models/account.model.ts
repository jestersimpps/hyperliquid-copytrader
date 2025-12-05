export interface SubAccountConfig {
  id: string
  name: string
  trackedWallet: string
  userWallet: string
  vaultAddress: string
  enabled: boolean
  minOrderValue?: number
  driftThresholdPercent?: number
}

export interface TelegramConfig {
  botToken: string
  chatId: string
  polling: boolean
}

export interface MultiAccountConfig {
  privateKey: string
  isTestnet: boolean
  accounts: SubAccountConfig[]
  telegram: TelegramConfig | null
  dashboardPort: number
  globalMinOrderValue: number
  globalDriftThresholdPercent: number
}

export interface SubAccountState {
  id: string
  name: string
  tradingPaused: boolean
  hrefModeEnabled: boolean
  pausedSymbols: Map<string, number>
  drawdownPausedSymbols: Map<string, number>
  takeProfitMode: boolean
  positionSizeMultiplier: number
}

export interface AccountContext {
  config: SubAccountConfig
  state: SubAccountState
}
