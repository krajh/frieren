import { Database } from "bun:sqlite";

export const WISDOM_V2_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS wisdom_relations (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES wisdom_entries(id),
    to_id TEXT NOT NULL REFERENCES wisdom_entries(id),
    relationship TEXT NOT NULL,
    strength REAL DEFAULT 0.5,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_wisdom_relations_from ON wisdom_relations(from_id);`,
  `CREATE INDEX IF NOT EXISTS idx_wisdom_relations_to ON wisdom_relations(to_id);`,
];

const ALT_COLUMNS: Array<[string, string]> = [
  ["project_id", "TEXT"],
  ["status", "TEXT DEFAULT 'active'"],
];

export const applyWisdomMigrations = (
  db: Database,
  vecLoaded: boolean,
): void => {
  for (const [col, def] of ALT_COLUMNS) {
    try {
      db.exec(`ALTER TABLE wisdom_entries ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists — safe to continue
    }
  }

  for (const statement of WISDOM_V2_MIGRATIONS) {
    db.exec(statement);
  }

  if (vecLoaded) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS wisdom_vec USING vec0(
          entry_id TEXT PRIMARY KEY,
          embedding FLOAT[512]
        )`,
      );
    } catch {
      // vec0 unavailable or already exists — safe to continue
    }
  }
};
