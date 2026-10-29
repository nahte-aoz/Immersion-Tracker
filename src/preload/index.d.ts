import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  OcrLanguageCode,
  OcrLanguageOption,
  ScreenOcrResult,
  ScreenPreview,
  ScreenRegion,
  TimerStatistics
} from './types'

export interface customAPI {
  startTimer: () => Promise<void>
  stopTimer: () => Promise<void>
  getSeconds: () => Promise<number>
  isTimerRunning: () => Promise<boolean>
  getTimerStatistics: () => Promise<TimerStatistics>
  getOcrLanguages: () => Promise<OcrLanguageCode[]>
  getSupportedOcrLanguages: () => Promise<OcrLanguageOption[]>
  setOcrLanguages: (languages: OcrLanguageCode[]) => Promise<OcrLanguageCode[]>
  getScreenPreview: () => Promise<ScreenPreview>
  setScreenRegion: (region: ScreenRegion | null) => Promise<void>
  startScreenScan: (region: ScreenRegion) => Promise<void>
  stopScreenScan: () => Promise<void>
  onScreenScanResult: (callback: (result: ScreenOcrResult) => void) => () => void
  onScreenScanError: (callback: (message: string) => void) => () => void
  onScreenScanStopped: (callback: () => void) => () => void
  onScreenScanStarted: (callback: () => void) => () => void
  onTimerState: (callback: (isRunning: boolean) => void) => () => void
  onTick: (cb: (s: number) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: customAPI
  }
}
