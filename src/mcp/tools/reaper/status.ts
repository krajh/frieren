import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

type StatusCount = { status: string; count: number };

type TaskRow = {
  task_id: string;
  status: string;
  priority: number;
  coordinator_origin: string;
  target_vessel: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
};

export const registerReaperStatusTool = (server: McpServer): void => {
  server.registerTool(
    "reaper_status",
    {
      description:
        "Query Reaper Realm queue state. Returns summary counts and optionally a specific task.",
      inputSchema: {
        task_id: z
          .string()
          .optional()
          .describe("Specific task ID to query"),
        status_filter: z
          .string()
          .optional()
          .describe("Filter tasks by status (e.g. 'pending', 'manifesting')"),
        limit: z
          .number()
          .optional()
          .describe("Max tasks to return (default 20)"),
      },
    },
    async (args) => {
      const { db } = initDb("queue");

      const counts = db
        .query<StatusCount, []>(
          `SELECT status, COUNT(*) as count FROM reaper_realm_queue GROUP BY status`,
        )
        .all();

      const summary: Record<string, number> = {
        pending: 0,
        manifesting: 0,
        completed: 0,
        failed: 0,
        dead: 0,
        cancelled: 0,
      };
      for (const row of counts) {
        summary[row.status] = row.count;
      }

      if (args.task_id) {
        const task = db
          .query<TaskRow, [string]>(
            `SELECT task_id, status, priority, coordinator_origin, target_vessel,
                    retry_count, created_at, updated_at, completed_at, error
             FROM reaper_realm_queue WHERE task_id = ?`,
          )
          .get(args.task_id);
        db.close();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ summary, task: task ?? null }),
            },
          ],
        };
      }

      const lim = args.limit ?? 20;
      let query = `SELECT task_id, status, priority, coordinator_origin, target_vessel,
                           retry_count, created_at, updated_at, completed_at, error
                    FROM reaper_realm_queue`;
      const params: string[] = [];

      if (args.status_filter) {
        query += ` WHERE status = ?`;
        params.push(args.status_filter);
      }
      query += ` ORDER BY priority ASC, created_at ASC LIMIT ?`;

      const tasks = db
        .query<TaskRow, (string | number)[]>(
          query,
        )
        .all(...params, lim);
      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ summary, tasks }),
          },
        ],
      };
    },
  );
};
