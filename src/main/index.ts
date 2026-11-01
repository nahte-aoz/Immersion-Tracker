import { app, shell, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  getAudioSettings,
  getOcrLanguages,
  getSupportedOcrLanguages,
  getTimerStatistics,
  recordTimerSession,
  setAudioSettings,
  setOcrLanguages
} from './db'
import { groupAudioSessions, isPerAppCaptureSupported, listAudioSessions } from './audioApps'
import { getScreenPreview, shutdownScreenOcr, startScreenOcr, stopScreenOcr } from './screenOcr'
import {
  pushAudioFrames,
  reportCaptureError,
  setSpeechApps,
  shutdownSpeechDetection,
  startSpeechDetection,
  stopSpeechDetection
} from './speechLanguage'
import type { AudioAppList, AudioSettings, ScreenRegion } from '../preload/types'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 850,
    minHeight: 620,
    center: true,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Express call
//
// const callServer = async (): Promise<void> => {
//   try {
//     const res: Response = await fetch('http://localhost:3000/secret/a', { method: 'PUT' });
//     const text: string = await res.text();
//     console.log(text); // 'Successfully communicated with Express!'
//   } catch (err: unknown) {
//     console.error('Fetch failed:', err);
//   }
// };
//
// callServer();

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('burger', () => console.log('pong'))

  // Lets the renderer capture what Windows is playing (WASAPI loopback, not the microphone).
  // Only the audio track is used; the renderer stops the screen video track immediately.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}))
    },
    { useSystemPicker: false }
  )

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('before-quit', shutdownScreenOcr)
app.on('before-quit', shutdownSpeechDetection)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

let seconds = 0
let interval: NodeJS.Timeout | undefined
let sessionStartSeconds = 0
type TimerSource = 'manual' | 'screen' | 'audio'
const activeTimerSources = new Set<TimerSource>()
const screenActivityGracePeriodMs = 20_000
// Speech is sampled every several seconds and often pauses (music, scene changes), so audio
// gets a longer grace period than on-screen text.
const audioActivityGracePeriodMs = 30_000
let selectedScreenRegion: ScreenRegion | null = null
let isScreenScanRunning = false
let isAudioSelected = false
let isAudioDetectionRunning = false
let isAudioCaptureRequested = false

const broadcastTimerState = (): void => {
  const isRunning = Boolean(interval)
  BrowserWindow.getAllWindows().forEach((window) =>
    window.webContents.send('timer:state', isRunning)
  )
}

const startTimerInterval = (): void => {
  if (interval) return

  sessionStartSeconds = seconds
  interval = setInterval(() => {
    seconds++
    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.send('timer:tick', seconds)
    )
  }, 1000)
  broadcastTimerState()
}

const stopTimerInterval = (): void => {
  if (!interval || activeTimerSources.size > 0) return

  clearInterval(interval)
  interval = undefined
  recordTimerSession(seconds - sessionStartSeconds)
  broadcastTimerState()
}

// Saves the in-progress session when the app quits while the timer is running. The window may
// already be gone by now, so this skips the renderer broadcast.
const saveActiveTimerSession = (): void => {
  if (!interval) return

  clearInterval(interval)
  interval = undefined
  screenDetection.clear()
  audioDetection.clear()
  activeTimerSources.clear()
  const sessionSeconds = seconds - sessionStartSeconds
  if (sessionSeconds > 0) recordTimerSession(sessionSeconds)
}

app.on('before-quit', saveActiveTimerSession)

const setTimerSource = (source: TimerSource, active: boolean): void => {
  if (active) {
    if (activeTimerSources.has(source)) return
    activeTimerSources.add(source)
    startTimerInterval()
    return
  }

  if (!activeTimerSources.delete(source)) return
  stopTimerInterval()
}

interface DetectionGate {
  update: (active: boolean) => void
  stop: () => void
  clear: () => void
}

// Counts a detection source toward the timer until its grace period passes with no new
// positive detection, so brief gaps don't flicker the clock.
const createDetectionGate = (source: 'screen' | 'audio', gracePeriodMs: number): DetectionGate => {
  let timeout: NodeJS.Timeout | undefined

  const clear = (): void => {
    if (timeout) clearTimeout(timeout)
    timeout = undefined
  }
  const scheduleDeactivation = (): void => {
    timeout = setTimeout(() => {
      timeout = undefined
      setTimerSource(source, false)
    }, gracePeriodMs)
  }

  return {
    update: (active) => {
      if (active) {
        clear()
        setTimerSource(source, true)
        scheduleDeactivation()
      } else if (activeTimerSources.has(source) && !timeout) {
        scheduleDeactivation()
      }
    },
    stop: () => {
      clear()
      setTimerSource(source, false)
    },
    clear
  }
}

const screenDetection = createDetectionGate('screen', screenActivityGracePeriodMs)
const audioDetection = createDetectionGate('audio', audioActivityGracePeriodMs)
const updateScreenDetection = screenDetection.update
const stopScreenDetection = screenDetection.stop

const notifyScreenScanStopped = (): void => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('screen:scan:stopped'))
}

const notifyScreenScanStarted = (): void => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('screen:scan:started'))
}

