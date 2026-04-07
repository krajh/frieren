import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

/**
 * Frieren Contradiction Detection Tool
 *
 * Validates a new fact against stored knowledge graph triples.
 * Returns warnings when the input contradicts currently active facts.
 */

type TripleRow = {
  id: string;
  predicate: string;
  object_value: string | null;
  valid_from: string;
  valid_to: string | null;
  confidence: number;
  subject_name: string;
  object_name: string | null;
};

export const registerKgValidateTool = (server: McpServer): void => {
  server.registerTool(
    "kg_validate",
    {
      description:
        "Validate a fact against stored knowledge. " +
        "Checks if the given subject+predicate has a conflicting value in the active KG. " +
        "Returns CONFLICT if a different value is stored, OK if consistent, UNKNOWN if no data.",
      inputSchema: {
        subject: z.string().describe("Subject entity name (e.g. 'Kai')"),
        predicate: z.string().describe("Predicate to check (e.g. 'works_on')"),
        object: z
          .string()
          .optional()
          .describe("Claimed object/value to validate against stored facts"),
        as_of: z
          .string()
          .optional()
          .describe("ISO date for validation point (default: now)"),
        project_id: z.string().optional().describe("Project scope"),
      },
    },
    async (args) => {
      const { subject, predicate, object, as_of, project_id } = args;
      const asOfDate = as_of ?? new Date().toISOString();

      const { db } = initDb("wisdom");

      // Get active triples for this subject+predicate at as_of
      const conditions: string[] = [
        `s.name = ?`,
        `t.predicate = ?`,
        `t.valid_from <= ?`,
        `(t.valid_to IS NULL OR t.valid_to > ?)`,
      ];
      const params: (string | number)[] = [
        subject,
        predicate,
        asOfDate,
        asOfDate,
      ];

      if (project_id) {
        conditions.push(`t.project_id = ?`);
        params.push(project_id);
      }

      const rows = db
        .query<TripleRow, typeof params>(
          `SELECT t.id, t.predicate, t.object_value, t.valid_from, t.valid_to,
                  t.confidence, s.name AS subject_name, o.name AS object_name
           FROM kg_triples t
           JOIN kg_entities s ON s.id = t.subject_id
           LEFT JOIN kg_entities o ON o.id = t.object_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY t.confidence DESC`,
        )
        .all(...params);

      db.close();

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "UNKNOWN",
                message: `No stored facts for: ${subject} ${predicate}`,
                as_of: asOfDate,
              }),
            },
          ],
        };
      }

      const storedValues = rows.map(
        (r) => r.object_name ?? r.object_value ?? "(none)",
      );

      if (!object) {
        // Just return what's stored
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "OK",
                message: `Found ${rows.length} active fact(s)`,
                stored: storedValues,
                as_of: asOfDate,
              }),
            },
          ],
        };
      }

      // Check if claimed object matches any stored value
      const normalizedClaim = object.toLowerCase().trim();
      const matches = storedValues.some(
        (v) => v.toLowerCase().trim() === normalizedClaim,
      );

      if (matches) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "OK",
                message: `Fact is consistent with stored knowledge`,
                claimed: object,
                stored: storedValues,
                as_of: asOfDate,
              }),
            },
          ],
        };
      }

      // Conflict found
      const conflicts = rows.map((r) => ({
        id: r.id,
        stored_object: r.object_name ?? r.object_value,
        confidence: r.confidence,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "CONFLICT",
              message: `⚠️ Claimed fact conflicts with stored knowledge`,
              subject,
              predicate,
              claimed: object,
              conflicts,
              as_of: asOfDate,
              recommendation:
                "Verify which is correct. Use kg_invalidate to retire stale facts, then kg_add to record the updated value.",
            }),
          },
        ],
      };
    },
  );
};
