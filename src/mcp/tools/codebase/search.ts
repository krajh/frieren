import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";
import { applyCodebaseMigrations } from "../../../db/codebase-schema.js";
import { detectProjectId } from "../../../project/detectProjectId.js";

type ChunkResult = {
  score: number;
  file_path: string;
  name: string | null;
  chunk_type: string;
  start_line: number | null;
  content: string;
};

const matchesGlob = (filePath: string, pattern: string): boolean => {
  // Simple glob: support ** and *
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DSTAR__/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filePath);
};

export const registerCodebaseSearchTool = (server: McpServer): void => {
  server.registerTool(
    "codebase_search",
    {
      description: "Semantic + keyword search over indexed source code.",
      inputSchema: {
        query: z.string().describe("Search query"),
        project_id: z
          .string()
          .optional()
          .describe("Project ID (auto-detected if omitted)"),
        root_path: z
          .string()
          .optional()
          .describe("Project root path (auto-detected from git if omitted)"),
        file_filter: z
          .string()
          .optional()
          .describe("Glob pattern to filter files (e.g. src/**/*.ts)"),
        chunk_type: z
          .enum(["function", "class", "module", "block"])
          .optional()
          .describe("Filter by chunk type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 10)"),
      },
    },
    async (args) => {
      const { query, file_filter, chunk_type, limit = 10 } = args;

      const resolvedProjectId =
        args.project_id ?? detectProjectId(args.root_path) ?? "unknown";
      const { db, vecLoaded } = initDb("index", resolvedProjectId);
      applyCodebaseMigrations(db, vecLoaded);

      let results: ChunkResult[] = [];

      if (vecLoaded) {
        const { vectors, error } = await embedTexts([query]);
        if (!error && vectors[0]) {
          try {
            type VecRow = {
              chunk_id: string;
              distance: number;
            };
            const vecRows = db
              .query<
                VecRow,
                [Uint8Array, number]
              >(`SELECT chunk_id, distance FROM code_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
              .all(new Uint8Array(vectors[0].buffer), limit * 2);

            if (vecRows.length > 0) {
              const ids = vecRows.map((r) => r.chunk_id);
              const distMap = new Map(
                vecRows.map((r) => [r.chunk_id, r.distance]),
              );

              type ChunkRow = {
                id: string;
                file_path: string;
                name: string | null;
                chunk_type: string;
                start_line: number | null;
                content: string;
              };

              const placeholders = ids.map(() => "?").join(",");
              const rows = db
                .query<ChunkRow, string[]>(
                  `SELECT id, file_path, name, chunk_type, start_line, content
                   FROM code_chunks
                   WHERE project_id = ? AND id IN (${placeholders})${chunk_type ? " AND chunk_type = ?" : ""}`,
                )
                .all(
                  resolvedProjectId,
                  ...ids,
                  ...(chunk_type ? [chunk_type] : []),
                );

              results = rows.map((row) => ({
                score: 1 - (distMap.get(row.id) ?? 1),
                file_path: row.file_path,
                name: row.name,
                chunk_type: row.chunk_type,
                start_line: row.start_line,
                content: row.content,
              }));
            }
          } catch {
            // vec search failed, fall through to keyword
            results = [];
          }
        }
      }

      // Keyword fallback (or supplement if vec returned nothing)
      if (results.length === 0) {
        const likePattern = `%${query}%`;
        type ChunkRow = {
          file_path: string;
          name: string | null;
          chunk_type: string;
          start_line: number | null;
          content: string;
        };
        const rows = db
          .query<ChunkRow, string[]>(
            `SELECT file_path, name, chunk_type, start_line, content
             FROM code_chunks
             WHERE project_id = ?
               AND (content LIKE ? OR name LIKE ?)
               ${chunk_type ? "AND chunk_type = ?" : ""}
             LIMIT ?`,
          )
          .all(
            resolvedProjectId,
            likePattern,
            likePattern,
            ...(chunk_type ? [chunk_type] : []),
            String(limit),
          );

        results = rows.map((row) => ({
          score: 0.5,
          file_path: row.file_path,
          name: row.name,
          chunk_type: row.chunk_type,
          start_line: row.start_line,
          content: row.content,
        }));
      }

      // Apply file filter
      if (file_filter) {
        results = results.filter((r) => matchesGlob(r.file_path, file_filter));
      }

      // Sort by score desc and cap
      results = results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => ({
          ...r,
          content: r.content.slice(0, 500),
        }));

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
