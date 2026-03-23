import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

export const registerReaperEnqueueTool = (server: McpServer): void => {
  server.registerTool(
    "reaper_enqueue",
    {
      description:
        "Cast a task into the Reaper Realm for background execution by Shade.",
      inputSchema: {
        task: z.string().describe("The instruction for Shade"),
        files: z
          .array(z.string())
          .optional()
          .describe("Target file paths for context"),
        priority: z
          .number()
          .min(1)
          .max(10)
          .optional()
          .describe("1-10, lower = higher priority (default 5)"),
        max_retries: z
          .number()
          .optional()
          .describe("Retry count before marking dead (default 3)"),
        timeout_seconds: z
          .number()
          .optional()
          .describe("Per-task timeout in seconds (default 600)"),
        idempotency_key: z
          .string()
          .optional()
          .describe("Prevent duplicate task submission"),
        project_id: z.string().optional().describe("Project scope"),
      },
    },
    async (args) => {
      const {
        task,
        files,
        priority,
        max_retries,
        timeout_seconds,
        idempotency_key,
        project_id,
      } = args;

      const { db } = initDb("queue");

      if (idempotency_key) {
        const existing = db
          .query<
            { task_id: string; status: string },
            [string]
          >(`SELECT task_id, status FROM reaper_realm_queue WHERE idempotency_key = ?`)
          .get(idempotency_key);
        if (existing) {
          db.close();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  id: existing.task_id,
                  status: existing.status,
                  deduplicated: true,
                }),
              },
            ],
          };
        }
      }

      const taskId = `reaper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const payload = JSON.stringify({
        instruction: task,
        target_files: files ?? [],
        timeout_seconds: timeout_seconds ?? 600,
      });

      db.run(
        `INSERT INTO reaper_realm_queue
          (task_id, status, idempotency_key, project_id, priority, payload, max_retries, timeout_seconds)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)`,
        [
          taskId,
          idempotency_key ?? null,
          project_id ?? null,
          priority ?? 5,
          payload,
          max_retries ?? 3,
          timeout_seconds ?? 600,
        ],
      );
      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: taskId,
              status: "pending",
              priority: priority ?? 5,
            }),
          },
        ],
      };
    },
  );
};
