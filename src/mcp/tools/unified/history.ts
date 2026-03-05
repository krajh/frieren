import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";
import { getIndexDir, getSessionsDir } from "../../../utils/paths.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";

type TimelineEntry = {
  timestamp: string;
  plane: "wisdom" | "session" | "codebase";
  event_type: string;
  content: string;
  id: string;
};

export const registerMemoryHistoryTool = (server: McpServer): void => {
  server.registerTool(
    "memory_history",
    {
      description:
        "Show the full history of how an entity (file path, symbol, or wisdom entry ID) evolved across all Frieren memory planes.",
      inputSchema: {
        entity_id: z
          .string()
          .describe(
            "File path, symbol name, or wisdom entry ID to trace history for",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "ISO date — only return events after this date (default: 30 days ago)",
          ),
      },
    },
    async (args) => {
      const { entity_id } = args;

      const since =
        args.since ??
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const timeline: TimelineEntry[] = [];

      // --- Wisdom plane ---
      try {
        const { db } = initDb("wisdom");

        type WisdomRow = {
          id: string;
          type: string;
          content: string;
          created_at: string;
        };

        const rows = db
          .query<WisdomRow, [string, string]>(
            `SELECT id, type, content, created_at
             FROM wisdom_entries
             WHERE content LIKE ? AND created_at >= ?
             ORDER BY created_at ASC`,
          )
          .all(`%${entity_id}%`, since);

        for (const r of rows) {
          timeline.push({
            timestamp: r.created_at,
            plane: "wisdom",
            event_type: r.type,
            content: r.content.slice(0, 200),
            id: r.id,
          });
        }

        db.close();
      } catch {
        // wisdom DB unavailable — skip
      }

      // --- Session plane (all project DBs) ---
      try {
        const sessionsDir = getSessionsDir();
        const sessionDbFiles = readdirSync(sessionsDir)
          .filter((f) => f.endsWith(".db"))
          .map((f) => join(sessionsDir, f));

        for (const dbPath of sessionDbFiles.slice(0, 10)) {
          try {
            const { Database } = await import("bun:sqlite");
            const db = new Database(dbPath);

            type EventRow = {
              id: string;
              event_type: string;
              content: string;
              created_at: string;
            };

            const rows = db
              .query<EventRow, [string, string]>(
                `SELECT id, event_type, content, created_at
                 FROM session_events
                 WHERE content LIKE ? AND created_at >= ?
                 ORDER BY created_at ASC`,
              )
              .all(`%${entity_id}%`, since);

            for (const r of rows) {
              timeline.push({
                timestamp: r.created_at,
                plane: "session",
                event_type: r.event_type,
                content: r.content.slice(0, 200),
                id: r.id,
              });
            }

            db.close();
          } catch {
            // skip unreadable DB
          }
        }
      } catch {
        // sessions dir unavailable — skip
      }

      // --- Codebase plane (all project DBs) ---
      try {
        const indexDir = getIndexDir();
        const indexDbFiles = readdirSync(indexDir)
          .filter((f) => f.endsWith(".db"))
          .map((f) => join(indexDir, f));

        for (const dbPath of indexDbFiles.slice(0, 10)) {
          try {
            const { Database } = await import("bun:sqlite");
            const db = new Database(dbPath);

            type ChunkRow = {
              id: string;
              chunk_type: string;
              content: string;
              file_path: string;
              name: string | null;
              indexed_at: string;
            };

            const rows = db
              .query<ChunkRow, [string, string, string]>(
                `SELECT id, chunk_type, content, file_path, name, indexed_at
                 FROM code_chunks
                 WHERE (file_path LIKE ? OR name LIKE ?) AND indexed_at >= ?
                 ORDER BY indexed_at ASC`,
              )
              .all(`%${entity_id}%`, `%${entity_id}%`, since);

            for (const r of rows) {
              const label = r.name
                ? `${r.chunk_type}: ${r.name} (${r.file_path})`
                : `${r.chunk_type}: ${r.file_path}`;
              timeline.push({
                timestamp: r.indexed_at,
                plane: "codebase",
                event_type: r.chunk_type,
                content: `${label}\n${r.content.slice(0, 150)}`,
                id: r.id,
              });
            }

            db.close();
          } catch {
            // skip unreadable DB
          }
        }
      } catch {
        // index dir unavailable — skip
      }

      // Sort chronologically
      timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              entity_id,
              timeline,
              total: timeline.length,
            }),
          },
        ],
      };
    },
  );
};
