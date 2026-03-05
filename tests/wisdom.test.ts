import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WISDOM_SCHEMA } from "../src/db/schema.js";
import { applyWisdomMigrations } from "../src/db/wisdom-schema.js";

// --- Helpers ----------------------------------------------------------------

let tmpDir: string;
let db: Database;

const makeDb = (): Database => {
  const path = join(tmpDir, "wisdom-test.db");
  const d = new Database(path);
  for (const stmt of WISDOM_SCHEMA) {
    d.exec(stmt);
  }
  applyWisdomMigrations(d, false /* vec not loaded */);
  return d;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "frieren-test-"));
  db = makeDb();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- Helpers for inserting entries ------------------------------------------

const insertEntry = (
  d: Database,
  id: string,
  type: string,
  content: string,
): void => {
  const now = new Date().toISOString();
  d.run(
    `INSERT INTO wisdom_entries
      (id, type, content, confidence, source_agent, project_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, type, content, 0.8, "frieren", null, "active", now, now],
  );
};

// ---------------------------------------------------------------------------

describe("wisdom plane", () => {
  test("write + keyword search round-trip", () => {
    const id = crypto.randomUUID();
    insertEntry(db, id, "decision", "Use Bun for the runtime");

    type WisdomRow = {
      id: string;
      type: string;
      content: string;
      confidence: number;
    };
    const rows = db
      .query<
        WisdomRow,
        [string]
      >(`SELECT id, type, content, confidence FROM wisdom_entries WHERE content LIKE ?`)
      .all("%Bun%");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.type).toBe("decision");
    expect(rows[0]?.content).toContain("Bun");
  });

  test("relate two wisdom entries", () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    insertEntry(db, id1, "pattern", "Prefer composition over inheritance");
    insertEntry(db, id2, "pattern", "Single responsibility principle");

    const relationId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO wisdom_relations (id, from_id, to_id, relationship, strength, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [relationId, id1, id2, "supports", 0.7, now],
    );

    type RelationRow = {
      id: string;
      from_id: string;
      to_id: string;
      relationship: string;
    };
    const relation = db
      .query<
        RelationRow,
        [string]
      >(`SELECT id, from_id, to_id, relationship FROM wisdom_relations WHERE id = ?`)
      .get(relationId);

    expect(relation).not.toBeNull();
    expect(relation?.from_id).toBe(id1);
    expect(relation?.to_id).toBe(id2);
    expect(relation?.relationship).toBe("supports");
  });

  test("wisdom stats shape matches frieren_status contract", () => {
    const entries: Array<[string, string]> = [
      ["decision", "Use SQLite for storage"],
      ["decision", "Deploy on Linux"],
      ["pattern", "Repository pattern"],
      ["constraint", "Max 1MB per entry"],
      ["issue", "Slow startup"],
    ];

    for (const [type, content] of entries) {
      insertEntry(db, crypto.randomUUID(), type, content);
    }

    type TypeCount = { type: string; count: number };
    const typeCounts = db
      .query<
        TypeCount,
        []
      >(`SELECT type, COUNT(*) as count FROM wisdom_entries GROUP BY type`)
      .all();

    const byType = { decisions: 0, patterns: 0, constraints: 0, issues: 0 };
    let total = 0;

    for (const row of typeCounts) {
      total += row.count;
      if (row.type === "decision") byType.decisions = row.count;
      else if (row.type === "pattern") byType.patterns = row.count;
      else if (row.type === "constraint") byType.constraints = row.count;
      else if (row.type === "issue") byType.issues = row.count;
    }

    const stats = { total, by_type: byType, vec_enabled: false };

    expect(typeof stats.total).toBe("number");
    expect(stats.total).toBe(5);
    expect(stats.by_type.decisions).toBe(2);
    expect(stats.by_type.patterns).toBe(1);
    expect(stats.by_type.constraints).toBe(1);
    expect(stats.by_type.issues).toBe(1);
    expect(typeof stats.vec_enabled).toBe("boolean");
    expect(stats.vec_enabled).toBe(false);
  });
});
