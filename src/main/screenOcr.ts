import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  nativeImage,
  screen,
  type Display,
  type NativeImage
} from 'electron'
import { toDetectorLanguage } from './languages'
import type {
  ScreenArea,
  ScreenDisplayInfo,
  ScreenOcrResult,
  ScreenPreview
} from '../preload/types'

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
  // The detected language (franc code), when the text counts as a target language.
  language: string
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
let activeActivityCallback: ((active: boolean, language?: string) => void) | undefined
let activeTargetLanguages: string[] = []
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
const buildOwocrConfig = (language: string, useOneOcr: boolean): string =>
  [
    '[general]',
    'read_from = websocket',
    'write_to = websocket',
    `websocket_port = ${owocrPort}`,
    // OneOCR when it's available; Windows' built-in OCR only as a fallback.
    `engines = ${useOneOcr ? 'oneocr,winrtocr' : 'winrtocr'}`,
    `engine = ${useOneOcr ? 'oneocr' : 'winrtocr'}`,
    `language = ${language}`,
    'output_format = text',
    'line_separator = \\n',
    'show_log_at_startup = False',
    'notifications = False',
    'pause_at_startup = False',
    ''
  ].join('\n')

const oneOcrFiles = ['oneocr.dll', 'oneocr.onemodel', 'onnxruntime.dll']

const runPowerShell = (command: string): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', command],
      { timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resolve(error ? '' : stdout.trim())
    )
  })

// OneOCR is the Windows Snipping Tool's text recogniser. OwOCR copies its three files into its
// config folder on first use, but it can't find the Snipping Tool from our private home folder,
// so it silently fell back to Windows' weaker OCR. Copy them ourselves, using the real user
// profile. Returns whether OneOCR is ready.
const prepareOneOcr = async (home: string): Promise<boolean> => {
  const target = join(home, '.config', 'oneocr')
  if (oneOcrFiles.every((file) => existsSync(join(target, file)))) return true

  const sources = [join(homedir(), '.config', 'oneocr')]
  const installLocation = await runPowerShell(
    'Get-AppxPackage Microsoft.ScreenSketch | Select-Object -ExpandProperty InstallLocation'
  )
  if (installLocation) sources.push(join(installLocation, 'SnippingTool'))

  const source = sources.find((folder) =>
    oneOcrFiles.every((file) => existsSync(join(folder, file)))
  )
  if (!source) return false

  try {
    mkdirSync(target, { recursive: true })
    for (const file of oneOcrFiles) copyFileSync(join(source, file), join(target, file))
    return true
  } catch {
    return false
  }
}

const launchOwocr = (executable: string, language: string, useOneOcr: boolean): void => {
  // OwOCR reads ~/.config/owocr_config.ini, so give it a private home to keep this app's
  // settings separate from any OwOCR install the user already has.
  const home = join(app.getPath('userData'), 'owocr-home')
  mkdirSync(join(home, '.config'), { recursive: true })
  writeFileSync(join(home, '.config', 'owocr_config.ini'), buildOwocrConfig(language, useOneOcr))
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
    if (!owocrProcess) {
      const home = join(app.getPath('userData'), 'owocr-home')
      const useOneOcr = await prepareOneOcr(home)
      console.info(
        `[screen-ocr] OCR engine: ${useOneOcr ? 'OneOCR' : 'Windows OCR (OneOCR unavailable)'}`
      )
      launchOwocr(executable, language, useOneOcr)
    }
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

export interface ScreenOcrTarget {
  displayId: number | null
  // Fractions (0..1) of the display, so they survive resolution and scaling changes.
  areas: ScreenArea[]
}

interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

interface BitmapLayer {
  width: number
  height: number
  // BGRA, tightly packed.
  pixels: Buffer
}

const previewMaxWidth = 1600
// Gap between separate (non-overlapping) areas when they are stacked into one image.
const areaGapPixels = 16
const opaqueBlack = 0xff000000

const resolveDisplay = (displayId: number | null): Display =>
  screen.getAllDisplays().find((display) => display.id === displayId) ?? screen.getPrimaryDisplay()

export const getScreenDisplays = (): ScreenDisplayInfo[] => {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: `Display ${index + 1}${display.label ? ` - ${display.label}` : ''}`,
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
    isPrimary: display.id === primaryId
  }))
}

