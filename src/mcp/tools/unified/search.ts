import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { embedTexts } from "../../../embedding/client.js";
import { getIndexDir, getSessionsDir } from "../../../utils/paths.js";

import {
  createEmptyTrajectory,
  type RetrievalTrajectory,
  writeRetrievalLog,
} from "../debug/retrieval-log.js";
import { applyCodebaseMigrations } from "../../../db/codebase-schema.js";
import { applySessionMigrations } from "../../../db/session-schema.js";
import { initDb } from "../../../db/init.js";

type Plane = "wisdom" | "session" | "codebase";
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

type SearchResult = {
  id: string;
  plane: Plane;
  type: string;
  content: string;
  score: number;
  source: "vector" | "keyword" | "graph";
  file_path?: string;
  name?: string;
  created_at: string;
};

type PlaneSearchOutcome = {
  results: SearchResult[];
  trajectory: RetrievalTrajectory;
};

// Deduplicate by ID, keeping the highest-scoring entry
const dedup = (results: SearchResult[]): SearchResult[] => {
  const seen = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = seen.get(r.id);
    if (!existing || r.score > existing.score) {
      seen.set(r.id, r);
    }
  }
  return [...seen.values()];
};

const searchWisdom = async (
  query: string,
  embedding: Float32Array | null,
  limit: number,
  fidelity: Fidelity,
): Promise<PlaneSearchOutcome> => {
  const { db, vecLoaded } = initDb("wisdom");
  const results: SearchResult[] = [];
  const trajectory = createEmptyTrajectory();

  type WisdomRow = {
    id: string;
    type: string;
    content: string;
    abstract: string | null;
    summary: string | null;
    created_at: string;
  };

  // Vector search
  if (vecLoaded && embedding) {
    try {
      const vecRows = db
        .query<WisdomRow & { distance: number }, [Uint8Array, number]>(
          `SELECT we.id, we.type, we.content, we.abstract, we.summary, we.created_at, vd.distance
           FROM wisdom_vec vd
           JOIN wisdom_entries we ON we.id = vd.entry_id
           WHERE vd.embedding MATCH ? AND k = ?
           ORDER BY vd.distance`,
        )
        .all(new Uint8Array(embedding.buffer), limit);

      for (const r of vecRows) {
        trajectory.vector_hits.push({
          id: r.id,
          score: 1 - r.distance,
          plane: "wisdom",
          source: "vector",
        });
        results.push({
          id: r.id,
          plane: "wisdom",
          type: r.type,
          content: renderByFidelity(r.content, r.abstract, r.summary, fidelity),
          score: 1 - r.distance,
          source: "vector",
          created_at: r.created_at,
        });
      }
    } catch {
      // vec search failed — fall through to keyword
    }
  }

  // Keyword fallback
  if (results.length === 0) {
    const rows = db
      .query<WisdomRow, [string, number]>(
        `SELECT id, type, content, abstract, summary, created_at FROM wisdom_entries
         WHERE content LIKE ? LIMIT ?`,
      )
      .all(`%${query}%`, limit);

    for (const r of rows) {
      trajectory.keyword_hits.push({
        id: r.id,
        score: 0.5,
        plane: "wisdom",
        source: "keyword",
      });
      results.push({
        id: r.id,
        plane: "wisdom",
        type: r.type,
        content: renderByFidelity(r.content, r.abstract, r.summary, fidelity),
        score: 0.5,
        source: "keyword",
        created_at: r.created_at,
      });
    }
  }

  // Graph expansion: BFS up to depth 2 on wisdom_relations
  const expanded: SearchResult[] = [];
  const visited = new Set(results.map((r) => r.id));
  let frontier = results.map((r) => ({ id: r.id, hop: 0 }));
  let totalExpanded = 0;

  while (frontier.length > 0 && totalExpanded < 50) {
    const nextFrontier: Array<{ id: string; hop: number }> = [];

    for (const { id, hop } of frontier) {
      if (hop >= 2) continue;

      type RelRow = { from_id: string; to_id: string; relationship: string };
      const relRows = db
        .query<RelRow, [string, string]>(
          `SELECT from_id, to_id, relationship FROM wisdom_relations
           WHERE from_id = ? OR to_id = ?`,
        )
        .all(id, id);

      for (const rel of relRows) {
        const neighborId = rel.from_id === id ? rel.to_id : rel.from_id;
        if (visited.has(neighborId) || totalExpanded >= 50) continue;

        visited.add(neighborId);
        totalExpanded++;
        trajectory.graph_expansions.push({
          from_id: id,
          to_id: neighborId,
          relation: rel.relationship,
          plane: "wisdom",
        });

        const neighbor = db
          .query<WisdomRow, [string]>(
            `SELECT id, type, content, abstract, summary, created_at
             FROM wisdom_entries WHERE id = ?`,
          )
          .get(neighborId);

        if (neighbor) {
          const hopDecay = 1.0 / (hop + 2); // hop+1 distance from initial hit
          expanded.push({
            id: neighbor.id,
            plane: "wisdom",
            type: neighbor.type,
            content: renderByFidelity(
              neighbor.content,
              neighbor.abstract,
              neighbor.summary,
              fidelity,
            ),
            score: hopDecay * 0.3,
            source: "graph",
            created_at: neighbor.created_at,
          });
          nextFrontier.push({ id: neighborId, hop: hop + 1 });
        }
      }
    }

    frontier = nextFrontier;
  }

  db.close();
  return { results: [...results, ...expanded], trajectory };
};

