import Database from "better-sqlite3";
import { join } from 'path'
import { app } from "electron";
import { schemaSQL } from './schema'
import { OCR_LANGUAGE_OPTIONS, type OcrLanguageCode } from '../../preload/types'

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

	const dailyRows = db
		.prepare(
			`SELECT
				date(stopped_at, 'localtime') AS date,
				SUM(timer) AS seconds,
				COUNT(*) AS sessions
			FROM sessions
			WHERE stopped_at IS NOT NULL
				AND date(stopped_at, 'localtime') >= date('now', 'localtime', '-364 days')
			GROUP BY date(stopped_at, 'localtime')`
		)
		.all() as Array<{ date: string; seconds: number; sessions: number }>

	const dailyByDate = new Map(dailyRows.map((row) => [row.date, row]))
	const today = new Date()
	today.setHours(0, 0, 0, 0)
	const calendar = Array.from({ length: 365 }, (_, index) => {
		const date = new Date(today)
		date.setDate(today.getDate() - (364 - index))
		const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
		return dailyByDate.get(dateKey) ?? { date: dateKey, seconds: 0, sessions: 0 }
	})
	const daily = calendar.slice(-7)

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