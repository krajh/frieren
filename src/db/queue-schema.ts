import { Database } from "./database.js";

export const QUEUE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reaper_realm_queue (
    task_id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    project_id TEXT,
    coordinator_origin TEXT NOT NULL DEFAULT 'rias',
    target_vessel TEXT NOT NULL DEFAULT 'shade',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','manifesting','completed','failed','dead','cancelled')),
    priority INTEGER NOT NULL DEFAULT 5,
    payload TEXT NOT NULL,
    result TEXT,
    error TEXT,
    heartbeat_at TEXT,
    timeout_seconds INTEGER NOT NULL DEFAULT 600,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS idx_srq_status_priority
    ON reaper_realm_queue(status, priority);`,
  `CREATE INDEX IF NOT EXISTS idx_srq_heartbeat
    ON reaper_realm_queue(heartbeat_at)
    WHERE status = 'manifesting';`,
  `CREATE INDEX IF NOT EXISTS idx_srq_idempotency
    ON reaper_realm_queue(idempotency_key)
    WHERE idempotency_key IS NOT NULL;`,
];

export const applyQueueMigrations = (db: Database): void => {
  for (const stmt of QUEUE_SCHEMA) {
    db.exec(stmt);
  }

  // Garbage collection: purge completed/dead/cancelled tasks older than 7 days
  db.exec(
    `DELETE FROM reaper_realm_queue
     WHERE status IN ('completed','dead','cancelled')
     AND updated_at < datetime('now', '-7 days')`,
  );
};
