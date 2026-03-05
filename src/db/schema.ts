export const WISDOM_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wisdom_entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence REAL NOT NULL,
    source_agent TEXT NOT NULL,
    evidence TEXT,
    tags TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS edges (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL,
    strength REAL NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES nodes(id),
    FOREIGN KEY (target_id) REFERENCES nodes(id)
  );`,
  `CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector BLOB NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_wisdom_entries_type ON wisdom_entries(type);`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);`,
  `CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);`,
  `CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_id);`,
];

export const SESSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    artifacts TEXT,
    agent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);`,
  `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);`,
];

export const INDEX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS index_state (
    project_id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    last_commit TEXT,
    indexed_at TEXT NOT NULL,
    status TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    symbol_name TEXT,
    content TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    language TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS file_deps (
    source_file TEXT NOT NULL,
    target_file TEXT NOT NULL,
    dep_type TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);`,
  `CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(symbol_name);`,
  `CREATE INDEX IF NOT EXISTS idx_file_deps_source ON file_deps(source_file);`,
  `CREATE INDEX IF NOT EXISTS idx_file_deps_target ON file_deps(target_file);`,
];
