import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";
import { applyCodebaseMigrations } from "../../../db/codebase-schema.js";
import { detectProjectId } from "../../../project/detectProjectId.js";

type GraphNode = { file: string; depth: number };
type GraphEdge = { from: string; to: string; dep_type: string };

export const registerCodebaseGraphTool = (server: McpServer): void => {
  server.registerTool(
    "codebase_graph",
    {
      description: "Traverse the import dependency graph for a file.",
      inputSchema: {
        entry: z
          .string()
          .describe("Entry file path (relative to project root)"),
        direction: z
          .enum(["deps", "dependents", "both"])
          .optional()
          .describe("Traversal direction (default: deps)"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("BFS depth (default 3)"),
        project_id: z
          .string()
          .optional()
          .describe("Project ID (auto-detected if omitted)"),
      },
    },
    async (args) => {
      const { entry, direction = "deps", depth = 3 } = args;

      const resolvedProjectId =
        args.project_id ?? detectProjectId() ?? "unknown";
      const { db, vecLoaded } = initDb("index", resolvedProjectId);
      applyCodebaseMigrations(db, vecLoaded);

      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const visited = new Set<string>();

      type DepRow = { from_file: string; to_file: string; dep_type: string };

      const bfs = (startFile: string, dir: "deps" | "dependents"): void => {
        const queue: Array<{ file: string; d: number }> = [
          { file: startFile, d: 0 },
        ];
        visited.add(startFile);
        nodes.push({ file: startFile, depth: 0 });

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.d >= depth) continue;

          let rows: DepRow[];
          if (dir === "deps") {
            rows = db
              .query<DepRow, [string, string]>(
                `SELECT from_file, to_file, dep_type FROM code_deps
                 WHERE project_id = ? AND from_file = ?`,
              )
              .all(resolvedProjectId, current.file);
          } else {
            rows = db
              .query<DepRow, [string, string]>(
                `SELECT from_file, to_file, dep_type FROM code_deps
                 WHERE project_id = ? AND to_file = ?`,
              )
              .all(resolvedProjectId, current.file);
          }

          for (const row of rows) {
            const next = dir === "deps" ? row.to_file : row.from_file;
            edges.push({
              from: row.from_file,
              to: row.to_file,
              dep_type: row.dep_type,
            });

            if (!visited.has(next)) {
              visited.add(next);
              nodes.push({ file: next, depth: current.d + 1 });
              queue.push({ file: next, d: current.d + 1 });
            }
          }
        }
      };

      if (direction === "deps" || direction === "both") {
        bfs(entry, "deps");
      }

      if (direction === "dependents" || direction === "both") {
        // Reset visited but keep nodes/edges so "both" accumulates
        visited.clear();
        bfs(entry, "dependents");
      }

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ nodes, edges }),
          },
        ],
      };
    },
  );
};
