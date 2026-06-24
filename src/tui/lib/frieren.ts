import { Database } from "../../db/database.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { loadConfig, loadProjectNames, saveProjectName } from "../../config.js";
import { detectProjectInfo } from "../../project/detectProjectId.js";
import {
  getIndexDir,
  getQueueDbPath,
  getSessionsDir,
  getWisdomDbPath,
} from "../../utils/paths.js";

export interface FrierenStats {
  wisdomCount: number;
  sessionProjects: number;
  codebaseProjects: number;
  kgTriples: number;
  reaperPending: number;
  diskUsageBytes: number;
}

export interface RecentEvent {
  timestamp: string;
  type: string;
  summary: string;
}

export interface WisdomEntry {
  id: string;
  type: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at?: string;
  confidence: number;
  kind?: string;
  realm?: string;
  suite?: string;
  project_id?: string;
  summary?: string;
  abstract?: string;
}

export interface WisdomRelation {
  id: string;
  relationship: string;
  strength: number;
  created_at: string;
  direction: "outgoing" | "incoming";
  related_id: string;
  related_type?: string;
  related_content?: string;
}

export interface SessionEvent {
  id?: string;
  session_id: string;
  event_type: string;
  content: string;
  created_at: string;
  project_id?: string;
  summary?: string;
  abstract?: string;
  artifacts?: string;
}

export interface CodeChunk {
  file: string;
  content: string;
  chunk_type: string;
  summary?: string;
  deps: string[];
  dependents: string[];
  name?: string;
  start_line?: number;
  end_line?: number;
  indexed_at?: string;
}

export interface KGEntity {
  id: string;
  name: string;
  type: string;
}

export interface KGTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  valid_from?: string;
  valid_to?: string | null;
  source?: string | null;
}

export interface MemoryTimelineEntry {
  id: string;
  timestamp: string;
  plane: "wisdom" | "session" | "codebase";
  event_type: string;
  content: string;
}

export interface ReaperTask {
  task_id: string;
  status: string;
  task: string;
  priority: number;
  created_at: string;
  result?: string;
  error?: string;
}

export interface CreateWisdomEntryInput {
  type: string;
  content: string;
  tags?: string[];
  kind?: string;
  realm?: string;
  suite?: string;
}

export interface UpdateEntryMetaInput {
  tags?: string[];
  kind?: string;
  realm?: string;
  suite?: string;
}

type DbHandle = {
  db: Database;
  close: () => void;
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const DEFAULT_STATS: FrierenStats = {
  wisdomCount: 0,
  sessionProjects: 0,
  codebaseProjects: 0,
  kgTriples: 0,
  reaperPending: 0,
  diskUsageBytes: 0,
};

const MAX_QUERY_LIMIT = 100;
const QUERY_CACHE_TTL_MS = 3000;

const queryCache = new Map<string, CacheEntry<unknown>>();

const getCacheKey = (name: string, params: unknown[]): string => {
  return `${name}:${JSON.stringify(params)}`;
};

const withCache = <T>(key: string, loader: () => T, ttlMs = QUERY_CACHE_TTL_MS): T => {
  const now = Date.now();
  const cached = queryCache.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = loader();
  queryCache.set(key, {
    expiresAt: now + ttlMs,
    value,
  });
  return value;
};

const clampLimit = (limit?: number): number => {
  return Math.max(1, Math.min(limit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT));
};

const clampOffset = (offset = 0): number => {
  return Math.max(0, offset);
};

const shortHash = (projectId: string): string => projectId.slice(0, 8);

/**
 * Resolve a human-readable project name for a project ID.
 * Priority: config override → auto-detected (cached) → short hash.
 */
export function resolveProjectName(projectId: string): string {
  const names = loadProjectNames();
  if (names[projectId]) {
    return names[projectId];
  }
  return shortHash(projectId);
}

/**
 * Get the current project's display name by detecting it from git,
 * auto-saving to config for persistence.
 */
export function getCurrentProjectName(): string {
  const info = detectProjectInfo();
  if (!info) {
    return "unknown";
  }
  // Auto-save display name if not yet in config
  const names = loadProjectNames();
  if (!names[info.projectId]) {
    saveProjectName(info.projectId, info.displayName);
  }
  return info.displayName;
}

/**
 * Get the current project ID from git detection.
 */
export function getCurrentProjectId(): string | null {
  return detectProjectInfo()?.projectId ?? null;
}

const getDbFiles = (dirPath: string): string[] => {
  if (!existsSync(dirPath)) {
    return [];
  }

  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
      .map((entry) => join(dirPath, entry.name))
      .sort();
  } catch {
    return [];
  }
};

const getProjectIdFromPath = (dbPath: string): string => basename(dbPath, ".db");

const getSessionDbPath = (projectId: string): string => join(getSessionsDir(), `${projectId}.db`);

