import { Database } from "bun:sqlite";

export const RETRIEVAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS retrieval_logs (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    planes_searched TEXT NOT NULL,
    results_count INTEGER NOT NULL,
    graph_expansions INTEGER NOT NULL,
    trajectory TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE INDEX IF NOT EXISTS idx_retrieval_logs_created_at
    ON retrieval_logs(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_retrieval_logs_query
    ON retrieval_logs(query);`,
];

export const applyRetrievalMigrations = (db: Database): void => {
  for (const stmt of RETRIEVAL_SCHEMA) {
    db.exec(stmt);
  }
};
