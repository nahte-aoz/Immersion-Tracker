// Runs on the audio rendering thread: downmixes to mono and hands ~100 ms blocks of 16 kHz PCM
// to the main thread. Audio is only streamed onward in memory; it is never stored.
const BLOCK_SAMPLES = 1600

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(BLOCK_SAMPLES)
    this.filled = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    for (let i = 0; i < input[0].length; i++) {
      let sum = 0
      for (let channel = 0; channel < input.length; channel++) sum += input[channel][i]
      this.block[this.filled++] = sum / input.length

      if (this.filled === BLOCK_SAMPLES) {
        this.port.postMessage(this.block, [this.block.buffer])
        this.block = new Float32Array(BLOCK_SAMPLES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