const getIndexDbPath = (projectId: string): string => join(getIndexDir(), `${projectId}.db`);

const openReadonlyDb = (dbPath: string): DbHandle | null => {
  if (!existsSync(dbPath)) {
    return null;
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    return {
      db,
      close: () => db.close(false),
    };
  } catch {
    return null;
  }
};

const openReadWriteDb = (dbPath: string): DbHandle | null => {
  try {
    const db = new Database(dbPath);
    return {
      db,
      close: () => db.close(false),
    };
  } catch {
    return null;
  }
};

const hasTable = (db: Database, tableName: string): boolean => {
  try {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) as { name: string } | null;

    return row?.name === tableName;
  } catch {
    return false;
  }
};

const getTableColumns = (db: Database, tableName: string): Set<string> => {
  try {
    const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set<string>();
  }
};

const getCount = (db: Database, tableName: string, whereClause?: string): number => {
  if (!hasTable(db, tableName)) {
    return 0;
  }

  try {
    const query = whereClause
      ? `SELECT COUNT(*) AS count FROM ${tableName} WHERE ${whereClause}`
      : `SELECT COUNT(*) AS count FROM ${tableName}`;
    const row = db.query(query).get() as { count: number } | null;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
};

const getDirectorySize = (targetPath: string, depth = 0): number => {
  // Cap at depth 2 to avoid blocking the render loop on large installations.
  if (!existsSync(targetPath) || depth > 2) {
    return 0;
  }

  try {
    const stats = statSync(targetPath);

    if (stats.isFile()) {
      return stats.size;
    }

    if (!stats.isDirectory()) {
      return 0;
    }

    return readdirSync(targetPath, { withFileTypes: true }).reduce((total, entry) => {
      return total + getDirectorySize(join(targetPath, entry.name), depth + 1);
    }, 0);
  } catch {
    return 0;
  }
};

const getSessionSummaryExpression = (columns: Set<string>): string => {
  if (columns.has("abstract") && columns.has("summary")) {
    return "COALESCE(abstract, summary, substr(content, 1, 120))";
  }

  if (columns.has("summary")) {
    return "COALESCE(summary, substr(content, 1, 120))";
  }

  if (columns.has("abstract")) {
    return "COALESCE(abstract, substr(content, 1, 120))";
  }

  return "substr(content, 1, 120)";
};

const parseJsonArray = (value: string | null | undefined): string[] => {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const getOptionalColumn = (columns: Set<string>, name: string): string => {
  return columns.has(name) ? name : `NULL AS ${name}`;
};

const getWisdomSelectClause = (columns: Set<string>): string => {
  return [
    "id",
    "type",
    "content",
    columns.has("confidence") ? "confidence" : "0.8 AS confidence",
    "created_at",
    getOptionalColumn(columns, "updated_at"),
    getOptionalColumn(columns, "tags"),
    getOptionalColumn(columns, "kind"),
    getOptionalColumn(columns, "realm"),
    getOptionalColumn(columns, "suite"),
    getOptionalColumn(columns, "project_id"),
    getOptionalColumn(columns, "summary"),
    getOptionalColumn(columns, "abstract"),
  ].join(", ");
};

const getReaperTaskText = (payload: string | null | undefined): string => {
  if (!payload) {
    return "";
  }

  try {
    const parsed = JSON.parse(payload) as { instruction?: string; task?: string };
    return parsed.instruction ?? parsed.task ?? payload;
  } catch {
    return payload;
  }
};

const mapWisdomEntry = (row: {
  id: string;
  type: string;
  content: string;
  confidence: number | null;
  created_at: string;
  updated_at?: string | null;
  tags?: string | null;
  kind?: string | null;
  realm?: string | null;
  suite?: string | null;
  project_id?: string | null;
  summary?: string | null;
  abstract?: string | null;
}): WisdomEntry => ({
  id: row.id,
  type: row.type,
  content: row.content,
  confidence: row.confidence ?? 0.8,
  created_at: row.created_at,
  updated_at: row.updated_at ?? undefined,
  tags: parseJsonArray(row.tags),
  kind: row.kind ?? undefined,
  realm: row.realm ?? undefined,
  suite: row.suite ?? undefined,
  project_id: row.project_id ?? undefined,
  summary: row.summary ?? undefined,
  abstract: row.abstract ?? undefined,
});

export function getStats(): FrierenStats {
  return withCache("getStats", () => {
    const stats: FrierenStats = {
      ...DEFAULT_STATS,
      sessionProjects: getDbFiles(getSessionsDir()).length,
      codebaseProjects: getDbFiles(getIndexDir()).length,
      diskUsageBytes: getDirectorySize(loadConfig().storage.home),
    };

    const wisdomHandle = openReadonlyDb(getWisdomDbPath());
    if (wisdomHandle) {
      try {
        stats.wisdomCount = getCount(wisdomHandle.db, "wisdom_entries");
        stats.kgTriples = getCount(wisdomHandle.db, "kg_triples");
      } finally {
        wisdomHandle.close();
      }
    }

    const queueHandle = openReadonlyDb(getQueueDbPath());
    if (queueHandle) {
      try {
        if (hasTable(queueHandle.db, "reaper_realm_queue")) {
          stats.reaperPending = getCount(
            queueHandle.db,
            "reaper_realm_queue",
            "status IN ('pending', 'manifesting')",
          );
        } else {
          stats.reaperPending = getCount(queueHandle.db, "tasks", "status = 'pending'");
        }
      } finally {
        queueHandle.close();
      }
    }

    return stats;
  });
}

export function getRecentActivity(limit = 5, offset = 0): RecentEvent[] {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  return withCache(getCacheKey("getRecentActivity", [safeLimit, safeOffset]), () => {
    const events: RecentEvent[] = [];

    for (const dbPath of getDbFiles(getSessionsDir())) {
      const handle = openReadonlyDb(dbPath);
      if (!handle) {
        continue;
      }

      try {
        if (!hasTable(handle.db, "session_events")) {
          continue;
        }

        const columns = getTableColumns(handle.db, "session_events");
        const summaryExpression = getSessionSummaryExpression(columns);
        // NOTE: We over-fetch per-DB and rely on the global sort+slice below
        // for correct pagination. Per-DB OFFSET would double-skip rows when
        // multiple session DBs are queried.
        const rows = handle.db
          .query(
            `SELECT created_at AS timestamp, event_type AS type, ${summaryExpression} AS summary
             FROM session_events
             ORDER BY created_at DESC
             LIMIT ?`,
          )
          .all(safeLimit * 10) as Array<{
          timestamp: string;
          type: string;
          summary: string | null;
        }>;

        events.push(
          ...rows.map((row) => ({
            timestamp: row.timestamp,
            type: row.type,
            summary: (row.summary ?? "").trim(),
          })),
        );
      } catch {
        continue;
      } finally {
        handle.close();
      }
    }

    return events
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(safeOffset, safeOffset + safeLimit);
  });
}

export function getProjects(): string[] {
  const sessionProjects = getDbFiles(getSessionsDir()).map(getProjectIdFromPath);
  const codebaseProjects = getDbFiles(getIndexDir()).map(getProjectIdFromPath);

  return [...new Set([...sessionProjects, ...codebaseProjects])].sort();
}

export function searchWisdom(query?: string, typeFilter?: string, limit = 50, offset = 0): WisdomEntry[] {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  return withCache(getCacheKey("searchWisdom", [query ?? "", typeFilter ?? "", safeLimit, safeOffset]), () => {
    const handle = openReadonlyDb(getWisdomDbPath());
    if (!handle) {
      return [];
    }

    try {
      if (!hasTable(handle.db, "wisdom_entries")) {
        return [];
      }

      const columns = getTableColumns(handle.db, "wisdom_entries");
      const conditions: string[] = [];
      const params: Array<string | number> = [];

      if (columns.has("status")) {
        conditions.push("COALESCE(status, 'active') != 'deleted'");
      }

      if (query?.trim()) {
        const queryFields = ["content"];
        if (columns.has("summary")) {
          queryFields.push("summary");
        }
        if (columns.has("abstract")) {
          queryFields.push("abstract");
        }
        conditions.push(`(${queryFields.map((field) => `${field} LIKE ?`).join(" OR ")})`);
        for (let index = 0; index < queryFields.length; index += 1) {
          params.push(`%${query.trim()}%`);
        }
      }

      if (typeFilter && typeFilter !== "all") {
        conditions.push("type = ?");
        params.push(typeFilter);
      }

      params.push(safeLimit, safeOffset);

      const rows = handle.db
        .query<
          {
            id: string;
            type: string;
            content: string;
            confidence: number | null;
            created_at: string;
            updated_at: string | null;
            tags: string | null;
            kind: string | null;
            realm: string | null;
            suite: string | null;
            project_id: string | null;
            summary: string | null;
            abstract: string | null;
          },
          Array<string | number>
        >(
          `SELECT ${getWisdomSelectClause(columns)}
           FROM wisdom_entries
           ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params);

      return rows.map(mapWisdomEntry);
    } catch {
      return [];
    } finally {
      handle.close();
    }
  });
}

export function getWisdomDetail(id: string): WisdomEntry | null {
  const handle = openReadonlyDb(getWisdomDbPath());
  if (!handle) {
    return null;
  }

  try {
    if (!hasTable(handle.db, "wisdom_entries")) {
      return null;
    }

    const columns = getTableColumns(handle.db, "wisdom_entries");
    const row = handle.db
      .query<
        {
          id: string;
          type: string;
          content: string;
          confidence: number | null;
          created_at: string;
          updated_at: string | null;
          tags: string | null;
          kind: string | null;
          realm: string | null;
          suite: string | null;
          project_id: string | null;
          summary: string | null;
          abstract: string | null;
        },
        [string]
      >(
        `SELECT ${getWisdomSelectClause(columns)}
         FROM wisdom_entries
         WHERE id = ?
         LIMIT 1`,
      )
      .get(id);

    return row ? mapWisdomEntry(row) : null;
  } catch {
    return null;
  } finally {
    handle.close();
  }
}

export function getWisdomRelations(id: string): WisdomRelation[] {
  const handle = openReadonlyDb(getWisdomDbPath());
  if (!handle) {
    return [];
  }

  try {
    if (!hasTable(handle.db, "wisdom_relations") || !hasTable(handle.db, "wisdom_entries")) {
      return [];
    }

    const rows = handle.db
      .query<
        {
          id: string;
          relationship: string;
          strength: number;
          created_at: string;
          related_id: string;
          direction: "outgoing" | "incoming";
          related_type: string | null;
          related_content: string | null;
        },
        [string, string, string, string, string]
      >(
        `SELECT wr.id,
                wr.relationship,
                wr.strength,
                wr.created_at,
                CASE WHEN wr.from_id = ? THEN wr.to_id ELSE wr.from_id END AS related_id,
                CASE WHEN wr.from_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
                we.type AS related_type,
                we.content AS related_content
         FROM wisdom_relations wr
         LEFT JOIN wisdom_entries we
           ON we.id = CASE WHEN wr.from_id = ? THEN wr.to_id ELSE wr.from_id END
         WHERE wr.from_id = ? OR wr.to_id = ?
         ORDER BY wr.created_at DESC`,
      )
      .all(id, id, id, id, id);

    return rows.map((row) => ({
      id: row.id,
      relationship: row.relationship,
      strength: row.strength,
      created_at: row.created_at,
      direction: row.direction,
      related_id: row.related_id,
      related_type: row.related_type ?? undefined,
      related_content: row.related_content ?? undefined,
    }));
  } catch {
    return [];
  } finally {
    handle.close();
  }
}

export function listSessions(projectId?: string): string[] {
  const dbPaths = projectId ? [getSessionDbPath(projectId)].filter(existsSync) : getDbFiles(getSessionsDir());
  const sessionMap = new Map<string, string>();

  for (const dbPath of dbPaths) {
    const handle = openReadonlyDb(dbPath);
    if (!handle) {
      continue;
    }

    try {
      if (!hasTable(handle.db, "session_events")) {
        continue;
      }

      const rows = handle.db
        .query<{ session_id: string; last_seen: string }, []>(
          `SELECT session_id, MAX(created_at) AS last_seen
           FROM session_events
           GROUP BY session_id
           ORDER BY last_seen DESC`,
        )
        .all();

      for (const row of rows) {
        const existing = sessionMap.get(row.session_id);
        if (!existing || existing < row.last_seen) {
          sessionMap.set(row.session_id, row.last_seen);
        }
      }
    } catch {
      continue;
    } finally {
      handle.close();
    }
  }

  return [...sessionMap.entries()]
    .sort((left, right) => right[1].localeCompare(left[1]))
    .map(([sessionId]) => sessionId);
}

export function getSessionEvents(sessionId: string, limit = 100, offset = 0): SessionEvent[] {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  return withCache(getCacheKey("getSessionEvents", [sessionId, safeLimit, safeOffset]), () => {
    const events: SessionEvent[] = [];

    for (const dbPath of getDbFiles(getSessionsDir())) {
      const handle = openReadonlyDb(dbPath);
      if (!handle) {
        continue;
      }

      try {
        if (!hasTable(handle.db, "session_events")) {
          continue;
        }

        const columns = getTableColumns(handle.db, "session_events");
        const rows = handle.db
          .query<
            {
              id: string;
              session_id: string;
              project_id: string | null;
              event_type: string;
              content: string;
              created_at: string;
              artifacts: string | null;
              summary: string | null;
              abstract: string | null;
            },
            [string, number, number]
          >(
            `SELECT id,
                    session_id,
                    project_id,
                    event_type,
                    content,
                    created_at,
                    ${getOptionalColumn(columns, "artifacts")},
                    ${getOptionalColumn(columns, "summary")},
                    ${getOptionalColumn(columns, "abstract")}
             FROM session_events
             WHERE session_id = ?
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
          )
          .all(sessionId, safeLimit, safeOffset);

        events.push(
          ...rows.map((row) => ({
            id: row.id,
            session_id: row.session_id,
            project_id: row.project_id ?? undefined,
            event_type: row.event_type,
            content: row.content,
            created_at: row.created_at,
            artifacts: row.artifacts ?? undefined,
            summary: row.summary ?? undefined,
            abstract: row.abstract ?? undefined,
          })),
        );
      } catch {
        continue;
      } finally {
        handle.close();
      }
    }

    return events
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, safeLimit);
  });
}

