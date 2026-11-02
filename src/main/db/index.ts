import Database from 'better-sqlite3'
import { join } from 'path'
import { app } from 'electron'
import { schemaSQL } from './schema'
import {
  OCR_LANGUAGE_OPTIONS,
  ALL_PROFILE,
  UNKNOWN_LANGUAGE,
  type AudioApp,
  type GeneralSettings,
  type AudioSettings,
  type OcrLanguageCode,
  type ScreenArea,
  type ScreenOcrSettings
} from '../../preload/types'

const db = new Database(join(app.getPath('userData'), 'immersion-tracker.db'))
db.exec(schemaSQL)
// Sessions recorded before languages were tracked count as unspecified time.
db.exec(
  `INSERT INTO session_languages (session_id, language, seconds)
   SELECT id, 'unknown', timer FROM sessions
   WHERE id NOT IN (SELECT session_id FROM session_languages)`
)
db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(
  'ocr_languages',
  JSON.stringify(['eng', 'jpn'])
)

const supportedOcrLanguages = new Set<string>(OCR_LANGUAGE_OPTIONS.map(({ code }) => code))

export const getOcrLanguages = (): OcrLanguageCode[] => {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('ocr_languages') as
    { value: string } | undefined
  if (!row) return ['eng', 'jpn']

  try {
    const savedLanguages = JSON.parse(row.value) as string[]
    const selectedLanguages = savedLanguages.filter((language) =>
      supportedOcrLanguages.has(language)
    )
    return selectedLanguages.length ? (selectedLanguages as OcrLanguageCode[]) : ['eng', 'jpn']
  } catch {
    return ['eng', 'jpn']
  }
}

export const setOcrLanguages = (languages: string[]): OcrLanguageCode[] => {
  const selectedLanguages = [...new Set(languages)].filter((language) =>
    supportedOcrLanguages.has(language)
  )
  if (selectedLanguages.length === 0) {
    throw new Error('Select at least one OCR language.')
  }

  db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(
    JSON.stringify(selectedLanguages),
    'ocr_languages'
  )
  return selectedLanguages as OcrLanguageCode[]
}

export const getSupportedOcrLanguages = (): typeof OCR_LANGUAGE_OPTIONS => OCR_LANGUAGE_OPTIONS

// The language profile in use: 'all' (every language selected in Settings) or one of them.
export const getActiveProfile = (): string => {
  const saved = readSetting('active_profile')
  return saved && getOcrLanguages().includes(saved as OcrLanguageCode) ? saved : ALL_PROFILE
}

export const setActiveProfile = (profile: string): string => {
  const valid = profile === ALL_PROFILE || getOcrLanguages().includes(profile as OcrLanguageCode)
  writeSetting('active_profile', valid ? profile : ALL_PROFILE)
  return getActiveProfile()
}

const sessionColumns = db.pragma('table_info(sessions)') as Array<{ name: string }>
if (!sessionColumns.some((column) => column.name === 'stopped_at')) {
  db.exec('ALTER TABLE sessions ADD COLUMN stopped_at TEXT')
}

export interface TimerStatistics {
  totalSessions: number
  totalSeconds: number
  averageSeconds: number
  longestSeconds: number
  daily: Array<{ date: string; seconds: number; sessions: number }>
  calendar: Array<{ date: string; seconds: number; sessions: number }>
  recent: Array<{ id: number; seconds: number; stoppedAt: string | null }>
  hourly: number[]
  byLanguage: Array<{ language: string; seconds: number }>
}

// Records a finished session with its time split per language.
export const recordTimerSession = (
  seconds: number,
  languageSeconds: Record<string, number> = {}
): void => {
  const entries = Object.entries(languageSeconds).filter(([, value]) => value > 0)
  if (entries.length === 0) entries.push([UNKNOWN_LANGUAGE, seconds])

  db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO sessions (timer, stopped_at) VALUES (?, ?)')
      .run(seconds, new Date().toISOString())
    const insert = db.prepare(
      'INSERT INTO session_languages (session_id, language, seconds) VALUES (?, ?, ?)'
    )
    for (const [language, value] of entries) insert.run(lastInsertRowid, language, value)
  })()
}

