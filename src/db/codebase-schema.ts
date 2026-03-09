import { Database } from "bun:sqlite";

export const CODEBASE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS code_chunks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    name TEXT,
    content TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    language TEXT,
    indexed_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS code_deps (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    from_file TEXT NOT NULL,
    to_file TEXT NOT NULL,
    dep_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS index_meta (
    project_id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    last_commit TEXT,
    indexed_at TEXT NOT NULL,
    file_count INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0
  );`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_project ON code_chunks(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(project_id, file_path);`,
  `CREATE INDEX IF NOT EXISTS idx_deps_from ON code_deps(project_id, from_file);`,
  `CREATE INDEX IF NOT EXISTS idx_deps_to ON code_deps(project_id, to_file);`,
];

export const applyCodebaseMigrations = (
  db: Database,
  vecLoaded: boolean,
): void => {
  for (const stmt of CODEBASE_SCHEMA) {
    db.exec(stmt);
  }

  if (vecLoaded) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS code_vec USING vec0(
          chunk_id TEXT PRIMARY KEY,
          embedding float[512]
        );`,
      );
    } catch {
      // vec0 table creation failure is non-fatal
    }
  }
};
