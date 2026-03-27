import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";
import { detectProjectId } from "../../../project/detectProjectId.js";

type EventRow = {
  id: string;
  session_id: string;
  project_id: string;
  event_type: string;
  content: string;
  abstract: string | null;
  summary: string | null;
  artifacts: string | null;
  created_at: string;
};

type ScoredEvent = EventRow & { score: number };

const FIDELITY_LEVELS = ["L0", "L1", "L2"] as const;
type Fidelity = (typeof FIDELITY_LEVELS)[number];

const renderByFidelity = (
  content: string,
  abstract: string | null,
  summary: string | null,
  fidelity: Fidelity,
): string => {
  if (fidelity === "L0") {
    return abstract ?? content.slice(0, 150);
  }

  if (fidelity === "L1") {
    return summary ?? content.slice(0, 500);
  }

  return content;
};

export const registerSessionRecallTool = (server: McpServer): void => {
  server.registerTool(
    "session_recall",
    {
      description: "Search events in session history.",
      inputSchema: {
        query: z.string().describe("Search query"),
        session_id: z
          .string()
          .optional()
          .describe(
            "Scope to a specific session (all project sessions if omitted)",
          ),
        project_id: z
          .string()
          .optional()
          .describe("Project ID (auto-detected if omitted)"),
        since: z
          .string()
          .optional()
          .describe("ISO date string — only return events after this date"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum results (default 20)"),
        fidelity: z
          .enum(FIDELITY_LEVELS)
          .optional()
          .describe("Response fidelity: L0=abstract, L1=summary, L2=full"),
      },
    },
    async (args) => {
      const {
        query,
        session_id,
        project_id,
        since,
        limit = 20,
        fidelity = "L1",
      } = args;

      const resolvedProjectId = project_id ?? detectProjectId() ?? "unknown";
      const { db, vecLoaded } = initDb("session", resolvedProjectId);

      let results: ScoredEvent[] = [];

      if (vecLoaded) {
        const { vectors, error } = await embedTexts([query]);
        if (!error && vectors.length > 0 && vectors[0]) {
          try {
            type VecRow = { event_id: string; distance: number };
            const vecRows = db
              .query<VecRow, [Uint8Array, number]>(
                `SELECT event_id, distance FROM session_vec
                 ORDER BY vec_distance_cosine(embedding, ?) LIMIT ?`,
              )
              .all(new Uint8Array(vectors[0].buffer), limit * 2);

            if (vecRows.length > 0) {
              const ids = vecRows.map((r) => r.event_id);
              const distanceMap = new Map(
                vecRows.map((r) => [r.event_id, r.distance]),
              );

              const placeholders = ids.map(() => "?").join(",");
              let sql = `SELECT id, session_id, project_id, event_type, content, abstract, summary, artifacts, created_at FROM session_events WHERE id IN (${placeholders})`;
              const params: (string | number)[] = [...ids];

              if (session_id) {
                sql += ` AND session_id = ?`;
                params.push(session_id);
              }
              if (since) {
                sql += ` AND created_at >= ?`;
                params.push(since);
              }

              const rows = db
                .query<EventRow, (string | number)[]>(sql)
                .all(...params);
              results = rows
                .map((r) => ({ ...r, score: 1 - (distanceMap.get(r.id) ?? 1) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);
            }
          } catch {
            // vec search failed — fall through to keyword search
          }
        }
      }

      // Keyword fallback (also used when vec returns no results)
      if (results.length === 0) {
        let sql = `SELECT id, session_id, project_id, event_type, content, abstract, summary, artifacts, created_at FROM session_events WHERE content LIKE ? AND project_id = ?`;
        const params: (string | number)[] = [`%${query}%`, resolvedProjectId];

        if (session_id) {
          sql += ` AND session_id = ?`;
          params.push(session_id);
        }
        if (since) {
          sql += ` AND created_at >= ?`;
          params.push(since);
        }

        sql += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);

        const rows = db
          .query<EventRow, (string | number)[]>(sql)
          .all(...params);
        results = rows.map((r) => ({ ...r, score: 0.5 }));
      }

      db.close();

      const fidelityResults = results.map((result) => ({
        ...result,
        content: renderByFidelity(
          result.content,
          result.abstract,
          result.summary,
          fidelity,
        ),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(fidelityResults),
          },
        ],
      };
    },
  );
};
