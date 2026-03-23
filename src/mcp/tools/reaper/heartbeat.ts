import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

export const registerReaperHeartbeatTool = (server: McpServer): void => {
  server.registerTool(
    "reaper_heartbeat",
    {
      description:
        "Update heartbeat for a manifesting task. Shade calls this while working.",
      inputSchema: {
        task_id: z.string().describe("The task being worked on"),
      },
    },
    async (args) => {
      const { db } = initDb("queue");

      const result = db.run(
        `UPDATE reaper_realm_queue
         SET heartbeat_at = datetime('now'),
             updated_at = datetime('now')
         WHERE task_id = ? AND status = 'manifesting'`,
        [args.task_id],
      );

      db.close();

      if (result.changes === 0) {
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

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ task_id: args.task_id, ok: true }),
          },
        ],
      };
    },
  );
};