const startScreenScan = (region: ScreenRegion): void => {
  if (isScreenScanRunning) return

  stopScreenDetection()
  isScreenScanRunning = true
  notifyScreenScanStarted()
  startScreenOcr(
    region,
    getOcrLanguages(),
    (result) => {
      BrowserWindow.getAllWindows().forEach((window) =>
        window.webContents.send('screen:scan:result', result)
      )
    },
    (message) => {
      stopScreenOcr()
      isScreenScanRunning = false
      stopScreenDetection()
      BrowserWindow.getAllWindows().forEach((window) =>
        window.webContents.send('screen:scan:error', message)
      )
      notifyScreenScanStopped()
    },
    updateScreenDetection
  )
}

const stopScreenScan = (): void => {
  stopScreenOcr()
  isScreenScanRunning = false
  stopScreenDetection()
  notifyScreenScanStopped()
}

const sendToWindows = (channel: string, ...args: unknown[]): void =>
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channel, ...args))

const startAudioDetection = (): void => {
  if (isAudioDetectionRunning) return

  audioDetection.stop()
  isAudioDetectionRunning = true
  setSpeechApps(getAudioSettings().apps.map((audioApp) => audioApp.exe))
  sendToWindows('audio:started')
  startSpeechDetection(
    getOcrLanguages(),
    (result) => sendToWindows('audio:result', result),
    (message) => {
      stopSpeechDetection()
      isAudioDetectionRunning = false
      isAudioCaptureRequested = false
      audioDetection.stop()
      sendToWindows('audio:error', message)
      sendToWindows('audio:stopped')
    },
    audioDetection.update,
    (capturing) => {
      isAudioCaptureRequested = capturing
      sendToWindows('audio:capture', capturing)
    },
    (rms) => sendToWindows('audio:level', rms)
  )
}

const stopAudioDetection = (): void => {
  stopSpeechDetection()
  isAudioDetectionRunning = false
  isAudioCaptureRequested = false
  audioDetection.stop()
  sendToWindows('audio:stopped')
}

const startTimer = (): void => {
  setTimerSource('manual', true)
  if (selectedScreenRegion) startScreenScan(selectedScreenRegion)
  if (isAudioSelected || getAudioSettings().alwaysListen) startAudioDetection()
}

const stopTimer = (): void => {
  stopScreenScan()
  // "Always listen" keeps listening after the session is saved, so the next detection resumes it.
  if (getAudioSettings().alwaysListen) audioDetection.clear()
  else stopAudioDetection()
  activeTimerSources.clear()
  stopTimerInterval()
}

ipcMain.handle('timer:get', () => {
  return seconds
})
ipcMain.handle('timer:is-running', () => Boolean(interval))

ipcMain.handle('stats:get', () => getTimerStatistics())
ipcMain.handle('ocr-languages:get', () => getOcrLanguages())
ipcMain.handle('ocr-languages:set', (_event, languages: string[]) => setOcrLanguages(languages))
ipcMain.handle('ocr-languages:options', () => getSupportedOcrLanguages())
ipcMain.handle('screen:preview', () => getScreenPreview())
ipcMain.handle('screen:region:set', (_event, region: ScreenRegion | null) => {
  selectedScreenRegion = region
})
ipcMain.handle('screen:scan:start', (_event, region: ScreenRegion) => {
  selectedScreenRegion = region
  startScreenScan(region)
})
ipcMain.handle('screen:scan:stop', stopScreenScan)
ipcMain.handle('audio:start', () => {
  isAudioSelected = true
  startAudioDetection()
})
ipcMain.handle('audio:stop', () => {
  isAudioSelected = false
  stopAudioDetection()
})
ipcMain.handle('audio:is-running', () => isAudioDetectionRunning)
// The renderer registers its audio listeners on load; this starts "always listen" once it can
// capture, and re-requests capture if a listening session predates a renderer reload.
ipcMain.handle('audio:renderer-ready', () => {
  if (getAudioSettings().alwaysListen && !isAudioDetectionRunning) {
    isAudioSelected = true
    startAudioDetection()
  } else if (isAudioDetectionRunning && isAudioCaptureRequested) {
    sendToWindows('audio:capture', true)
  }
})
ipcMain.handle('audio:settings:get', (): AudioSettings => getAudioSettings())
ipcMain.handle('audio:settings:set', (_event, changes: Partial<AudioSettings>): AudioSettings => {
  const previous = getAudioSettings()
  const next = setAudioSettings(changes)
  if (JSON.stringify(next.apps) !== JSON.stringify(previous.apps)) {
    setSpeechApps(next.apps.map((audioApp) => audioApp.exe))
  }
  if (next.alwaysListen !== previous.alwaysListen) {
    isAudioSelected = next.alwaysListen
    if (next.alwaysListen) startAudioDetection()
    else stopAudioDetection()
  }
  return next
})
ipcMain.handle('audio:apps:list', async (): Promise<AudioAppList> => {
  const supported = isPerAppCaptureSupported()
  return { supported, apps: supported ? groupAudioSessions(await listAudioSessions()) : [] }
})
ipcMain.on('audio:frames', (_event, samples: unknown) => {
  if (samples instanceof Float32Array) pushAudioFrames(samples)
})
ipcMain.on('audio:capture-error', (_event, message: string) => reportCaptureError(String(message)))

ipcMain.handle('timer:start', startTimer)

ipcMain.handle('timer:stop', stopTimer)
