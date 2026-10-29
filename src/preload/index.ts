import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  OcrLanguageCode,
  OcrLanguageOption,
  ScreenOcrResult,
  ScreenPreview,
  ScreenRegion,
  TimerStatistics
} from './types'

// Custom APIs for renderer
const api = {
  startTimer: (): Promise<void> => ipcRenderer.invoke('timer:start'),
  stopTimer: (): Promise<void> => ipcRenderer.invoke('timer:stop'),
  getSeconds: (): Promise<number> => ipcRenderer.invoke('timer:get'),
  isTimerRunning: (): Promise<boolean> => ipcRenderer.invoke('timer:is-running'),
  getTimerStatistics: (): Promise<TimerStatistics> => ipcRenderer.invoke('stats:get'),
  getOcrLanguages: (): Promise<OcrLanguageCode[]> => ipcRenderer.invoke('ocr-languages:get'),
  getSupportedOcrLanguages: (): Promise<OcrLanguageOption[]> =>
    ipcRenderer.invoke('ocr-languages:options'),
  setOcrLanguages: (languages: OcrLanguageCode[]): Promise<OcrLanguageCode[]> =>
    ipcRenderer.invoke('ocr-languages:set', languages),
  getScreenPreview: (): Promise<ScreenPreview> => ipcRenderer.invoke('screen:preview'),
  setScreenRegion: (region: ScreenRegion | null): Promise<void> =>
    ipcRenderer.invoke('screen:region:set', region),
  startScreenScan: (region: ScreenRegion): Promise<void> =>
    ipcRenderer.invoke('screen:scan:start', region),
  stopScreenScan: (): Promise<void> => ipcRenderer.invoke('screen:scan:stop'),
  onScreenScanResult: (callback: (result: ScreenOcrResult) => void) => {
    const listener = (_event: unknown, result: ScreenOcrResult): void => callback(result)
    ipcRenderer.on('screen:scan:result', listener)
    return () => ipcRenderer.removeListener('screen:scan:result', listener)
  },
  onScreenScanError: (callback: (message: string) => void) => {
    const listener = (_event: unknown, message: string): void => callback(message)
    ipcRenderer.on('screen:scan:error', listener)
    return () => ipcRenderer.removeListener('screen:scan:error', listener)
  },
  onScreenScanStopped: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('screen:scan:stopped', listener)
    return () => ipcRenderer.removeListener('screen:scan:stopped', listener)
  },
  onScreenScanStarted: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('screen:scan:started', listener)
    return () => ipcRenderer.removeListener('screen:scan:started', listener)
  },
  onTimerState: (callback: (isRunning: boolean) => void) => {
    const listener = (_event: unknown, isRunning: boolean): void => callback(isRunning)
    ipcRenderer.on('timer:state', listener)
    return () => ipcRenderer.removeListener('timer:state', listener)
  },
  onTick: (cb: (s: number) => void) => {
    const listener = (_e: unknown, s: number): void => cb(s)
    ipcRenderer.on('timer:tick', listener)
    return () => {
      ipcRenderer.removeListener('timer:tick', listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
