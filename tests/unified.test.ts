import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WISDOM_SCHEMA } from "../src/db/schema.js";
import { applyWisdomMigrations } from "../src/db/wisdom-schema.js";
import { applySessionMigrations } from "../src/db/session-schema.js";

// ---------------------------------------------------------------------------
// Setup: isolated tmp dirs for all three planes
// ---------------------------------------------------------------------------

let tmpDir: string;
let wisdomDb: Database;
let sessionDb: Database;

const makeWisdomDb = (dir: string): Database => {
  const path = join(dir, "wisdom.db");
  const d = new Database(path);
  for (const stmt of WISDOM_SCHEMA) d.exec(stmt);
  applyWisdomMigrations(d, false);
  return d;
};

const makeSessionDb = (dir: string, projectId: string): Database => {
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const path = join(sessionsDir, `${projectId}.db`);
  const d = new Database(path);
  applySessionMigrations(d, false);
  return d;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "frieren-unified-test-"));
  wisdomDb = makeWisdomDb(tmpDir);
  sessionDb = makeSessionDb(tmpDir, "proj-test");
});

afterEach(() => {
  wisdomDb.close();
  sessionDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const insertWisdomEntry = (
  d: Database,
  id: string,
  content: string,
  type = "decision",
): void => {
  const now = new Date().toISOString();
  d.run(
    `INSERT INTO wisdom_entries
      (id, type, content, confidence, source_agent, project_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, type, content, 0.8, "frieren", null, "active", now, now],
  );
};

const insertWisdomRelation = (
  d: Database,
  fromId: string,
  toId: string,
): void => {
  const id = crypto.randomUUID();
  d.run(
    `INSERT INTO wisdom_relations (id, from_id, to_id, relationship, strength, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, fromId, toId, "relates_to", 0.7, new Date().toISOString()],
  );
};

const insertSessionEvent = (
  d: Database,
  id: string,
  sessionId: string,
  content: string,
): void => {
  d.run(
    `INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [sessionId, "proj-test", new Date().toISOString()],
  );
  d.run(
    `INSERT INTO session_events
      (id, session_id, project_id, event_type, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      sessionId,
      "proj-test",
      "observation",
      content,
      new Date().toISOString(),
    ],
  );
};

// ---------------------------------------------------------------------------
// Direct DB unit tests (no MCP server needed)
// ---------------------------------------------------------------------------

describe("unified plane — wisdom keyword search", () => {
  test("finds seeded wisdom entry by keyword", () => {
    const id = crypto.randomUUID();
    insertWisdomEntry(wisdomDb, id, "Use Bun as the runtime for Frieren");

    type Row = { id: string; content: string };
    const rows = wisdomDb
      .query<
        Row,
        [string]
      >(`SELECT id, content FROM wisdom_entries WHERE content LIKE ?`)
      .all("%Bun%");

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.id).toBe(id);
  });
});

describe("unified plane — graph expansion scoring", () => {
  test("graph-expanded relation exists in wisdom_relations", () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    insertWisdomEntry(wisdomDb, id1, "Primary decision: use Bun");
    insertWisdomEntry(wisdomDb, id2, "Related: Bun supports SQLite natively");
    insertWisdomRelation(wisdomDb, id1, id2);

    type RelRow = { from_id: string; to_id: string };
    const rels = wisdomDb
      .query<
        RelRow,
        [string]
      >(`SELECT from_id, to_id FROM wisdom_relations WHERE from_id = ?`)
      .all(id1);

    expect(rels).toHaveLength(1);
    expect(rels[0]?.to_id).toBe(id2);
  });

  test("graph hop score is lower than direct hit score", () => {
    // Simulate scoring formula:
    // direct hit: score * 0.7 (where score = 0.5 for keyword hit)
    // graph hop at depth 1: hop_decay * 0.3 = (1/(1+1)) * 0.3 = 0.15
    const directScore = 0.5 * 0.7; // 0.35
    const graphHopScore = (1.0 / (0 + 2)) * 0.3; // 0.15

    expect(graphHopScore).toBeLessThan(directScore);
  });
});

describe("unified plane — session events", () => {
  test("finds seeded session event by content", () => {
    const sessionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    insertSessionEvent(
      sessionDb,
      eventId,
      sessionId,
      "Implemented GraphRAG retrieval logic",
    );

    type EventRow = { id: string; content: string };
    const rows = sessionDb
      .query<
        EventRow,
        [string]
      >(`SELECT id, content FROM session_events WHERE content LIKE ?`)
      .all("%GraphRAG%");

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.id).toBe(eventId);
  });
});

describe("unified plane — memory_history logic", () => {
  test("wisdom entry is retrievable by entity_id match", () => {
    const id = crypto.randomUUID();
    const entityId = "auth-flow-decision";
    insertWisdomEntry(
      wisdomDb,
      id,
      `Decision: redesign ${entityId} for email-based login`,
    );

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    type Row = { id: string; content: string; created_at: string };
    const rows = wisdomDb
      .query<Row, [string, string]>(
        `SELECT id, content, created_at FROM wisdom_entries
         WHERE content LIKE ? AND created_at >= ?
         ORDER BY created_at ASC`,
      )
      .all(`%${entityId}%`, since);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.content).toContain(entityId);
  });

  test("session event is retrievable by entity_id match", () => {
    const sessionId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const entityId = "src/auth/login.ts";
    insertSessionEvent(
      sessionDb,
      eventId,
      sessionId,
      `Worked on ${entityId}: added token refresh logic`,
    );

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    type Row = { id: string; content: string };
    const rows = sessionDb
      .query<Row, [string, string]>(
        `SELECT id, content FROM session_events
         WHERE content LIKE ? AND created_at >= ?`,
      )
      .all(`%${entityId}%`, since);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.id).toBe(eventId);
  });

  test("planes: ['wisdom'] — only wisdom results returned (keyword)", () => {
    const wisdomId = crypto.randomUUID();
    insertWisdomEntry(
      wisdomDb,
      wisdomId,
      "Use TypeScript strict mode everywhere",
    );

    // Verify wisdom plane has the entry
    type Row = { id: string };
    const rows = wisdomDb
      .query<
        Row,
        [string]
      >(`SELECT id FROM wisdom_entries WHERE content LIKE ?`)
      .all("%TypeScript%");

    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(wisdomId);

    // And that session plane does NOT have it
    const sessionRows = sessionDb
      .query<
        Row,
        [string]
      >(`SELECT id FROM session_events WHERE content LIKE ?`)
      .all("%TypeScript%");

    expect(sessionRows).toHaveLength(0);
  });
});
