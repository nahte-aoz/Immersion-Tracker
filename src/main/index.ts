import {
  app,
  shell,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  session,
  Tray
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  deleteTimerSession,
  getActiveProfile,
  getAudioSettings,
  getGeneralSettings,
  getOcrLanguages,
  getScreenOcrSettings,
  getSupportedOcrLanguages,
  getTimerStatistics,
  recordTimerSession,
  setActiveProfile,
  setAudioSettings,
  setGeneralSettings,
  setOcrLanguages,
  setScreenAreas,
  setScreenDisplay
} from './db'
import { toAppLanguage } from './languages'
import { groupAudioSessions, isPerAppCaptureSupported, listAudioSessions } from './audioApps'
import {
  getScreenDisplays,
  getScreenPreview,
  shutdownScreenOcr,
  startScreenOcr,
  stopScreenOcr
} from './screenOcr'
import {
  pushAudioFrames,
  reportCaptureError,
  setSpeechApps,
  shutdownSpeechDetection,
  startSpeechDetection,
  stopSpeechDetection
} from './speechLanguage'
import { ALL_PROFILE, UNKNOWN_LANGUAGE } from '../preload/types'
import type { AudioAppList, AudioSettings, GeneralSettings, ScreenArea } from '../preload/types'

let isQuitting = false
let tray: Tray | undefined

