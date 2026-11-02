export const schemaSQL = `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timer INTEGER NOT NULL,
    stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS session_languages (
    session_id INTEGER NOT NULL,
    language TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    PRIMARY KEY (session_id, language)
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)`
