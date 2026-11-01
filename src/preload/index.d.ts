import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AudioAppList,
  AudioSettings,
  OcrLanguageCode,
  OcrLanguageOption,
  ScreenOcrResult,
  ScreenPreview,
  ScreenRegion,
  SpeechLanguageResult,
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
  startAudioDetection: () => Promise<void>
  stopAudioDetection: () => Promise<void>
  isAudioDetectionRunning: () => Promise<boolean>
  sendAudioFrames: (samples: Float32Array) => void
  reportAudioCaptureError: (message: string) => void
  audioRendererReady: () => Promise<void>
  getAudioSettings: () => Promise<AudioSettings>
  setAudioSettings: (changes: Partial<AudioSettings>) => Promise<AudioSettings>
  listAudioApps: () => Promise<AudioAppList>
  onAudioLevel: (callback: (rms: number) => void) => () => void
  onAudioCapture: (callback: (capturing: boolean) => void) => () => void
  onAudioResult: (callback: (result: SpeechLanguageResult) => void) => () => void
  onAudioError: (callback: (message: string) => void) => () => void
  onAudioStarted: (callback: () => void) => () => void
  onAudioStopped: (callback: () => void) => () => void
  onTimerState: (callback: (isRunning: boolean) => void) => () => void
  onTick: (cb: (s: number) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: customAPI
  }
}
