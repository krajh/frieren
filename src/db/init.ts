import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

import { ensureDir } from "../utils/fs.js";
import {
  getIndexDbPath,
  getIndexDir,
  getSessionDbPath,
  getSessionsDir,
  getStorageHome,
  getWisdomDbPath,
} from "../utils/paths.js";
import { INDEX_SCHEMA, WISDOM_SCHEMA } from "./schema.js";
import { applyCodebaseMigrations } from "./codebase-schema.js";
import { applySessionMigrations } from "./session-schema.js";
import { applyWisdomMigrations } from "./wisdom-schema.js";

export type DbKind = "wisdom" | "session" | "index";

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
    sqliteVec.load(db);
    return { db, vecLoaded: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.warn(`[frieren] sqlite-vec extension not loaded: ${message}`);
    return { db, vecLoaded: false, vecError: message };
  }
};

export const initDb = (kind: DbKind, projectId?: string): InitResult => {
  ensureDir(getStorageHome());

  if (kind === "wisdom") {
    const db = new Database(getWisdomDbPath());
    const vec = safeLoadVec(db);
    applySchema(db, WISDOM_SCHEMA);
    applyWisdomMigrations(db, vec.vecLoaded);
    return vec;
  }

  if (!projectId) {
    throw new Error("projectId is required for session and index databases");
  }

  if (kind === "session") {
    ensureDir(getSessionsDir());
    const db = new Database(getSessionDbPath(projectId));
    const vec = safeLoadVec(db);
    applySessionMigrations(db, vec.vecLoaded);
    return vec;
  }

  ensureDir(getIndexDir());
  const db = new Database(getIndexDbPath(projectId));
  const vec = safeLoadVec(db);
  applySchema(db, INDEX_SCHEMA);
  applyCodebaseMigrations(db, vec.vecLoaded);
  return vec;
};
