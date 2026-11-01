// Downloads the pinned speech models (Silero VAD + Whisper-base language-ID weights) into
// resources/speech so electron-builder can bundle them. The app never downloads models at
// runtime. Runs automatically before `build:win`; safe to re-run (skips verified files).
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const whisperRevision = '64da57285918e20ea79ea5c88eed7197933abaa8'
const sileroTag = 'v6.2.3'

const files = [
  {
    name: 'whisper-base/encoder_model_quantized.onnx',
    url: `https://huggingface.co/Xenova/whisper-base/resolve/${whisperRevision}/onnx/encoder_model_quantized.onnx`,
    sha256: '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9'
  },
  {
    name: 'whisper-base/decoder_model_quantized.onnx',
    url: `https://huggingface.co/Xenova/whisper-base/resolve/${whisperRevision}/onnx/decoder_model_quantized.onnx`,
    sha256: '96fc8b98013e0f9461159a7b0d57922e170b15767db8afef1ea7880f1deef33b'
  },
  {
    name: 'silero_vad.onnx',
    url: `https://github.com/snakers4/silero-vad/raw/${sileroTag}/src/silero_vad/data/silero_vad.onnx`,
    sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3'
  }
]

const notice = `Speech models bundled with Immersion Tracker (used locally; no audio leaves the device)

- whisper-base/*.onnx: ONNX export of OpenAI Whisper base by Xenova (Apache-2.0).
  https://huggingface.co/Xenova/whisper-base  (OpenAI Whisper is MIT-licensed)
- silero_vad.onnx: Silero VAD by Silero Team (MIT). https://github.com/snakers4/silero-vad
`

const targetDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'speech')
const hashOf = (buffer) => createHash('sha256').update(buffer).digest('hex')

for (const file of files) {
  const path = join(targetDir, file.name)
  if (existsSync(path) && hashOf(await readFile(path)) === file.sha256) {
    console.log(`[fetch-speech-models] ${file.name} already present`)
    continue
  }

  console.log(`[fetch-speech-models] downloading ${file.name}`)
  const response = await fetch(file.url)
  if (!response.ok) throw new Error(`Download failed for ${file.name}: HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  const actual = hashOf(data)
  if (actual !== file.sha256) {
    throw new Error(`Checksum mismatch for ${file.name}: expected ${file.sha256}, got ${actual}`)
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.part`, data)
  await rename(`${path}.part`, path)
}

await writeFile(join(targetDir, 'NOTICE.txt'), notice)
console.log(`[fetch-speech-models] models ready in ${targetDir}`)