const searchSession = async (
  query: string,
  embedding: Float32Array | null,
  limit: number,
  fidelity: Fidelity,
): Promise<PlaneSearchOutcome> => {
  // Scan all project session DBs
  let sessionDbFiles: string[] = [];
  try {
    const sessionsDir = getSessionsDir();
    sessionDbFiles = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => join(sessionsDir, f));
  } catch {
    return { results: [], trajectory: createEmptyTrajectory() };
  }

  const allResults: SearchResult[] = [];
  const trajectory = createEmptyTrajectory();

  for (const dbPath of sessionDbFiles.slice(0, 10)) {
    // cap at 10 projects
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);
      applySessionMigrations(db, true);

      type EventRow = {
        id: string;
        event_type: string;
        content: string;
        abstract: string | null;
        summary: string | null;
        created_at: string;
      };

      let results: SearchResult[] = [];

      if (embedding) {
        try {
          type VecRow = { event_id: string; distance: number };
          const vecRows = db
            .query<VecRow, [Uint8Array, number]>(
              `SELECT event_id, distance FROM session_vec
               ORDER BY vec_distance_cosine(embedding, ?) LIMIT ?`,
            )
            .all(new Uint8Array(embedding.buffer), limit);

          if (vecRows.length > 0) {
            const ids = vecRows.map((r) => r.event_id);
            const distMap = new Map(
              vecRows.map((r) => [r.event_id, r.distance]),
            );
            const placeholders = ids.map(() => "?").join(",");

            const rows = db
              .query<EventRow, string[]>(
                `SELECT id, event_type, content, created_at
                        , abstract, summary
                 FROM session_events WHERE id IN (${placeholders})`,
              )
              .all(...ids);

            results = rows.map((r) => ({
              id: r.id,
              plane: "session" as Plane,
              type: r.event_type,
              content: renderByFidelity(
                r.content,
                r.abstract,
                r.summary,
                fidelity,
              ),
              score: 1 - (distMap.get(r.id) ?? 1),
              source: "vector" as const,
              created_at: r.created_at,
            }));

            trajectory.vector_hits.push(
              ...results.map((r) => ({
                id: r.id,
                score: r.score,
                plane: "session" as const,
                source: "vector" as const,
              })),
            );
          }
        } catch {
          // no vec table in this DB
        }
      }

      if (results.length === 0) {
        const rows = db
          .query<EventRow, [string, number]>(
            `SELECT id, event_type, content, abstract, summary, created_at
             FROM session_events WHERE content LIKE ? LIMIT ?`,
          )
          .all(`%${query}%`, limit);

        results = rows.map((r) => ({
          id: r.id,
          plane: "session" as Plane,
          type: r.event_type,
          content: renderByFidelity(r.content, r.abstract, r.summary, fidelity),
          score: 0.5,
          source: "keyword" as const,
          created_at: r.created_at,
        }));

        trajectory.keyword_hits.push(
          ...results.map((r) => ({
            id: r.id,
            score: r.score,
            plane: "session" as const,
            source: "keyword" as const,
          })),
        );
      }

      db.close();
      allResults.push(...results);
    } catch {
      // skip unreadable DBs
    }
  }

  return { results: allResults, trajectory };
};

