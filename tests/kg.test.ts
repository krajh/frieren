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
  const path = join(tmpDir, "kg-test.db");
  const d = new Database(path);
  for (const stmt of WISDOM_SCHEMA) {
    d.exec(stmt);
  }
  applyWisdomMigrations(d, false);
  return d;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "frieren-kg-test-"));
  db = makeDb();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// --- Helpers ----------------------------------------------------------------

const insertEntity = (d: Database, name: string, type: string): string => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  d.run(
    `INSERT INTO kg_entities (id, name, type, attributes, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, type, null, null, now, now],
  );
  return id;
};

const insertTriple = (
  d: Database,
  subjectId: string,
  predicate: string,
  objectId: string | null,
  objectValue: string | null,
  validFrom: string,
  validTo: string | null = null,
  confidence = 1.0,
): string => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  d.run(
    `INSERT INTO kg_triples
      (id, subject_id, predicate, object_id, object_value, valid_from, valid_to, confidence, source, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      subjectId,
      predicate,
      objectId,
      objectValue,
      validFrom,
      validTo,
      confidence,
      null,
      null,
      now,
    ],
  );
  return id;
};

// ---------------------------------------------------------------------------

describe("kg_entities table", () => {
  test("insert and retrieve entity", () => {
    const id = insertEntity(db, "Kai", "person");

    type EntityRow = { id: string; name: string; type: string };
    const row = db
      .query<
        EntityRow,
        [string]
      >(`SELECT id, name, type FROM kg_entities WHERE id = ?`)
      .get(id);

    expect(row).not.toBeNull();
    expect(row?.name).toBe("Kai");
    expect(row?.type).toBe("person");
  });

  test("upsert-like: same name+type returns existing id", () => {
    const id1 = insertEntity(db, "OpenCode", "project");

    // Simulate upsert logic: find existing
    type Row = { id: string };
    const existing = db
      .query<
        Row,
        [string, string]
      >(`SELECT id FROM kg_entities WHERE name = ? AND type = ? LIMIT 1`)
      .get("OpenCode", "project");

    expect(existing?.id).toBe(id1);
  });
});

describe("kg_triples table", () => {
  test("insert triple with object entity", () => {
    const kaiId = insertEntity(db, "Kai", "person");
    const ocId = insertEntity(db, "OpenCode", "project");
    const tripleId = insertTriple(
      db,
      kaiId,
      "works_on",
      ocId,
      null,
      "2024-01-01",
    );

    type TripleRow = {
      id: string;
      subject_id: string;
      predicate: string;
      object_id: string | null;
      valid_from: string;
      valid_to: string | null;
    };
    const row = db
      .query<
        TripleRow,
        [string]
      >(`SELECT id, subject_id, predicate, object_id, valid_from, valid_to FROM kg_triples WHERE id = ?`)
      .get(tripleId);

    expect(row?.predicate).toBe("works_on");
    expect(row?.object_id).toBe(ocId);
    expect(row?.valid_to).toBeNull();
  });

  test("insert triple with literal value", () => {
    const kaiId = insertEntity(db, "Kai", "person");
    const tripleId = insertTriple(
      db,
      kaiId,
      "tenure_years",
      null,
      "3 years",
      "2024-01-01",
    );

    type TripleRow = { object_id: string | null; object_value: string | null };
    const row = db
      .query<
        TripleRow,
        [string]
      >(`SELECT object_id, object_value FROM kg_triples WHERE id = ?`)
      .get(tripleId);

    expect(row?.object_id).toBeNull();
    expect(row?.object_value).toBe("3 years");
  });
});

