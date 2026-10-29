import { ElectronAPI } from '@electron-toolkit/preload'
import type { ScreenOcrResult, ScreenPreview, ScreenRegion, TimerStatistics } from './types'

export interface customAPI {
  startTimer: () => Promise<void>
  stopTimer: () => Promise<void>
  getSeconds: () => Promise<number>
  getTimerStatistics: () => Promise<TimerStatistics>
  getScreenPreview: () => Promise<ScreenPreview>
  startScreenScan: (region: ScreenRegion) => Promise<void>
  stopScreenScan: () => Promise<void>
  onScreenScanResult: (callback: (result: ScreenOcrResult) => void) => () => void
  onScreenScanError: (callback: (message: string) => void) => () => void
  onTick: (cb: (s: number) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: customAPI
  }
}
