// Compiles the small Windows helpers (native/*/*.cs: audio-session lister, window z-order) with the
// .NET Framework C# compiler that ships with every Windows install, so no SDK is needed.
// Output: resources/audio-sessions/*.exe (bundled by electron-builder).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('[build-audio-sessions] skipped: per-application audio is Windows-only')
  process.exit(0)
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const compiler = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'Microsoft.NET',
  'Framework64',
  'v4.0.30319',
  'csc.exe'
)
if (!existsSync(compiler)) {
  console.error(`[build-audio-sessions] C# compiler not found at ${compiler}`)
  process.exit(1)
}

const helpers = [
  ['audio-sessions', 'AudioSessions.cs'],
  ['window-order', 'WindowOrder.cs']
]
const outputDir = join(projectRoot, 'resources', 'audio-sessions')
mkdirSync(outputDir, { recursive: true })

for (const [name, source] of helpers) {
  const output = join(outputDir, `${name}.exe`)
  const result = spawnSync(
    compiler,
    [
      '-nologo',
      '-target:exe',
      '-platform:x64',
      '-optimize+',
      `-out:${output}`,
      join(projectRoot, 'native', name, source)
    ],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
  console.log(`[build-audio-sessions] built ${output}`)
}
