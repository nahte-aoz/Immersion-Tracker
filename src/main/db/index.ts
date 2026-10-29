import Database from "better-sqlite3";
import { join } from 'path'
import { app } from "electron";
import { schemaSQL } from './schema'

const db = new Database(join(app.getPath('userData'), 'immersion-tracker.db'))
db.exec(schemaSQL)

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