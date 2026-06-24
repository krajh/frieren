import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Database } from "../../db/database.js";

import { loadConfig, loadProjectNames } from "../../config.js";
import { initDb } from "../../db/init.js";
import { detectProjectInfo } from "../../project/detectProjectId.js";
import {
  getIndexDbPath,
  getIndexDir,
  getSessionsDir,
  getWisdomDbPath,
} from "../../utils/paths.js";

type SessionStats = {
  total_events: number;
  active_sessions: number;
  oldest_event: string | null;
};

type CodebaseProjectStat = {
  project_id: string;
  display_name: string;
  file_count: number;
  chunk_count: number;
  last_indexed: string;
};

type StatusResponse = {
  storage: {
    home: string;
  };
  wisdom: {
    path: string;
    exists: boolean;
    sizeBytes: number | null;
    vec: string;
    stats: {
      total: number;
      by_type: {
        decisions: number;
        patterns: number;
        constraints: number;
        issues: number;
      };
      vec_enabled: boolean;
    };
  };
  session: {
    projectId: string | null;
    displayName?: string;
    stats: SessionStats;
  };
  index: {
    projectId: string | null;
    displayName?: string;
    path: string | null;
    exists: boolean;
    sizeBytes: number | null;
    vec: string;
  };
  codebase: {
    indexed_projects: CodebaseProjectStat[];
  };
  embeddings: {
    queueDepth: number;
  };
};

const safeStat = (
  path: string,
): { exists: boolean; sizeBytes: number | null } => {
  try {
    const stats = statSync(path);
    return { exists: true, sizeBytes: stats.size };
  } catch {
    return { exists: false, sizeBytes: null };
  }
};

const aggregateSessionStats = (): SessionStats => {
  const sessionsDir = getSessionsDir();
  let totalEvents = 0;
  let activeSessions = 0;
  let oldestEvent: string | null = null;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".db"));
  } catch {
    return { total_events: 0, active_sessions: 0, oldest_event: null };
  }

  for (const file of dbFiles) {
    const dbPath = join(sessionsDir, file);
    let db: Database | null = null;
    try {
      db = new Database(dbPath);

      type CountRow = { count: number };
      const evtCount = db
        .query<CountRow, []>(`SELECT COUNT(*) as count FROM session_events`)
        .get();
      if (evtCount) totalEvents += evtCount.count;

      type ActiveRow = { count: number };
      const activeCount = db
        .query<
          ActiveRow,
          []
        >(`SELECT COUNT(*) as count FROM sessions WHERE ended_at IS NULL`)
        .get();
      if (activeCount) activeSessions += activeCount.count;

      type OldestRow = { oldest: string | null };
      const oldest = db
        .query<
          OldestRow,
          []
        >(`SELECT MIN(created_at) as oldest FROM session_events`)
        .get();
      if (oldest?.oldest) {
        if (!oldestEvent || oldest.oldest < oldestEvent) {
          oldestEvent = oldest.oldest;
        }
      }
    } catch {
      // skip unreadable DB
    } finally {
      db?.close();
    }
  }

  return {
    total_events: totalEvents,
    active_sessions: activeSessions,
    oldest_event: oldestEvent,
  };
};

const aggregateCodebaseStats = (): CodebaseProjectStat[] => {
  const indexDir = getIndexDir();
  const stats: CodebaseProjectStat[] = [];

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(indexDir).filter((f) => f.endsWith(".db"));
  } catch {
    return stats;
  }

  for (const file of dbFiles) {
    const dbPath = join(indexDir, file);
    let db: Database | null = null;
    try {
      db = new Database(dbPath);
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
      const names = loadProjectNames();
      const resolveName = (pid: string): string => names[pid] ?? pid.slice(0, 8);
      for (const row of rows) {
        stats.push({
          project_id: row.project_id,
          display_name: resolveName(row.project_id),
          file_count: row.file_count,
          chunk_count: row.chunk_count,
          last_indexed: row.indexed_at,
        });
      }
    } catch {
      // skip unreadable DB
    } finally {
      db?.close();
    }
  }

  return stats;
};

export const registerStatusTool = (server: McpServer): void => {
  server.registerTool(
    "frieren_status",
    {
      description: "Report Frieren storage and plane health.",
    },
    async () => {
      const config = loadConfig();
      const projectInfo = detectProjectInfo();
      const projectId = projectInfo?.projectId ?? null;
      const projectNames = loadProjectNames();
      const resolveName = (pid: string): string => projectNames[pid] ?? pid.slice(0, 8);

      const wisdomPath = getWisdomDbPath();
      const wisdomStats = safeStat(wisdomPath);
      const wisdomInit = initDb("wisdom");

      type TypeCount = { type: string; count: number };
      const typeCounts = wisdomInit.db
        .query<
          TypeCount,
          []
        >(`SELECT type, COUNT(*) as count FROM wisdom_entries GROUP BY type`)
        .all();

      const byType = { decisions: 0, patterns: 0, constraints: 0, issues: 0 };
      let totalWisdom = 0;
      for (const row of typeCounts) {
        totalWisdom += row.count;
        if (row.type === "decision") byType.decisions = row.count;
        else if (row.type === "pattern") byType.patterns = row.count;
        else if (row.type === "constraint") byType.constraints = row.count;
        else if (row.type === "issue") byType.issues = row.count;
      }

      wisdomInit.db.close();

      const sessionStats = aggregateSessionStats();

      const indexPath = projectId ? getIndexDbPath(projectId) : null;
      const indexStats = indexPath
        ? safeStat(indexPath)
        : { exists: false, sizeBytes: null };
      const indexInit = projectId
        ? initDb("index", projectId)
        : { vecLoaded: false };

      const response: StatusResponse = {
        storage: {
          home: config.storage.home,
        },
        wisdom: {
          path: wisdomPath,
          ...wisdomStats,
          vec: wisdomInit.vecLoaded
            ? "ok"
            : "unavailable (extension not loaded)",
          stats: {
            total: totalWisdom,
            by_type: byType,
            vec_enabled: wisdomInit.vecLoaded,
          },
        },
        session: {
          projectId,
          displayName: projectId ? resolveName(projectId) : undefined,
          stats: sessionStats,
        },
        index: {
          projectId,
          displayName: projectId ? resolveName(projectId) : undefined,
          path: indexPath,
          ...indexStats,
          vec: indexInit.vecLoaded
            ? "ok"
            : "unavailable (extension not loaded)",
        },
        codebase: {
          indexed_projects: aggregateCodebaseStats(),
        },
        embeddings: {
          queueDepth: 0,
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    },
  );
};
