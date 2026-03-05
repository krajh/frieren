import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  applyCodebaseMigrations,
  CODEBASE_SCHEMA,
} from "../src/db/codebase-schema.js";
import {
  chunkCode,
  shouldSkipFile,
  detectLanguage,
} from "../src/codebase/indexer.js";

// ---- DB helpers ------------------------------------------------------------

const makeDb = (): Database => {
  const db = new Database(":memory:");
  for (const stmt of CODEBASE_SCHEMA) {
    db.exec(stmt);
  }
  applyCodebaseMigrations(db, false);
  return db;
};

const insertChunk = (
  db: Database,
  opts: {
    id?: string;
    project_id?: string;
    file_path: string;
    chunk_type: string;
    name?: string | null;
    content: string;
    start_line?: number;
    end_line?: number;
    language?: string;
  },
): string => {
  const id = opts.id ?? crypto.randomUUID();
  db.run(
    `INSERT INTO code_chunks (id, project_id, file_path, chunk_type, name, content, start_line, end_line, language, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.project_id ?? "test-proj",
      opts.file_path,
      opts.chunk_type,
      opts.name ?? null,
      opts.content,
      opts.start_line ?? 1,
      opts.end_line ?? 5,
      opts.language ?? "typescript",
      new Date().toISOString(),
    ],
  );
  return id;
};

const insertDep = (
  db: Database,
  opts: {
    project_id?: string;
    from_file: string;
    to_file: string;
    dep_type?: string;
  },
): void => {
  db.run(
    `INSERT INTO code_deps (id, project_id, from_file, to_file, dep_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      opts.project_id ?? "test-proj",
      opts.from_file,
      opts.to_file,
      opts.dep_type ?? "import",
      new Date().toISOString(),
    ],
  );
};

// ---- Indexer unit tests ----------------------------------------------------

