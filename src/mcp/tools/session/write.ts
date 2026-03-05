import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";
import { detectProjectId } from "../../../project/detectProjectId.js";

const EVENT_TYPES = [
  "tool_call",
  "decision",
  "blocker",
  "milestone",
  "note",
  "error",
] as const;

const artifactSchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  url: z.string().optional(),
  label: z.string().optional(),
});

export const registerSessionWriteTool = (server: McpServer): void => {
  server.registerTool(
    "session_write",
    {
      description: "Record an event in the current session.",
      inputSchema: {
        event_type: z.enum(EVENT_TYPES).describe("Type of session event"),
        content: z.string().describe("Event content"),
        artifacts: z
          .array(artifactSchema)
          .optional()
          .describe("Associated artifacts (files, URLs, etc.)"),
        session_id: z
          .string()
          .optional()
          .describe("Session ID (auto-created if omitted)"),
        project_id: z
          .string()
          .optional()
          .describe("Project ID (auto-detected if omitted)"),
      },
    },
    async (args) => {
      const { event_type, content, artifacts, session_id, project_id } = args;

      const resolvedProjectId = project_id ?? detectProjectId() ?? "unknown";
      const { db, vecLoaded } = initDb("session", resolvedProjectId);

      const now = new Date().toISOString();

      // Resolve or create session
      let resolvedSessionId = session_id;
      if (!resolvedSessionId) {
        // Find the most recent open session for this project
        type SessionRow = { id: string };
        const existing = db
          .query<
            SessionRow,
            [string]
          >(`SELECT id FROM sessions WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`)
          .get(resolvedProjectId);

        if (existing) {
          resolvedSessionId = existing.id;
        } else {
          resolvedSessionId = crypto.randomUUID();
          db.run(
            `INSERT INTO sessions (id, project_id, started_at) VALUES (?, ?, ?)`,
            [resolvedSessionId, resolvedProjectId, now],
          );
        }
      }

      const eventId = crypto.randomUUID();
      const artifactsJson = artifacts ? JSON.stringify(artifacts) : null;

      db.run(
        `INSERT INTO session_events (id, session_id, project_id, event_type, content, artifacts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          resolvedSessionId,
          resolvedProjectId,
          event_type,
          content,
          artifactsJson,
          now,
        ],
      );

      if (vecLoaded) {
        const { vectors, error } = await embedTexts([content]);
        if (!error && vectors.length > 0 && vectors[0]) {
          try {
            db.run(
              `INSERT OR REPLACE INTO session_vec(event_id, embedding) VALUES (?, ?)`,
              [eventId, new Uint8Array(vectors[0].buffer)],
            );
          } catch {
            // vec insert failure is non-fatal
          }
        }
      }

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              event_id: eventId,
              session_id: resolvedSessionId,
            }),
          },
        ],
      };
    },
  );
};
