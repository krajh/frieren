import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { embedTexts } from "../../../embedding/client.js";
import { initDb } from "../../../db/init.js";
import { extractAbstract, extractSummary } from "../../../tiering/extract.js";

const WISDOM_TYPES = ["decision", "pattern", "constraint", "issue"] as const;

export const registerWisdomWriteTool = (server: McpServer): void => {
  server.registerTool(
    "wisdom_write",
    {
      description: "Write a wisdom entry to the Frieren wisdom plane.",
      inputSchema: {
        type: z.enum(WISDOM_TYPES).describe("Category of wisdom"),
        content: z.string().describe("The wisdom content"),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Confidence score 0–1 (default 0.8)"),
        evidence: z
          .array(z.string())
          .optional()
          .describe("Supporting evidence"),
        project_id: z
          .string()
          .optional()
          .describe("Project ID to scope this wisdom"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags for classification"),
      },
    },
    async (args) => {
      const {
        type,
        content,
        confidence = 0.8,
        evidence,
        project_id,
        tags,
      } = args;

      const { db, vecLoaded } = initDb("wisdom");

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const evidenceJson = evidence ? JSON.stringify(evidence) : null;
      const tagsJson = tags ? JSON.stringify(tags) : null;
      const abstract = extractAbstract(content, "text");
      const summary = extractSummary(content, "text");

      db.run(
        `INSERT INTO wisdom_entries
          (id, type, content, abstract, summary, confidence, source_agent, evidence, tags, project_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           abstract = excluded.abstract,
           summary = excluded.summary,
           confidence = excluded.confidence,
           evidence = excluded.evidence,
           tags = excluded.tags,
           project_id = excluded.project_id,
           status = excluded.status,
          updated_at = excluded.updated_at`,
        [
          id,
          type,
          content,
          abstract,
          summary,
          confidence,
          "frieren",
          evidenceJson,
          tagsJson,
          project_id ?? null,
          "active",
          now,
          now,
        ],
      );

      if (vecLoaded) {
        const { vectors, error } = await embedTexts([content]);
        if (!error && vectors.length > 0 && vectors[0]) {
          try {
            db.run(
              `INSERT OR REPLACE INTO wisdom_vec(entry_id, embedding) VALUES (?, ?)`,
              [id, new Uint8Array(vectors[0].buffer)],
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
            text: JSON.stringify({ id, type, created: true }),
          },
        ],
      };
    },
  );
};