describe("indexer chunking", () => {
  test("chunks a function declaration", () => {
    const code = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`.trim();

    const { chunks } = chunkCode(code, "src/greet.ts");
    expect(chunks.length).toBeGreaterThan(0);

    const fnChunk = chunks.find((c) => c.chunk_type === "function");
    expect(fnChunk).toBeDefined();
    expect(fnChunk?.name).toBe("greet");
    expect(fnChunk?.content).toContain("Hello");
  });

  test("chunks a class declaration", () => {
    const code = `
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}
`.trim();

    const { chunks } = chunkCode(code, "src/calc.ts");
    const classChunk = chunks.find((c) => c.chunk_type === "class");
    expect(classChunk).toBeDefined();
    expect(classChunk?.name).toBe("Calculator");
  });

  test("extracts import deps", () => {
    const code = `
import { foo } from './foo.js';
import type { Bar } from '../bar.js';
const x = require('./utils.js');
`.trim();

    const { deps } = chunkCode(code, "src/index.ts");
    const targets = deps.map((d) => d.to_file);
    expect(targets).toContain("./foo.js");
    expect(targets).toContain("../bar.js");
    expect(deps.some((d) => d.dep_type === "require")).toBe(true);
  });

  test("treats small JSON as a single module chunk", () => {
    const json = `{"name": "frieren", "version": "0.1.0"}`;
    const { chunks } = chunkCode(json, "package.json");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunk_type).toBe("module");
  });

  test("skips large JSON files", () => {
    const bigJson = Array.from(
      { length: 100 },
      (_, i) => `"key${i}": ${i}`,
    ).join(",\n");
    const { chunks } = chunkCode(`{${bigJson}}`, "big.json");
    expect(chunks).toHaveLength(0);
  });

  test("shouldSkipFile rejects node_modules", () => {
    expect(shouldSkipFile("node_modules/lodash/index.js")).toBe(true);
  });

  test("shouldSkipFile accepts ts files", () => {
    expect(shouldSkipFile("src/server.ts")).toBe(false);
  });

  test("shouldSkipFile rejects binary extensions", () => {
    expect(shouldSkipFile("assets/logo.png")).toBe(true);
  });

  test("detectLanguage returns correct values", () => {
    expect(detectLanguage("src/foo.ts")).toBe("typescript");
    expect(detectLanguage("src/foo.tsx")).toBe("typescript");
    expect(detectLanguage("src/foo.js")).toBe("javascript");
    expect(detectLanguage("docs/README.md")).toBe("markdown");
  });

  test("splits function exceeding MAX_CHUNK_LINES into sub-chunks", () => {
    // Build a function body > 100 lines
    const bodyLines = Array.from(
      { length: 120 },
      (_, i) => `  const x${i} = ${i};`,
    ).join("\n");
    const code = `function bigFn() {\n${bodyLines}\n}`;

    const { chunks } = chunkCode(code, "src/big.ts");
    // Should produce multiple chunks since the function is > 100 lines
    const fnChunks = chunks.filter(
      (c) =>
        c.name === "bigFn" ||
        c.chunk_type === "function" ||
        c.chunk_type === "block",
    );
    expect(fnChunks.length).toBeGreaterThan(1);
  });
});

// ---- Codebase search (keyword) tests ---------------------------------------

describe("codebase search (keyword)", () => {
  test("finds function by name in DB", () => {
    const db = makeDb();

    insertChunk(db, {
      file_path: "src/auth.ts",
      chunk_type: "function",
      name: "authenticateUser",
      content: "export function authenticateUser(token: string) { ... }",
    });
    insertChunk(db, {
      file_path: "src/utils.ts",
      chunk_type: "function",
      name: "formatDate",
      content: "export function formatDate(date: Date) { ... }",
    });

    type ChunkRow = { name: string | null; file_path: string };
    const rows = db
      .query<ChunkRow, [string, string, string]>(
        `SELECT name, file_path FROM code_chunks
         WHERE project_id = ? AND (content LIKE ? OR name LIKE ?)
         LIMIT 10`,
      )
      .all("test-proj", "%authenticateUser%", "%authenticateUser%");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("authenticateUser");

    db.close();
  });

  test("chunk_type filter works", () => {
    const db = makeDb();

    insertChunk(db, {
      file_path: "src/index.ts",
      chunk_type: "function",
      name: "init",
      content: "function init() {}",
    });
    insertChunk(db, {
      file_path: "src/index.ts",
      chunk_type: "class",
      name: "App",
      content: "class App { init() {} }",
    });

    type ChunkRow = { chunk_type: string };
    const rows = db
      .query<ChunkRow, [string, string, string, string]>(
        `SELECT chunk_type FROM code_chunks
         WHERE project_id = ? AND content LIKE ? AND chunk_type = ?
         LIMIT ?`,
      )
      .all("test-proj", "%init%", "function", "10");

    expect(rows.every((r) => r.chunk_type === "function")).toBe(true);

    db.close();
  });
});

// ---- Codebase graph BFS tests ----------------------------------------------

describe("codebase graph", () => {
  test("BFS deps traversal returns correct nodes and edges", () => {
    const db = makeDb();

    // a.ts -> b.ts -> c.ts
    insertDep(db, { from_file: "src/a.ts", to_file: "src/b.ts" });
    insertDep(db, { from_file: "src/b.ts", to_file: "src/c.ts" });

    type DepRow = { from_file: string; to_file: string; dep_type: string };

    // BFS from a.ts (deps direction)
    const visited = new Set<string>();
    const nodes: Array<{ file: string; depth: number }> = [];
    const edges: Array<{ from: string; to: string; dep_type: string }> = [];

    const queue: Array<{ file: string; d: number }> = [
      { file: "src/a.ts", d: 0 },
    ];
    visited.add("src/a.ts");
    nodes.push({ file: "src/a.ts", depth: 0 });

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.d >= 3) continue;

      const rows = db
        .query<
          DepRow,
          [string, string]
        >(`SELECT from_file, to_file, dep_type FROM code_deps WHERE project_id = ? AND from_file = ?`)
        .all("test-proj", current.file);

      for (const row of rows) {
        edges.push({
          from: row.from_file,
          to: row.to_file,
          dep_type: row.dep_type,
        });
        if (!visited.has(row.to_file)) {
          visited.add(row.to_file);
          nodes.push({ file: row.to_file, depth: current.d + 1 });
          queue.push({ file: row.to_file, d: current.d + 1 });
        }
      }
    }

    const nodeFiles = nodes.map((n) => n.file);
    expect(nodeFiles).toContain("src/a.ts");
    expect(nodeFiles).toContain("src/b.ts");
    expect(nodeFiles).toContain("src/c.ts");
    expect(edges).toHaveLength(2);

    db.close();
  });

  test("depth limit caps traversal", () => {
    const db = makeDb();

    // chain: a -> b -> c -> d
    insertDep(db, { from_file: "src/a.ts", to_file: "src/b.ts" });
    insertDep(db, { from_file: "src/b.ts", to_file: "src/c.ts" });
    insertDep(db, { from_file: "src/c.ts", to_file: "src/d.ts" });

    type DepRow = { from_file: string; to_file: string; dep_type: string };
    const MAX_DEPTH = 2;

    const visited = new Set<string>();
    const nodes: Array<{ file: string; depth: number }> = [];
    const queue: Array<{ file: string; d: number }> = [
      { file: "src/a.ts", d: 0 },
    ];
    visited.add("src/a.ts");
    nodes.push({ file: "src/a.ts", depth: 0 });

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.d >= MAX_DEPTH) continue;

      const rows = db
        .query<
          DepRow,
          [string, string]
        >(`SELECT from_file, to_file, dep_type FROM code_deps WHERE project_id = ? AND from_file = ?`)
        .all("test-proj", current.file);

      for (const row of rows) {
        if (!visited.has(row.to_file)) {
          visited.add(row.to_file);
          nodes.push({ file: row.to_file, depth: current.d + 1 });
          queue.push({ file: row.to_file, d: current.d + 1 });
        }
      }
    }

    const nodeFiles = nodes.map((n) => n.file);
    expect(nodeFiles).toContain("src/a.ts");
    expect(nodeFiles).toContain("src/b.ts");
    expect(nodeFiles).toContain("src/c.ts");
    // d.ts should NOT be reached (depth 3 > MAX_DEPTH 2)
    expect(nodeFiles).not.toContain("src/d.ts");

    db.close();
  });
});

// ---- memory_status codebase shape ------------------------------------------

describe("status codebase shape", () => {
  test("index_meta returns correct shape", () => {
    const db = makeDb();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO index_meta (project_id, root_path, last_commit, indexed_at, file_count, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["proj-abc", "/home/user/projects/abc", "abc123", now, 10, 42],
    );

    type MetaRow = {
      project_id: string;
      file_count: number;
      chunk_count: number;
      indexed_at: string;
    };

    const rows = db
      .query<
        MetaRow,
        []
      >(`SELECT project_id, file_count, chunk_count, indexed_at FROM index_meta`)
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.project_id).toBe("proj-abc");
    expect(rows[0]?.file_count).toBe(10);
    expect(rows[0]?.chunk_count).toBe(42);
    expect(typeof rows[0]?.indexed_at).toBe("string");

    db.close();
  });
});
