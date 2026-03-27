import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { initDb } from "../../../db/init.js";
import {
  getIndexDbPath,
  getIndexDir,
  getSessionDbPath,
  getSessionsDir,
} from "../../../utils/paths.js";

const BROWSE_OPS = ["ls", "tree", "stat", "find"] as const;
const BROWSE_PLANES = ["wisdom", "session", "codebase"] as const;

const browseInputSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("ls"),
    plane: z.enum(BROWSE_PLANES),
    type: z.string().optional(),
    project_id: z.string().optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  z.object({
    op: z.literal("tree"),
    project_id: z.string(),
  }),
  z.object({
    op: z.literal("stat"),
    plane: z.enum(BROWSE_PLANES),
    entry_id: z.string(),
    project_id: z.string().optional(),
  }),
  z.object({
    op: z.literal("find"),
    plane: z.enum(BROWSE_PLANES),
    pattern: z.string(),
    project_id: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  }),
]);

type LsResult = {
  id: string;
  type: string;
  preview: string;
  timestamp: string;
  project_id?: string | null;
};

type DbFile = {
  path: string;
  projectId: string;
};

type TreeNode = {
  name: string;
  files: number;
  chunks: number;
  children: TreeNode[];
};

const getDbFiles = (dir: string): DbFile[] => {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".db"))
      .map((file) => ({
        path: join(dir, file),
        projectId: file.slice(0, -3),
      }));
  } catch {
    return [];
  }
};

const truncatePreview = (value: string, max = 100): string =>
  value.length <= max ? value : `${value.slice(0, max)}...`;

const safeParseTags = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // ignore malformed tags payload
  }
  return [];
};

const buildSnippet = (text: string, regex: RegExp): string | null => {
  const match = regex.exec(text);
  if (!match || match.index < 0) return null;

  const start = Math.max(0, match.index - 50);
  const end = Math.min(text.length, match.index + match[0].length + 50);
  return text.slice(start, end);
};

