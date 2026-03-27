import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";
import { parseJsonField } from "./retrieval-log.js";

type RetrievalLogRow = {
  id: string;
  query: string;
  planes_searched: string;
  results_count: number;
  graph_expansions: number;
  trajectory: string;
  duration_ms: number;
  created_at: string;
};

export const registerRetrievalDebugTool = (server: McpServer): void => {
  server.registerTool(
    "retrieval_debug",
    {
      description:
        "Query retrieval trajectory logs by time range, query substring, or plane.",
      inputSchema: {
        from: z.string().optional().describe("ISO datetime start (inclusive)"),
        to: z.string().optional().describe("ISO datetime end (inclusive)"),
        query_contains: z
          .string()
          .optional()
          .describe("Substring match against logged query text"),
        plane: z
          .enum(["wisdom", "session", "codebase"])
          .optional()
          .describe("Filter logs by searched plane"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max log rows to return (default 50)"),
      },
    },
    async (args) => {
      const { from, to, query_contains, plane, limit = 50 } = args;
      const { db } = initDb("wisdom");

      try {
        const where: string[] = [];
        const params: Array<string | number> = [];

        if (from) {
          where.push("created_at >= ?");
          params.push(from);
        }
        if (to) {
          where.push("created_at <= ?");
          params.push(to);
        }
        if (query_contains) {
          where.push("query LIKE ?");
          params.push(`%${query_contains}%`);
        }
        if (plane) {
          where.push("planes_searched LIKE ?");
          params.push(`%\"${plane}\"%`);
        }

        const whereClause =
          where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const rows = db
          .query<RetrievalLogRow, Array<string | number>>(
            `SELECT id, query, planes_searched, results_count, graph_expansions,
                    trajectory, duration_ms, created_at
             FROM retrieval_logs
             ${whereClause}
             ORDER BY created_at DESC
             LIMIT ?`,
          )
          .all(...params, limit);

        const parsed = rows.map((row) => ({
          id: row.id,
          query: row.query,
          planes_searched: parseJsonField<string[]>(row.planes_searched, []),
          results_count: row.results_count,
          graph_expansions: row.graph_expansions,
          trajectory: parseJsonField<Record<string, unknown>>(
            row.trajectory,
            {},
          ),
          duration_ms: row.duration_ms,
          created_at: row.created_at,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed),
            },
          ],
        };
      } finally {
        db.close();
      }
    },
  );
};
