import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

export const registerReaperCompleteTool = (server: McpServer): void => {
  server.registerTool(
    "reaper_complete",
    {
      description: "Mark a Reaper Realm task as completed with results.",
      inputSchema: {
        task_id: z.string().describe("The task to complete"),
        result: z.string().describe("JSON result/summary from execution"),
      },
    },
    async (args) => {
      const { db } = initDb("queue");

      const res = db.run(
        `UPDATE reaper_realm_queue
         SET status = 'completed',
             result = ?,
             completed_at = datetime('now'),
             updated_at = datetime('now')
         WHERE task_id = ? AND status = 'manifesting'`,
        [args.result, args.task_id],
      );

      db.close();

      if (res.changes === 0) {
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
            text: JSON.stringify({
              task_id: args.task_id,
              ok: true,
              status: "completed",
            }),
          },
        ],
      };
    },
  );
};