// Captures one monitor at its physical resolution (the capture API otherwise returns it scaled
// down to DIPs, which hurts OCR on scaled displays).
const captureDisplay = async (displayId: number | null): Promise<NativeImage> => {
  const display = resolveDisplay(displayId)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor)
    }
  })
  const index = screen.getAllDisplays().findIndex((item) => item.id === display.id)
  const source =
    sources.find((item) => item.display_id === String(display.id)) ?? sources[index] ?? sources[0]

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('No screen capture source is available.')
  }

  return source.thumbnail
}

export const getScreenPreview = async (displayId: number | null): Promise<ScreenPreview> => {
  const image = await captureDisplay(displayId)
  const scaled =
    image.getSize().width > previewMaxWidth
      ? image.resize({ width: previewMaxWidth, quality: 'good' })
      : image
  const size = scaled.getSize()
  return {
    dataUrl: `data:image/jpeg;base64,${scaled.toJPEG(85).toString('base64')}`,
    width: size.width,
    height: size.height
  }
}

const rectsOverlap = (first: PixelRect, second: PixelRect): boolean =>
  first.x < second.x + second.width &&
  second.x < first.x + first.width &&
  first.y < second.y + second.height &&
  second.y < first.y + first.height

const boundsOf = (rects: PixelRect[]): PixelRect => {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// Groups rectangles that overlap (directly or through a chain of others), in reading order.
const clusterOverlappingRects = (rects: PixelRect[]): PixelRect[][] => {
  const parent = rects.map((_, index) => index)
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]]
      index = parent[index]
    }
    return index
  }
  for (let first = 0; first < rects.length; first++) {
    for (let second = first + 1; second < rects.length; second++) {
      if (rectsOverlap(rects[first], rects[second])) parent[find(second)] = find(first)
    }
  }

  const clusters = new Map<number, PixelRect[]>()
  rects.forEach((rect, index) => {
    const root = find(index)
    clusters.set(root, [...(clusters.get(root) ?? []), rect])
  })
  return [...clusters.values()].sort((first, second) => {
    const a = boundsOf(first)
    const b = boundsOf(second)
    return a.y - b.y || a.x - b.x
  })
}

// One image per cluster of overlapping areas: only the selected pixels are kept (everything else
// is black), so text inside an overlap appears - and is read - once.
const buildClusterLayer = (
  image: NativeImage,
  cluster: PixelRect[],
  masks: PixelRect[]
): BitmapLayer => {
  const bounds = boundsOf(cluster)
  const source = image.crop(bounds).toBitmap()
  blackOut(source, bounds, masks)
  if (cluster.length === 1) return { width: bounds.width, height: bounds.height, pixels: source }

  const pixels = Buffer.alloc(bounds.width * bounds.height * 4)
  new Uint32Array(pixels.buffer, pixels.byteOffset, bounds.width * bounds.height).fill(opaqueBlack)
  for (const rect of cluster) {
    for (let row = 0; row < rect.height; row++) {
      const start = ((rect.y - bounds.y + row) * bounds.width + (rect.x - bounds.x)) * 4
      source.copy(pixels, start, start, start + rect.width * 4)
    }
  }
  return { width: bounds.width, height: bounds.height, pixels }
}

// Stacks the clusters top to bottom into a single image, so one OCR pass covers every area.
const stackLayers = (layers: BitmapLayer[]): BitmapLayer => {
  if (layers.length === 1) return layers[0]

  const width = Math.max(...layers.map((layer) => layer.width))
  const height =
    layers.reduce((total, layer) => total + layer.height, 0) + areaGapPixels * (layers.length - 1)
  const pixels = Buffer.alloc(width * height * 4)
  new Uint32Array(pixels.buffer, pixels.byteOffset, width * height).fill(opaqueBlack)

  let top = 0
  for (const layer of layers) {
    for (let row = 0; row < layer.height; row++) {
      layer.pixels.copy(
        pixels,
        (top + row) * width * 4,
        row * layer.width * 4,
        (row + 1) * layer.width * 4
      )
    }
    top += layer.height + areaGapPixels
  }
  return { width, height, pixels }
}

const toPixelRects = (areas: ScreenArea[], size: { width: number; height: number }): PixelRect[] =>
  areas
    .map((area) => {
      const x = Math.max(0, Math.min(Math.round(area.x * size.width), size.width - 1))
      const y = Math.max(0, Math.min(Math.round(area.y * size.height), size.height - 1))
      return {
        x,
        y,
        width: Math.min(Math.round(area.width * size.width), size.width - x),
        height: Math.min(Math.round(area.height * size.height), size.height - y)
      }
    })
    .filter(
      (rect) =>
        Number.isFinite(rect.x + rect.y + rect.width + rect.height) &&
        rect.width >= 4 &&
        rect.height >= 4
    )

