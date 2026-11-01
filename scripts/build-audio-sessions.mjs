// Compiles the small audio-session lister (native/audio-sessions/AudioSessions.cs) with the
// .NET Framework C# compiler that ships with every Windows install, so no SDK is needed.
// Output: resources/audio-sessions/audio-sessions.exe (bundled by electron-builder).
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

const output = join(projectRoot, 'resources', 'audio-sessions', 'audio-sessions.exe')
mkdirSync(dirname(output), { recursive: true })
const result = spawnSync(
  compiler,
  [
    '-nologo',
    '-target:exe',
    '-platform:x64',
    '-optimize+',
    `-out:${output}`,
    join(projectRoot, 'native', 'audio-sessions', 'AudioSessions.cs')
  ],
  { stdio: 'inherit' }
)
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`[build-audio-sessions] built ${output}`)
