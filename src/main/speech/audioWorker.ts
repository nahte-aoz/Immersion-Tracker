// Runs in an Electron utility process so ONNX inference never blocks the main process and a
// native crash can't take the app down. Receives raw 16 kHz mono PCM (or captures selected
// applications itself) and replies with language guesses. Audio is processed in memory only;
// nothing is written to disk or sent over a network.
import { availableParallelism } from 'node:os'
import { AppAudioMixer } from './appCapture'
import { SpeechLanguagePipeline } from './audioPipeline'
import { WhisperLanguageId } from './languageId'
import { SileroVad } from './sileroVad'
import type { SpeechWorkerRequest, SpeechWorkerResponse } from './workerProtocol'

const port = process.parentPort
const send = (message: SpeechWorkerResponse): void => port.postMessage(message)
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
const levelIntervalMs = 200

let pipeline: SpeechLanguagePipeline | undefined
let mixer: AppAudioMixer | undefined
let lastLevelAt = 0
// Work is handled strictly in order so a reset can't overtake queued audio.
let queue: Promise<void> = Promise.resolve()
const enqueue = (task: () => Promise<void> | void): void => {
  queue = queue
    .then(task)
    .catch((error: unknown) => send({ type: 'error', message: describe(error) }))
}

const initialise = async (modelDir: string): Promise<void> => {
  const vad = await SileroVad.create(`${modelDir}/silero_vad.onnx`)
  const languageId = await WhisperLanguageId.create(
    `${modelDir}/whisper-base`,
    Math.max(1, Math.min(2, availableParallelism() - 1))
  )
  pipeline = new SpeechLanguagePipeline({
    vad,
    identify: (audio) => languageId.identify(audio),
    onProbeStart: () => send({ type: 'probe-start' }),
    onResult: (result) => send({ type: 'result', ...result }),
    onError: (error) => send({ type: 'error', message: describe(error) })
  })
  send({ type: 'ready' })
}

const handleMixedBlock = (block: Float32Array): void => {
  const now = Date.now()
  if (now - lastLevelAt >= levelIntervalMs) {
    lastLevelAt = now
    let sum = 0
    for (const sample of block) sum += sample * sample
    send({ type: 'level', rms: Math.sqrt(sum / block.length) })
  }
  enqueue(() => pipeline?.push(block))
}

port.on('message', (event) => {
  const request = event.data as SpeechWorkerRequest
  if (request.type === 'init') {
    enqueue(() => initialise(request.modelDir))
  } else if (request.type === 'frames') {
    enqueue(() => pipeline?.push(request.samples))
  } else if (request.type === 'reset') {
    enqueue(() => pipeline?.reset())
  } else if (request.type === 'capture-apps') {
    mixer ??= new AppAudioMixer(handleMixedBlock, (message) =>
      send({ type: 'capture-error', message })
    )
    void mixer.setProcesses(request.pids)
  } else if (request.type === 'capture-stop') {
    mixer?.stop()
  }
})
