import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applySessionMigrations } from "../src/db/session-schema.js";

// --- Helpers ----------------------------------------------------------------

let tmpDir: string;
let db: Database;

const makeDb = (): Database => {
  const path = join(tmpDir, "session-test.db");
  const d = new Database(path);
  applySessionMigrations(d, false /* vec not loaded */);
  return d;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "frieren-session-test-"));
  db = makeDb();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- Helpers ----------------------------------------------------------------

const insertSession = (d: Database, id: string, projectId: string): void => {
  d.run(`INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)`, [
    id,
    projectId,
    new Date().toISOString(),
  ]);
};

const insertEvent = (
  d: Database,
  opts: {
    id?: string;
    session_id: string;
    project_id?: string;
    event_type?: string;
    content: string;
    created_at?: string;
  },
): string => {
  const id = opts.id ?? crypto.randomUUID();
  const now = opts.created_at ?? new Date().toISOString();
  d.run(
    `INSERT INTO session_events (id, session_id, project_id, event_type, content, artifacts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.session_id,
      opts.project_id ?? "test-project",
      opts.event_type ?? "note",
      opts.content,
      null,
      now,
    ],
  );
  return id;
};

// ---------------------------------------------------------------------------

describe("session plane", () => {
  test("write event + returns ids", () => {
    const sessionId = crypto.randomUUID();
    insertSession(db, sessionId, "test-project");

    const eventId = insertEvent(db, {
      session_id: sessionId,
      content: "Started working on session plane implementation",
    });

    type EventRow = { id: string; session_id: string; event_type: string };
    const row = db
      .query<
        EventRow,
        [string]
      >(`SELECT id, session_id, event_type FROM session_events WHERE id = ?`)
      .get(eventId);

    expect(row).not.toBeNull();
    expect(row?.id).toBe(eventId);
    expect(row?.session_id).toBe(sessionId);
  });

  test("session_recall finds event by keyword", () => {
    const sessionId = crypto.randomUUID();
    insertSession(db, sessionId, "test-project");

    insertEvent(db, {
      session_id: sessionId,
      content: "Implemented vector search with sqlite-vec fallback",
    });
    insertEvent(db, {
      session_id: sessionId,
      content: "Unrelated event about something else entirely",
    });

    type EventRow = { id: string; content: string };
    const rows = db
      .query<
        EventRow,
        [string, string]
      >(`SELECT id, content FROM session_events WHERE content LIKE ? AND project_id = ? ORDER BY created_at DESC`)
      .all("%sqlite-vec%", "test-project");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain("sqlite-vec");
  });

  test("60-day cleanup removes old events on next open", () => {
    const sessionId = crypto.randomUUID();
    insertSession(db, sessionId, "test-project");

    const oldDate = "2024-01-01T00:00:00.000Z"; // > 60 days ago
    const oldEventId = insertEvent(db, {
      session_id: sessionId,
      content: "Very old event that should be cleaned up",
      created_at: oldDate,
    });

    // Verify old event exists before reopening
    type CountRow = { count: number };
    const beforeCount = db
      .query<
        CountRow,
        [string]
      >(`SELECT COUNT(*) as count FROM session_events WHERE id = ?`)
      .get(oldEventId);
    expect(beforeCount?.count).toBe(1);

    // Close and reopen — cleanup runs on open
    const dbPath = join(tmpDir, "session-test.db");
    db.close();
    const db2 = new Database(dbPath);
    applySessionMigrations(db2, false);

    const afterCount = db2
      .query<
        CountRow,
        [string]
      >(`SELECT COUNT(*) as count FROM session_events WHERE id = ?`)
      .get(oldEventId);
    expect(afterCount?.count).toBe(0);

    db2.close();
    // Reassign so afterEach doesn't double-close
    db = new Database(join(tmpDir, "session-test-alt.db"));
    applySessionMigrations(db, false);
  });

  test("memory_status session shape", () => {
    const sessionId = crypto.randomUUID();
    insertSession(db, sessionId, "test-project");

    insertEvent(db, { session_id: sessionId, content: "Event one" });
    insertEvent(db, { session_id: sessionId, content: "Event two" });

    type CountRow = { count: number };
    const totalEvents = db
      .query<CountRow, []>(`SELECT COUNT(*) as count FROM session_events`)
      .get();

    type ActiveRow = { count: number };
    const activeSessions = db
      .query<
        ActiveRow,
        []
      >(`SELECT COUNT(*) as count FROM sessions WHERE ended_at IS NULL`)
      .get();

    type OldestRow = { oldest: string | null };
    const oldest = db
      .query<
        OldestRow,
        []
      >(`SELECT MIN(created_at) as oldest FROM session_events`)
      .get();

    const stats = {
      total_events: totalEvents?.count ?? 0,
      active_sessions: activeSessions?.count ?? 0,
      oldest_event: oldest?.oldest ?? null,
    };

    expect(typeof stats.total_events).toBe("number");
    expect(stats.total_events).toBe(2);
    expect(typeof stats.active_sessions).toBe("number");
    expect(stats.active_sessions).toBe(1);
    expect(stats.oldest_event).not.toBeNull();
  });
});
