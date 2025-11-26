import { Position } from './position.model'

export type DriftType = 'missing' | 'extra' | 'size_mismatch' | 'side_mismatch'

export interface PositionDrift {
  coin: string
  trackedPosition: Position | null
  userPosition: Position | null
  driftType: DriftType
  isFavorable: boolean
  priceImprovement: number
  scaledTargetSize: number
  currentPrice: number
  sizeDiffPercent: number
}

export interface DriftReport {
  hasDrift: boolean
  drifts: PositionDrift[]
  timestamp: number
}
