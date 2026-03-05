import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";

const WISDOM_TYPES = ["decision", "pattern", "constraint", "issue"] as const;

type WisdomRow = {
  id: string;
  type: string;
  content: string;
  confidence: number;
  evidence: string | null;
  project_id: string | null;
  tags: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
};

type SearchResult = WisdomRow & { score: number };

export const registerWisdomSearchTool = (server: McpServer): void => {
  server.registerTool(
    "wisdom_search",
    {
      description:
        "Search the Frieren wisdom plane by semantic or keyword query.",
      inputSchema: {
        query: z.string().describe("Search query"),
        type_filter: z
          .enum(WISDOM_TYPES)
          .optional()
          .describe("Filter by wisdom type"),
        project_id: z.string().optional().describe("Filter by project ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results (default 10)"),
      },
    },
    async (args) => {
      const { query, type_filter, project_id, limit = 10 } = args;

      const { db, vecLoaded } = initDb("wisdom");

      let results: SearchResult[] = [];

      if (vecLoaded) {
        const { vectors, error } = await embedTexts([query]);
        if (!error && vectors.length > 0 && vectors[0]) {
          try {
            const conditions: string[] = [];
            const params: (string | number | Uint8Array)[] = [
              new Uint8Array(vectors[0].buffer),
              limit,
            ];

            if (type_filter) {
              conditions.push("we.type = ?");
              params.push(type_filter);
            }
            if (project_id) {
              conditions.push("we.project_id = ?");
              params.push(project_id);
            }

            const whereClause =
              conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

            const rows = db
              .query<WisdomRow & { distance: number }, typeof params>(
                `SELECT we.id, we.type, we.content, we.confidence,
                        we.evidence, we.project_id, we.tags, we.status,
                        we.created_at, we.updated_at, vd.distance
                 FROM wisdom_vec vd
                 JOIN wisdom_entries we ON we.id = vd.entry_id
                 WHERE vd.embedding MATCH ? AND k = ?
                 ${whereClause}
                 ORDER BY vd.distance`,
              )
              .all(...params);

            results = rows.map((r) => ({
              ...r,
              score: 1 - r.distance,
            }));
          } catch {
            // vec search failed — fall through to keyword search
          }
        }
      }

      if (results.length === 0) {
        const conditions: string[] = ["content LIKE ?"];
        const params: (string | number)[] = [`%${query}%`];

        if (type_filter) {
          conditions.push("type = ?");
          params.push(type_filter);
        }
        if (project_id) {
          conditions.push("project_id = ?");
          params.push(project_id);
        }
        params.push(limit);

        const rows = db
          .query<WisdomRow, typeof params>(
            `SELECT id, type, content, confidence, evidence, project_id,
                    tags, status, created_at, updated_at
             FROM wisdom_entries
             WHERE ${conditions.join(" AND ")}
             LIMIT ?`,
          )
          .all(...params);

        results = rows.map((r) => ({ ...r, score: 0.5 }));
      }

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results),
          },
        ],
      };
    },
  );
};
