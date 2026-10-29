import { ElectronAPI } from '@electron-toolkit/preload'
import type { TimerStatistics } from './types'

export interface customAPI {
  startTimer: () => Promise<void>
  stopTimer: () => Promise<void>
  getSeconds: () => Promise<number>
  getTimerStatistics: () => Promise<TimerStatistics>
  onTick: (cb: (s: number) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: customAPI
  }
}
