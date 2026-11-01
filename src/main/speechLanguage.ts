import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { isPerAppCaptureSupported, listAudioSessions } from './audioApps'
import audioWorkerPath from './speech/audioWorker?modulePath'
import type { SpeechWorkerRequest, SpeechWorkerResponse } from './speech/workerProtocol'
import type { SpeechLanguageResult } from '../preload/types'

let worker: UtilityProcess | undefined
let workerReady = false
let workerStartup: Promise<void> | undefined
let rejectWorkerStartup: ((error: Error) => void) | undefined
let activeSessionId = 0
let isActive = false
let targetLanguages = new Set<string>()
let activeResultCallback: ((result: SpeechLanguageResult) => void) | undefined
let activeErrorCallback: ((message: string) => void) | undefined
let activeActivityCallback: ((active: boolean) => void) | undefined
let activeCaptureCallback: ((capturing: boolean) => void) | undefined
let activeLevelCallback: ((rms: number) => void) | undefined
// Lower-cased executable names to listen to; empty means all system audio.
let selectedApps: string[] = []
// 'system' is captured by the renderer (whole-device loopback); 'apps' by the worker.
let captureMode: 'none' | 'system' | 'apps' = 'none'
let appPollTimer: NodeJS.Timeout | undefined
let appListFailures = 0
let watchdogTimer: NodeJS.Timeout | undefined
let lastFrameAt = 0
let probeStartedAt = 0

const workerStartupTimeoutMs = 60000
// Capture delivers (silent) frames continuously, so a long gap means capture died.
const frameStallTimeoutMs = 10000
const probeTimeoutMs = 30000
const appPollIntervalMs = 3000
const maxAppListFailures = 3
const watchdogIntervalMs = 2000
// Below this a guess is too uncertain to count as the target language.
const minimumConfidence = 0.5

// Whisper's language codes, keyed by the Tesseract-style codes the app stores.
const whisperLanguageCodes: Record<string, string> = {
  eng: 'en',
  jpn: 'ja',
  chi_sim: 'zh',
  chi_tra: 'zh',
  kor: 'ko',
  rus: 'ru',
  spa: 'es',
  fra: 'fr',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  ara: 'ar',
  hin: 'hi'
}

const findSpeechModelDir = (): string | undefined => {
  const candidates = [
    process.env.SPEECH_MODELS_PATH,
    join(process.resourcesPath, 'speech'),
    join(app.getAppPath(), 'resources', 'speech')
  ]
  return candidates.find(
    (candidate) =>
      candidate &&
      existsSync(join(candidate, 'silero_vad.onnx')) &&
      existsSync(join(candidate, 'whisper-base', 'decoder_model_quantized.onnx'))
  )
}

const send = (message: SpeechWorkerRequest): void => worker?.postMessage(message)

const failSession = (sessionId: number, message: string): void => {
  if (!isActive || sessionId !== activeSessionId) return
  activeErrorCallback?.(message)
  stopSpeechDetection()
}

const handleWorkerMessage = (message: SpeechWorkerResponse): void => {
  if (message.type === 'probe-start') {
    probeStartedAt = Date.now()
  } else if (message.type === 'error') {
    rejectWorkerStartup?.(new Error(message.message))
    // A worker that failed to initialise is unusable; drop it so the next start retries.
    if (!workerReady) worker?.kill()
    failSession(activeSessionId, `Speech detection failed: ${message.message}`)
  } else if (message.type === 'level' && isActive) {
    lastFrameAt = Date.now()
    activeLevelCallback?.(message.rms)
  } else if (message.type === 'capture-error') {
    failSession(activeSessionId, message.message)
  } else if (message.type === 'result' && isActive) {
    probeStartedAt = 0
    const isTarget =
      targetLanguages.has(message.language) && message.confidence >= minimumConfidence
    const result = {
      language: message.language,
      confidence: Math.round(message.confidence * 100),
      isTarget
    }
    console.info('[speech-language]', result, `${Math.round(message.elapsedMs)}ms`)
    activeActivityCallback?.(isTarget)
    activeResultCallback?.(result)
  }
}

const ensureWorker = (): Promise<void> => {
  if (worker && workerReady) return Promise.resolve()
  if (worker && workerStartup) return workerStartup

  const modelDir = findSpeechModelDir()
  if (!modelDir) {
    return Promise.reject(
      new Error(
        'Speech models were not found. Run "npm run fetch:speech-models" to bundle them, or set SPEECH_MODELS_PATH.'
      )
    )
  }

  const child = utilityProcess.fork(audioWorkerPath, [], { serviceName: 'speech-language-id' })
  worker = child
  workerReady = false
  workerStartup = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Speech models did not load in time.'))
      child.kill()
    }, workerStartupTimeoutMs)
    rejectWorkerStartup = (error) => {
      clearTimeout(timeout)
      reject(error)
    }

    child.on('message', (message: SpeechWorkerResponse) => {
      if (message.type === 'ready') {
        clearTimeout(timeout)
        workerReady = true
        resolve()
      } else {
        handleWorkerMessage(message)
      }
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      const wasActive = isActive
      if (worker === child) {
        worker = undefined
        workerReady = false
        workerStartup = undefined
      }
      reject(new Error('The speech engine exited before it was ready.'))
      if (wasActive) failSession(activeSessionId, 'Speech detection stopped unexpectedly.')
    })
  })
  // Callers handle the rejection; this prevents an unhandled-rejection report when none is waiting.
  workerStartup.catch(() => undefined)
  send({ type: 'init', modelDir })
  return workerStartup
}

