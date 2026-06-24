import { Database } from "./database.js";
import * as sqliteVec from "sqlite-vec";

import { ensureDir } from "../utils/fs.js";
import {
  getIndexDbPath,
  getIndexDir,
  getQueueDbPath,
  getSessionDbPath,
  getSessionsDir,
  getStorageHome,
  getWisdomDbPath,
} from "../utils/paths.js";
import { INDEX_SCHEMA, WISDOM_SCHEMA } from "./schema.js";
import { applyCodebaseMigrations } from "./codebase-schema.js";
import { applyQueueMigrations } from "./queue-schema.js";
import { applyRetrievalMigrations } from "./retrieval-schema.js";
import { applySessionMigrations } from "./session-schema.js";
import { applyWisdomMigrations } from "./wisdom-schema.js";

export type DbKind = "wisdom" | "session" | "index" | "queue";

type InitResult = {
  db: Database;
  vecLoaded: boolean;
  vecError?: string;
};

const applySchema = (db: Database, statements: string[]): void => {
  for (const statement of statements) {
    db.exec(statement);
  }
};

const safeLoadVec = (db: Database): InitResult => {
  try {
    // sqlite-vec needs the raw better-sqlite3 instance for loadExtension()
    sqliteVec.load(db.raw);
    return { db, vecLoaded: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";

    return { db, vecLoaded: false, vecError: message };
  }
};

export const initDb = (kind: DbKind, projectId?: string): InitResult => {
  ensureDir(getStorageHome());

  if (kind === "wisdom") {
    const db = new Database(getWisdomDbPath());
    db.exec("PRAGMA journal_mode=WAL");
    const vec = safeLoadVec(db);
    applySchema(db, WISDOM_SCHEMA);
    applyRetrievalMigrations(db);
    applyWisdomMigrations(db, vec.vecLoaded);
    return vec;
  }

  if (kind === "queue") {
    const db = new Database(getQueueDbPath());
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    applyQueueMigrations(db);
    return { db, vecLoaded: false };
  }

  if (!projectId) {
    throw new Error("projectId is required for session and index databases");
  }

  if (kind === "session") {
    ensureDir(getSessionsDir());
    const db = new Database(getSessionDbPath(projectId));
    db.exec("PRAGMA journal_mode=WAL");
    const vec = safeLoadVec(db);
    applySessionMigrations(db, vec.vecLoaded);
    return vec;
  }

  ensureDir(getIndexDir());
  const db = new Database(getIndexDbPath(projectId));
  db.exec("PRAGMA journal_mode=WAL");
  const vec = safeLoadVec(db);
  applySchema(db, INDEX_SCHEMA);
  applyCodebaseMigrations(db, vec.vecLoaded);
  return vec;
};