describe("temporal validity", () => {
  test("as_of query returns only facts valid at that time", () => {
    const kaiId = insertEntity(db, "Kai", "person");
    const proj1 = insertEntity(db, "ProjectAlpha", "project");
    const proj2 = insertEntity(db, "ProjectBeta", "project");

    // Kai worked on Alpha from Jan-Mar 2024
    insertTriple(
      db,
      kaiId,
      "works_on",
      proj1,
      null,
      "2024-01-01",
      "2024-03-31",
    );
    // Kai moved to Beta from Apr 2024 onwards
    insertTriple(db, kaiId, "works_on", proj2, null, "2024-04-01", null);

    type Row = { object_id: string };

    // Query at Feb 2024 — should find Alpha
    const febRows = db
      .query<Row, [string, string, string, string]>(
        `SELECT t.object_id FROM kg_triples t
         WHERE t.subject_id = ? AND t.predicate = ?
           AND t.valid_from <= ? AND (t.valid_to IS NULL OR t.valid_to > ?)`,
      )
      .all(kaiId, "works_on", "2024-02-15", "2024-02-15");

    expect(febRows).toHaveLength(1);
    expect(febRows[0]?.object_id).toBe(proj1);

    // Query at May 2024 — should find Beta
    const mayRows = db
      .query<Row, [string, string, string, string]>(
        `SELECT t.object_id FROM kg_triples t
         WHERE t.subject_id = ? AND t.predicate = ?
           AND t.valid_from <= ? AND (t.valid_to IS NULL OR t.valid_to > ?)`,
      )
      .all(kaiId, "works_on", "2024-05-01", "2024-05-01");

    expect(mayRows).toHaveLength(1);
    expect(mayRows[0]?.object_id).toBe(proj2);
  });

  test("invalidate: sets valid_to on active triple", () => {
    const kaiId = insertEntity(db, "Kai", "person");
    const tripleId = insertTriple(
      db,
      kaiId,
      "focus",
      null,
      "memory-system",
      "2024-01-01",
      null,
    );

    // Invalidate
    db.run(
      `UPDATE kg_triples SET valid_to = ? WHERE id = ? AND valid_to IS NULL`,
      ["2024-12-31", tripleId],
    );

    type Row = { valid_to: string | null };
    const row = db
      .query<Row, [string]>(`SELECT valid_to FROM kg_triples WHERE id = ?`)
      .get(tripleId);

    expect(row?.valid_to).toBe("2024-12-31");
  });

  test("currently active triples have null valid_to", () => {
    const kaiId = insertEntity(db, "Kai", "person");
    insertTriple(db, kaiId, "works_on", null, "OpenCode", "2023-01-01", null); // active
    insertTriple(
      db,
      kaiId,
      "works_on",
      null,
      "OldProject",
      "2021-01-01",
      "2022-12-31",
    ); // expired

    const now = new Date().toISOString();
    type Row = { object_value: string };
    const activeRows = db
      .query<Row, [string, string, string, string]>(
        `SELECT object_value FROM kg_triples
         WHERE subject_id = ? AND predicate = ?
           AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
      )
      .all(kaiId, "works_on", now, now);

    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.object_value).toBe("OpenCode");
  });
});

describe("agent diary (wisdom_entries with agent_id)", () => {
  test("write diary entry with agent_id", () => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO wisdom_entries
        (id, type, content, confidence, source_agent, tags, project_id, status, realm, suite, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        "pattern",
        "Always run verify-loop before marking done",
        0.9,
        "marin-coder",
        null,
        null,
        "active",
        "agent-diary",
        "marin-coder",
        "marin-coder",
        now,
        now,
      ],
    );

    type Row = { id: string; agent_id: string; realm: string };
    const row = db
      .query<
        Row,
        [string]
      >(`SELECT id, agent_id, realm FROM wisdom_entries WHERE id = ?`)
      .get(id);

    expect(row?.agent_id).toBe("marin-coder");
    expect(row?.realm).toBe("agent-diary");
  });

  test("read diary entries filtered by agent_id", () => {
    const now = new Date().toISOString();
    for (const [agent, content] of [
      ["marin-coder", "Marin lesson 1"],
      ["marin-coder", "Marin lesson 2"],
      ["guillotine-reviewer", "Reviewer lesson 1"],
    ] as [string, string][]) {
      db.run(
        `INSERT INTO wisdom_entries
          (id, type, content, confidence, source_agent, status, realm, suite, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          "pattern",
          content,
          0.8,
          agent,
          "active",
          "agent-diary",
          agent,
          agent,
          now,
          now,
        ],
      );
    }

    type Row = { content: string };
    const marinEntries = db
      .query<
        Row,
        [string, string]
      >(`SELECT content FROM wisdom_entries WHERE agent_id = ? AND realm = ? ORDER BY created_at DESC`)
      .all("marin-coder", "agent-diary");

    expect(marinEntries).toHaveLength(2);
    expect(marinEntries.some((r) => r.content === "Marin lesson 1")).toBe(true);
    expect(marinEntries.some((r) => r.content === "Marin lesson 2")).toBe(true);
  });
});
