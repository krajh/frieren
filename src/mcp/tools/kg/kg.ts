import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { initDb } from "../../../db/init.js";

/**
 * Frieren Knowledge Graph Tools
 *
 * Temporal entity-relationship tracking with validity windows.
 * Supports "as of" queries and contradiction detection.
 *
 * Schema:
 *   kg_entities  — named nodes (people, projects, concepts)
 *   kg_triples   — (subject, predicate, object, valid_from, valid_to)
 */

type TripleRow = {
  id: string;
  subject_id: string;
  predicate: string;
  object_id: string | null;
  object_value: string | null;
  valid_from: string;
  valid_to: string | null;
  confidence: number;
  source: string | null;
  project_id: string | null;
  created_at: string;
  // joined fields
  subject_name?: string;
  subject_type?: string;
  object_name?: string;
};

function upsertEntity(
  db: ReturnType<typeof initDb>["db"],
  name: string,
  type: string,
  attributes: Record<string, unknown> | undefined,
  project_id: string | undefined,
): string {
  const existing = db
    .query<
      { id: string },
      [string, string]
    >(`SELECT id FROM kg_entities WHERE name = ? AND type = ? LIMIT 1`)
    .get(name, type);

  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO kg_entities (id, name, type, attributes, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      type,
      attributes ? JSON.stringify(attributes) : null,
      project_id ?? null,
      now,
      now,
    ],
  );
  return id;
}

export const registerKgAddTool = (server: McpServer): void => {
  server.registerTool(
    "kg_add",
    {
      description:
        "Add a temporal triple to the knowledge graph. " +
        "subject and object are entity names (auto-created if new). " +
        "valid_from defaults to now; omit valid_to for open-ended facts.",
      inputSchema: {
        subject: z.string().describe("Subject entity name (e.g. 'Kai')"),
        subject_type: z
          .string()
          .optional()
          .describe("Subject entity type (default: 'entity')"),
        predicate: z
          .string()
          .describe("Relationship predicate (e.g. 'works_on')"),
        object: z
          .string()
          .optional()
          .describe("Object entity name (e.g. 'OpenCode')"),
        object_type: z
          .string()
          .optional()
          .describe("Object entity type (default: 'entity')"),
        object_value: z
          .string()
          .optional()
          .describe("Literal value if no object entity (e.g. '3 years')"),
        valid_from: z
          .string()
          .optional()
          .describe("ISO date when fact became true (default: now)"),
        valid_to: z
          .string()
          .optional()
          .describe("ISO date when fact stopped being true (omit for ongoing)"),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Confidence 0-1 (default 1.0)"),
        source: z.string().optional().describe("Source of this fact"),
        project_id: z.string().optional().describe("Project scope"),
      },
    },
    async (args) => {
      const {
        subject,
        subject_type = "entity",
        predicate,
        object,
        object_type = "entity",
        object_value,
        valid_from,
        valid_to,
        confidence = 1.0,
        source,
        project_id,
      } = args;

      const { db } = initDb("wisdom");

      const subjectId = upsertEntity(
        db,
        subject,
        subject_type,
        undefined,
        project_id,
      );

      let objectId: string | null = null;
      if (object) {
        objectId = upsertEntity(db, object, object_type, undefined, project_id);
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const validFrom = valid_from ?? now;

      db.run(
        `INSERT INTO kg_triples
          (id, subject_id, predicate, object_id, object_value, valid_from, valid_to, confidence, source, project_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          subjectId,
          predicate,
          objectId,
          object_value ?? null,
          validFrom,
          valid_to ?? null,
          confidence,
          source ?? null,
          project_id ?? null,
          now,
        ],
      );

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id,
              subject,
              predicate,
              object: object ?? object_value,
              valid_from: validFrom,
              valid_to: valid_to ?? null,
              created: true,
            }),
          },
        ],
      };
    },
  );
};

export const registerKgQueryTool = (server: McpServer): void => {
  server.registerTool(
    "kg_query",
    {
      description:
        "Query the knowledge graph. Filter by entity, predicate, or 'as_of' date. " +
        "Use as_of to ask 'what was true at time X?'. " +
        "Omit as_of to get currently active triples only.",
      inputSchema: {
        entity: z
          .string()
          .optional()
          .describe("Entity name to query (subject or object)"),
        predicate: z
          .string()
          .optional()
          .describe("Filter by predicate (e.g. 'works_on')"),
        as_of: z
          .string()
          .optional()
          .describe(
            "ISO date for temporal query ('what was true at this time?'). Default: now (active only).",
          ),
        project_id: z.string().optional().describe("Filter by project"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results (default 20)"),
      },
    },
    async (args) => {
      const { entity, predicate, as_of, project_id, limit = 20 } = args;

      const { db } = initDb("wisdom");
      const asOfDate = as_of ?? new Date().toISOString();

      const conditions: string[] = [
        // Temporal filter: fact was valid at as_of
        `t.valid_from <= ?`,
        `(t.valid_to IS NULL OR t.valid_to > ?)`,
      ];
      const params: (string | number)[] = [asOfDate, asOfDate];

      if (entity) {
        conditions.push(`(s.name LIKE ? OR o.name LIKE ?)`);
        params.push(`%${entity}%`, `%${entity}%`);
      }

      if (predicate) {
        conditions.push(`t.predicate LIKE ?`);
        params.push(`%${predicate}%`);
      }

      if (project_id) {
        conditions.push(`t.project_id = ?`);
        params.push(project_id);
      }

      params.push(limit);

      const rows = db
        .query<TripleRow, typeof params>(
          `SELECT t.id, t.predicate, t.object_value, t.valid_from, t.valid_to,
                  t.confidence, t.source, t.created_at,
                  s.name AS subject_name, s.type AS subject_type,
                  o.name AS object_name
           FROM kg_triples t
           JOIN kg_entities s ON s.id = t.subject_id
           LEFT JOIN kg_entities o ON o.id = t.object_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY t.valid_from DESC
           LIMIT ?`,
        )
        .all(...params);

      const results = rows.map((r) => ({
        id: r.id,
        subject: r.subject_name,
        subject_type: r.subject_type,
        predicate: r.predicate,
        object: r.object_name ?? r.object_value,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
        confidence: r.confidence,
        source: r.source,
      }));

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              as_of: asOfDate,
              count: results.length,
              results,
            }),
          },
        ],
      };
    },
  );
};

export const registerKgInvalidateTool = (server: McpServer): void => {
  server.registerTool(
    "kg_invalidate",
    {
      description:
        "Mark a knowledge graph triple as no longer valid. " +
        "Sets valid_to on matching triples. " +
        "Use when a fact has changed or been superseded.",
      inputSchema: {
        subject: z.string().describe("Subject entity name"),
        predicate: z.string().describe("Predicate to invalidate"),
        object: z
          .string()
          .optional()
          .describe(
            "Object entity name (optional — invalidates all matching subject+predicate if omitted)",
          ),
        ended: z
          .string()
          .optional()
          .describe("ISO date the fact ended (default: now)"),
        project_id: z.string().optional().describe("Project scope"),
      },
    },
    async (args) => {
      const { subject, predicate, object, ended, project_id } = args;
      const endedAt = ended ?? new Date().toISOString();

      const { db } = initDb("wisdom");

      // Find subject entity
      const subjectEntity = db
        .query<
          { id: string },
          [string]
        >(`SELECT id FROM kg_entities WHERE name = ? LIMIT 1`)
        .get(subject);

      if (!subjectEntity) {
        db.close();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Entity not found: ${subject}` }),
            },
          ],
        };
      }

      const conditions: string[] = [
        `subject_id = ?`,
        `predicate = ?`,
        `(valid_to IS NULL OR valid_to > ?)`,
      ];
      const params: (string | number)[] = [
        subjectEntity.id,
        predicate,
        endedAt,
      ];

      if (object) {
        const objectEntity = db
          .query<
            { id: string },
            [string]
          >(`SELECT id FROM kg_entities WHERE name = ? LIMIT 1`)
          .get(object);
        if (objectEntity) {
          conditions.push(`object_id = ?`);
          params.push(objectEntity.id);
        }
      }

      if (project_id) {
        conditions.push(`project_id = ?`);
        params.push(project_id);
      }

      const result = db.run(
        `UPDATE kg_triples SET valid_to = ?
         WHERE ${conditions.join(" AND ")}`,
        [endedAt, ...params],
      );

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              invalidated: result.changes,
              ended_at: endedAt,
              subject,
              predicate,
              object: object ?? "*",
            }),
          },
        ],
      };
    },
  );
};

