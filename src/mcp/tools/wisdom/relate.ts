import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

const RELATIONSHIPS = [
  "supports",
  "contradicts",
  "extends",
  "supersedes",
  "related",
] as const;

export const registerWisdomRelateTool = (server: McpServer): void => {
  server.registerTool(
    "wisdom_relate",
    {
      description: "Create a relation between two wisdom entries.",
      inputSchema: {
        id1: z.string().describe("ID of the first wisdom entry"),
        id2: z.string().describe("ID of the second wisdom entry"),
        relationship: z
          .enum(RELATIONSHIPS)
          .describe("Type of relationship from id1 to id2"),
        strength: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Relation strength 0–1 (default 0.5)"),
      },
    },
    async (args) => {
      const { id1, id2, relationship, strength = 0.5 } = args;

      const { db } = initDb("wisdom");

      const relation_id = crypto.randomUUID();
      const now = new Date().toISOString();

      db.run(
        `INSERT INTO wisdom_relations (id, from_id, to_id, relationship, strength, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [relation_id, id1, id2, relationship, strength, now],
      );

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ relation_id }),
          },
        ],
      };
    },
  );
};
