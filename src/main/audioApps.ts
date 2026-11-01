import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { AudioAppInfo } from '../preload/types'

export interface AudioSession {
  pid: number
  exe: string
  name: string
  playing: boolean
}

// WASAPI process loopback (capturing a single application) needs Windows 10 version 2004.
const minimumWindowsBuild = 19041

export const isPerAppCaptureSupported = (): boolean => {
  if (process.platform !== 'win32') return false
  const build = Number(release().split('.')[2])
  return Number.isFinite(build) && build >= minimumWindowsBuild
}

const findHelper = (): string | undefined =>
  [
    join(process.resourcesPath, 'audio-sessions', 'audio-sessions.exe'),
    join(app.getAppPath(), 'resources', 'audio-sessions', 'audio-sessions.exe')
  ].find((candidate) => existsSync(candidate))

// Applications that currently have an audio session on any playback device. Read-only: the
// helper only enumerates sessions, it never opens an audio stream.
export const listAudioSessions = (): Promise<AudioSession[]> =>
  new Promise((resolve, reject) => {
    const helper = findHelper()
    if (!helper) {
      reject(
        new Error('The audio application helper was not found. Run "npm run build:audio-sessions".')
      )
      return
    }

    execFile(helper, { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(new Error('Unable to read which applications are playing audio.'))
        return
      }
      try {
        resolve(JSON.parse(stdout) as AudioSession[])
      } catch {
        reject(new Error('Unable to read which applications are playing audio.'))
      }
    })
  })

// One entry per executable (browsers and chat apps hold several sessions), playing if any is.
export const groupAudioSessions = (sessions: AudioSession[]): AudioAppInfo[] => {
  // This app's own (muted) capture session isn't something to listen to.
  const ownExe = basename(process.execPath).toLowerCase()
  const byExe = new Map<string, AudioAppInfo>()
  for (const session of sessions) {
    const key = session.exe.toLowerCase()
    if (key === ownExe) continue
    const existing = byExe.get(key)
    byExe.set(key, {
      exe: session.exe,
      name: existing?.name ?? session.name,
      playing: Boolean(existing?.playing) || session.playing
    })
  }
  return [...byExe.values()]
}
