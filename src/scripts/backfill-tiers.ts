import { Database } from "../db/database.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { extractAbstract, extractSummary } from "../tiering/extract.js";
import {
  getIndexDir,
  getSessionsDir,
  getWisdomDbPath,
} from "../utils/paths.js";

type WisdomRow = {
  id: string;
  content: string;
};

type SessionRow = {
  id: string;
  content: string;
};

type CodeRow = {
  id: string;
  content: string;
  chunk_type: string;
  name: string | null;
};

const BATCH_SIZE = 100;

const ensureTierColumns = (db: Database, table: string): void => {
  for (const [col, def] of [
    ["abstract", "TEXT"],
    ["summary", "TEXT"],
  ] as const) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    } catch {
      // Column already exists — safe to continue
    }
  }
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
};

const backfillWisdomDb = (dbPath: string): number => {
  const db = new Database(dbPath);
  try {
    ensureTierColumns(db, "wisdom_entries");

    const rows = db
      .query<WisdomRow, []>(
        `SELECT id, content FROM wisdom_entries
         WHERE abstract IS NULL OR summary IS NULL`,
      )
      .all();

    for (const batch of chunk(rows, BATCH_SIZE)) {
      const tx = db.transaction((batchRows: WisdomRow[]) => {
        for (const row of batchRows) {
          const abstract = extractAbstract(row.content, "text");
          const summary = extractSummary(row.content, "text");
          db.run(
            `UPDATE wisdom_entries
             SET abstract = COALESCE(abstract, ?), summary = COALESCE(summary, ?)
             WHERE id = ?`,
            [abstract, summary, row.id],
          );
        }
      });
      tx(batch);
    }

    return rows.length;
  } finally {
    db.close();
  }
};

const backfillSessionDb = (dbPath: string): number => {
  const db = new Database(dbPath);
  try {
    ensureTierColumns(db, "session_events");

    const rows = db
      .query<SessionRow, []>(
        `SELECT id, content FROM session_events
         WHERE abstract IS NULL OR summary IS NULL`,
      )
      .all();

    for (const batch of chunk(rows, BATCH_SIZE)) {
      const tx = db.transaction((batchRows: SessionRow[]) => {
        for (const row of batchRows) {
          const abstract = extractAbstract(row.content, "text");
          const summary = extractSummary(row.content, "text");
          db.run(
            `UPDATE session_events
             SET abstract = COALESCE(abstract, ?), summary = COALESCE(summary, ?)
             WHERE id = ?`,
            [abstract, summary, row.id],
          );
        }
      });
      tx(batch);
    }

    return rows.length;
  } finally {
    db.close();
  }
};

const backfillCodebaseDb = (dbPath: string): number => {
  const db = new Database(dbPath);
  try {
    ensureTierColumns(db, "code_chunks");

    const rows = db
      .query<CodeRow, []>(
        `SELECT id, content, chunk_type, name FROM code_chunks
         WHERE abstract IS NULL OR summary IS NULL`,
      )
      .all();

    for (const batch of chunk(rows, BATCH_SIZE)) {
      const tx = db.transaction((batchRows: CodeRow[]) => {
        for (const row of batchRows) {
          const abstract = extractAbstract(row.content, "code", {
            chunkType: row.chunk_type,
            name: row.name ?? undefined,
          });
          const summary = extractSummary(row.content, "code");
          db.run(
            `UPDATE code_chunks
             SET abstract = COALESCE(abstract, ?), summary = COALESCE(summary, ?)
             WHERE id = ?`,
            [abstract, summary, row.id],
          );
        }
      });
      tx(batch);
    }

    return rows.length;
  } finally {
    db.close();
  }
};

const listDbFiles = (dirPath: string): string[] => {
  try {
    return readdirSync(dirPath)
      .filter((entry) => entry.endsWith(".db"))
      .map((entry) => join(dirPath, entry));
  } catch {
    return [];
  }
};

const main = (): void => {
  loadConfig();

  const wisdomDb = getWisdomDbPath();
  const sessionDbs = listDbFiles(getSessionsDir());
  const indexDbs = listDbFiles(getIndexDir());

  const wisdomUpdated = backfillWisdomDb(wisdomDb);
  let sessionUpdated = 0;
  let codeUpdated = 0;

  for (const dbPath of sessionDbs) {
    sessionUpdated += backfillSessionDb(dbPath);
  }

  for (const dbPath of indexDbs) {
    codeUpdated += backfillCodebaseDb(dbPath);
  }

  console.log(
    JSON.stringify({
      status: "ok",
      wisdom_updated: wisdomUpdated,
      session_updated: sessionUpdated,
      codebase_updated: codeUpdated,
      session_dbs_scanned: sessionDbs.length,
      codebase_dbs_scanned: indexDbs.length,
    }),
  );
};

main();
