import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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

          for (const chunk of chunks) {
            const chunkId = crypto.randomUUID();
            db.run(
              `INSERT INTO code_chunks (id, project_id, file_path, chunk_type, name, content, start_line, end_line, language, indexed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                chunkId,
                resolvedProjectId,
                relFile,
                chunk.chunk_type,
                chunk.name ?? null,
                chunk.content,
                chunk.start_line,
                chunk.end_line,
                chunk.language,
                now,
              ],
            );
            chunksCreated++;

            if (vecLoaded) {
              const { vectors, error } = await embedTexts([chunk.content]);
              if (!error && vectors[0]) {
                try {
                  db.run(
                    `INSERT OR REPLACE INTO code_vec(chunk_id, embedding) VALUES (?, ?)`,
                    [chunkId, new Uint8Array(vectors[0].buffer)],
                  );
                } catch {
                  // vec insert failure is non-fatal
                }
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