const runLsWisdom = (
  args: Extract<z.infer<typeof browseInputSchema>, { op: "ls" }>,
): LsResult[] => {
  const { db } = initDb("wisdom");
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (args.type) {
      conditions.push("type = ?");
      params.push(args.type);
    }
    if (args.project_id) {
      conditions.push("project_id = ?");
      params.push(args.project_id);
    }
    if (args.date_from) {
      conditions.push("created_at >= ?");
      params.push(args.date_from);
    }
    if (args.date_to) {
      conditions.push("created_at <= ?");
      params.push(args.date_to);
    }
    if (args.tags && args.tags.length > 0) {
      for (const tag of args.tags) {
        conditions.push("tags LIKE ?");
        params.push(`%\"${tag}\"%`);
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    params.push(limit, offset);

    type WisdomRow = {
      id: string;
      type: string;
      content: string;
      project_id: string | null;
      created_at: string;
    };

    const rows = db
      .query<WisdomRow, (string | number)[]>(
        `SELECT id, type, content, project_id, created_at
         FROM wisdom_entries
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params);

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      preview: truncatePreview(row.content),
      timestamp: row.created_at,
      project_id: row.project_id,
    }));
  } finally {
    db.close();
  }
};

const runLsSession = (
  args: Extract<z.infer<typeof browseInputSchema>, { op: "ls" }>,
): LsResult[] => {
  const dbFiles = args.project_id
    ? [{ path: getSessionDbPath(args.project_id), projectId: args.project_id }]
    : getDbFiles(getSessionsDir());

  const merged: LsResult[] = [];

  for (const dbFile of dbFiles) {
    let db: Database | null = null;
    try {
      db = new Database(dbFile.path);

      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (args.type) {
        conditions.push("event_type = ?");
        params.push(args.type);
      }
      if (args.date_from) {
        conditions.push("created_at >= ?");
        params.push(args.date_from);
      }
      if (args.date_to) {
        conditions.push("created_at <= ?");
        params.push(args.date_to);
      }
      if (args.tags && args.tags.length > 0) {
        for (const tag of args.tags) {
          conditions.push("content LIKE ?");
          params.push(`%${tag}%`);
        }
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push((args.limit ?? 20) + (args.offset ?? 0));

      type SessionRow = {
        id: string;
        event_type: string;
        content: string;
        created_at: string;
        project_id: string;
      };

      const rows = db
        .query<SessionRow, (string | number)[]>(
          `SELECT id, event_type, content, created_at, project_id
           FROM session_events
           ${whereClause}
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(...params);

      merged.push(
        ...rows.map((row) => ({
          id: row.id,
          type: row.event_type,
          preview: truncatePreview(row.content),
          timestamp: row.created_at,
          project_id: row.project_id,
        })),
      );
    } catch {
      // skip unreadable db
    } finally {
      db?.close();
    }
  }

  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  return merged
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(offset, offset + limit);
};

const runLsCodebase = (
  args: Extract<z.infer<typeof browseInputSchema>, { op: "ls" }>,
): LsResult[] => {
  const dbFiles = args.project_id
    ? [{ path: getIndexDbPath(args.project_id), projectId: args.project_id }]
    : getDbFiles(getIndexDir());

  const merged: LsResult[] = [];

  for (const dbFile of dbFiles) {
    let db: Database | null = null;
    try {
      db = new Database(dbFile.path);

      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (args.type) {
        conditions.push("chunk_type = ?");
        params.push(args.type);
      }
      if (args.project_id) {
        conditions.push("project_id = ?");
        params.push(args.project_id);
      }
      if (args.date_from) {
        conditions.push("indexed_at >= ?");
        params.push(args.date_from);
      }
      if (args.date_to) {
        conditions.push("indexed_at <= ?");
        params.push(args.date_to);
      }
      if (args.tags && args.tags.length > 0) {
        for (const tag of args.tags) {
          conditions.push("(file_path LIKE ? OR content LIKE ?)");
          params.push(`%${tag}%`, `%${tag}%`);
        }
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push((args.limit ?? 20) + (args.offset ?? 0));

      type CodeRow = {
        id: string;
        chunk_type: string;
        content: string;
        indexed_at: string;
        project_id: string;
      };

      const rows = db
        .query<CodeRow, (string | number)[]>(
          `SELECT id, chunk_type, content, indexed_at, project_id
           FROM code_chunks
           ${whereClause}
           ORDER BY indexed_at DESC
           LIMIT ?`,
        )
        .all(...params);

      merged.push(
        ...rows.map((row) => ({
          id: row.id,
          type: row.chunk_type,
          preview: truncatePreview(row.content),
          timestamp: row.indexed_at,
          project_id: row.project_id,
        })),
      );
    } catch {
      // skip unreadable db
    } finally {
      db?.close();
    }
  }

  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  return merged
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(offset, offset + limit);
};

const runTree = (
  args: Extract<z.infer<typeof browseInputSchema>, { op: "tree" }>,
): TreeNode => {
  const { db } = initDb("index", args.project_id);
  try {
    type Row = { file_path: string; chunks: number };
    const rows = db
      .query<Row, [string]>(
        `SELECT file_path, COUNT(*) as chunks
         FROM code_chunks
         WHERE project_id = ?
         GROUP BY file_path`,
      )
      .all(args.project_id);

    type MutableTreeNode = {
      name: string;
      files: number;
      chunks: number;
      children: Map<string, MutableTreeNode>;
    };

    const root: MutableTreeNode = {
      name: ".",
      files: 0,
      chunks: 0,
      children: new Map(),
    };

    for (const row of rows) {
      const parts = row.file_path.split("/");
      parts.pop();

      let current = root;
      current.files += 1;
      current.chunks += row.chunks;

      for (const part of parts) {
        if (!part) continue;
        let next = current.children.get(part);
        if (!next) {
          next = {
            name: part,
            files: 0,
            chunks: 0,
            children: new Map(),
          };
          current.children.set(part, next);
        }

        next.files += 1;
        next.chunks += row.chunks;
        current = next;
      }
    }

    const toOutput = (node: MutableTreeNode): TreeNode => ({
      name: node.name,
      files: node.files,
      chunks: node.chunks,
      children: Array.from(node.children.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(toOutput),
    });

    return toOutput(root);
  } finally {
    db.close();
  }
};

const runStatWisdom = (
  args: Extract<z.infer<typeof browseInputSchema>, { op: "stat" }>,
): Record<string, unknown> => {
  const { db } = initDb("wisdom");
  try {
    const entry = db
      .query<
        Record<string, unknown>,
        [string]
      >(`SELECT * FROM wisdom_entries WHERE id = ? LIMIT 1`)
      .get(args.entry_id);

    if (!entry) {
      return { plane: "wisdom", entry_id: args.entry_id, found: false };
    }

    type RelationRow = {
      id: string;
      from_id: string;
      to_id: string;
      relationship: string;
      strength: number;
      created_at: string;
      related_id: string;
      direction: "outgoing" | "incoming";
      related_type: string | null;
      related_content: string | null;
    };

    const relations = db
      .query<RelationRow, [string, string, string, string, string]>(
        `SELECT wr.id,
                wr.from_id,
                wr.to_id,
                wr.relationship,
                wr.strength,
                wr.created_at,
                CASE WHEN wr.from_id = ? THEN wr.to_id ELSE wr.from_id END as related_id,
                CASE WHEN wr.from_id = ? THEN 'outgoing' ELSE 'incoming' END as direction,
                we.type as related_type,
                we.content as related_content
         FROM wisdom_relations wr
         LEFT JOIN wisdom_entries we
           ON we.id = CASE WHEN wr.from_id = ? THEN wr.to_id ELSE wr.from_id END
         WHERE wr.from_id = ? OR wr.to_id = ?
         ORDER BY wr.created_at DESC`,
      )
      .all(
        args.entry_id,
        args.entry_id,
        args.entry_id,
        args.entry_id,
        args.entry_id,
      );

    return {
      plane: "wisdom",
      found: true,
      entry,
      related_entries: relations.map((rel) => ({
        id: rel.related_id,
        type: rel.related_type,
        content_preview: rel.related_content
          ? truncatePreview(rel.related_content)
          : null,
        relation: {
          id: rel.id,
          direction: rel.direction,
          relationship: rel.relationship,
          strength: rel.strength,
          created_at: rel.created_at,
        },
      })),
    };
  } finally {
    db.close();
  }
};

const runStatInProjectDbs = (
  table: "session_events" | "code_chunks",
  idField: "id",
  entryId: string,
  dbFiles: DbFile[],
): Record<string, unknown> => {
  for (const dbFile of dbFiles) {
    let db: Database | null = null;
    try {
      db = new Database(dbFile.path);
      const row = db
        .query<
          Record<string, unknown>,
          [string]
        >(`SELECT * FROM ${table} WHERE ${idField} = ? LIMIT 1`)
        .get(entryId);
      if (row) {
        return {
          found: true,
          project_id: dbFile.projectId,
          entry: row,
        };
      }
    } catch {
      // skip unreadable db
    } finally {
      db?.close();
    }
  }

  return { found: false };
};

const runStat = (
  args: Extract<z.infer<typeof browseInputSchema>, { op: "stat" }>,
): Record<string, unknown> => {
  if (args.plane === "wisdom") {
    return runStatWisdom(args);
  }

  if (args.plane === "session") {
    const dbFiles = args.project_id
      ? [
          {
            path: getSessionDbPath(args.project_id),
            projectId: args.project_id,
          },
        ]
      : getDbFiles(getSessionsDir());

    return {
      plane: "session",
      entry_id: args.entry_id,
      ...runStatInProjectDbs("session_events", "id", args.entry_id, dbFiles),
    };
  }

  const dbFiles = args.project_id
    ? [{ path: getIndexDbPath(args.project_id), projectId: args.project_id }]
    : getDbFiles(getIndexDir());

  return {
    plane: "codebase",
    entry_id: args.entry_id,
    ...runStatInProjectDbs("code_chunks", "id", args.entry_id, dbFiles),
  };
};

const runFind = (
  args: Extract<z.infer<typeof browseInputSchema>, { op: "find" }>,
): Record<string, unknown> => {
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern);
  } catch {
    return {
      plane: args.plane,
      pattern: args.pattern,
      error: "Invalid regex pattern",
      matches: [],
      total: 0,
    };
  }

  const matches: Array<Record<string, unknown>> = [];
  const scanCap = 5000;

  if (args.plane === "wisdom") {
    const { db } = initDb("wisdom");
    try {
      const params: (string | number)[] = [];
      let whereClause = "";
      if (args.project_id) {
        whereClause = "WHERE project_id = ?";
        params.push(args.project_id);
      }
      params.push(scanCap);

      type Row = {
        id: string;
        type: string;
        content: string;
        tags: string | null;
        created_at: string;
      };

      const rows = db
        .query<Row, (string | number)[]>(
          `SELECT id, type, content, tags, created_at
           FROM wisdom_entries
           ${whereClause}
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(...params);

      for (const row of rows) {
        regex.lastIndex = 0;
        const contentSnippet = buildSnippet(row.content, regex);
        regex.lastIndex = 0;
        const tagsText = safeParseTags(row.tags).join(", ");
        const tagsSnippet = tagsText ? buildSnippet(tagsText, regex) : null;

        if (contentSnippet || tagsSnippet) {
          matches.push({
            id: row.id,
            type: row.type,
            timestamp: row.created_at,
            matched_field: contentSnippet ? "content" : "tags",
            snippet: contentSnippet ?? tagsSnippet,
          });
        }
      }
    } finally {
      db.close();
    }
  }

  if (args.plane === "session") {
    const dbFiles = args.project_id
      ? [
          {
            path: getSessionDbPath(args.project_id),
            projectId: args.project_id,
          },
        ]
      : getDbFiles(getSessionsDir());

    for (const dbFile of dbFiles) {
      let db: Database | null = null;
      try {
        db = new Database(dbFile.path);
        type Row = {
          id: string;
          event_type: string;
          content: string;
          artifacts: string | null;
          created_at: string;
          project_id: string;
        };

        const rows = db
          .query<Row, [number]>(
            `SELECT id, event_type, content, artifacts, created_at, project_id
             FROM session_events
             ORDER BY created_at DESC
             LIMIT ?`,
          )
          .all(scanCap);

        for (const row of rows) {
          regex.lastIndex = 0;
          const contentSnippet = buildSnippet(row.content, regex);
          regex.lastIndex = 0;
          const artifactSnippet = row.artifacts
            ? buildSnippet(row.artifacts, regex)
            : null;

          if (contentSnippet || artifactSnippet) {
            matches.push({
              id: row.id,
              type: row.event_type,
              timestamp: row.created_at,
              project_id: row.project_id,
              matched_field: contentSnippet ? "content" : "artifacts",
              snippet: contentSnippet ?? artifactSnippet,
            });
          }
        }
      } catch {
        // skip unreadable db
      } finally {
        db?.close();
      }
    }
  }

  if (args.plane === "codebase") {
    const dbFiles = args.project_id
      ? [{ path: getIndexDbPath(args.project_id), projectId: args.project_id }]
      : getDbFiles(getIndexDir());

    for (const dbFile of dbFiles) {
      let db: Database | null = null;
      try {
        db = new Database(dbFile.path);
        type Row = {
          id: string;
          chunk_type: string;
          file_path: string;
          content: string;
          indexed_at: string;
          project_id: string;
        };

        const rows = db
          .query<Row, [number]>(
            `SELECT id, chunk_type, file_path, content, indexed_at, project_id
             FROM code_chunks
             ORDER BY indexed_at DESC
             LIMIT ?`,
          )
          .all(scanCap);

        for (const row of rows) {
          regex.lastIndex = 0;
          const pathSnippet = buildSnippet(row.file_path, regex);
          regex.lastIndex = 0;
          const contentSnippet = buildSnippet(row.content, regex);

          if (pathSnippet || contentSnippet) {
            matches.push({
              id: row.id,
              type: row.chunk_type,
              timestamp: row.indexed_at,
              project_id: row.project_id,
              matched_field: pathSnippet ? "file_path" : "content",
              snippet: pathSnippet ?? contentSnippet,
              file_path: row.file_path,
            });
          }
        }
      } catch {
        // skip unreadable db
      } finally {
        db?.close();
      }
    }
  }

  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  const sliced = matches
    .sort((a, b) =>
      String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")),
    )
    .slice(offset, offset + limit);

  return {
    plane: args.plane,
    pattern: args.pattern,
    matches: sliced,
    total: matches.length,
    offset,
    limit,
  };
};

export const registerMemoryBrowseTool = (server: McpServer): void => {
  server.registerTool(
    "memory_browse",
    {
      description:
        "Deterministic memory navigation with ls, tree, stat, and find operations.",
      inputSchema: {
        op: z
          .enum(BROWSE_OPS)
          .describe("Browse operation: ls, tree, stat, find"),
        plane: z
          .enum(BROWSE_PLANES)
          .optional()
          .describe("Target plane (wisdom, session, codebase)"),
        type: z
          .string()
          .optional()
          .describe(
            "Optional type filter (wisdom type, event_type, chunk_type)",
          ),
        project_id: z
          .string()
          .optional()
          .describe("Project scope (required for tree, optional otherwise)"),
        date_from: z
          .string()
          .optional()
          .describe("ISO date lower bound for ls"),
        date_to: z.string().optional().describe("ISO date upper bound for ls"),
        tags: z.array(z.string()).optional().describe("Optional tag filters"),
        entry_id: z.string().optional().describe("Entry ID for stat"),
        pattern: z.string().optional().describe("Regex pattern for find"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Page size (default 20, max 100)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Pagination offset (default 0)"),
      },
    },
    async (args) => {
      const parsed = browseInputSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Invalid input",
                details: parsed.error.issues,
              }),
            },
          ],
        };
      }

      const input = parsed.data;

      if (input.op === "ls") {
        const entries =
          input.plane === "wisdom"
            ? runLsWisdom(input)
            : input.plane === "session"
              ? runLsSession(input)
              : runLsCodebase(input);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                op: "ls",
                plane: input.plane,
                limit: input.limit ?? 20,
                offset: input.offset ?? 0,
                entries,
                total: entries.length,
              }),
            },
          ],
        };
      }

      if (input.op === "tree") {
        const tree = runTree(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                op: "tree",
                plane: "codebase",
                project_id: input.project_id,
                tree,
              }),
            },
          ],
        };
      }

      if (input.op === "stat") {
        const result = runStat(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                op: "stat",
                ...result,
              }),
            },
          ],
        };
      }

      const result = runFind(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              op: "find",
              ...result,
            }),
          },
        ],
      };
    },
  );
};
