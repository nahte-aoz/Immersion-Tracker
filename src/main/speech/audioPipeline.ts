import type { LanguageGuess } from './languageId'
import { VAD_FRAME_SAMPLES } from './sileroVad'

export interface SpeechProbeResult extends LanguageGuess {
  speechSeconds: number
  elapsedMs: number
}

interface PipelineDependencies {
  vad: { process: (frame: Float32Array) => Promise<number>; reset: () => void }
  identify: (audio: Float32Array) => Promise<LanguageGuess>
  onProbeStart?: () => void
  onResult: (result: SpeechProbeResult) => void
  onError: (error: unknown) => void
}

const SAMPLE_RATE = 16000
const SPEECH_THRESHOLD = 0.5
const SILENCE_THRESHOLD = 0.35
// Keep ~320 ms of trailing audio after speech so word endings aren't clipped.
const HANGOVER_FRAMES = 10
// Probe once there is this much speech, then at most every MIN_PROBE_GAP_SECONDS of audio.
const MIN_PROBE_SPEECH_SECONDS = 3
const MAX_PROBE_SPEECH_SECONDS = 10
const MIN_PROBE_GAP_SECONDS = 6

// Turns a continuous 16 kHz mono stream into language guesses: a VAD keeps only speech, and when
// enough has accumulated one Whisper language probe runs on it. Audio is only ever held in
// memory and is discarded after each probe.
export class SpeechLanguagePipeline {
  private remainder = new Float32Array(0)
  private speechFrames: Float32Array[] = []
  private inSpeech = false
  private trailingSilenceFrames = 0
  private audioSeconds = 0
  private lastProbeSeconds = -Infinity
  private probeRunning = false

  constructor(private readonly deps: PipelineDependencies) {}

  reset(): void {
    this.remainder = new Float32Array(0)
    this.speechFrames = []
    this.inSpeech = false
    this.trailingSilenceFrames = 0
    this.audioSeconds = 0
    this.lastProbeSeconds = -Infinity
    this.deps.vad.reset()
  }

  async push(samples: Float32Array): Promise<void> {
    let data = samples
    if (this.remainder.length > 0) {
      data = new Float32Array(this.remainder.length + samples.length)
      data.set(this.remainder, 0)
      data.set(samples, this.remainder.length)
    }

    let offset = 0
    while (offset + VAD_FRAME_SAMPLES <= data.length) {
      await this.processFrame(data.slice(offset, offset + VAD_FRAME_SAMPLES))
      offset += VAD_FRAME_SAMPLES
    }
    this.remainder = data.slice(offset)
  }

  private async processFrame(frame: Float32Array): Promise<void> {
    const probability = await this.deps.vad.process(frame)
    this.audioSeconds += VAD_FRAME_SAMPLES / SAMPLE_RATE

    if (probability >= SPEECH_THRESHOLD) {
      this.inSpeech = true
      this.trailingSilenceFrames = 0
    } else if (this.inSpeech && probability < SILENCE_THRESHOLD) {
      if (++this.trailingSilenceFrames > HANGOVER_FRAMES) this.inSpeech = false
    }

    if (this.inSpeech) {
      this.speechFrames.push(frame)
      this.maybeProbe()
    }
  }

  private maybeProbe(): void {
    const speechSeconds = (this.speechFrames.length * VAD_FRAME_SAMPLES) / SAMPLE_RATE
    if (
      this.probeRunning ||
      speechSeconds < MIN_PROBE_SPEECH_SECONDS ||
      this.audioSeconds - this.lastProbeSeconds < MIN_PROBE_GAP_SECONDS
    ) {
      return
    }

    // Use the most recent speech and drop the rest; nothing is kept after the probe.
    const maxFrames = Math.floor((MAX_PROBE_SPEECH_SECONDS * SAMPLE_RATE) / VAD_FRAME_SAMPLES)
    const frames = this.speechFrames.slice(-maxFrames)
    this.speechFrames = []
    this.lastProbeSeconds = this.audioSeconds
    this.probeRunning = true

    const audio = new Float32Array(frames.length * VAD_FRAME_SAMPLES)
    frames.forEach((frame, index) => audio.set(frame, index * VAD_FRAME_SAMPLES))

    const startedAt = performance.now()
    this.deps.onProbeStart?.()
    // Not awaited: the stream keeps flowing (and is VAD-processed) while the probe runs.
    void this.deps
      .identify(audio)
      .then((guess) =>
        this.deps.onResult({
          ...guess,
          speechSeconds: audio.length / SAMPLE_RATE,
          elapsedMs: performance.now() - startedAt
        })
      )
      .catch((error: unknown) => this.deps.onError(error))
      .finally(() => {
        this.probeRunning = false
      })
  }
}