const stopAppPolling = (): void => {
  if (appPollTimer) clearInterval(appPollTimer)
  appPollTimer = undefined
}

// Finds the processes of the selected applications and tells the worker to capture them.
const refreshAppCapture = async (sessionId: number): Promise<void> => {
  try {
    const sessions = await listAudioSessions()
    if (!isActive || sessionId !== activeSessionId || captureMode !== 'apps') return
    appListFailures = 0
    const wanted = new Set(selectedApps)
    send({
      type: 'capture-apps',
      pids: sessions.filter((session) => wanted.has(session.exe.toLowerCase())).map((s) => s.pid)
    })
  } catch {
    if (++appListFailures >= maxAppListFailures) {
      failSession(sessionId, 'Unable to read which applications are playing audio.')
    }
  }
}

// Switches between capturing the whole system (renderer) and selected applications (worker).
const applyCaptureMode = (sessionId: number): void => {
  const wantsApps = selectedApps.length > 0
  if (wantsApps && !isPerAppCaptureSupported()) {
    failSession(
      sessionId,
      'Listening to specific applications needs Windows 10 version 2004 or later.'
    )
    return
  }

  const next = wantsApps ? 'apps' : 'system'
  if (next === captureMode) {
    if (next === 'apps') void refreshAppCapture(sessionId)
    return
  }

  if (captureMode === 'system') activeCaptureCallback?.(false)
  if (captureMode === 'apps') {
    stopAppPolling()
    send({ type: 'capture-stop' })
  }
  captureMode = next
  lastFrameAt = Date.now()

  if (next === 'system') {
    activeCaptureCallback?.(true)
  } else {
    appListFailures = 0
    void refreshAppCapture(sessionId)
    appPollTimer = setInterval(() => void refreshAppCapture(sessionId), appPollIntervalMs)
  }
}

export const setSpeechApps = (executables: string[]): void => {
  selectedApps = [...new Set(executables.map((executable) => executable.toLowerCase()))]
  if (isActive && workerReady) applyCaptureMode(activeSessionId)
}

const startWatchdog = (sessionId: number): void => {
  stopWatchdog()
  lastFrameAt = Date.now()
  watchdogTimer = setInterval(() => {
    const now = Date.now()
    if (probeStartedAt && now - probeStartedAt > probeTimeoutMs) {
      worker?.kill()
    } else if (now - lastFrameAt > frameStallTimeoutMs) {
      failSession(sessionId, 'No audio is being captured.')
    }
  }, watchdogIntervalMs)
}

const stopWatchdog = (): void => {
  if (watchdogTimer) clearInterval(watchdogTimer)
  watchdogTimer = undefined
}

export const startSpeechDetection = (
  languages: string[],
  onResult: (result: SpeechLanguageResult) => void,
  onError: (message: string) => void,
  onActivity: (active: boolean) => void,
  onCapture: (capturing: boolean) => void,
  onLevel: (rms: number) => void
): void => {
  stopSpeechDetection()
  const sessionId = activeSessionId
  targetLanguages = new Set(
    languages.map((language) => whisperLanguageCodes[language]).filter(Boolean)
  )
  activeResultCallback = onResult
  activeErrorCallback = onError
  activeActivityCallback = onActivity
  activeCaptureCallback = onCapture
  activeLevelCallback = onLevel
  probeStartedAt = 0
  isActive = true
  console.info('[speech-language] live detection started', [...targetLanguages])

  if (targetLanguages.size === 0) {
    failSession(sessionId, 'None of the selected languages are supported for speech detection.')
    return
  }

  ensureWorker().then(
    () => {
      if (!isActive || sessionId !== activeSessionId) return
      send({ type: 'reset' })
      startWatchdog(sessionId)
      applyCaptureMode(sessionId)
    },
    (error: unknown) =>
      failSession(
        sessionId,
        error instanceof Error ? error.message : 'Speech detection failed to start.'
      )
  )
}

export const pushAudioFrames = (samples: Float32Array): void => {
  if (!isActive || !workerReady || captureMode !== 'system') return
  lastFrameAt = Date.now()
  send({ type: 'frames', samples })
}

export const reportCaptureError = (message: string): void => failSession(activeSessionId, message)

export const stopSpeechDetection = (): void => {
  if (isActive) console.info('[speech-language] live detection stopped')
  const wasCapturing = activeCaptureCallback
  isActive = false
  activeSessionId++
  stopWatchdog()
  stopAppPolling()
  probeStartedAt = 0
  activeActivityCallback = undefined
  activeCaptureCallback = undefined
  activeLevelCallback = undefined
  wasCapturing?.(false)
  if (workerReady) {
    if (captureMode === 'apps') send({ type: 'capture-stop' })
    send({ type: 'reset' })
  }
  captureMode = 'none'
}

export const shutdownSpeechDetection = (): void => {
  stopSpeechDetection()
  worker?.kill()
  worker = undefined
  workerReady = false
  workerStartup = undefined
}
