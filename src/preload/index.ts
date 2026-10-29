import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { TimerStatistics } from './types'

// Custom APIs for renderer
const api = {
  startTimer: (): Promise<void> => ipcRenderer.invoke('timer:start'),
  stopTimer: (): Promise<void> => ipcRenderer.invoke('timer:stop'),
  getSeconds: (): Promise<number> => ipcRenderer.invoke("timer:get"),
  getTimerStatistics: (): Promise<TimerStatistics> => ipcRenderer.invoke('stats:get'),
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