const searchCodebase = async (
  query: string,
  embedding: Float32Array | null,
  limit: number,
  fidelity: Fidelity,
  directoryFirst: boolean,
): Promise<PlaneSearchOutcome> => {
  // Scan all project index DBs
  let indexDbFiles: string[] = [];
  try {
    const indexDir = getIndexDir();
    indexDbFiles = readdirSync(indexDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => join(indexDir, f));
  } catch {
    return { results: [], trajectory: createEmptyTrajectory() };
  }

  const allResults: SearchResult[] = [];
  const trajectory = createEmptyTrajectory();

  for (const dbPath of indexDbFiles.slice(0, 10)) {
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);
      applyCodebaseMigrations(db, true);

      type ChunkRow = {
        id: string;
        chunk_type: string;
        content: string;
        abstract: string | null;
        summary: string | null;
        file_path: string;
        name: string | null;
        indexed_at: string;
      };

      let results: SearchResult[] = [];

      if (embedding) {
        try {
          const queryEmbedding = new Uint8Array(embedding.buffer);
          const scopedDirectories: string[] = [];
          let useDirectoryScopedSearch = false;

          if (directoryFirst) {
            try {
              type DirRow = { dir_path: string; distance: number };
              const dirRows = db
                .query<DirRow, [Uint8Array, number]>(
                  `SELECT ds.dir_path, dv.distance
                   FROM dir_vec dv
                   JOIN dir_summaries ds
                     ON dv.dir_key = ds.project_id || '::' || ds.dir_path
                   WHERE dv.embedding MATCH ?
                   ORDER BY distance
                   LIMIT ?`,
                )
                .all(queryEmbedding, 3);

              const topDirScore =
                dirRows.length > 0 ? 1 - (dirRows[0]?.distance ?? 1) : 0;
              if (dirRows.length > 0 && topDirScore >= 0.3) {
                useDirectoryScopedSearch = true;
                scopedDirectories.push(...dirRows.map((row) => row.dir_path));
                trajectory.directories_visited.push(...scopedDirectories);
              }
            } catch {
              // dir summaries unavailable; continue flat search
            }
          }

          type VecRow = { chunk_id: string; distance: number };
          const vecRows = useDirectoryScopedSearch
            ? (() => {
                const dirPlaceholders = scopedDirectories
                  .map(() => "?")
                  .join(",");
                return db
                  .query<VecRow, [...string[], Uint8Array, number]>(
                    `SELECT cv.chunk_id, cv.distance
                     FROM code_vec cv
                     JOIN code_chunks cc ON cc.id = cv.chunk_id
                     WHERE COALESCE(cc.dir_path, '.') IN (${dirPlaceholders})
                       AND cv.embedding MATCH ?
                     ORDER BY cv.distance
                     LIMIT ?`,
                  )
                  .all(...scopedDirectories, queryEmbedding, limit);
              })()
            : db
                .query<VecRow, [Uint8Array, number]>(
                  `SELECT chunk_id, distance FROM code_vec
                   WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
                )
                .all(queryEmbedding, limit);

          const effectiveVecRows =
            useDirectoryScopedSearch && vecRows.length === 0
              ? db
                  .query<VecRow, [Uint8Array, number]>(
                    `SELECT chunk_id, distance FROM code_vec
                     WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
                  )
                  .all(queryEmbedding, limit)
              : vecRows;

          if (effectiveVecRows.length > 0) {
            const ids = effectiveVecRows.map((r) => r.chunk_id);
            const distMap = new Map(
              effectiveVecRows.map((r) => [r.chunk_id, r.distance]),
            );
            const placeholders = ids.map(() => "?").join(",");
            const dirPlaceholders = scopedDirectories.map(() => "?").join(",");
            const dirFilterSql =
              useDirectoryScopedSearch && scopedDirectories.length > 0
                ? ` AND COALESCE(dir_path, '.') IN (${dirPlaceholders})`
                : "";

            const rows = db
              .query<ChunkRow, string[]>(
                `SELECT id, chunk_type, content, file_path, name, indexed_at
                        , abstract, summary
                 FROM code_chunks WHERE id IN (${placeholders})${dirFilterSql}`,
              )
              .all(
                ...ids,
                ...(useDirectoryScopedSearch ? scopedDirectories : []),
              );

            const finalRows =
              useDirectoryScopedSearch && rows.length === 0
                ? db
                    .query<ChunkRow, string[]>(
                      `SELECT id, chunk_type, content, file_path, name, indexed_at
                              , abstract, summary
                       FROM code_chunks WHERE id IN (${placeholders})`,
                    )
                    .all(...ids)
                : rows;

            results = finalRows.map((r) => ({
              id: r.id,
              plane: "codebase" as Plane,
              type: r.chunk_type,
              content: renderByFidelity(
                r.content,
                r.abstract,
                r.summary,
                fidelity,
              ),
              score: 1 - (distMap.get(r.id) ?? 1),
              source: "vector" as const,
              file_path: r.file_path,
              name: r.name ?? undefined,
              created_at: r.indexed_at,
            }));

            trajectory.vector_hits.push(
              ...finalRows.map((r) => ({
                id: r.id,
                score: 1 - (distMap.get(r.id) ?? 1),
                plane: "codebase" as const,
                source: "vector" as const,
              })),
            );
          }
        } catch {
          // no vec table
        }
      }

      if (results.length === 0) {
        const rows = db
          .query<ChunkRow, [string, string, number]>(
            `SELECT id, chunk_type, content, abstract, summary, file_path, name, indexed_at
             FROM code_chunks WHERE content LIKE ? OR name LIKE ? LIMIT ?`,
          )
          .all(`%${query}%`, `%${query}%`, limit);

        results = rows.map((r) => ({
          id: r.id,
          plane: "codebase" as Plane,
          type: r.chunk_type,
          content: renderByFidelity(r.content, r.abstract, r.summary, fidelity),
          score: 0.5,
          source: "keyword" as const,
          file_path: r.file_path,
          name: r.name ?? undefined,
          created_at: r.indexed_at,
        }));

        trajectory.keyword_hits.push(
          ...results.map((r) => ({
            id: r.id,
            score: r.score,
            plane: "codebase" as const,
            source: "keyword" as const,
          })),
        );
      }

      // Graph expansion: code_deps at depth 1
      const expanded: SearchResult[] = [];
      const visited = new Set(results.map((r) => r.id));
      let totalExpanded = 0;

      for (const hit of results) {
        if (!hit.file_path || totalExpanded >= 50) break;
        trajectory.directories_visited.push(dirname(hit.file_path));

        type DepRow = { from_file: string; to_file: string; dep_type: string };
        const depRows = db
          .query<DepRow, [string, string]>(
            `SELECT from_file, to_file, dep_type FROM code_deps
             WHERE from_file = ? OR to_file = ?`,
          )
          .all(hit.file_path, hit.file_path);

        for (const dep of depRows) {
          const neighborFile =
            dep.from_file === hit.file_path ? dep.to_file : dep.from_file;

          const neighborChunks = db
            .query<ChunkRow, [string, number]>(
              `SELECT id, chunk_type, content, abstract, summary, file_path, name, indexed_at
               FROM code_chunks WHERE file_path = ? LIMIT ?`,
            )
            .all(neighborFile, 3);

          for (const chunk of neighborChunks) {
            if (visited.has(chunk.id) || totalExpanded >= 50) continue;
            visited.add(chunk.id);
            totalExpanded++;
            trajectory.graph_expansions.push({
              from_id: hit.id,
              to_id: chunk.id,
              relation: dep.dep_type,
              plane: "codebase",
            });
            trajectory.directories_visited.push(dirname(chunk.file_path));

            expanded.push({
              id: chunk.id,
              plane: "codebase",
              type: chunk.chunk_type,
              content: renderByFidelity(
                chunk.content,
                chunk.abstract,
                chunk.summary,
                fidelity,
              ),
              score: 0.3 * 0.5, // hop_decay at depth 1 = 0.5
              source: "graph",
              file_path: chunk.file_path,
              name: chunk.name ?? undefined,
              created_at: chunk.indexed_at,
            });
          }
        }
      }

      db.close();
      allResults.push(...results, ...expanded);
    } catch {
      // skip unreadable DBs
    }
  }

  return { results: allResults, trajectory };
};

