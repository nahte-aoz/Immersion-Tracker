import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, desktopCapturer, screen, type NativeImage } from 'electron'
import type { ScreenOcrResult, ScreenPreview, ScreenRegion } from '../preload/types'

interface FrameSnapshot {
  regionKey: string
  pixels: Buffer
}

interface CapturedFrame {
  regionKey: string
  image: Buffer
}

interface RecognizedBlock {
  text: string
  letterCount: number
}

interface FrameRecognition {
  result: ScreenOcrResult | null
  targetTextKey: string
}

let owocrSocket: WebSocket | undefined
let owocrProcess: ChildProcess | undefined
let owocrProcessLanguage = ''
let pendingAcks = 0
let inFlightFrame: CapturedFrame | undefined
let inFlightTimer: NodeJS.Timeout | undefined
let languageDetectorPromise: Promise<typeof import('franc-min')> | undefined
let lastMeaningfulFrame: FrameSnapshot | undefined
let lastOcrImageKey = ''
let lastLoggedRegionKey = ''
let lastLoggedWords = new Set<string>()
let pendingFrame: CapturedFrame | undefined
let activeScanId = 0
let activeResultCallback: ((result: ScreenOcrResult) => void) | undefined
let activeErrorCallback: ((message: string) => void) | undefined
let activeActivityCallback: ((active: boolean) => void) | undefined
let scanTimer: NodeJS.Timeout | undefined
let isScanActive = false

const scanIntervalMs = 500
// Not OwOCR's default (7331), so a user's own OwOCR instance is never mistaken for ours.
const owocrPort = Number(process.env.OWOCR_PORT) || 17331
const owocrStartupTimeoutMs = 30000
const owocrResultTimeoutMs = 5000

// OwOCR's two-letter codes, keyed by the Tesseract-style codes the app stores.
const owocrLanguageCodes: Record<string, string> = {
  jpn: 'ja',
  chi_sim: 'zh',
  chi_tra: 'zh',
  kor: 'ko',
  rus: 'ru',
  ara: 'ar'
}

// OwOCR takes a single language and uses it as a script filter on the output: with 'en' it
// drops Japanese/Korean/etc. text entirely, while a non-Latin setting still lets Latin text
// through. So prefer the first selected non-Latin language and only fall back to 'en'.
const pickOwocrLanguage = (languages: string[]): string =>
  languages.map((language) => owocrLanguageCodes[language]).find(Boolean) ?? 'en'

const findOwocrExecutable = (): string | undefined => {
  const executableName = process.platform === 'win32' ? 'owocr.exe' : 'owocr'
  const candidates = [
    process.env.OWOCR_PATH,
    join(app.getPath('userData'), 'owocr', executableName),
    join(process.resourcesPath, 'owocr', executableName),
    join(app.getAppPath(), 'resources', 'owocr', executableName)
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate))
}

