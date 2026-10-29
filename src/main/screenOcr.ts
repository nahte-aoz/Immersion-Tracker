import { createHash } from 'node:crypto'
import { desktopCapturer, screen, type NativeImage } from 'electron'
import { createWorker, PSM } from 'tesseract.js'
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
  confidence: number
  letterCount: number
}

interface FrameRecognition {
  result: ScreenOcrResult | null
  targetTextKey: string
}

let workerPromise: ReturnType<typeof createWorker> | undefined
let workerLanguageKey = ''
let languageDetectorPromise: Promise<typeof import('franc-min')> | undefined
let lastMeaningfulFrame: FrameSnapshot | undefined
let lastOcrImageKey = ''
let lastLoggedRegionKey = ''
let lastLoggedWords = new Set<string>()
let pendingFrame: CapturedFrame | undefined
let isOcrRunning = false
let activeScanId = 0
let activeResultCallback: ((result: ScreenOcrResult) => void) | undefined
let activeErrorCallback: ((message: string) => void) | undefined
let activeActivityCallback: ((active: boolean) => void) | undefined
let scanTimer: NodeJS.Timeout | undefined
let isScanActive = false

const scanIntervalMs = 500

const getOcrWorker = async (
  languages: string[]
): Promise<Awaited<ReturnType<typeof createWorker>>> => {
  const languageKey = languages.join('+')
  if (workerPromise && workerLanguageKey !== languageKey) {
    const previousWorker = await workerPromise
    await previousWorker.terminate()
    workerPromise = undefined
  }

  workerLanguageKey = languageKey
  workerPromise ??= createWorker(languages).then(async (worker) => {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
    return worker
  })
  return workerPromise
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

  const scale = width < 700 ? 3 : width < 1400 ? 2 : 1
  const recognitionImage =
    scale > 1
      ? croppedImage.resize({ width: width * scale, height: height * scale, quality: 'best' })
      : croppedImage

  return { regionKey: frameKey, image: recognitionImage.toPNG() }
}

const recognizeFrame = async (
  frame: CapturedFrame,
  languages: string[]
): Promise<FrameRecognition> => {
  const worker = await getOcrWorker(languages)
  const { data } = await worker.recognize(frame.image, {}, { blocks: true })
  const recognizedBlocks: RecognizedBlock[] = (data.blocks ?? [])
    .map((block) => {
      const words = block.paragraphs
        .flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words))
        .filter((word) => {
          const text = word.text.trim()
          const characters = Array.from(text)
          const contentCount = characters.filter((character) =>
            /[\p{L}\p{N}]/u.test(character)
          ).length
          const minimumConfidence = characters.length === 1 ? 70 : characters.length === 2 ? 55 : 48
          return (
            word.confidence >= minimumConfidence &&
            contentCount > 0 &&
            contentCount / characters.length >= 0.4
          )
        })
      const text = words.map((word) => word.text.trim()).join(' ')
      const letterCount = (text.match(/\p{L}/gu) ?? []).length
      return {
        text,
        confidence: words.length
          ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length
          : 0,
        letterCount
      }
    })
    .filter((block) => block.text && block.confidence >= 48)

  if (recognizedBlocks.length === 0 && data.text.trim()) {
    recognizedBlocks.push({
      text: data.text.replace(/\s+/g, ' ').trim(),
      confidence: data.confidence,
      letterCount: (data.text.match(/\p{L}/gu) ?? []).length
    })
  }

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
    language:
      block.letterCount >= 12
        ? franc(block.text, { only: detectorLanguages, minLength: 12 })
        : 'und'
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
  const confidence = Math.round(
    selectedBlocks.reduce((sum, block) => sum + block.confidence, 0) / selectedBlocks.length
  )
  if (!text || confidence < 48) {
    return { result: null, targetTextKey: '' }
  }

  const result = { text, language, confidence }
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

const recognizePendingFrames = async (scanId: number, languages: string[]): Promise<void> => {
  if (isOcrRunning || !pendingFrame) return
  isOcrRunning = true

  try {
    while (isScanActive && scanId === activeScanId && pendingFrame) {
      const frame = pendingFrame
      pendingFrame = undefined
      const recognition = await recognizeFrame(frame, languages)
      if (!isScanActive || scanId !== activeScanId) break
      activeActivityCallback?.(recognition.targetTextKey !== '')
      if (recognition.result) activeResultCallback?.(recognition.result)
    }
  } catch (error) {
    if (isScanActive && scanId === activeScanId) {
      activeErrorCallback?.(error instanceof Error ? error.message : 'Screen scan failed.')
      stopScreenOcr()
    }
  } finally {
    isOcrRunning = false
    if (isScanActive && pendingFrame) void recognizePendingFrames(activeScanId, languages)
  }
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
        void recognizePendingFrames(scanId, languages)
      }
    } catch (error) {
      if (isScanActive && scanId === activeScanId) {
        onError(error instanceof Error ? error.message : 'Screen capture failed.')
        stopScreenOcr()
      }
      return
    }

    if (isScanActive && scanId === activeScanId) {
      scanTimer = setTimeout(() => void capture(), scanIntervalMs)
    }
  }

  void capture()
}

export const stopScreenOcr = (): void => {
  if (isScanActive) console.info('[screen-ocr] live scan stopped')
  isScanActive = false
  activeScanId++
  pendingFrame = undefined
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = undefined
  activeActivityCallback = undefined
}
