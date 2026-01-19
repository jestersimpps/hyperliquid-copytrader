export interface SubAccountConfig {
  id: string
  name: string
  privateKey: string
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
  isTestnet: boolean
  accounts: SubAccountConfig[]
  telegram: TelegramConfig | null
  dashboardPort: number
  globalMinOrderValue: number
  globalDriftThresholdPercent: number
}

export type OrderType = 'market' | 'limit'

export interface SubAccountState {
  id: string
  name: string
  tradingPaused: boolean
  hrefThreshold: number
  pausedSymbols: Map<string, number>
  drawdownPausedSymbols: Map<string, number>
  takeProfitThreshold: number
  positionSizeMultiplier: number
  orderType: OrderType
}

export interface AccountContext {
  config: SubAccountConfig
  state: SubAccountState
}