export function getRecentEvents(projectId?: string, limit = 50, offset = 0): SessionEvent[] {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  return withCache(getCacheKey("getRecentEvents", [projectId ?? "", safeLimit, safeOffset]), () => {
    const dbPaths = projectId ? [getSessionDbPath(projectId)].filter(existsSync) : getDbFiles(getSessionsDir());
    const events: SessionEvent[] = [];

    for (const dbPath of dbPaths) {
      const handle = openReadonlyDb(dbPath);
      if (!handle) {
        continue;
      }

      try {
        if (!hasTable(handle.db, "session_events")) {
          continue;
        }

        const columns = getTableColumns(handle.db, "session_events");
        const rows = handle.db
          .query<
            {
              id: string;
              session_id: string;
              project_id: string | null;
              event_type: string;
              content: string;
              created_at: string;
              artifacts: string | null;
              summary: string | null;
              abstract: string | null;
            },
            [number, number]
          >(
            `SELECT id,
                    session_id,
                    project_id,
                    event_type,
                    content,
                    created_at,
                    ${getOptionalColumn(columns, "artifacts")},
                    ${getOptionalColumn(columns, "summary")},
                    ${getOptionalColumn(columns, "abstract")}
             FROM session_events
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?`,
          )
          .all(safeLimit, safeOffset);

        events.push(
          ...rows.map((row) => ({
            id: row.id,
            session_id: row.session_id,
            project_id: row.project_id ?? undefined,
            event_type: row.event_type,
            content: row.content,
            created_at: row.created_at,
            artifacts: row.artifacts ?? undefined,
            summary: row.summary ?? undefined,
            abstract: row.abstract ?? undefined,
          })),
        );
      } catch {
        continue;
      } finally {
        handle.close();
      }
    }

    return events
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, safeLimit);
  });
}

