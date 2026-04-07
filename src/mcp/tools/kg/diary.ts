import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

/**
 * Frieren Agent Diary Tools
 *
 * Allows specialist agents to maintain their own diary suite.
 * Stored as wisdom entries with agent_id scoping.
 *
 * Each agent's diary is a namespaced slice of the wisdom plane.
 */

const DIARY_REALM = "agent-diary";

export const registerDiaryWriteTool = (server: McpServer): void => {
  server.registerTool(
    "diary_write",
    {
      description:
        "Write an entry to an agent's diary. " +
        "Agents use this to persist patterns, lessons, and recurring context across sessions. " +
        "Diary entries are scoped to the agent and stored in the wisdom plane.",
      inputSchema: {
        agent_id: z
          .string()
          .describe(
            "Agent identifier (e.g. 'marin-coder', 'guillotine-reviewer')",
          ),
        content: z.string().describe("Diary entry content"),
        type: z
          .enum(["decision", "pattern", "constraint", "issue"])
          .optional()
          .describe("Entry type (default: pattern)"),
        tags: z.array(z.string()).optional().describe("Tags for filtering"),
        project_id: z.string().optional().describe("Project scope"),
      },
    },
    async (args) => {
      const { agent_id, content, type = "pattern", tags, project_id } = args;

      const { db } = initDb("wisdom");

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const tagsJson = tags ? JSON.stringify(tags) : null;

      db.run(
        `INSERT INTO wisdom_entries
          (id, type, content, confidence, source_agent, tags, project_id, status, realm, suite, agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          type,
          content,
          0.8,
          agent_id,
          tagsJson,
          project_id ?? null,
          "active",
          DIARY_REALM,
          agent_id,
          agent_id,
          now,
          now,
        ],
      );

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id, agent_id, type, created: true }),
          },
        ],
      };
    },
  );
};

export const registerDiaryReadTool = (server: McpServer): void => {
  server.registerTool(
    "diary_read",
    {
      description:
        "Read an agent's diary entries. " +
        "Returns the most recent entries for the given agent. " +
        "Agents use this at session start to reload context.",
      inputSchema: {
        agent_id: z.string().describe("Agent identifier (e.g. 'marin-coder')"),
        last_n: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Number of recent entries to return (default 10)"),
        type: z
          .enum(["decision", "pattern", "constraint", "issue"])
          .optional()
          .describe("Filter by entry type"),
        project_id: z.string().optional().describe("Project scope filter"),
      },
    },
    async (args) => {
      const { agent_id, last_n = 10, type, project_id } = args;

      const { db } = initDb("wisdom");

      const conditions: string[] = [
        `agent_id = ?`,
        `realm = ?`,
        `status = 'active'`,
      ];
      const params: (string | number)[] = [agent_id, DIARY_REALM];

      if (type) {
        conditions.push(`type = ?`);
        params.push(type);
      }

      if (project_id) {
        conditions.push(`project_id = ?`);
        params.push(project_id);
      }

      params.push(last_n);

      const rows = db
        .query<
          {
            id: string;
            type: string;
            content: string;
            confidence: number;
            tags: string | null;
            created_at: string;
          },
          typeof params
        >(
          `SELECT id, type, content, confidence, tags, created_at
           FROM wisdom_entries
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(...params);

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              agent_id,
              count: rows.length,
              entries: rows.map((r) => ({
                id: r.id,
                type: r.type,
                content: r.content,
                tags: r.tags ? JSON.parse(r.tags) : [],
                created_at: r.created_at,
              })),
            }),
          },
        ],
      };
    },
  );
};
