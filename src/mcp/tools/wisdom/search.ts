import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";
import {
  createEmptyTrajectory,
  writeRetrievalLog,
} from "../debug/retrieval-log.js";

const WISDOM_TYPES = ["decision", "pattern", "constraint", "issue"] as const;
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

type WisdomRow = {
  id: string;
  type: string;
  content: string;
  abstract: string | null;
  summary: string | null;
  confidence: number;
  evidence: string | null;
  project_id: string | null;
  tags: string | null;
  status: string | null;
  realm: string | null;
  suite: string | null;
  kind: string | null;
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
        // OpenCode taxonomy filters
        realm: z
          .string()
          .optional()
          .describe("Filter by realm (top-level domain)"),
        suite: z
          .string()
          .optional()
          .describe("Filter by suite (group within realm)"),
        kind: z
          .string()
          .optional()
          .describe(
            "Filter by kind (memory type: facts, events, discoveries, preferences, advice)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results (default 10)"),
        fidelity: z
          .enum(FIDELITY_LEVELS)
          .optional()
          .describe("Response fidelity: L0=abstract, L1=summary, L2=full"),
        debug: z
          .boolean()
          .optional()
          .describe("Include retrieval trajectory in response"),
      },
    },
    async (args) => {
      const startedAt = performance.now();
      const {
        query,
        type_filter,
        project_id,
        realm,
        suite,
        kind,
        limit = 10,
        fidelity = "L1",
        debug = false,
      } = args;

      const { db, vecLoaded } = initDb("wisdom");

      let results: SearchResult[] = [];
      const trajectory = createEmptyTrajectory();

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
            if (realm) {
              conditions.push("we.realm = ?");
              params.push(realm);
            }
            if (suite) {
              conditions.push("we.suite = ?");
              params.push(suite);
            }
            if (kind) {
              conditions.push("we.kind = ?");
              params.push(kind);
            }

            const whereClause =
              conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

            const rows = db
              .query<WisdomRow & { distance: number }, typeof params>(
                `SELECT we.id, we.type, we.content, we.confidence,
                        we.abstract, we.summary, we.evidence,
                        we.project_id, we.tags, we.status,
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

            trajectory.vector_hits.push(
              ...results.map((r) => ({
                id: r.id,
                score: r.score,
                plane: "wisdom" as const,
                source: "vector" as const,
              })),
            );
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
        if (realm) {
          conditions.push("realm = ?");
          params.push(realm);
        }
        if (suite) {
          conditions.push("suite = ?");
          params.push(suite);
        }
        if (kind) {
          conditions.push("kind = ?");
          params.push(kind);
        }
        params.push(limit);

        const rows = db
          .query<WisdomRow, typeof params>(
            `SELECT id, type, content, confidence, evidence, project_id,
                    abstract, summary, tags, status, realm, suite, kind, created_at, updated_at
             FROM wisdom_entries
             WHERE ${conditions.join(" AND ")}
             LIMIT ?`,
          )
          .all(...params);

        results = rows.map((r) => ({ ...r, score: 0.5 }));

        trajectory.keyword_hits.push(
          ...results.map((r) => ({
            id: r.id,
            score: r.score,
            plane: "wisdom" as const,
            source: "keyword" as const,
          })),
        );
      }

      const finalResults = results;
      const fidelityResults = finalResults.map((result) => ({
        ...result,
        content: renderByFidelity(
          result.content,
          result.abstract,
          result.summary,
          fidelity,
        ),
      }));
      trajectory.final_results = finalResults.map((r) => ({
        id: r.id,
        score: r.score,
        plane: "wisdom",
        source: trajectory.vector_hits.some((hit) => hit.id === r.id)
          ? "vector"
          : trajectory.keyword_hits.some((hit) => hit.id === r.id)
            ? "keyword"
            : "graph",
      }));

      writeRetrievalLog({
        query,
        planesSearched: ["wisdom"],
        resultsCount: trajectory.final_results.length,
        graphExpansions: trajectory.graph_expansions.length,
        trajectory,
        durationMs: performance.now() - startedAt,
      });

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              debug
                ? {
                    results: fidelityResults,
                    trajectory,
                  }
                : fidelityResults,
            ),
          },
        ],
      };
    },
  );
};
