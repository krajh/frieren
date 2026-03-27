import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";
import { applyCodebaseMigrations } from "../../../db/codebase-schema.js";
import { detectProjectId } from "../../../project/detectProjectId.js";
import {
  getChangedFiles,
  getGitHead,
  getGitRoot,
} from "../../../codebase/diff.js";
import { chunkCode, shouldSkipFile } from "../../../codebase/indexer.js";
import { extractAbstract, extractSummary } from "../../../tiering/extract.js";

const collectFiles = (dir: string, rootPath: string): string[] => {
  const result: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: "utf8" }) as string[];
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relPath = relative(rootPath, fullPath);

    // Skip hidden dirs and known skip dirs
    if (entry.startsWith(".")) continue;

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      result.push(...collectFiles(fullPath, rootPath));
    } else if (!shouldSkipFile(relPath)) {
      result.push(relPath);
    }
  }

  return result;
};

export const registerCodebaseIndexTool = (server: McpServer): void => {
  server.registerTool(
    "codebase_index",
    {
      description:
        "Index or re-index a project's source code for semantic search.",
      inputSchema: {
        project_id: z
          .string()
          .optional()
          .describe("Project ID (auto-detected if omitted)"),
        root_path: z
          .string()
          .optional()
          .describe("Project root path (auto-detected from git if omitted)"),
        force: z
          .boolean()
          .optional()
          .describe("Force full re-index (default false)"),
      },
    },
    async (args) => {
      const { force = false } = args;

      const resolvedRoot =
        args.root_path ?? getGitRoot(process.cwd()) ?? process.cwd();
      const resolvedProjectId =
        args.project_id ?? detectProjectId(resolvedRoot) ?? "unknown";

      const { db, vecLoaded } = initDb("index", resolvedProjectId);
      applyCodebaseMigrations(db, vecLoaded);

      // Get last indexed commit
      type MetaRow = { last_commit: string | null; root_path: string };
      const meta = db
        .query<
          MetaRow,
          [string]
        >(`SELECT last_commit, root_path FROM index_meta WHERE project_id = ?`)
        .get(resolvedProjectId);

      const headCommit = getGitHead(resolvedRoot);
      const isIncremental =
        !force && meta?.last_commit != null && headCommit != null;

      let filesToIndex: string[];

      if (isIncremental) {
        const changed = getChangedFiles(resolvedRoot, meta!.last_commit!);
        filesToIndex = changed.filter((f) => !shouldSkipFile(f));
      } else {
        filesToIndex = collectFiles(resolvedRoot, resolvedRoot);
      }

      // Run the heavy indexing loop in the background so the MCP call
      // returns immediately instead of blocking until all files are processed.
      (async () => {
        const now = new Date().toISOString();
        let chunksCreated = 0;

        for (const relFile of filesToIndex) {
          const fullPath = join(resolvedRoot, relFile);
          const dirPath = dirname(relFile);

          if (vecLoaded) {
            db.run(
              `DELETE FROM code_vec
               WHERE chunk_id IN (
                 SELECT id FROM code_chunks WHERE project_id = ? AND file_path = ?
               )`,
              [resolvedProjectId, relFile],
            );
          }

          db.run(
            `DELETE FROM code_chunks WHERE project_id = ? AND file_path = ?`,
            [resolvedProjectId, relFile],
          );
          db.run(
            `DELETE FROM code_deps WHERE project_id = ? AND from_file = ?`,
            [resolvedProjectId, relFile],
          );

          let content: string;
          try {
            content = readFileSync(fullPath, "utf8");
          } catch {
            continue;
          }

          const { chunks, deps } = chunkCode(content, relFile);

          // Assign IDs upfront so we can batch-embed all chunks for this file
          // in a single inference call rather than one call per chunk.
          const chunkIds = chunks.map(() => crypto.randomUUID());
          let fileVectors: Float32Array[] = [];
          if (vecLoaded && chunks.length > 0) {
            const { vectors, error } = await embedTexts(
              chunks.map((c) => c.content),
            );
            if (!error) fileVectors = vectors;
          }

          for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci]!;
            const chunkId = chunkIds[ci]!;
            const abstract = extractAbstract(chunk.content, "code", {
              chunkType: chunk.chunk_type,
              name: chunk.name ?? undefined,
            });
            const summary = extractSummary(chunk.content, "code");
            db.run(
              `INSERT INTO code_chunks (id, project_id, file_path, dir_path, chunk_type, name, content, abstract, summary, start_line, end_line, language, indexed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                chunkId,
                resolvedProjectId,
                relFile,
                dirPath,
                chunk.chunk_type,
                chunk.name ?? null,
                chunk.content,
                abstract,
                summary,
                chunk.start_line,
                chunk.end_line,
                chunk.language,
                now,
              ],
            );
            chunksCreated++;

            const vec = fileVectors[ci];
            if (vec) {
              try {
                db.run(
                  `INSERT OR REPLACE INTO code_vec(chunk_id, embedding) VALUES (?, ?)`,
                  [chunkId, new Uint8Array(vec.buffer)],
                );
              } catch {
                // vec insert failure is non-fatal
              }
            }
          }

          for (const dep of deps) {
            db.run(
              `INSERT INTO code_deps (id, project_id, from_file, to_file, dep_type, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                crypto.randomUUID(),
                resolvedProjectId,
                relFile,
                dep.to_file,
                dep.dep_type,
                now,
              ],
            );
          }
        }

        if (vecLoaded) {
          db.run(
            `DELETE FROM dir_vec WHERE dir_key IN (
               SELECT project_id || '::' || dir_path
               FROM dir_summaries
               WHERE project_id = ?
             )`,
            [resolvedProjectId],
          );
        }

        type DirSummaryRow = {
          dir_path: string | null;
          file_count: number;
          chunk_count: number;
          names: string | null;
        };

        const dirRows = db
          .query<DirSummaryRow, [string]>(
            `SELECT
               dir_path,
               COUNT(DISTINCT file_path) AS file_count,
               COUNT(*) AS chunk_count,
               GROUP_CONCAT(name, ', ') AS names
             FROM code_chunks
             WHERE project_id = ?
             GROUP BY dir_path`,
          )
          .all(resolvedProjectId);

        db.run(`DELETE FROM dir_summaries WHERE project_id = ?`, [
          resolvedProjectId,
        ]);

        const dirPayload = dirRows.map((row) => {
          const safeDirPath = row.dir_path ?? ".";
          const nameList = (row.names ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
            .slice(0, 24)
            .join(", ");
          const summary =
            `dir: ${safeDirPath} | ${row.file_count} files, ${row.chunk_count} chunks: ${nameList}`.slice(
              0,
              1200,
            );
          return {
            dir_path: safeDirPath,
            file_count: row.file_count,
            chunk_count: row.chunk_count,
            summary,
          };
        });

        let dirVectors: Float32Array[] = [];
        if (vecLoaded && dirPayload.length > 0) {
          const { vectors, error } = await embedTexts(
            dirPayload.map((row) => row.summary),
          );
          if (!error) {
            dirVectors = vectors;
          }
        }

        for (let i = 0; i < dirPayload.length; i++) {
          const row = dirPayload[i]!;
          const dirKey = `${resolvedProjectId}::${row.dir_path}`;
          const embedding = dirVectors[i]
            ? new Uint8Array(dirVectors[i]!.buffer)
            : null;
          db.run(
            `INSERT OR REPLACE INTO dir_summaries
               (dir_path, project_id, file_count, chunk_count, summary, embedding)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              row.dir_path,
              resolvedProjectId,
              row.file_count,
              row.chunk_count,
              row.summary,
              embedding,
            ],
          );

          if (embedding) {
            try {
              db.run(
                `INSERT OR REPLACE INTO dir_vec (dir_key, embedding) VALUES (?, ?)`,
                [dirKey, embedding],
              );
            } catch {
              // vec insert failure is non-fatal
            }
          }
        }

        type CountRow = { n: number };
        const totalFiles =
          db
            .query<
              CountRow,
              [string]
            >(`SELECT COUNT(DISTINCT file_path) as n FROM code_chunks WHERE project_id = ?`)
            .get(resolvedProjectId)?.n ?? 0;
        const totalChunks =
          db
            .query<
              CountRow,
              [string]
            >(`SELECT COUNT(*) as n FROM code_chunks WHERE project_id = ?`)
            .get(resolvedProjectId)?.n ?? 0;

        db.run(
          `INSERT OR REPLACE INTO index_meta (project_id, root_path, last_commit, indexed_at, file_count, chunk_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            resolvedProjectId,
            resolvedRoot,
            headCommit,
            now,
            totalFiles,
            totalChunks,
          ],
        );

        db.close();
      })().catch(() => {
        db.close();
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              project_id: resolvedProjectId,
              files_to_index: filesToIndex.length,
              mode: isIncremental ? "incremental" : "full",
              status: "indexing_started",
            }),
          },
        ],
      };
    },
  );
};
