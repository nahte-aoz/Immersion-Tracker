// Captures the audio of specific applications (WASAPI process loopback, via the
// loopback-capture addon) and mixes it into one 16 kHz mono stream. Everything stays in memory.
import type { LoopbackCapture } from 'loopback-capture'

const BLOCK_SAMPLES = 1600 // 100 ms at 16 kHz
const BLOCK_INTERVAL_MS = 100
const MAX_BUFFERED_SAMPLES = 16000 // drop the oldest audio beyond 1 s rather than lag behind

// 48 kHz -> 16 kHz: a windowed-sinc low-pass (~7 kHz) followed by keeping every third sample.
const DECIMATION = 3
const TAPS = 47
const filter = (() => {
  const cutoff = 7000 / 48000
  const centre = (TAPS - 1) / 2
  const taps = Float64Array.from({ length: TAPS }, (_, index) => {
    const x = index - centre
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * index) / (TAPS - 1)) +
      0.08 * Math.cos((4 * Math.PI * index) / (TAPS - 1))
    return sinc * window
  })
  const sum = taps.reduce((total, tap) => total + tap, 0)
  return Float32Array.from(taps, (tap) => tap / sum)
})()

class Downsampler {
  private history = new Float32Array(TAPS - 1)
  private phase = 0

  process(input: Float32Array): Float32Array {
    const combined = new Float32Array(this.history.length + input.length)
    combined.set(this.history, 0)
    combined.set(input, this.history.length)

    const output: number[] = []
    let position = TAPS - 1 + this.phase
    for (; position < combined.length; position += DECIMATION) {
      let sum = 0
      for (let tap = 0; tap < TAPS; tap++) sum += filter[tap] * combined[position - tap]
      output.push(sum)
    }
    this.phase = position - combined.length
    this.history = combined.slice(combined.length - (TAPS - 1))
    return Float32Array.from(output)
  }
}

class Source {
  private readonly downsampler = new Downsampler()
  private readonly ring = new Float32Array(MAX_BUFFERED_SAMPLES)
  private start = 0
  private count = 0

  constructor(readonly capture: LoopbackCapture) {}

  // `chunk` is interleaved signed 16-bit little-endian stereo at 48 kHz.
  push(chunk: Buffer): void {
    const frames = Math.floor(chunk.length / 4)
    const mono = new Float32Array(frames)
    for (let frame = 0; frame < frames; frame++) {
      mono[frame] = (chunk.readInt16LE(frame * 4) + chunk.readInt16LE(frame * 4 + 2)) / 65536
    }

    for (const sample of this.downsampler.process(mono)) {
      if (this.count === this.ring.length) {
        this.start = (this.start + 1) % this.ring.length
        this.count--
      }
      this.ring[(this.start + this.count) % this.ring.length] = sample
      this.count++
    }
  }

  // Adds up to `block.length` buffered samples into `block`.
  mixInto(block: Float32Array): void {
    const available = Math.min(block.length, this.count)
    for (let i = 0; i < available; i++) block[i] += this.ring[(this.start + i) % this.ring.length]
    this.start = (this.start + available) % this.ring.length
    this.count -= available
  }
}

export class AppAudioMixer {
  private readonly sources = new Map<number, Source>()
  private timer: NodeJS.Timeout | undefined
  private addon: typeof import('loopback-capture').default | undefined

  constructor(
    private readonly onBlock: (block: Float32Array) => void,
    private readonly onFatalError: (message: string) => void
  ) {}

  async setProcesses(pids: number[]): Promise<void> {
    try {
      this.addon ??= (await import('loopback-capture')).default
    } catch {
      this.onFatalError('Per-application audio capture is not available on this system.')
      return
    }

    const wanted = new Set(pids)
    for (const [pid, source] of this.sources) {
      if (!wanted.has(pid)) {
        this.stopSource(pid, source)
      }
    }
    for (const pid of wanted) {
      if (!this.sources.has(pid)) this.startSource(pid)
    }
    this.timer ??= setInterval(() => this.emitBlock(), BLOCK_INTERVAL_MS)
  }

  stop(): void {
    for (const [pid, source] of this.sources) this.stopSource(pid, source)
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private startSource(pid: number): void {
    if (!this.addon) return
    try {
      const capture = new this.addon.LoopbackCapture()
      const source = new Source(capture)
      capture.start(pid, (chunk) => source.push(chunk))
      this.sources.set(pid, source)
    } catch {
      // The process may have exited between listing and capturing; it is retried on the next refresh.
    }
  }

  private stopSource(pid: number, source: Source): void {
    this.sources.delete(pid)
    try {
      source.capture.stop()
    } catch {
      // Already stopped.
    }
  }

  private emitBlock(): void {
    const block = new Float32Array(BLOCK_SAMPLES)
    for (const source of this.sources.values()) source.mixInto(block)
    for (let i = 0; i < block.length; i++) block[i] = Math.max(-1, Math.min(1, block[i]))
    this.onBlock(block)
  }
}
