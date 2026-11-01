import Database from "better-sqlite3";
import { join } from 'path'
import { app } from "electron";
import { schemaSQL } from './schema'
import {
	OCR_LANGUAGE_OPTIONS,
	type AudioApp,
	type AudioSettings,
	type OcrLanguageCode
} from '../../preload/types'

const db = new Database(join(app.getPath('userData'), 'immersion-tracker.db'))
db.exec(schemaSQL)
db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(
	'ocr_languages',
	JSON.stringify(['eng', 'jpn'])
)

const supportedOcrLanguages = new Set<string>(OCR_LANGUAGE_OPTIONS.map(({ code }) => code))

export const getOcrLanguages = (): OcrLanguageCode[] => {
	const row = db
		.prepare('SELECT value FROM app_settings WHERE key = ?')
		.get('ocr_languages') as { value: string } | undefined
	if (!row) return ['eng', 'jpn']

	try {
		const savedLanguages = JSON.parse(row.value) as string[]
		const selectedLanguages = savedLanguages.filter((language) => supportedOcrLanguages.has(language))
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

export const getSupportedOcrLanguages = () => OCR_LANGUAGE_OPTIONS

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
}

export const recordTimerSession = (seconds: number): void => {
	db.prepare('INSERT INTO sessions (timer, stopped_at) VALUES (?, ?)').run(seconds, new Date().toISOString())
}

export const getTimerStatistics = (): TimerStatistics => {
	const summary = db
		.prepare(
			`SELECT
				COUNT(*) AS totalSessions,
				COALESCE(SUM(timer), 0) AS totalSeconds,
				COALESCE(AVG(timer), 0) AS averageSeconds,
				COALESCE(MAX(timer), 0) AS longestSeconds
			FROM sessions`
		)
		.get() as Omit<TimerStatistics, 'daily' | 'recent'>

	// Every day with a finished session, across all years, so the renderer can page through them.
	const calendar = db
		.prepare(
			`SELECT
				date(stopped_at, 'localtime') AS date,
				SUM(timer) AS seconds,
				COUNT(*) AS sessions
			FROM sessions
			WHERE stopped_at IS NOT NULL
			GROUP BY date(stopped_at, 'localtime')
			ORDER BY date`
		)
		.all() as Array<{ date: string; seconds: number; sessions: number }>

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
			`SELECT id, timer AS seconds, stopped_at AS stoppedAt
			FROM sessions
			ORDER BY id DESC
			LIMIT 12`
		)
		.all() as TimerStatistics['recent']

	return { ...summary, daily, calendar, recent }
}

const audioSettingsKeys = { alwaysListen: 'audio_always_listen', apps: 'audio_apps' }

const readSetting = (key: string): string | undefined =>
	(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value

const writeSetting = (key: string, value: string): void => {
	db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
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