const openOwocrSocket = (): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${owocrPort}`)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', () => reject(new Error('OwOCR is not reachable.')), {
      once: true
    })
  })

// Only on-device engines: OneOCR (Windows 11) with Windows' built-in OCR as the fallback.
// Cloud engines are left out so captured frames never leave the machine.
const buildOwocrConfig = (language: string): string =>
  [
    '[general]',
    'read_from = websocket',
    'write_to = websocket',
    `websocket_port = ${owocrPort}`,
    'engines = oneocr,winrtocr',
    'engine = oneocr',
    `language = ${language}`,
    'output_format = text',
    'line_separator = \\n',
    'show_log_at_startup = False',
    'notifications = False',
    'pause_at_startup = False',
    ''
  ].join('\n')

const launchOwocr = (executable: string, language: string): void => {
  // OwOCR reads ~/.config/owocr_config.ini, so give it a private home to keep this app's
  // settings separate from any OwOCR install the user already has.
  const home = join(app.getPath('userData'), 'owocr-home')
  mkdirSync(join(home, '.config'), { recursive: true })
  writeFileSync(join(home, '.config', 'owocr_config.ini'), buildOwocrConfig(language))
  owocrProcessLanguage = language

  owocrProcess = spawn(executable, [], {
    cwd: dirname(executable),
    env: { ...process.env, USERPROFILE: home, HOME: home },
    stdio: 'ignore',
    windowsHide: true
  })
  const launched = owocrProcess
  launched.once('exit', () => {
    if (owocrProcess === launched) owocrProcess = undefined
  })
}

// The packaged OwOCR runs as a launcher plus a worker; kill the whole tree on Windows.
const killOwocrProcess = (): void => {
  const pid = owocrProcess?.pid
  owocrProcess = undefined
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    process.kill(pid)
  }
}

// Connects to a running OwOCR (started with read_from/write_to = websocket), launching the
// bundled build when none is listening yet.
const connectOwocr = async (languages: string[]): Promise<WebSocket> => {
  const language = pickOwocrLanguage(languages)
  // The language is only read at startup, so restart our own instance when it changes.
  if (owocrProcess && owocrProcessLanguage !== language) killOwocrProcess()

  try {
    return await openOwocrSocket()
  } catch {
    const executable = findOwocrExecutable()
    if (!executable) {
      throw new Error(
        `OwOCR was not found. Start it with "-r websocket -w websocket" (port ${owocrPort}) or ` +
          'run "npm run fetch:owocr" to bundle it.'
      )
    }
    if (!owocrProcess) launchOwocr(executable, language)
  }

  const deadline = Date.now() + owocrStartupTimeoutMs
  while (Date.now() < deadline) {
    if (!owocrProcess) throw new Error('OwOCR exited before it started listening.')
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      return await openOwocrSocket()
    } catch {
      // Still starting up.
    }
  }
  throw new Error('OwOCR did not start listening in time.')
}

const closeOwocrSocket = (): void => {
  const socket = owocrSocket
  owocrSocket = undefined
  pendingAcks = 0
  inFlightFrame = undefined
  if (inFlightTimer) clearTimeout(inFlightTimer)
  inFlightTimer = undefined
  socket?.close()
}

export const shutdownScreenOcr = (): void => {
  stopScreenOcr()
  killOwocrProcess()
}

const hasMeaningfulChange = (regionKey: string, pixels: Buffer): boolean => {
  const previousFrame = lastMeaningfulFrame

  if (
    !previousFrame ||
    previousFrame.regionKey !== regionKey ||
    previousFrame.pixels.length !== pixels.length
  ) {
    lastMeaningfulFrame = { regionKey, pixels }
    return true
  }

  const pixelCount = pixels.length / 4
  const sampleStride = Math.max(4, Math.floor(pixelCount / 30000) * 4)
  let samples = 0
  let changedPixels = 0

  for (let offset = 0; offset + 2 < pixels.length; offset += sampleStride) {
    const difference =
      Math.abs(pixels[offset] - previousFrame.pixels[offset]) +
      Math.abs(pixels[offset + 1] - previousFrame.pixels[offset + 1]) +
      Math.abs(pixels[offset + 2] - previousFrame.pixels[offset + 2])
    if (difference > 45) changedPixels++
    samples++
  }

  const changedMeaningfully = changedPixels >= Math.max(8, Math.ceil(samples * 0.005))
  if (changedMeaningfully) lastMeaningfulFrame = { regionKey, pixels }
  return changedMeaningfully
}

const capturePrimaryScreen = async (): Promise<NativeImage> => {
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height }
  })
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0]

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('No screen capture source is available.')
  }

  return source.thumbnail
}

export const getScreenPreview = async (): Promise<ScreenPreview> => {
  const thumbnail = await capturePrimaryScreen()
  const { width, height } = thumbnail.getSize()
  return { dataUrl: thumbnail.toDataURL(), width, height }
}

const captureChangedRegion = async (region: ScreenRegion): Promise<CapturedFrame | null> => {
  const thumbnail = await capturePrimaryScreen()
  const size = thumbnail.getSize()
  const x = Math.max(0, Math.min(Math.floor(region.x), size.width - 1))
  const y = Math.max(0, Math.min(Math.floor(region.y), size.height - 1))
  const width = Math.min(Math.floor(region.width), size.width - x)
  const height = Math.min(Math.floor(region.height), size.height - y)

  if (!Number.isFinite(x + y + width + height) || width < 4 || height < 4) {
    throw new Error('Select a larger screen region.')
  }

  const croppedImage = thumbnail.crop({ x, y, width, height })
  const frameKey = `${x}:${y}:${width}:${height}`
  const pixels = croppedImage.toBitmap()
  if (!hasMeaningfulChange(frameKey, pixels)) return null

  const imageKey = createHash('sha256').update(pixels).digest('hex')
  if (imageKey === lastOcrImageKey) return null
  lastOcrImageKey = imageKey

  return { regionKey: frameKey, image: croppedImage.toPNG() }
}

const processRecognizedText = async (
  frame: CapturedFrame,
  rawText: string,
  languages: string[]
): Promise<FrameRecognition> => {
  // OwOCR's text output has no per-word confidence, so each line is a block and noise is
  // filtered by content ratio alone.
  const recognizedBlocks: RecognizedBlock[] = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      const characters = Array.from(line)
      const contentCount = characters.filter((character) => /[\p{L}\p{N}]/u.test(character)).length
      return contentCount > 0 && contentCount / characters.length >= 0.4
    })
    .map((text) => ({ text, letterCount: (text.match(/\p{L}/gu) ?? []).length }))

  if (recognizedBlocks.length === 0) {
    return { result: null, targetTextKey: '' }
  }

  languageDetectorPromise ??= import('franc-min')
  const { franc } = await languageDetectorPromise
  const detectorLanguages = languages.map((language) =>
    language === 'chi_sim' || language === 'chi_tra' ? 'cmn' : language
  )
  const classifiedBlocks = recognizedBlocks.map((block) => ({
    ...block,
    language: detectBlockLanguage(block, detectorLanguages, franc)
  }))
  const languageTotals = new Map<string, number>()
  for (const block of classifiedBlocks) {
    if (block.language !== 'und') {
      languageTotals.set(
        block.language,
        (languageTotals.get(block.language) ?? 0) + block.letterCount
      )
    }
  }
  const language =
    [...languageTotals.entries()].sort((first, second) => second[1] - first[1])[0]?.[0] ?? 'und'
  const selectedBlocks =
    language === 'und'
      ? classifiedBlocks
      : classifiedBlocks.filter((block) => block.language === language || block.language === 'und')
  const text = selectedBlocks
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) {
    return { result: null, targetTextKey: '' }
  }

  // OwOCR doesn't report a confidence in text mode; the field is kept for the renderer type.
  const result = { text, language, confidence: 100 }
  const normalizedText = text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const targetTextKey = language === 'und' ? '' : `${language}:${normalizedText}`
  const normalizedWords = new Set(normalizedText.split(/\s+/).filter(Boolean))
  if (frame.regionKey === lastLoggedRegionKey && lastLoggedWords.size > 0) {
    const sharedWords = [...normalizedWords].filter((word) => lastLoggedWords.has(word)).length
    const unionSize = new Set([...normalizedWords, ...lastLoggedWords]).size
    if (sharedWords / Math.max(1, unionSize) >= 0.75) {
      return { result: null, targetTextKey }
    }
  }

  lastLoggedRegionKey = frame.regionKey
  lastLoggedWords = normalizedWords
  console.info('[screen-ocr]', result)
  return { result, targetTextKey }
}

const detectBlockLanguage = (
  block: RecognizedBlock,
  detectorLanguages: string[],
  franc: (text: string, options: { only: string[]; minLength: number }) => string
): string => {
  const distinctiveScripts: Array<{ language: string; pattern: RegExp }> = [
    { language: 'jpn', pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
    { language: 'kor', pattern: /\p{Script=Hangul}/u },
    { language: 'rus', pattern: /\p{Script=Cyrillic}/u },
    { language: 'ara', pattern: /\p{Script=Arabic}/u },
    { language: 'hin', pattern: /\p{Script=Devanagari}/u }
  ]
  const scriptLanguage = distinctiveScripts.find(
    ({ language, pattern }) => detectorLanguages.includes(language) && pattern.test(block.text)
  )?.language
  if (scriptLanguage) return scriptLanguage

  const hasHanCharacters = /\p{Script=Han}/u.test(block.text)
  const cjkLanguages = detectorLanguages.filter(
    (language) => language === 'jpn' || language === 'cmn'
  )
  if (hasHanCharacters && cjkLanguages.length === 1) return cjkLanguages[0]

  if (block.letterCount < 12) return 'und'
  return franc(block.text, { only: detectorLanguages, minLength: 12 })
}

const failScan = (scanId: number, message: string): void => {
  if (!isScanActive || scanId !== activeScanId) return
  activeErrorCallback?.(message)
  stopScreenOcr()
}

const clearInFlightFrame = (): void => {
  inFlightFrame = undefined
  if (inFlightTimer) clearTimeout(inFlightTimer)
  inFlightTimer = undefined
}

// One frame is in flight at a time so OwOCR's queue never backs up behind stale subtitles.
const sendNextFrame = (scanId: number): void => {
  const socket = owocrSocket
  if (
    !isScanActive ||
    scanId !== activeScanId ||
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    inFlightFrame ||
    !pendingFrame
  ) {
    return
  }

  inFlightFrame = pendingFrame
  pendingFrame = undefined
  pendingAcks++
  socket.send(inFlightFrame.image)
  // OwOCR sends nothing back when its engine errors; don't stall the scan on it.
  inFlightTimer = setTimeout(() => {
    clearInFlightFrame()
    sendNextFrame(scanId)
  }, owocrResultTimeoutMs)
}

const handleOwocrMessage = async (
  scanId: number,
  data: string,
  languages: string[]
): Promise<void> => {
  if (!isScanActive || scanId !== activeScanId) return

  // OwOCR answers each frame with 'True'/'False' (accepted/paused) before the recognized text.
  if (pendingAcks > 0 && (data === 'True' || data === 'False')) {
    pendingAcks--
    if (data === 'False') {
      clearInFlightFrame()
      lastOcrImageKey = ''
      lastMeaningfulFrame = undefined
      sendNextFrame(scanId)
    }
    return
  }

  const frame = inFlightFrame
  if (!frame) return
  clearInFlightFrame()

  try {
    const recognition = await processRecognizedText(frame, data, languages)
    if (!isScanActive || scanId !== activeScanId) return
    activeActivityCallback?.(recognition.targetTextKey !== '')
    if (recognition.result) activeResultCallback?.(recognition.result)
  } catch (error) {
    failScan(scanId, error instanceof Error ? error.message : 'Screen scan failed.')
    return
  }
  sendNextFrame(scanId)
}

export const startScreenOcr = (
  region: ScreenRegion,
  languages: string[],
  onResult: (result: ScreenOcrResult) => void,
  onError: (message: string) => void,
  onActivity: (active: boolean) => void
): void => {
  stopScreenOcr()
  const scanId = activeScanId
  lastMeaningfulFrame = undefined
  lastOcrImageKey = ''
  lastLoggedRegionKey = ''
  lastLoggedWords = new Set()
  pendingFrame = undefined
  activeResultCallback = onResult
  activeErrorCallback = onError
  activeActivityCallback = onActivity
  isScanActive = true
  console.info('[screen-ocr] live scan started', region)

  const capture = async (): Promise<void> => {
    if (!isScanActive || scanId !== activeScanId) return

    try {
      const frame = await captureChangedRegion(region)
      if (frame && isScanActive && scanId === activeScanId) {
        pendingFrame = frame
        sendNextFrame(scanId)
      }
    } catch (error) {
      failScan(scanId, error instanceof Error ? error.message : 'Screen capture failed.')
      return
    }

    if (isScanActive && scanId === activeScanId) {
      scanTimer = setTimeout(() => void capture(), scanIntervalMs)
    }
  }

  void connectOwocr(languages).then(
    (socket) => {
      if (!isScanActive || scanId !== activeScanId) {
        socket.close()
        return
      }

      owocrSocket = socket
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') void handleOwocrMessage(scanId, event.data, languages)
      })
      socket.addEventListener('close', () => {
        if (owocrSocket !== socket) return
        owocrSocket = undefined
        failScan(scanId, 'Lost the connection to OwOCR.')
      })
      void capture()
    },
    (error) => failScan(scanId, error instanceof Error ? error.message : 'OwOCR failed to start.')
  )
}

export const stopScreenOcr = (): void => {
  if (isScanActive) console.info('[screen-ocr] live scan stopped')
  isScanActive = false
  activeScanId++
  pendingFrame = undefined
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = undefined
  activeActivityCallback = undefined
  closeOwocrSocket()
}