const windowOrderHelper = (): string | undefined =>
  [
    join(process.resourcesPath, 'audio-sessions', 'window-order.exe'),
    join(app.getAppPath(), 'resources', 'audio-sessions', 'window-order.exe')
  ].find((candidate) => existsSync(candidate))

const subtractRect = (rect: PixelRect, cut: PixelRect): PixelRect[] => {
  if (!rectsOverlap(rect, cut)) return [rect]
  const pieces: PixelRect[] = []
  const rectRight = rect.x + rect.width
  const rectBottom = rect.y + rect.height
  const cutRight = cut.x + cut.width
  const cutBottom = cut.y + cut.height
  const top = Math.max(rect.y, cut.y)
  const bottom = Math.min(rectBottom, cutBottom)
  if (cut.y > rect.y)
    pieces.push({ x: rect.x, y: rect.y, width: rect.width, height: cut.y - rect.y })
  if (cutBottom < rectBottom) {
    pieces.push({ x: rect.x, y: cutBottom, width: rect.width, height: rectBottom - cutBottom })
  }
  if (cut.x > rect.x)
    pieces.push({ x: rect.x, y: top, width: cut.x - rect.x, height: bottom - top })
  if (cutRight < rectRight) {
    pieces.push({ x: cutRight, y: top, width: rectRight - cutRight, height: bottom - top })
  }
  return pieces
}

// The parts of this app's own windows that are actually showing on `display` (not hidden behind
// other windows), in image pixels. These are blacked out so the app's own text is never read,
// while the app stays visible to screenshots and recorders.
const getOwnWindowMasks = async (
  display: Display,
  imageSize: { width: number; height: number }
): Promise<PixelRect[]> => {
  const showing = BrowserWindow.getAllWindows().some((window) => {
    if (!window.isVisible() || window.isMinimized()) return false
    const bounds = window.getBounds()
    return (
      bounds.x < display.bounds.x + display.bounds.width &&
      display.bounds.x < bounds.x + bounds.width &&
      bounds.y < display.bounds.y + display.bounds.height &&
      display.bounds.y < bounds.y + bounds.height
    )
  })
  const helper = windowOrderHelper()
  if (!showing || !helper) return []

  const windows = await new Promise<Array<PixelRect & { pid: number }>>((resolve) => {
    execFile(helper, { timeout: 3000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      try {
        resolve(error ? [] : (JSON.parse(stdout) as Array<PixelRect & { pid: number }>))
      } catch {
        resolve([])
      }
    })
  })

  const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
  const physical = screen.dipToScreenRect(null, display.bounds)
  const scaleX = imageSize.width / physical.width
  const scaleY = imageSize.height / physical.height

  const masks: PixelRect[] = []
  windows.forEach((window, index) => {
    if (window.pid !== process.pid) return
    // Whatever is above this window in the z-order hides part of it.
    let visible: PixelRect[] = [window]
    for (const above of windows.slice(0, index)) {
      if (above.pid === process.pid) continue
      visible = visible.flatMap((piece) => subtractRect(piece, above))
    }
    for (const piece of visible) {
      masks.push({
        x: Math.round((piece.x - origin.x) * scaleX),
        y: Math.round((piece.y - origin.y) * scaleY),
        width: Math.round(piece.width * scaleX),
        height: Math.round(piece.height * scaleY)
      })
    }
  })
  return masks
}

const blackPixel = Buffer.from([0, 0, 0, 255])

const blackOut = (bitmap: Buffer, bounds: PixelRect, masks: PixelRect[]): void => {
  for (const mask of masks) {
    const left = Math.max(bounds.x, mask.x)
    const top = Math.max(bounds.y, mask.y)
    const right = Math.min(bounds.x + bounds.width, mask.x + mask.width)
    const bottom = Math.min(bounds.y + bounds.height, mask.y + mask.height)
    if (right <= left || bottom <= top) continue
    for (let y = top; y < bottom; y++) {
      const start = ((y - bounds.y) * bounds.width + (left - bounds.x)) * 4
      bitmap.fill(blackPixel, start, start + (right - left) * 4)
    }
  }
}

