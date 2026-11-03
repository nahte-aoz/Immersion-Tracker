// Downloads the pinned OwOCR Windows release into resources/owocr so electron-builder can
// bundle it. Run automatically before `build:win`; safe to re-run (skips when up to date).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const version = '1.26.8'
const sha256 = 'b095ae2ffbda9392300407decfbfb7d47ed0fa6502c91902ec419978b55df628'
const url = `https://github.com/AuroraWright/owocr/releases/download/${version}/owocr-windows.zip`

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = join(projectRoot, 'resources', 'owocr')
const versionFile = join(targetDir, '.owocr-version')

const hashFile = async (path) => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

if (existsSync(versionFile) && (await readFile(versionFile, 'utf8')).trim() === version) {
  console.log(`[fetch-owocr] OwOCR ${version} already present`)
  process.exit(0)
}

const workDir = await mkdtemp(join(tmpdir(), 'owocr-'))
try {
  const zipPath = join(workDir, 'owocr-windows.zip')
  console.log(`[fetch-owocr] downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath))

  const actual = await hashFile(zipPath)
  if (actual !== sha256) throw new Error(`Checksum mismatch: expected ${sha256}, got ${actual}`)

  const extractDir = join(workDir, 'extracted')
  await mkdir(extractDir)
  console.log('[fetch-owocr] extracting')
  // Windows' bundled bsdtar reads zip archives; a GNU tar earlier on PATH (e.g. Git Bash) doesn't.
  const tar = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
  const extraction = spawnSync(tar, ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' })
  if (extraction.status !== 0) throw new Error('Extraction failed')

  // The archive may wrap everything in a single top-level folder.
  let root = extractDir
  const entries = await readdir(extractDir)
  if (!existsSync(join(root, 'owocr.exe')) && entries.length === 1) root = join(root, entries[0])
  if (!existsSync(join(root, 'owocr.exe'))) throw new Error('owocr.exe not found in the archive')

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(dirname(targetDir), { recursive: true })
  // Copy rather than rename: the temp folder can be on a different drive (e.g. on CI runners).
  await cp(root, targetDir, { recursive: true })
  // OwOCR is GPL-3.0; the release zip doesn't include the license text, so ship it alongside.
  const licenseResponse = await fetch(
    `https://raw.githubusercontent.com/AuroraWright/owocr/${version}/LICENSE`
  )
  if (!licenseResponse.ok)
    throw new Error(`License download failed: HTTP ${licenseResponse.status}`)
  await writeFile(join(targetDir, 'LICENSE.txt'), await licenseResponse.text())
  await writeFile(versionFile, `${version}\n`)
  console.log(`[fetch-owocr] installed OwOCR ${version} to ${targetDir}`)
} finally {
  await rm(workDir, { recursive: true, force: true })
}