const showMainWindow = (): void => {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) {
    createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

const ensureTray = (): void => {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Immersion Tracker')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: showMainWindow },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('click', showMainWindow)
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 850,
    minHeight: 620,
    icon: join(__dirname, '../../resources/icon.png'),
    center: true,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Keep audio capture and timers running at full speed while hidden in the tray.
      backgroundThrottling: false
    }
  })

  // Keep this window out of screen captures, so Screen OCR never reads the app's own text (it
  // sees what is behind the window instead), even when other windows only partly cover it.
  mainWindow.setContentProtection(true)

  // "Minimize to tray": closing or minimizing the window hides it to the system tray, so the timer, OCR and
  // audio keep running. Quit from the tray menu.
  mainWindow.on('close', (event) => {
    if (!isQuitting && getGeneralSettings().minimizeToTray) {
      event.preventDefault()
      mainWindow.hide()
      ensureTray()
    }
  })

  // The minimize button goes to the tray too.
  mainWindow.on('minimize', () => {
    if (getGeneralSettings().minimizeToTray) {
      mainWindow.hide()
      ensureTray()
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

  // "Run OCR on start": begin scanning right away when areas were saved.
  if (getGeneralSettings().runOcrOnStart && getScreenScanTarget().areas.length > 0) {
    startScreenScan()
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('before-quit', () => {
  isQuitting = true
  tray?.destroy()
  tray = undefined
})
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

// The language profile in use ('all' or one language), and the time of the current session
// split per language. In the "all" profile the language is whichever was detected last.
let activeProfile = getActiveProfile()
let currentLanguage: string | null = null
let languageSeconds: Record<string, number> = {}

const getProfileLanguages = (): string[] =>
  activeProfile === ALL_PROFILE ? getOcrLanguages() : [activeProfile]

const noteDetectedLanguage = (code: string | undefined): void => {
  const language = code ? toAppLanguage(code, getProfileLanguages()) : null
  if (language) currentLanguage = language
}

const finishSessionLanguages = (): Record<string, number> => {
  const finished = languageSeconds
  languageSeconds = {}
  currentLanguage = null
  return finished
}

const startTimerInterval = (): void => {
  if (interval) return

  sessionStartSeconds = seconds
  languageSeconds = {}
  interval = setInterval(() => {
    seconds++
    const language =
      activeProfile === ALL_PROFILE ? (currentLanguage ?? UNKNOWN_LANGUAGE) : activeProfile
    languageSeconds[language] = (languageSeconds[language] ?? 0) + 1
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
  recordTimerSession(seconds - sessionStartSeconds, finishSessionLanguages())
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
  if (sessionSeconds > 0) recordTimerSession(sessionSeconds, finishSessionLanguages())
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
const updateScreenDetection = (active: boolean, language?: string): void => {
  if (active) noteDetectedLanguage(language)
  screenDetection.update(active)
}
const stopScreenDetection = screenDetection.stop

const notifyScreenScanStopped = (): void => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('screen:scan:stopped'))
}

const notifyScreenScanStarted = (): void => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('screen:scan:started'))
}

// The saved monitor and the areas selected on it (empty when none were chosen yet).
const getScreenScanTarget = (): { displayId: number | null; areas: ScreenArea[] } => {
  const settings = getScreenOcrSettings()
  const displays = getScreenDisplays()
  const display = displays.find((item) => item.id === settings.displayId)
  const displayId = display?.id ?? displays.find((item) => item.isPrimary)?.id ?? null
  return { displayId, areas: settings.areas[String(displayId)] ?? [] }
}

const startScreenScan = (): void => {
  if (isScreenScanRunning) return

  const target = getScreenScanTarget()
  if (target.areas.length === 0) {
    sendToWindows('screen:scan:error', 'Select at least one screen area first.')
    notifyScreenScanStopped()
    return
  }

  stopScreenDetection()
  isScreenScanRunning = true
  notifyScreenScanStarted()
  startScreenOcr(
    target,
    getOcrLanguages(),
    getProfileLanguages(),
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
    getProfileLanguages(),
    (result) => sendToWindows('audio:result', result),
    (message) => {
      stopSpeechDetection()
      isAudioDetectionRunning = false
      isAudioCaptureRequested = false
      audioDetection.stop()
      sendToWindows('audio:error', message)
      sendToWindows('audio:stopped')
    },
    (active, language) => {
      if (active) noteDetectedLanguage(language)
      audioDetection.update(active)
    },
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
  if (getScreenScanTarget().areas.length > 0) startScreenScan()
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

ipcMain.handle('sessions:delete', (_event, id: number) => deleteTimerSession(Number(id)))
ipcMain.handle('stats:get', (_event, language?: string) => getTimerStatistics(language))
ipcMain.handle('ocr-languages:get', () => getOcrLanguages())
// Applies a profile change: detection restarts so it only looks for the new profile's languages.
const applyProfile = (): void => {
  currentLanguage = null
  if (isScreenScanRunning) {
    stopScreenScan()
    startScreenScan()
  }
  if (isAudioDetectionRunning) {
    stopAudioDetection()
    startAudioDetection()
  }
  sendToWindows('profile:changed', activeProfile)
}

ipcMain.handle('ocr-languages:set', (_event, languages: string[]) => {
  const saved = setOcrLanguages(languages)
  // A profile for a language that was just removed from Settings falls back to "all".
  const profile = getActiveProfile()
  if (profile !== activeProfile) {
    activeProfile = profile
    applyProfile()
  } else {
    sendToWindows('profile:changed', activeProfile)
  }
  return saved
})
ipcMain.handle('profile:get', () => activeProfile)
ipcMain.handle('profile:set', (_event, profile: string) => {
  const next = setActiveProfile(profile)
  if (next !== activeProfile) {
    activeProfile = next
    applyProfile()
  }
  return activeProfile
})
ipcMain.handle('ocr-languages:options', () => getSupportedOcrLanguages())
ipcMain.handle('screen:displays', () => getScreenDisplays())
ipcMain.handle('screen:settings:get', () => getScreenOcrSettings())
ipcMain.handle('screen:display:set', (_event, displayId: number | null) =>
  setScreenDisplay(displayId)
)
ipcMain.handle('screen:areas:set', (_event, displayId: number, areas: ScreenArea[]) =>
  setScreenAreas(displayId, areas)
)
ipcMain.handle('screen:preview', (_event, displayId: number | null) => getScreenPreview(displayId))
ipcMain.handle('screen:scan:start', () => startScreenScan())
ipcMain.handle('screen:scan:stop', stopScreenScan)
ipcMain.handle('screen:scan:is-running', () => isScreenScanRunning)
ipcMain.handle('general:get', (): GeneralSettings => getGeneralSettings())
ipcMain.handle('general:set', (_event, changes: Partial<GeneralSettings>): GeneralSettings =>
  setGeneralSettings(changes)
)
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
