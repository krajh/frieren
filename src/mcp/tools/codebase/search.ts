import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";
import { applyCodebaseMigrations } from "../../../db/codebase-schema.js";
import { detectProjectId } from "../../../project/detectProjectId.js";
import {
  createEmptyTrajectory,
  writeRetrievalLog,
} from "../debug/retrieval-log.js";

type ChunkResult = {
  score: number;
  file_path: string;
  dir_path: string | null;
  name: string | null;
  chunk_type: string;
  start_line: number | null;
  content: string;
  abstract: string | null;
  summary: string | null;
};

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
        fidelity: z
          .enum(FIDELITY_LEVELS)
          .optional()
          .describe("Response fidelity: L0=abstract, L1=summary, L2=full"),
        debug: z
          .boolean()
          .optional()
          .describe("Include retrieval trajectory in response"),
        directory_first: z
          .boolean()
          .optional()
          .describe("Use directory-aware two-phase retrieval (default true)"),
      },
    },
    async (args) => {
      const startedAt = performance.now();
      const {
        query,
        file_filter,
        chunk_type,
        limit = 10,
        fidelity = "L1",
        debug = false,
        directory_first = true,
      } = args;

      const resolvedProjectId =
        args.project_id ?? detectProjectId(args.root_path) ?? "unknown";
      const { db, vecLoaded } = initDb("index", resolvedProjectId);
      applyCodebaseMigrations(db, vecLoaded);

      let results: ChunkResult[] = [];
      const trajectory = createEmptyTrajectory();
      let queryEmbedding: Uint8Array | null = null;
      let usedDirectoryScopedVector = false;

      if (vecLoaded) {
        const { vectors, error } = await embedTexts([query]);
        if (!error && vectors[0]) {
          try {
            queryEmbedding = new Uint8Array(vectors[0].buffer);

            const scopedDirectories: string[] = [];
            let useDirectoryScopedSearch = false;

            if (directory_first) {
              try {
                type DirRow = {
                  dir_path: string;
                  distance: number;
                };
                const dirRows = db
                  .query<DirRow, [string, Uint8Array, number]>(
                    `SELECT ds.dir_path, dv.distance
                     FROM dir_vec dv
                     JOIN dir_summaries ds
                       ON dv.dir_key = ds.project_id || '::' || ds.dir_path
                     WHERE ds.project_id = ? AND dv.embedding MATCH ?
                     ORDER BY distance
                     LIMIT ?`,
                  )
                  .all(resolvedProjectId, queryEmbedding, 3);

                const topDirScore =
                  dirRows.length > 0 ? 1 - (dirRows[0]?.distance ?? 1) : 0;
                if (dirRows.length > 0 && topDirScore >= 0.3) {
                  useDirectoryScopedSearch = true;
                  usedDirectoryScopedVector = true;
                  scopedDirectories.push(...dirRows.map((row) => row.dir_path));
                  trajectory.directories_visited.push(...scopedDirectories);
                }
              } catch {
                // dir_summaries unavailable; fallback to flat search
              }
            }

            type VecRow = {
              chunk_id: string;
              distance: number;
            };
            const vecRows = useDirectoryScopedSearch
              ? (() => {
                  const dirPlaceholders = scopedDirectories
                    .map(() => "?")
                    .join(",");
                  return db
                    .query<VecRow, [string, ...string[], Uint8Array, number]>(
                      `SELECT cv.chunk_id, cv.distance
                       FROM code_vec cv
                       JOIN code_chunks cc ON cc.id = cv.chunk_id
                       WHERE cc.project_id = ?
                         AND COALESCE(cc.dir_path, '.') IN (${dirPlaceholders})
                         AND cv.embedding MATCH ?
                       ORDER BY cv.distance
                       LIMIT ?`,
                    )
                    .all(
                      resolvedProjectId,
                      ...scopedDirectories,
                      queryEmbedding,
                      limit * 2,
                    );
                })()
              : db
                  .query<
                    VecRow,
                    [Uint8Array, number]
                  >(`SELECT chunk_id, distance FROM code_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
                  .all(queryEmbedding, limit * 2);

            const effectiveVecRows =
              useDirectoryScopedSearch && vecRows.length === 0
                ? db
                    .query<
                      VecRow,
                      [Uint8Array, number]
                    >(`SELECT chunk_id, distance FROM code_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
                    .all(queryEmbedding, limit * 2)
                : vecRows;

            if (effectiveVecRows.length > 0) {
              const ids = effectiveVecRows.map((r) => r.chunk_id);
              const distMap = new Map(
                effectiveVecRows.map((r) => [r.chunk_id, r.distance]),
              );

              type ChunkRow = {
                id: string;
                file_path: string;
                dir_path: string | null;
                name: string | null;
                chunk_type: string;
                start_line: number | null;
                content: string;
                abstract: string | null;
                summary: string | null;
              };

              const placeholders = ids.map(() => "?").join(",");
              const dirPlaceholders = scopedDirectories
                .map(() => "?")
                .join(",");
              const dirFilterSql =
                useDirectoryScopedSearch && scopedDirectories.length > 0
                  ? ` AND COALESCE(dir_path, '.') IN (${dirPlaceholders})`
                  : "";

              const rows = db
                .query<ChunkRow, string[]>(
                  `SELECT id, file_path, dir_path, name, chunk_type, start_line, content, abstract, summary
                   FROM code_chunks
                   WHERE project_id = ? AND id IN (${placeholders})${dirFilterSql}${chunk_type ? " AND chunk_type = ?" : ""}`,
                )
                .all(
                  resolvedProjectId,
                  ...ids,
                  ...(useDirectoryScopedSearch ? scopedDirectories : []),
                  ...(chunk_type ? [chunk_type] : []),
                );

              const finalRows =
                useDirectoryScopedSearch && rows.length === 0
                  ? db
                      .query<ChunkRow, string[]>(
                        `SELECT id, file_path, dir_path, name, chunk_type, start_line, content, abstract, summary
                         FROM code_chunks
                         WHERE project_id = ? AND id IN (${placeholders})${chunk_type ? " AND chunk_type = ?" : ""}`,
                      )
                      .all(
                        resolvedProjectId,
                        ...ids,
                        ...(chunk_type ? [chunk_type] : []),
                      )
                  : rows;

              results = finalRows.map((row) => ({
                score: 1 - (distMap.get(row.id) ?? 1),
                file_path: row.file_path,
                dir_path: row.dir_path,
                name: row.name,
                chunk_type: row.chunk_type,
                start_line: row.start_line,
                content: row.content,
                abstract: row.abstract,
                summary: row.summary,
              }));

              trajectory.vector_hits.push(
                ...finalRows.map((row) => ({
                  id: row.id,
                  score: 1 - (distMap.get(row.id) ?? 1),
                  plane: "codebase" as const,
                  source: "vector" as const,
                })),
              );
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
          dir_path: string | null;
          name: string | null;
          chunk_type: string;
          start_line: number | null;
          content: string;
          abstract: string | null;
          summary: string | null;
        };
        const rows = db
          .query<ChunkRow, string[]>(
            `SELECT file_path, dir_path, name, chunk_type, start_line, content, abstract, summary
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
          dir_path: row.dir_path,
          name: row.name,
          chunk_type: row.chunk_type,
          start_line: row.start_line,
          content: row.content,
          abstract: row.abstract,
          summary: row.summary,
        }));

        trajectory.keyword_hits.push(
          ...rows.map((row) => ({
            id: `${row.file_path}:${row.start_line ?? 0}:${row.name ?? ""}`,
            score: 0.5,
            plane: "codebase" as const,
            source: "keyword" as const,
          })),
        );
      }

      // Apply file filter
      if (file_filter) {
        results = results.filter((r) => matchesGlob(r.file_path, file_filter));

        if (
          results.length === 0 &&
          vecLoaded &&
          queryEmbedding &&
          usedDirectoryScopedVector
        ) {
          type VecRow = {
            chunk_id: string;
            distance: number;
          };
          const fallbackVecRows = db
            .query<
              VecRow,
              [Uint8Array, number]
            >(`SELECT chunk_id, distance FROM code_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`)
            .all(queryEmbedding, limit * 8);

          if (fallbackVecRows.length > 0) {
            const fallbackIds = fallbackVecRows.map((row) => row.chunk_id);
            const fallbackDistMap = new Map(
              fallbackVecRows.map((row) => [row.chunk_id, row.distance]),
            );
            const placeholders = fallbackIds.map(() => "?").join(",");

            type ChunkRow = {
              id: string;
              file_path: string;
              dir_path: string | null;
              name: string | null;
              chunk_type: string;
              start_line: number | null;
              content: string;
              abstract: string | null;
              summary: string | null;
            };

            const fallbackRows = db
              .query<ChunkRow, string[]>(
                `SELECT id, file_path, dir_path, name, chunk_type, start_line, content, abstract, summary
                 FROM code_chunks
                 WHERE project_id = ? AND id IN (${placeholders})${chunk_type ? " AND chunk_type = ?" : ""}`,
              )
              .all(
                resolvedProjectId,
                ...fallbackIds,
                ...(chunk_type ? [chunk_type] : []),
              )
              .map((row) => ({
                score: 1 - (fallbackDistMap.get(row.id) ?? 1),
                file_path: row.file_path,
                dir_path: row.dir_path,
                name: row.name,
                chunk_type: row.chunk_type,
                start_line: row.start_line,
                content: row.content,
                abstract: row.abstract,
                summary: row.summary,
              }))
              .filter((row) => matchesGlob(row.file_path, file_filter));

            if (fallbackRows.length > 0) {
              results = fallbackRows;
              trajectory.vector_hits.push(
                ...fallbackRows.map((row) => ({
                  id: `${row.file_path}:${row.start_line ?? 0}:${row.name ?? ""}`,
                  score: row.score,
                  plane: "codebase" as const,
                  source: "vector" as const,
                })),
              );
            }
          }
        }
      }

      trajectory.directories_visited = Array.from(
        new Set([
          ...trajectory.directories_visited,
          ...results.map((r) => {
            const slash = r.file_path.lastIndexOf("/");
            return slash >= 0 ? r.file_path.slice(0, slash) : ".";
          }),
        ]),
      );

      // Sort by score desc and cap
      results = results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => ({
          ...r,
          content: renderByFidelity(r.content, r.abstract, r.summary, fidelity),
        }));

      trajectory.final_results = results.map((r) => ({
        id: `${r.file_path}:${r.start_line ?? 0}:${r.name ?? ""}`,
        score: r.score,
        plane: "codebase",
        source:
          trajectory.vector_hits.length > 0
            ? "vector"
            : trajectory.keyword_hits.length > 0
              ? "keyword"
              : "keyword",
      }));

      writeRetrievalLog({
        query: "[redacted]",
        planesSearched: ["codebase"],
        resultsCount: results.length,
        graphExpansions: trajectory.graph_expansions.length,
        trajectory,
        durationMs: performance.now() - startedAt,
      });

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(debug ? { results, trajectory } : results),
          },
        ],
      };
    },
  );
};