const captureChangedAreas = async (target: ScreenOcrTarget): Promise<CapturedFrame | null> => {
  const image = await captureDisplay(target.displayId)
  const size = image.getSize()
  const rects = toPixelRects(target.areas, size)
  if (rects.length === 0) throw new Error('Select at least one screen area.')

  const masks = await getOwnWindowMasks(resolveDisplay(target.displayId), size)
  const layer = stackLayers(
    clusterOverlappingRects(rects).map((cluster) => buildClusterLayer(image, cluster, masks))
  )
  const frameKey = `${resolveDisplay(target.displayId).id}:${size.width}x${size.height}:${rects
    .map((rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`)
    .join(';')}`
  if (!hasMeaningfulChange(frameKey, layer.pixels)) return null

  const imageKey = createHash('sha256').update(layer.pixels).digest('hex')
  if (imageKey === lastOcrImageKey) return null
  lastOcrImageKey = imageKey

  const png = nativeImage
    .createFromBitmap(layer.pixels, { width: layer.width, height: layer.height })
    .toPNG()
  return { regionKey: frameKey, image: png }
}

// Full-width Latin letters and digits (typed with a Japanese IME, e.g. "ｓｏｕｒｃｅ") are
// Latin text, not Japanese: fold them to plain ASCII before the language is detected.
const foldFullwidthLatin = (text: string): string =>
  text.replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 0xfee0)
  )

const processRecognizedText = async (
  frame: CapturedFrame,
  rawText: string,
  languages: string[]
): Promise<FrameRecognition> => {
  // OwOCR's text output has no per-word confidence, so each line is a block and noise is
  // filtered by content ratio alone.
  const recognizedBlocks: RecognizedBlock[] = rawText
    .split(/\r?\n/)
    .map((line) => foldFullwidthLatin(line.replace(/\s+/g, ' ').trim()))
    .filter((line) => {
      const characters = Array.from(line)
      const contentCount = characters.filter((character) => /[\p{L}\p{N}]/u.test(character)).length
      return contentCount > 0 && contentCount / characters.length >= 0.4
    })
    .map((text) => ({ text, letterCount: (text.match(/\p{L}/gu) ?? []).length }))

  if (recognizedBlocks.length === 0) {
    return { result: null, targetTextKey: '', language: '' }
  }

  languageDetectorPromise ??= import('franc-min')
  const { franc } = await languageDetectorPromise
  const detectorLanguages = languages.map(toDetectorLanguage)
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
  // Only the profile's languages count; other languages are still classified so that, for
  // example, English text isn't mistaken for the one selected language.
  const allowed = new Set(activeTargetLanguages.map(toDetectorLanguage))
  const language =
    [...languageTotals.entries()]
      .filter(([candidate]) => allowed.has(candidate))
      .sort((first, second) => second[1] - first[1])[0]?.[0] ?? 'und'
  if (language === 'und') return { result: null, targetTextKey: '', language: '' }
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
    return { result: null, targetTextKey: '', language: '' }
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
      return { result: null, targetTextKey, language }
    }
  }

  lastLoggedRegionKey = frame.regionKey
  lastLoggedWords = normalizedWords
  console.info('[screen-ocr]', result)
  return { result, targetTextKey, language }
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
  // Text without any Han/kana characters can't be Japanese or Chinese.
  const hasJapaneseScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
    block.text
  )
  const candidates = hasJapaneseScript
    ? detectorLanguages
    : detectorLanguages.filter((language) => language !== 'jpn' && language !== 'cmn')
  if (candidates.length === 0) return 'und'
  return franc(block.text, { only: candidates, minLength: 12 })
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
    activeActivityCallback?.(recognition.targetTextKey !== '', recognition.language)
    if (recognition.result) activeResultCallback?.(recognition.result)
  } catch (error) {
    failScan(scanId, error instanceof Error ? error.message : 'Screen scan failed.')
    return
  }
  sendNextFrame(scanId)
}

export const startScreenOcr = (
  target: ScreenOcrTarget,
  languages: string[],
  targetLanguages: string[],
  onResult: (result: ScreenOcrResult) => void,
  onError: (message: string) => void,
  onActivity: (active: boolean, language?: string) => void
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
  activeTargetLanguages = targetLanguages
  isScanActive = true
  console.info('[screen-ocr] live scan started', target)

  const capture = async (): Promise<void> => {
    if (!isScanActive || scanId !== activeScanId) return

    try {
      const frame = await captureChangedAreas(target)
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

  void connectOwocr(targetLanguages).then(
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