export function listIndexedProjects(): string[] {
  return getDbFiles(getIndexDir()).map(getProjectIdFromPath).sort();
}

export function getProjectFiles(projectId: string, limit = 100, offset = 0): string[] {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  return withCache(getCacheKey("getProjectFiles", [projectId, safeLimit, safeOffset]), () => {
    const handle = openReadonlyDb(getIndexDbPath(projectId));
    if (!handle) {
      return [];
    }

    try {
      if (!hasTable(handle.db, "code_chunks")) {
        return [];
      }

      const rows = handle.db
        .query<{ file_path: string }, [number, number]>(
          `SELECT DISTINCT file_path
           FROM code_chunks
           ORDER BY file_path ASC
           LIMIT ? OFFSET ?`,
        )
        .all(safeLimit, safeOffset);

      return rows.map((row) => row.file_path);
    } catch {
      return [];
    } finally {
      handle.close();
    }
  });
}

export function getFileChunks(projectId: string, filePath: string, limit = 100, offset = 0): CodeChunk[] {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  return withCache(getCacheKey("getFileChunks", [projectId, filePath, safeLimit, safeOffset]), () => {
    const handle = openReadonlyDb(getIndexDbPath(projectId));
    if (!handle) {
      return [];
    }

    try {
      if (!hasTable(handle.db, "code_chunks")) {
        return [];
      }

      const columns = getTableColumns(handle.db, "code_chunks");
      const deps = hasTable(handle.db, "code_deps")
        ? handle.db
            .query<{ to_file: string }, [string]>(
              `SELECT DISTINCT to_file FROM code_deps WHERE from_file = ? ORDER BY to_file ASC`,
            )
            .all(filePath)
            .map((row) => row.to_file)
        : [];
      const dependents = hasTable(handle.db, "code_deps")
        ? handle.db
            .query<{ from_file: string }, [string]>(
              `SELECT DISTINCT from_file FROM code_deps WHERE to_file = ? ORDER BY from_file ASC`,
            )
            .all(filePath)
            .map((row) => row.from_file)
        : [];

      const rows = handle.db
        .query<
          {
            file_path: string;
            content: string;
            chunk_type: string;
            summary: string | null;
            name: string | null;
            start_line: number | null;
            end_line: number | null;
            indexed_at: string | null;
          },
          [string, number, number]
        >(
          `SELECT file_path,
                  content,
                  chunk_type,
                  ${columns.has("summary") ? "summary" : columns.has("abstract") ? "abstract AS summary" : "NULL AS summary"},
                  name,
                  start_line,
                  end_line,
                  indexed_at
           FROM code_chunks
           WHERE file_path = ?
           ORDER BY COALESCE(start_line, 0) ASC, chunk_type ASC
           LIMIT ? OFFSET ?`,
        )
        .all(filePath, safeLimit, safeOffset);

      return rows.map((row) => ({
        file: row.file_path,
        content: row.content,
        chunk_type: row.chunk_type,
        summary: row.summary ?? undefined,
        deps,
        dependents,
        name: row.name ?? undefined,
        start_line: row.start_line ?? undefined,
        end_line: row.end_line ?? undefined,
        indexed_at: row.indexed_at ?? undefined,
      }));
    } catch {
      return [];
    } finally {
      handle.close();
    }
  });
}

