import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

export const registerReaperCancelTool = (server: McpServer): void => {
  server.registerTool(
    "reaper_cancel",
    {
      description:
        "Cancel a Reaper Realm task. Pending tasks are cancelled immediately; manifesting tasks are flagged for graceful abort.",
      inputSchema: {
        task_id: z.string().describe("The task to cancel"),
      },
    },
    async (args) => {
      const { db } = initDb("queue");

      const row = db
        .query<{ status: string }, [string]>(
          `SELECT status FROM reaper_realm_queue WHERE task_id = ?`,
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
                error: "task not found",
              }),
            },
          ],
        };
      }

      if (
        row.status === "completed" ||
        row.status === "dead" ||
        row.status === "cancelled"
      ) {
        db.close();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                task_id: args.task_id,
                ok: false,
                error: `task already ${row.status}`,
              }),
            },
          ],
        };
      }

      db.run(
        `UPDATE reaper_realm_queue
         SET status = 'cancelled',
             error = 'cancelled by coordinator',
             updated_at = datetime('now')
         WHERE task_id = ?`,
        [args.task_id],
      );
      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              task_id: args.task_id,
              ok: true,
              previous_status: row.status,
              status: "cancelled",
            }),
          },
        ],
      };
    },
  );
};