export const deleteTimerSession = (id: number): void => {
  db.transaction(() => {
    db.prepare('DELETE FROM session_languages WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  })()
}

// Statistics for one language, or for all languages added up when `language` is 'all'.
export const getTimerStatistics = (language: string = ALL_PROFILE): TimerStatistics => {
  const all = language === ALL_PROFILE
  const filter = all ? '' : 'AND sl.language = @language'
  const params = all ? {} : { language }

  const summary = db
    .prepare(
      `SELECT
        COUNT(*) AS totalSessions,
        COALESCE(SUM(seconds), 0) AS totalSeconds,
        COALESCE(AVG(seconds), 0) AS averageSeconds,
        COALESCE(MAX(seconds), 0) AS longestSeconds
      FROM (
        SELECT SUM(sl.seconds) AS seconds
        FROM session_languages sl
        WHERE sl.seconds > 0 ${filter}
        GROUP BY sl.session_id
      )`
    )
    .get(params) as Pick<
    TimerStatistics,
    'totalSessions' | 'totalSeconds' | 'averageSeconds' | 'longestSeconds'
  >

  // Every day with a finished session, across all years, so the renderer can page through them.
  const calendar = db
    .prepare(
      `SELECT
        date(s.stopped_at, 'localtime') AS date,
        SUM(sl.seconds) AS seconds,
        COUNT(DISTINCT s.id) AS sessions
      FROM sessions s
      JOIN session_languages sl ON sl.session_id = s.id
      WHERE s.stopped_at IS NOT NULL AND sl.seconds > 0 ${filter}
      GROUP BY date(s.stopped_at, 'localtime')
      ORDER BY date`
    )
    .all(params) as Array<{ date: string; seconds: number; sessions: number }>

  const calendarByDate = new Map(calendar.map((row) => [row.date, row]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const daily = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today)
    date.setDate(today.getDate() - (6 - index))
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    return calendarByDate.get(dateKey) ?? { date: dateKey, seconds: 0, sessions: 0 }
  })

  const recent = db
    .prepare(
      `SELECT s.id AS id, SUM(sl.seconds) AS seconds, s.stopped_at AS stoppedAt
      FROM sessions s
      JOIN session_languages sl ON sl.session_id = s.id
      WHERE sl.seconds > 0 ${filter}
      GROUP BY s.id
      ORDER BY s.id DESC
      LIMIT 12`
    )
    .all(params) as TimerStatistics['recent']

  // Today's time per hour: each session is spread back from when it stopped.
  const todaySessions = db
    .prepare(
      `SELECT s.stopped_at AS stoppedAt, SUM(sl.seconds) AS seconds
      FROM sessions s
      JOIN session_languages sl ON sl.session_id = s.id
      WHERE s.stopped_at IS NOT NULL
        AND date(s.stopped_at, 'localtime') >= date('now', 'localtime', '-1 day')
        AND sl.seconds > 0 ${filter}
      GROUP BY s.id`
    )
    .all(params) as Array<{ stoppedAt: string; seconds: number }>
  const dayStart = today.getTime()
  const hourly = Array.from({ length: 24 }, () => 0)
  for (const session of todaySessions) {
    const end = new Date(session.stoppedAt).getTime()
    const start = end - session.seconds * 1000
    for (let hour = 0; hour < 24; hour++) {
      const hourStart = dayStart + hour * 3600000
      const overlap = Math.min(end, hourStart + 3600000) - Math.max(start, hourStart)
      if (overlap > 0) hourly[hour] += overlap / 1000
    }
  }

  const byLanguage = db
    .prepare(
      `SELECT language, SUM(seconds) AS seconds
      FROM session_languages
      GROUP BY language
      HAVING SUM(seconds) > 0
      ORDER BY seconds DESC`
    )
    .all() as TimerStatistics['byLanguage']

  return { ...summary, daily, calendar, recent, hourly, byLanguage }
}

const audioSettingsKeys = { alwaysListen: 'audio_always_listen', apps: 'audio_apps' }

const readSetting = (key: string): string | undefined =>
  (
    db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      { value: string } | undefined
  )?.value

const writeSetting = (key: string, value: string): void => {
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export const getAudioSettings = (): AudioSettings => {
  let apps: AudioApp[] = []
  try {
    const saved = JSON.parse(readSetting(audioSettingsKeys.apps) ?? '[]') as unknown
    if (Array.isArray(saved)) {
      apps = saved.filter(
        (app): app is AudioApp =>
          typeof app?.exe === 'string' && app.exe !== '' && typeof app?.name === 'string'
      )
    }
  } catch {
    apps = []
  }
  return { alwaysListen: readSetting(audioSettingsKeys.alwaysListen) === 'true', apps }
}

export const setAudioSettings = (changes: Partial<AudioSettings>): AudioSettings => {
  if (typeof changes.alwaysListen === 'boolean') {
    writeSetting(audioSettingsKeys.alwaysListen, String(changes.alwaysListen))
  }
  if (Array.isArray(changes.apps)) {
    const unique = new Map<string, AudioApp>()
    for (const app of changes.apps) {
      if (typeof app?.exe === 'string' && app.exe !== '') {
        unique.set(app.exe.toLowerCase(), { exe: app.exe, name: String(app.name ?? app.exe) })
      }
    }
    writeSetting(audioSettingsKeys.apps, JSON.stringify([...unique.values()]))
  }
  return getAudioSettings()
}

const screenSettingsKeys = { display: 'ocr_display', areas: 'ocr_areas' }

const toValidArea = (area: unknown): ScreenArea | null => {
  const { x, y, width, height } = (area ?? {}) as Partial<ScreenArea>
  if (
    ![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    return null
  }
  const left = Math.max(0, Math.min(1, x as number))
  const top = Math.max(0, Math.min(1, y as number))
  const areaWidth = Math.min(1 - left, width as number)
  const areaHeight = Math.min(1 - top, height as number)
  return areaWidth > 0 && areaHeight > 0
    ? { x: left, y: top, width: areaWidth, height: areaHeight }
    : null
}

export const getScreenOcrSettings = (): ScreenOcrSettings => {
  const savedDisplay = Number(readSetting(screenSettingsKeys.display))
  const areas: Record<string, ScreenArea[]> = {}
  try {
    const saved = JSON.parse(readSetting(screenSettingsKeys.areas) ?? '{}') as Record<
      string,
      unknown
    >
    for (const [displayId, list] of Object.entries(saved)) {
      if (Array.isArray(list)) {
        areas[displayId] = list.map(toValidArea).filter((area): area is ScreenArea => area !== null)
      }
    }
  } catch {
    // Fall back to no saved areas.
  }
  return {
    displayId:
      readSetting(screenSettingsKeys.display) && Number.isFinite(savedDisplay)
        ? savedDisplay
        : null,
    areas
  }
}

export const setScreenDisplay = (displayId: number | null): ScreenOcrSettings => {
  writeSetting(screenSettingsKeys.display, displayId === null ? '' : String(displayId))
  return getScreenOcrSettings()
}

export const setScreenAreas = (displayId: number, areas: ScreenArea[]): ScreenOcrSettings => {
  const settings = getScreenOcrSettings()
  settings.areas[String(displayId)] = (Array.isArray(areas) ? areas : [])
    .map(toValidArea)
    .filter((area): area is ScreenArea => area !== null)
  writeSetting(screenSettingsKeys.areas, JSON.stringify(settings.areas))
  return settings
}

export const getGeneralSettings = (): GeneralSettings => ({
  runOcrOnStart: readSetting('run_ocr_on_start') === 'true',
  minimizeToTray: readSetting('minimize_to_tray') === 'true'
})

export const setGeneralSettings = (changes: Partial<GeneralSettings>): GeneralSettings => {
  if (typeof changes.runOcrOnStart === 'boolean') {
    writeSetting('run_ocr_on_start', String(changes.runOcrOnStart))
  }
  if (typeof changes.minimizeToTray === 'boolean') {
    writeSetting('minimize_to_tray', String(changes.minimizeToTray))
  }
  return getGeneralSettings()
}
