// Whisper log-mel front end (80 mels, 16 kHz, 30 s window), matching the reference
// implementation so the quantized Whisper ONNX encoder sees the features it was trained on.

export const WHISPER_SAMPLE_RATE = 16000
export const WHISPER_MAX_SAMPLES = 30 * WHISPER_SAMPLE_RATE
const N_FFT = 400
const HOP_LENGTH = 160
const N_MELS = 80
const N_BINS = N_FFT / 2 + 1
export const WHISPER_N_FRAMES = WHISPER_MAX_SAMPLES / HOP_LENGTH

const hzToMel = (hz: number): number =>
  hz < 1000 ? hz / (200 / 3) : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27)

const melToHz = (mel: number): number =>
  mel < 15 ? mel * (200 / 3) : 1000 * Math.exp((Math.log(6.4) / 27) * (mel - 15))

// Slaney-scale, slaney-normalised triangular filters, shape [N_MELS][N_BINS].
const buildMelFilters = (): Float32Array[] => {
  const melMin = hzToMel(0)
  const melMax = hzToMel(WHISPER_SAMPLE_RATE / 2)
  const edges = Array.from({ length: N_MELS + 2 }, (_, index) =>
    melToHz(melMin + ((melMax - melMin) * index) / (N_MELS + 1))
  )

  return Array.from({ length: N_MELS }, (_, mel) => {
    const filter = new Float32Array(N_BINS)
    const normalisation = 2 / (edges[mel + 2] - edges[mel])
    for (let bin = 0; bin < N_BINS; bin++) {
      const frequency = (bin * WHISPER_SAMPLE_RATE) / 2 / (N_BINS - 1)
      const down = (frequency - edges[mel]) / (edges[mel + 1] - edges[mel])
      const up = (edges[mel + 2] - frequency) / (edges[mel + 2] - edges[mel + 1])
      filter[bin] = Math.max(0, Math.min(down, up)) * normalisation
    }
    return filter
  })
}

// Periodic Hann window, as used by Whisper's STFT.
const hannWindow = Float64Array.from(
  { length: N_FFT },
  (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / N_FFT)
)

// 400 = 2^4 * 5^2 isn't a power of two, so use a mixed-radix Cooley-Tukey transform.
const fftFactors = [2, 2, 2, 2, 5, 5]
const twiddleCos = Float64Array.from({ length: N_FFT }, (_, k) =>
  Math.cos((2 * Math.PI * k) / N_FFT)
)
const twiddleSin = Float64Array.from(
  { length: N_FFT },
  (_, k) => -Math.sin((2 * Math.PI * k) / N_FFT)
)

const fftRecursive = (
  inRe: Float64Array,
  inIm: Float64Array,
  inOffset: number,
  stride: number,
  outRe: Float64Array,
  outIm: Float64Array,
  outOffset: number,
  size: number,
  factorIndex: number
): void => {
  if (size === 1) {
    outRe[outOffset] = inRe[inOffset]
    outIm[outOffset] = inIm[inOffset]
    return
  }

  const radix = fftFactors[factorIndex]
  const sub = size / radix
  for (let r = 0; r < radix; r++) {
    fftRecursive(
      inRe,
      inIm,
      inOffset + r * stride,
      stride * radix,
      outRe,
      outIm,
      outOffset + r * sub,
      sub,
      factorIndex + 1
    )
  }

  const twiddleStep = N_FFT / size
  const tmpRe = new Float64Array(radix)
  const tmpIm = new Float64Array(radix)
  for (let k = 0; k < sub; k++) {
    for (let r = 0; r < radix; r++) {
      const index = outOffset + r * sub + k
      const t = (r * k * twiddleStep) % N_FFT
      tmpRe[r] = outRe[index] * twiddleCos[t] - outIm[index] * twiddleSin[t]
      tmpIm[r] = outRe[index] * twiddleSin[t] + outIm[index] * twiddleCos[t]
    }
    for (let q = 0; q < radix; q++) {
      let sumRe = 0
      let sumIm = 0
      for (let r = 0; r < radix; r++) {
        const t = (((r * q * sub * twiddleStep) % N_FFT) + N_FFT) % N_FFT
        sumRe += tmpRe[r] * twiddleCos[t] - tmpIm[r] * twiddleSin[t]
        sumIm += tmpRe[r] * twiddleSin[t] + tmpIm[r] * twiddleCos[t]
      }
      outRe[outOffset + q * sub + k] = sumRe
      outIm[outOffset + q * sub + k] = sumIm
    }
  }
}

const melFilters = buildMelFilters()

// Returns Whisper encoder input of shape [1, 80, 3000], row-major. Audio longer than 30 s is
// truncated; shorter audio is zero-padded. Only frames that overlap real audio are computed -
// the all-zero padding frames have a known constant value.
export const computeWhisperFeatures = (audio: Float32Array): Float32Array => {
  const length = Math.min(audio.length, WHISPER_MAX_SAMPLES)
  const half = N_FFT / 2
  const activeFrames = Math.min(WHISPER_N_FRAMES, Math.floor((length + half - 1) / HOP_LENGTH) + 1)

  // Reflect-padded signal for the active region (frames are centred, so pad by half a window).
  const padded = new Float64Array(length + 2 * half)
  for (let i = 0; i < length; i++) padded[half + i] = audio[i]
  for (let i = 1; i <= half; i++) {
    padded[half - i] = audio[Math.min(i, length - 1)]
    // Beyond the real audio the 30 s buffer is zero padding, so only reflect at the start.
  }

  const logMel = new Float64Array(N_MELS * activeFrames)
  const frameRe = new Float64Array(N_FFT)
  const frameIm = new Float64Array(N_FFT)
  const outRe = new Float64Array(N_FFT)
  const outIm = new Float64Array(N_FFT)
  const power = new Float64Array(N_BINS)
  let maximum = -Infinity

  for (let frame = 0; frame < activeFrames; frame++) {
    const start = frame * HOP_LENGTH
    for (let i = 0; i < N_FFT; i++) {
      frameRe[i] = (padded[start + i] ?? 0) * hannWindow[i]
      frameIm[i] = 0
    }
    fftRecursive(frameRe, frameIm, 0, 1, outRe, outIm, 0, N_FFT, 0)
    for (let bin = 0; bin < N_BINS; bin++) {
      power[bin] = outRe[bin] * outRe[bin] + outIm[bin] * outIm[bin]
    }
    for (let mel = 0; mel < N_MELS; mel++) {
      const filter = melFilters[mel]
      let sum = 0
      for (let bin = 0; bin < N_BINS; bin++) sum += filter[bin] * power[bin]
      const value = Math.log10(Math.max(1e-10, sum))
      logMel[mel * activeFrames + frame] = value
      if (value > maximum) maximum = value
    }
  }

  const floor = Math.max(-10, maximum - 8)
  const features = new Float32Array(N_MELS * WHISPER_N_FRAMES)
  const padValue = (floor + 4) / 4
  for (let mel = 0; mel < N_MELS; mel++) {
    const row = mel * WHISPER_N_FRAMES
    for (let frame = 0; frame < activeFrames; frame++) {
      features[row + frame] = (Math.max(logMel[mel * activeFrames + frame], floor) + 4) / 4
    }
    features.fill(padValue, row + activeFrames, row + WHISPER_N_FRAMES)
  }
  return features
}
