import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getTimerStatistics, recordTimerSession } from './db'
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

let seconds = 0;
let interval: NodeJS.Timeout | undefined;
let sessionStartSeconds = 0

const startTimer = (): void => {
  if (interval) return

  sessionStartSeconds = seconds
  console.log("Timer started!")
  // Use setInterval to update the timer every 1000 milliseconds (1 second)
    interval = setInterval(() => {
      // Update the timer by incrementing the previous value by 1
      seconds++;
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('timer:tick', seconds))
    }, 1000)
};

// Function to pause the timer
const stopTimer = (): void => {
  // Clear the interval to stop the timer from updating
  if (interval) {
    clearInterval(interval);
    interval = undefined
    recordTimerSession(seconds - sessionStartSeconds)
  }
};

ipcMain.handle('timer:get', () => {
  return seconds;
})

ipcMain.handle('stats:get', () => getTimerStatistics())
ipcMain.handle('screen:preview', () => getScreenPreview())
ipcMain.handle('screen:scan:start', (event, region: ScreenRegion) => {
  const sender = event.sender
  startScreenOcr(
    region,
    (result) => sender.send('screen:scan:result', result),
    (message) => sender.send('screen:scan:error', message)
  )
})
ipcMain.handle('screen:scan:stop', () => stopScreenOcr())

ipcMain.handle('timer:start', startTimer)

ipcMain.handle('timer:stop', stopTimer)