export function searchKGEntities(query?: string, limit = 100, offset = 0): KGEntity[] {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  return withCache(getCacheKey("searchKGEntities", [query ?? "", safeLimit, safeOffset]), () => {
    const handle = openReadonlyDb(getWisdomDbPath());
    if (!handle) {
      return [];
    }

    try {
      if (!hasTable(handle.db, "kg_entities")) {
        return [];
      }

      const rows = query?.trim()
        ? handle.db
            .query<KGEntity, [string, number, number]>(
              `SELECT id, name, type
               FROM kg_entities
               WHERE name LIKE ?
               ORDER BY name ASC
               LIMIT ? OFFSET ?`,
            )
            .all(`%${query.trim()}%`, safeLimit, safeOffset)
        : handle.db
            .query<KGEntity, [number, number]>(
              `SELECT id, name, type
               FROM kg_entities
               ORDER BY name ASC
               LIMIT ? OFFSET ?`,
            )
            .all(safeLimit, safeOffset);

      return rows;
    } catch {
      return [];
    } finally {
      handle.close();
    }
  });
}

export function getEntityTriples(entityName: string): KGTriple[] {
  const handle = openReadonlyDb(getWisdomDbPath());
  if (!handle) {
    return [];
  }

  try {
    if (!hasTable(handle.db, "kg_triples") || !hasTable(handle.db, "kg_entities")) {
      return [];
    }

    const rows = handle.db
      .query<
        {
          subject_name: string;
          predicate: string;
          object_name: string | null;
          object_value: string | null;
          confidence: number;
          valid_from: string | null;
          valid_to: string | null;
          source: string | null;
        },
        [string, string]
      >(
        `SELECT s.name AS subject_name,
                t.predicate,
                o.name AS object_name,
                t.object_value,
                t.confidence,
                t.valid_from,
                t.valid_to,
                t.source
         FROM kg_triples t
         JOIN kg_entities s ON s.id = t.subject_id
         LEFT JOIN kg_entities o ON o.id = t.object_id
         WHERE s.name = ? OR o.name = ?
         ORDER BY t.valid_from DESC, t.created_at DESC`,
      )
      .all(entityName, entityName);

    return rows.map((row) => ({
      subject: row.subject_name,
      predicate: row.predicate,
      object: row.object_name ?? row.object_value ?? "(none)",
      confidence: row.confidence,
      valid_from: row.valid_from ?? undefined,
      valid_to: row.valid_to,
      source: row.source,
    }));
  } catch {
    return [];
  } finally {
    handle.close();
  }
}