export const registerKgTimelineTool = (server: McpServer): void => {
  server.registerTool(
    "kg_timeline",
    {
      description:
        "Get the chronological history of all facts about an entity. " +
        "Shows what was true and when — including superseded facts. " +
        "Use for temporal reasoning: 'how did X change over time?'",
      inputSchema: {
        entity: z.string().describe("Entity name to get timeline for"),
        predicate: z
          .string()
          .optional()
          .describe("Filter to a specific predicate"),
        project_id: z.string().optional().describe("Project scope"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max triples (default 50)"),
      },
    },
    async (args) => {
      const { entity, predicate, project_id, limit = 50 } = args;

      const { db } = initDb("wisdom");

      const conditions: string[] = [`(s.name LIKE ? OR o.name LIKE ?)`];
      const params: (string | number)[] = [`%${entity}%`, `%${entity}%`];

      if (predicate) {
        conditions.push(`t.predicate LIKE ?`);
        params.push(`%${predicate}%`);
      }

      if (project_id) {
        conditions.push(`t.project_id = ?`);
        params.push(project_id);
      }

      params.push(limit);

      const rows = db
        .query<TripleRow, typeof params>(
          `SELECT t.id, t.predicate, t.object_value, t.valid_from, t.valid_to,
                  t.confidence, t.source, t.created_at,
                  s.name AS subject_name, s.type AS subject_type,
                  o.name AS object_name
           FROM kg_triples t
           JOIN kg_entities s ON s.id = t.subject_id
           LEFT JOIN kg_entities o ON o.id = t.object_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY t.valid_from ASC
           LIMIT ?`,
        )
        .all(...params);

      const timeline = rows.map((r) => ({
        id: r.id,
        subject: r.subject_name,
        predicate: r.predicate,
        object: r.object_name ?? r.object_value,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
        active: r.valid_to === null,
        confidence: r.confidence,
        source: r.source,
      }));

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              entity,
              total_entries: timeline.length,
              timeline,
            }),
          },
        ],
      };
    },
  );
};
