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
  // Knowledge Graph: entity nodes
  `CREATE TABLE IF NOT EXISTS kg_entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    attributes TEXT,
    project_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(name);`,
  `CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(type);`,
  // Knowledge Graph: temporal triples (subject, predicate, object, validity window)
  `CREATE TABLE IF NOT EXISTS kg_triples (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL REFERENCES kg_entities(id),
    predicate TEXT NOT NULL,
    object_id TEXT,
    object_value TEXT,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    confidence REAL DEFAULT 1.0,
    source TEXT,
    project_id TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_kg_triples_subject ON kg_triples(subject_id);`,
  `CREATE INDEX IF NOT EXISTS idx_kg_triples_predicate ON kg_triples(predicate);`,
  `CREATE INDEX IF NOT EXISTS idx_kg_triples_valid ON kg_triples(valid_from, valid_to);`,
];

const ALT_COLUMNS: Array<[string, string]> = [
  ["project_id", "TEXT"],
  ["status", "TEXT DEFAULT 'active'"],
  ["abstract", "TEXT"],
  ["summary", "TEXT"],
  // OpenCode taxonomy fields (optional, non-breaking)
  ["realm", "TEXT"],
  ["suite", "TEXT"],
  ["kind", "TEXT"],
  // Agent diary field
  ["agent_id", "TEXT"],
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
          embedding FLOAT[384]
        )`,
      );
    } catch {
      // vec0 unavailable or already exists — safe to continue
    }
  }
};