export function getKGTimeline(entityName: string, limit = 50): KGTriple[] {
  const handle = openReadonlyDb(getWisdomDbPath());
  if (!handle) {
    return [];
  }

  try {
    if (!hasTable(handle.db, "kg_triples") || !hasTable(handle.db, "kg_entities")) {
      return [];
    }

    const rows = handle.db
      .query<
        {
          subject_name: string;
          predicate: string;
          object_name: string | null;
          object_value: string | null;
          confidence: number;
          valid_from: string | null;
          valid_to: string | null;
          source: string | null;
        },
        [string, string, number]
      >(
        `SELECT s.name AS subject_name,
                t.predicate,
                o.name AS object_name,
                t.object_value,
                t.confidence,
                t.valid_from,
                t.valid_to,
                t.source
         FROM kg_triples t
         JOIN kg_entities s ON s.id = t.subject_id
         LEFT JOIN kg_entities o ON o.id = t.object_id
         WHERE s.name LIKE ? OR o.name LIKE ?
         ORDER BY t.valid_from ASC
         LIMIT ?`,
      )
      .all(`%${entityName}%`, `%${entityName}%`, Math.max(1, limit));

    return rows.map((row) => ({
      subject: row.subject_name,
      predicate: row.predicate,
      object: row.object_name ?? row.object_value ?? "(none)",
      confidence: row.confidence,
      valid_from: row.valid_from ?? undefined,
      valid_to: row.valid_to,
      source: row.source,
    }));
  } catch {
    return [];
  } finally {
    handle.close();
  }
}