export const registerMemorySearchTool = (server: McpServer): void => {
  server.registerTool(
    "memory_search",
    {
      description:
        "Unified search across all Frieren memory planes (wisdom, session, codebase) with graph expansion.",
      inputSchema: {
        query: z.string().describe("Search query"),
        planes: z
          .array(z.enum(["wisdom", "session", "codebase"]))
          .optional()
          .describe("Planes to search (default: all three)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results to return (default 15)"),
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
          .describe("Use directory-aware codebase retrieval (default true)"),
      },
    },
    async (args) => {
      const startedAt = performance.now();
      const {
        query,
        planes = ["wisdom", "session", "codebase"],
        limit = 15,
        fidelity = "L1",
        debug = false,
        directory_first = true,
      } = args;

      // Embed once, share across planes
      let embedding: Float32Array | null = null;
      {
        const { vectors, error } = await embedTexts([query]);
        if (!error && vectors.length > 0 && vectors[0]) {
          embedding = vectors[0];
        }
      }

      // Search all requested planes in parallel
      const planeSearches: Promise<PlaneSearchOutcome>[] = [];

      if (planes.includes("wisdom")) {
        planeSearches.push(searchWisdom(query, embedding, limit, fidelity));
      }
      if (planes.includes("session")) {
        planeSearches.push(searchSession(query, embedding, limit, fidelity));
      }
      if (planes.includes("codebase")) {
        planeSearches.push(
          searchCodebase(query, embedding, limit, fidelity, directory_first),
        );
      }

      const planeResults = await Promise.all(planeSearches);
      const allCandidates = planeResults.flatMap((r) => r.results);
      const totalCandidates = allCandidates.length;
      const mergedTrajectory = createEmptyTrajectory();
      for (const result of planeResults) {
        mergedTrajectory.vector_hits.push(...result.trajectory.vector_hits);
        mergedTrajectory.keyword_hits.push(...result.trajectory.keyword_hits);
        mergedTrajectory.graph_expansions.push(
          ...result.trajectory.graph_expansions,
        );
        mergedTrajectory.directories_visited.push(
          ...result.trajectory.directories_visited,
        );
      }

      // Score merge: for vector/keyword hits use their own score,
      // for graph hits score = hop_decay * 0.3 (already computed in source fns).
      // For direct hits: blend as (score * 0.7) — graph already embeds decay.
      const rescored = allCandidates.map((r) => ({
        ...r,
        score: r.source !== "graph" ? r.score * 0.7 : r.score,
      }));

      const deduped = dedup(rescored);
      const finalResults = deduped
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      mergedTrajectory.final_results = finalResults.map((r) => ({
        id: r.id,
        score: r.score,
        plane: r.plane,
        source: r.source,
      }));

      writeRetrievalLog({
        query: "[redacted]",
        planesSearched: planes,
        resultsCount: finalResults.length,
        graphExpansions: mergedTrajectory.graph_expansions.length,
        trajectory: mergedTrajectory,
        durationMs: performance.now() - startedAt,
      });

      const payload: {
        results: SearchResult[];
        query_planes: Plane[];
        total_candidates: number;
        trajectory?: RetrievalTrajectory;
      } = {
        results: finalResults,
        query_planes: planes,
        total_candidates: totalCandidates,
      };

      if (debug) {
        payload.trajectory = mergedTrajectory;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  );
};
