import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";
import { getIndexDir, getSessionsDir } from "../../../utils/paths.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";

type Plane = "wisdom" | "session" | "codebase";

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
): Promise<SearchResult[]> => {
  const { db, vecLoaded } = initDb("wisdom");
  const results: SearchResult[] = [];

  type WisdomRow = {
    id: string;
    type: string;
    content: string;
    created_at: string;
  };

  // Vector search
  if (vecLoaded && embedding) {
    try {
      const vecRows = db
        .query<WisdomRow & { distance: number }, [Uint8Array, number]>(
          `SELECT we.id, we.type, we.content, we.created_at, vd.distance
           FROM wisdom_vec vd
           JOIN wisdom_entries we ON we.id = vd.entry_id
           WHERE vd.embedding MATCH ? AND k = ?
           ORDER BY vd.distance`,
        )
        .all(new Uint8Array(embedding.buffer), limit);

      for (const r of vecRows) {
        results.push({
          id: r.id,
          plane: "wisdom",
          type: r.type,
          content: r.content,
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
        `SELECT id, type, content, created_at FROM wisdom_entries
         WHERE content LIKE ? LIMIT ?`,
      )
      .all(`%${query}%`, limit);

    for (const r of rows) {
      results.push({
        id: r.id,
        plane: "wisdom",
        type: r.type,
        content: r.content,
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

      type RelRow = { from_id: string; to_id: string };
      const relRows = db
        .query<RelRow, [string, string]>(
          `SELECT from_id, to_id FROM wisdom_relations
           WHERE from_id = ? OR to_id = ?`,
        )
        .all(id, id);

      for (const rel of relRows) {
        const neighborId = rel.from_id === id ? rel.to_id : rel.from_id;
        if (visited.has(neighborId) || totalExpanded >= 50) continue;

        visited.add(neighborId);
        totalExpanded++;

        const neighbor = db
          .query<
            WisdomRow,
            [string]
          >(`SELECT id, type, content, created_at FROM wisdom_entries WHERE id = ?`)
          .get(neighborId);

        if (neighbor) {
          const hopDecay = 1.0 / (hop + 2); // hop+1 distance from initial hit
          expanded.push({
            id: neighbor.id,
            plane: "wisdom",
            type: neighbor.type,
            content: neighbor.content,
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
  return [...results, ...expanded];
};

const searchSession = async (
  query: string,
  embedding: Float32Array | null,
  limit: number,
): Promise<SearchResult[]> => {
  // Scan all project session DBs
  let sessionDbFiles: string[] = [];
  try {
    const sessionsDir = getSessionsDir();
    sessionDbFiles = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => join(sessionsDir, f));
  } catch {
    return [];
  }

  const allResults: SearchResult[] = [];

  for (const dbPath of sessionDbFiles.slice(0, 10)) {
    // cap at 10 projects
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);

      type EventRow = {
        id: string;
        event_type: string;
        content: string;
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
                 FROM session_events WHERE id IN (${placeholders})`,
              )
              .all(...ids);

            results = rows.map((r) => ({
              id: r.id,
              plane: "session" as Plane,
              type: r.event_type,
              content: r.content,
              score: 1 - (distMap.get(r.id) ?? 1),
              source: "vector" as const,
              created_at: r.created_at,
            }));
          }
        } catch {
          // no vec table in this DB
        }
      }

      if (results.length === 0) {
        const rows = db
          .query<EventRow, [string, number]>(
            `SELECT id, event_type, content, created_at
             FROM session_events WHERE content LIKE ? LIMIT ?`,
          )
          .all(`%${query}%`, limit);

        results = rows.map((r) => ({
          id: r.id,
          plane: "session" as Plane,
          type: r.event_type,
          content: r.content,
          score: 0.5,
          source: "keyword" as const,
          created_at: r.created_at,
        }));
      }

      db.close();
      allResults.push(...results);
    } catch {
      // skip unreadable DBs
    }
  }

  return allResults;
};

const searchCodebase = async (
  query: string,
  embedding: Float32Array | null,
  limit: number,
): Promise<SearchResult[]> => {
  // Scan all project index DBs
  let indexDbFiles: string[] = [];
  try {
    const indexDir = getIndexDir();
    indexDbFiles = readdirSync(indexDir)
      .filter((f) => f.endsWith(".db"))
      .map((f) => join(indexDir, f));
  } catch {
    return [];
  }

  const allResults: SearchResult[] = [];

  for (const dbPath of indexDbFiles.slice(0, 10)) {
    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);

      type ChunkRow = {
        id: string;
        chunk_type: string;
        content: string;
        file_path: string;
        name: string | null;
        indexed_at: string;
      };

      let results: SearchResult[] = [];

      if (embedding) {
        try {
          type VecRow = { chunk_id: string; distance: number };
          const vecRows = db
            .query<VecRow, [Uint8Array, number]>(
              `SELECT chunk_id, distance FROM code_vec
               WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
            )
            .all(new Uint8Array(embedding.buffer), limit);

          if (vecRows.length > 0) {
            const ids = vecRows.map((r) => r.chunk_id);
            const distMap = new Map(
              vecRows.map((r) => [r.chunk_id, r.distance]),
            );
            const placeholders = ids.map(() => "?").join(",");

            const rows = db
              .query<ChunkRow, string[]>(
                `SELECT id, chunk_type, content, file_path, name, indexed_at
                 FROM code_chunks WHERE id IN (${placeholders})`,
              )
              .all(...ids);

            results = rows.map((r) => ({
              id: r.id,
              plane: "codebase" as Plane,
              type: r.chunk_type,
              content: r.content.slice(0, 500),
              score: 1 - (distMap.get(r.id) ?? 1),
              source: "vector" as const,
              file_path: r.file_path,
              name: r.name ?? undefined,
              created_at: r.indexed_at,
            }));
          }
        } catch {
          // no vec table
        }
      }

      if (results.length === 0) {
        const rows = db
          .query<ChunkRow, [string, string, number]>(
            `SELECT id, chunk_type, content, file_path, name, indexed_at
             FROM code_chunks WHERE content LIKE ? OR name LIKE ? LIMIT ?`,
          )
          .all(`%${query}%`, `%${query}%`, limit);

        results = rows.map((r) => ({
          id: r.id,
          plane: "codebase" as Plane,
          type: r.chunk_type,
          content: r.content.slice(0, 500),
          score: 0.5,
          source: "keyword" as const,
          file_path: r.file_path,
          name: r.name ?? undefined,
          created_at: r.indexed_at,
        }));
      }

      // Graph expansion: code_deps at depth 1
      const expanded: SearchResult[] = [];
      const visited = new Set(results.map((r) => r.id));
      let totalExpanded = 0;

      for (const hit of results) {
        if (!hit.file_path || totalExpanded >= 50) break;

        type DepRow = { from_file: string; to_file: string };
        const depRows = db
          .query<DepRow, [string, string]>(
            `SELECT from_file, to_file FROM code_deps
             WHERE from_file = ? OR to_file = ?`,
          )
          .all(hit.file_path, hit.file_path);

        for (const dep of depRows) {
          const neighborFile =
            dep.from_file === hit.file_path ? dep.to_file : dep.from_file;

          const neighborChunks = db
            .query<ChunkRow, [string, number]>(
              `SELECT id, chunk_type, content, file_path, name, indexed_at
               FROM code_chunks WHERE file_path = ? LIMIT ?`,
            )
            .all(neighborFile, 3);

          for (const chunk of neighborChunks) {
            if (visited.has(chunk.id) || totalExpanded >= 50) continue;
            visited.add(chunk.id);
            totalExpanded++;

            expanded.push({
              id: chunk.id,
              plane: "codebase",
              type: chunk.chunk_type,
              content: chunk.content.slice(0, 500),
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

  return allResults;
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
      },
    },
    async (args) => {
      const {
        query,
        planes = ["wisdom", "session", "codebase"],
        limit = 15,
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
      const planeSearches: Promise<SearchResult[]>[] = [];

      if (planes.includes("wisdom")) {
        planeSearches.push(searchWisdom(query, embedding, limit));
      }
      if (planes.includes("session")) {
        planeSearches.push(searchSession(query, embedding, limit));
      }
      if (planes.includes("codebase")) {
        planeSearches.push(searchCodebase(query, embedding, limit));
      }

      const planeResults = await Promise.all(planeSearches);
      const allCandidates = planeResults.flat();
      const totalCandidates = allCandidates.length;

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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: finalResults,
              query_planes: planes,
              total_candidates: totalCandidates,
            }),
          },
        ],
      };
    },
  );
};