export function getReaperTasks(statusFilter?: string, limit = 100, offset = 0): ReaperTask[] {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  return withCache(getCacheKey("getReaperTasks", [statusFilter ?? "", safeLimit, safeOffset]), () => {
    const handle = openReadonlyDb(getQueueDbPath());
    if (!handle) {
      return [];
    }

    try {
      const tableName = hasTable(handle.db, "reaper_realm_queue")
        ? "reaper_realm_queue"
        : hasTable(handle.db, "tasks")
          ? "tasks"
          : null;

      if (!tableName) {
        return [];
      }

      const params: Array<string | number> = [];
      const where = statusFilter ? "WHERE status = ?" : "";
      if (statusFilter) {
        params.push(statusFilter);
      }
      params.push(safeLimit, safeOffset);

      const rows = handle.db
        .query<
          {
            task_id: string;
            status: string;
            priority: number;
            created_at: string;
            payload: string | null;
            result: string | null;
            error: string | null;
          },
          Array<string | number>
        >(
          `SELECT task_id, status, priority, created_at, payload, result, error
           FROM ${tableName}
           ${where}
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params);

      return rows.map((row) => ({
        task_id: row.task_id,
        status: row.status,
        task: getReaperTaskText(row.payload),
        priority: row.priority,
        created_at: row.created_at,
        result: row.result ?? undefined,
        error: row.error ?? undefined,
      }));
    } catch {
      return [];
    } finally {
      handle.close();
    }
  });
}

export function cancelReaperTask(taskId: string): boolean {
  const handle = openReadWriteDb(getQueueDbPath());
  if (!handle) {
    return false;
  }

  try {
    const tableName = hasTable(handle.db, "reaper_realm_queue")
      ? "reaper_realm_queue"
      : hasTable(handle.db, "tasks")
        ? "tasks"
        : null;

    if (!tableName) {
      return false;
    }

    const columns = getTableColumns(handle.db, tableName);
    const setClause = columns.has("updated_at")
      ? "SET status = 'cancelled', updated_at = datetime('now')"
      : "SET status = 'cancelled'";
    const info = handle.db
      .query(`UPDATE ${tableName} ${setClause} WHERE task_id = ? AND status = 'pending'`)
      .run(taskId);

    if ((info.changes ?? 0) > 0) {
      clearCache();
      return true;
    }

    return false;
  } catch {
    return false;
  } finally {
    handle.close();
  }
}

export function createWisdomEntry(entry: CreateWisdomEntryInput): string | null {
  const handle = openReadWriteDb(getWisdomDbPath());
  if (!handle) {
    return null;
  }

  try {
    if (!hasTable(handle.db, "wisdom_entries")) {
      return null;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const content = entry.content.trim();
    if (!content) {
      return null;
    }

    const columns = getTableColumns(handle.db, "wisdom_entries");
    const colList: string[] = [];
    const valList: string[] = [];
    const params: Array<string | number | null> = [];

    const addCol = (name: string, value: string | number | null) => {
      if (columns.has(name)) {
        colList.push(name);
        valList.push("?");
        params.push(value);
      }
    };

    addCol("id", id);
    addCol("type", entry.type);
    addCol("content", content);
    addCol("confidence", 0.8);
    addCol("source_agent", "frieren-tui");
    addCol("evidence", null);
    addCol("tags", JSON.stringify((entry.tags ?? []).filter(Boolean)));
    addCol("created_at", now);
    addCol("updated_at", now);
    addCol("status", "active");
    addCol("abstract", content.slice(0, 240));
    addCol("summary", content.slice(0, 120));
    addCol("realm", entry.realm?.trim() || null);
    addCol("suite", entry.suite?.trim() || null);
    addCol("kind", entry.kind?.trim() || null);
    addCol("agent_id", "frieren-tui");

    if (colList.length === 0) {
      return null;
    }

    handle.db
      .query(`INSERT INTO wisdom_entries (${colList.join(", ")}) VALUES (${valList.join(", ")})`)
      .run(...params);

    clearCache();
    return id;
  } catch {
    return null;
  } finally {
    handle.close();
  }
}

export function relateEntries(id1: string, id2: string, relationship: string): boolean {
  const handle = openReadWriteDb(getWisdomDbPath());
  if (!handle) {
    return false;
  }

  try {
    if (!hasTable(handle.db, "wisdom_relations")) {
      return false;
    }

    handle.db
      .query(
        `INSERT INTO wisdom_relations (id, from_id, to_id, relationship, strength, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), id1, id2, relationship.trim(), 0.5, new Date().toISOString());

    clearCache();
    return true;
  } catch {
    return false;
  } finally {
    handle.close();
  }
}

export function updateEntryMeta(id: string, updates: UpdateEntryMetaInput): boolean {
  const handle = openReadWriteDb(getWisdomDbPath());
  if (!handle) {
    return false;
  }

  try {
    if (!hasTable(handle.db, "wisdom_entries")) {
      return false;
    }

    const assignments: string[] = [];
    const params: Array<string> = [];

    if (updates.tags) {
      assignments.push("tags = ?");
      params.push(JSON.stringify(updates.tags.filter(Boolean)));
    }

    if (updates.kind !== undefined) {
      assignments.push("kind = ?");
      params.push(updates.kind.trim());
    }

    if (updates.realm !== undefined) {
      assignments.push("realm = ?");
      params.push(updates.realm.trim());
    }

    if (updates.suite !== undefined) {
      assignments.push("suite = ?");
      params.push(updates.suite.trim());
    }

    if (assignments.length === 0) {
      return true;
    }

    assignments.push("updated_at = ?");
    params.push(new Date().toISOString(), id);

    const info = handle.db
      .query(`UPDATE wisdom_entries SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...params);

    if ((info.changes ?? 0) > 0) {
      clearCache();
      return true;
    }

    return false;
  } catch {
    return false;
  } finally {
    handle.close();
  }
}

export function softDeleteEntry(id: string): boolean {
  const handle = openReadWriteDb(getWisdomDbPath());
  if (!handle) {
    return false;
  }

  try {
    if (!hasTable(handle.db, "wisdom_entries")) {
      return false;
    }

    const row = handle.db
      .query<{ tags: string | null }, [string]>("SELECT tags FROM wisdom_entries WHERE id = ? LIMIT 1")
      .get(id);
    const tags = new Set(parseJsonArray(row?.tags));
    tags.add("DELETE");

    const info = handle.db
      .query(
        `UPDATE wisdom_entries
         SET status = 'deleted', tags = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify([...tags]), new Date().toISOString(), id);

    if ((info.changes ?? 0) > 0) {
      clearCache();
      return true;
    }

    return false;
  } catch {
    return false;
  } finally {
    handle.close();
  }
}

export function clearCache(): void {
  queryCache.clear();
}

export function getMemoryTimeline(
  entityId: string,
  since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
): MemoryTimelineEntry[] {
  return withCache(getCacheKey("getMemoryTimeline", [entityId, since]), () => {
    const timeline: MemoryTimelineEntry[] = [];

    const wisdomHandle = openReadonlyDb(getWisdomDbPath());
  if (wisdomHandle) {
    try {
      if (hasTable(wisdomHandle.db, "wisdom_entries")) {
        const rows = wisdomHandle.db
          .query<
            { id: string; type: string; content: string; created_at: string },
            [string, string, string]
          >(
            `SELECT id, type, content, created_at
             FROM wisdom_entries
             WHERE (id = ? OR content LIKE ?) AND created_at >= ?
             ORDER BY created_at ASC`,
          )
          .all(entityId, `%${entityId}%`, since);

        timeline.push(
          ...rows.map((row) => ({
            id: row.id,
            timestamp: row.created_at,
            plane: "wisdom" as const,
            event_type: row.type,
            content: row.content.slice(0, 200),
          })),
        );
      }
    } catch {
      // ignore unreadable wisdom db
    } finally {
      wisdomHandle.close();
    }
  }

  for (const dbPath of getDbFiles(getSessionsDir()).slice(0, 20)) {
    const handle = openReadonlyDb(dbPath);
    if (!handle) {
      continue;
    }

    try {
      if (!hasTable(handle.db, "session_events")) {
        continue;
      }

      const rows = handle.db
        .query<
          { id: string; event_type: string; content: string; created_at: string },
          [string, string, string, string]
        >(
          `SELECT id, event_type, content, created_at
           FROM session_events
           WHERE (id = ? OR session_id = ? OR content LIKE ?) AND created_at >= ?
           ORDER BY created_at ASC`,
        )
        .all(entityId, entityId, `%${entityId}%`, since);

      timeline.push(
        ...rows.map((row) => ({
          id: row.id,
          timestamp: row.created_at,
          plane: "session" as const,
          event_type: row.event_type,
          content: row.content.slice(0, 200),
        })),
      );
    } catch {
      continue;
    } finally {
      handle.close();
    }
  }

  for (const dbPath of getDbFiles(getIndexDir()).slice(0, 20)) {
    const handle = openReadonlyDb(dbPath);
    if (!handle) {
      continue;
    }

    try {
      if (!hasTable(handle.db, "code_chunks")) {
        continue;
      }

      const rows = handle.db
        .query<
          {
            id: string;
            chunk_type: string;
            content: string;
            file_path: string;
            name: string | null;
            indexed_at: string;
          },
          [string, string, string, string, string]
        >(
          `SELECT id, chunk_type, content, file_path, name, indexed_at
           FROM code_chunks
           WHERE (id = ? OR file_path LIKE ? OR name LIKE ? OR content LIKE ?) AND indexed_at >= ?
           ORDER BY indexed_at ASC`,
        )
        .all(entityId, `%${entityId}%`, `%${entityId}%`, `%${entityId}%`, since);

      timeline.push(
        ...rows.map((row) => ({
          id: row.id,
          timestamp: row.indexed_at,
          plane: "codebase" as const,
          event_type: row.chunk_type,
          content: `${row.file_path}${row.name ? ` :: ${row.name}` : ""}\n${row.content.slice(0, 150)}`,
        })),
      );
    } catch {
      continue;
    } finally {
      handle.close();
    }
  }

    return timeline.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  });
}
