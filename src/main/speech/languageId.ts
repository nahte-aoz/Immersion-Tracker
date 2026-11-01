import * as ort from 'onnxruntime-node'
import { computeWhisperFeatures } from './whisperFeatures'

export interface LanguageGuess {
  language: string
  confidence: number
}

// Whisper's language tokens, in vocabulary order starting at <|en|> (id 50259).
// prettier-ignore
const WHISPER_LANGUAGES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it',
  'id', 'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur',
  'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn',
  'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si',
  'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha',
  'ba', 'jw', 'su'
]
const START_OF_TRANSCRIPT = 50258n
const FIRST_LANGUAGE_TOKEN = 50259

// Spoken-language ID with Whisper: run the encoder, then a single decoder step and read the
// language-token logits. No transcription is generated, which is much cheaper than decoding text.
export class WhisperLanguageId {
  private constructor(
    private readonly encoder: ort.InferenceSession,
    private readonly decoder: ort.InferenceSession
  ) {}

  static async create(modelDir: string, threads: number): Promise<WhisperLanguageId> {
    const options = { intraOpNumThreads: threads, interOpNumThreads: 1 }
    const [encoder, decoder] = await Promise.all([
      ort.InferenceSession.create(`${modelDir}/encoder_model_quantized.onnx`, options),
      ort.InferenceSession.create(`${modelDir}/decoder_model_quantized.onnx`, options)
    ])
    return new WhisperLanguageId(encoder, decoder)
  }

  async identify(audio: Float32Array): Promise<LanguageGuess> {
    const encoded = await this.encoder.run({
      input_features: new ort.Tensor('float32', computeWhisperFeatures(audio), [1, 80, 3000])
    })
    const decoded = await this.decoder.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from([START_OF_TRANSCRIPT]), [1, 1]),
      encoder_hidden_states: encoded.last_hidden_state
    })

    const logits = decoded.logits.data as Float32Array
    const languageLogits = logits.subarray(
      FIRST_LANGUAGE_TOKEN,
      FIRST_LANGUAGE_TOKEN + WHISPER_LANGUAGES.length
    )
    let best = 0
    for (let i = 1; i < languageLogits.length; i++) {
      if (languageLogits[i] > languageLogits[best]) best = i
    }
    let total = 0
    for (const logit of languageLogits) total += Math.exp(logit - languageLogits[best])
    return { language: WHISPER_LANGUAGES[best], confidence: 1 / total }
  }
}
