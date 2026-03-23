import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

type QueueRow = {
  task_id: string;
  coordinator_origin: string;
  target_vessel: string;
  priority: number;
  payload: string;
  timeout_seconds: number;
  retry_count: number;
  max_retries: number;
  created_at: string;
};

export const registerReaperDequeueTool = (server: McpServer): void => {
  server.registerTool(
    "reaper_dequeue",
    {
      description:
        "Claim the next pending task from the Reaper Realm. Atomic claim — no race conditions.",
      inputSchema: {
        target_vessel: z
          .string()
          .optional()
          .describe("Which vessel to claim for (default: shade)"),
      },
    },
    async (args) => {
      const { db } = initDb("queue");
      const vessel = args.target_vessel ?? "shade";

      // Recover stale tasks
      db.run(
        `UPDATE reaper_realm_queue
         SET status = 'pending',
             heartbeat_at = NULL,
             retry_count = retry_count + 1,
             updated_at = datetime('now')
         WHERE status = 'manifesting'
           AND CAST((julianday('now') - julianday(heartbeat_at)) * 86400 AS INTEGER) > timeout_seconds
           AND retry_count < max_retries`,
      );

      db.run(
        `UPDATE reaper_realm_queue
         SET status = 'dead',
             error = 'heartbeat timeout after max retries',
             updated_at = datetime('now')
         WHERE status = 'manifesting'
           AND CAST((julianday('now') - julianday(heartbeat_at)) * 86400 AS INTEGER) > timeout_seconds
           AND retry_count >= max_retries`,
      );

      // Atomic claim
      const row = db
        .query<QueueRow, [string]>(
          `UPDATE reaper_realm_queue
           SET status = 'manifesting',
               heartbeat_at = datetime('now'),
               updated_at = datetime('now')
           WHERE task_id = (
             SELECT task_id FROM reaper_realm_queue
             WHERE status = 'pending' AND target_vessel = ?
             ORDER BY priority ASC, created_at ASC
             LIMIT 1
           )
           RETURNING task_id, coordinator_origin, target_vessel, priority,
                     payload, timeout_seconds, retry_count, max_retries, created_at`,
        )
        .get(vessel);

      db.close();

      if (!row) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ claimed: false, queue_empty: true }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              claimed: true,
              task_id: row.task_id,
              coordinator_origin: row.coordinator_origin,
              target_vessel: row.target_vessel,
              priority: row.priority,
              payload: JSON.parse(row.payload),
              timeout_seconds: row.timeout_seconds,
              retry_count: row.retry_count,
              max_retries: row.max_retries,
              created_at: row.created_at,
            }),
          },
        ],
      };
    },
  );
};
