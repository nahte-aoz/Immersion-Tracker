import Database from "better-sqlite3";
import { join } from 'path'
import { app } from "electron";
import { schemaSQL } from './schema'

const db = new Database(join(app.getPath('userData'), 'immersion-tracker.db'))
db.exec(schemaSQL)

export const recordTimerSession = (seconds: number): void => {
	db.prepare('INSERT INTO sessions (timer) VALUES (?)').run(seconds)
}