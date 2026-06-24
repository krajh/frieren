import { Database } from "./database.js";

export const SESSION_V3_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    summary TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    project_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    artifacts TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_created_at ON session_events(created_at);`,
];

export const applySessionMigrations = (
  db: Database,
  vecLoaded: boolean,
): void => {
  for (const stmt of SESSION_V3_SCHEMA) {
    db.exec(stmt);
  }

  for (const [col, def] of [
    ["abstract", "TEXT"],
    ["summary", "TEXT"],
  ] as const) {
    try {
      db.exec(`ALTER TABLE session_events ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists — safe to continue
    }
  }

  // 60-day rolling retention cleanup
  db.exec(
    `DELETE FROM session_events WHERE created_at < datetime('now', '-60 days')`,
  );

  if (vecLoaded) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS session_vec USING vec0(
          event_id TEXT PRIMARY KEY,
          embedding FLOAT[384]
        )`,
      );
    } catch {
      // vec0 unavailable or already exists — safe to continue
    }
  }
};
