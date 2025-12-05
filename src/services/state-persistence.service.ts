import * as fs from 'fs'
import * as path from 'path'
import { SubAccountState } from '@/models'

interface PersistedState {
  tradingPaused: boolean
  hrefThreshold: number
  pausedSymbols: Record<string, number>
  drawdownPausedSymbols: Record<string, number>
  takeProfitMode: boolean
  positionSizeMultiplier: number
}

type PersistedStates = Record<string, PersistedState>

const STATE_FILE = path.join(process.cwd(), 'data', 'state.json')

function ensureDataDir(): void {
  const dataDir = path.dirname(STATE_FILE)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
}

export function saveState(accountId: string, state: SubAccountState): void {
  try {
    ensureDataDir()

    let allStates: PersistedStates = {}
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf-8')
      allStates = JSON.parse(content)
    }

    allStates[accountId] = {
      tradingPaused: state.tradingPaused,
      hrefThreshold: state.hrefThreshold,
      pausedSymbols: Object.fromEntries(state.pausedSymbols),
      drawdownPausedSymbols: Object.fromEntries(state.drawdownPausedSymbols),
      takeProfitMode: state.takeProfitMode,
      positionSizeMultiplier: state.positionSizeMultiplier
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(allStates, null, 2))
  } catch (error) {
    console.error(`Failed to save state for ${accountId}:`, error instanceof Error ? error.message : error)
  }
}

export function loadState(accountId: string): Partial<SubAccountState> | null {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return null
    }

    const content = fs.readFileSync(STATE_FILE, 'utf-8')
    const allStates: PersistedStates = JSON.parse(content)
    const persisted = allStates[accountId]

    if (!persisted) {
      return null
    }

    return {
      tradingPaused: persisted.tradingPaused,
      hrefThreshold: persisted.hrefThreshold,
      pausedSymbols: new Map(Object.entries(persisted.pausedSymbols || {})),
      drawdownPausedSymbols: new Map(Object.entries(persisted.drawdownPausedSymbols || {})),
      takeProfitMode: persisted.takeProfitMode,
      positionSizeMultiplier: persisted.positionSizeMultiplier
    }
  } catch (error) {
    console.error(`Failed to load state for ${accountId}:`, error instanceof Error ? error.message : error)
    return null
  }
}
