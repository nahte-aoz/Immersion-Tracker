import * as ort from 'onnxruntime-node'

export const VAD_FRAME_SAMPLES = 512
const CONTEXT_SAMPLES = 64
const STATE_SIZE = 2 * 128

// Silero VAD (16 kHz): 512-sample frames in, speech probability out. The model is stateful, so
// frames must be fed in order; the previous 64 samples are prepended as context.
export class SileroVad {
  private state = new Float32Array(STATE_SIZE)
  private context = new Float32Array(CONTEXT_SAMPLES)
  private readonly sampleRate = new ort.Tensor('int64', BigInt64Array.from([16000n]), [])

  private constructor(private readonly session: ort.InferenceSession) {}

  static async create(modelPath: string): Promise<SileroVad> {
    const session = await ort.InferenceSession.create(modelPath, {
      intraOpNumThreads: 1,
      interOpNumThreads: 1
    })
    return new SileroVad(session)
  }

  reset(): void {
    this.state = new Float32Array(STATE_SIZE)
    this.context = new Float32Array(CONTEXT_SAMPLES)
  }

  async process(frame: Float32Array): Promise<number> {
    const input = new Float32Array(CONTEXT_SAMPLES + VAD_FRAME_SAMPLES)
    input.set(this.context, 0)
    input.set(frame, CONTEXT_SAMPLES)
    this.context = frame.slice(VAD_FRAME_SAMPLES - CONTEXT_SAMPLES)

    const output = await this.session.run({
      input: new ort.Tensor('float32', input, [1, input.length]),
      state: new ort.Tensor('float32', this.state, [2, 1, 128]),
      sr: this.sampleRate
    })
    this.state = Float32Array.from(output.stateN.data as Float32Array)
    return (output.output.data as Float32Array)[0]
  }
}
