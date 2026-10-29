import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  getOcrLanguages,
  getSupportedOcrLanguages,
  getTimerStatistics,
  recordTimerSession,
  setOcrLanguages
} from './db'
import { getScreenPreview, startScreenOcr, stopScreenOcr } from './screenOcr'
import type { ScreenRegion } from '../preload/types'

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
const activeTimerSources = new Set<'manual' | 'screen'>()
let screenDetectionTimeout: NodeJS.Timeout | undefined
const screenActivityGracePeriodMs = 20_000
let selectedScreenRegion: ScreenRegion | null = null
let isScreenScanRunning = false

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

const setTimerSource = (source: 'manual' | 'screen', active: boolean): void => {
  if (active) {
    if (activeTimerSources.has(source)) return
    activeTimerSources.add(source)
    startTimerInterval()
    return
  }

  if (!activeTimerSources.delete(source)) return
  stopTimerInterval()
}

const scheduleScreenDeactivation = (): void => {
  screenDetectionTimeout = setTimeout(() => {
    screenDetectionTimeout = undefined
    setTimerSource('screen', false)
  }, screenActivityGracePeriodMs)
}

const updateScreenDetection = (active: boolean): void => {
  if (active) {
    if (screenDetectionTimeout) clearTimeout(screenDetectionTimeout)
    setTimerSource('screen', true)
    scheduleScreenDeactivation()
  } else if (activeTimerSources.has('screen') && !screenDetectionTimeout) {
    scheduleScreenDeactivation()
  }
}

const stopScreenDetection = (): void => {
  if (screenDetectionTimeout) clearTimeout(screenDetectionTimeout)
  screenDetectionTimeout = undefined
  setTimerSource('screen', false)
}

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

const startTimer = (): void => {
  setTimerSource('manual', true)
  if (selectedScreenRegion) startScreenScan(selectedScreenRegion)
}

const stopTimer = (): void => {
  stopScreenScan()
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

ipcMain.handle('timer:start', startTimer)

ipcMain.handle('timer:stop', stopTimer)
