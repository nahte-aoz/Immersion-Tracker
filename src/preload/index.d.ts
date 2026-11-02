import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AudioAppList,
  GeneralSettings,
  AudioSettings,
  OcrLanguageCode,
  OcrLanguageOption,
  ScreenOcrResult,
  ScreenArea,
  ScreenDisplayInfo,
  ScreenOcrSettings,
  ScreenPreview,
  SpeechLanguageResult,
  TimerStatistics
} from './types'

export interface customAPI {
  startTimer: () => Promise<void>
  stopTimer: () => Promise<void>
  getSeconds: () => Promise<number>
  isTimerRunning: () => Promise<boolean>
  getTimerStatistics: (language?: string) => Promise<TimerStatistics>
  deleteSession: (id: number) => Promise<void>
  getActiveProfile: () => Promise<string>
  setActiveProfile: (profile: string) => Promise<string>
  onProfileChanged: (callback: (profile: string) => void) => () => void
  getOcrLanguages: () => Promise<OcrLanguageCode[]>
  getSupportedOcrLanguages: () => Promise<OcrLanguageOption[]>
  setOcrLanguages: (languages: OcrLanguageCode[]) => Promise<OcrLanguageCode[]>
  getScreenDisplays: () => Promise<ScreenDisplayInfo[]>
  getScreenOcrSettings: () => Promise<ScreenOcrSettings>
  setScreenDisplay: (displayId: number | null) => Promise<ScreenOcrSettings>
  setScreenAreas: (displayId: number, areas: ScreenArea[]) => Promise<ScreenOcrSettings>
  getScreenPreview: (displayId: number | null) => Promise<ScreenPreview>
  startScreenScan: () => Promise<void>
  isScreenScanRunning: () => Promise<boolean>
  getGeneralSettings: () => Promise<GeneralSettings>
  setGeneralSettings: (changes: Partial<GeneralSettings>) => Promise<GeneralSettings>
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
