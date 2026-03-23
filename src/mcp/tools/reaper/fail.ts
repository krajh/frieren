import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

export const registerReaperFailTool = (server: McpServer): void => {
  server.registerTool(
    "reaper_fail",
    {
      description:
        "Mark a Reaper Realm task as failed. Auto-retries if under max_retries, otherwise marks dead.",
      inputSchema: {
        task_id: z.string().describe("The task that failed"),
        error: z.string().describe("Failure reason"),
      },
    },
    async (args) => {
      const { db } = initDb("queue");

      const row = db
        .query<{ retry_count: number; max_retries: number }, [string]>(
          `SELECT retry_count, max_retries FROM reaper_realm_queue WHERE task_id = ? AND status = 'manifesting'`,
        )
        .get(args.task_id);

      if (!row) {
        db.close();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                task_id: args.task_id,
                ok: false,
                error: "task not found or not in manifesting state",
              }),
            },
          ],
        };
      }

      if (row.retry_count < row.max_retries) {
        db.run(
          `UPDATE reaper_realm_queue
           SET status = 'pending',
               retry_count = retry_count + 1,
               error = ?,
               heartbeat_at = NULL,
               updated_at = datetime('now')
           WHERE task_id = ?`,
          [args.error, args.task_id],
        );
        db.close();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                task_id: args.task_id,
                status: "pending",
                retry_count: row.retry_count + 1,
                max_retries: row.max_retries,
                will_retry: true,
              }),
            },
          ],
        };
      }

      db.run(
        `UPDATE reaper_realm_queue
         SET status = 'dead',
             error = ?,
             updated_at = datetime('now')
         WHERE task_id = ?`,
        [args.error, args.task_id],
      );
      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              task_id: args.task_id,
              status: "dead",
              will_retry: false,
              error: args.error,
            }),
          },
        ],
      };
    },
  );
};
