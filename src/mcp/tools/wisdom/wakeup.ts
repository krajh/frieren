import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Database } from "../../../db/database.js";

import { initDb } from "../../../db/init.js";
import { compressL1 } from "../../../lib/frieren-compress.js";

/**
 * Frieren Wake-Up Context Tool
 *
 * Returns layered memory context for efficient L0+L1 loading:
 * - L0: Identity (~50 tokens) — reads from soul/SOUL.md
 * - L1: Essential facts (~120 tokens) — high-priority wisdom decisions
 *
 * Target: ≤200 tokens total for compact system prompt injection.
 */

type WisdomRow = {
  id: string;
  type: string;
  content: string;
  confidence: number;
  tags: string | null;
  created_at: string;
};

/**
 * Read L0 identity from soul files
 */
function getL0Identity(): string {
  try {
    const soulPath =
      process.env.SOUL_PATH ||
      `${process.env.HOME || "/home/kailashr"}/.config/opencode/soul/SOUL.md`;
    const fs = require("fs");
    if (fs.existsSync(soulPath)) {
      const content = fs.readFileSync(soulPath, "utf-8");
      const lines = content.split("\n").filter((l: string) => l.trim());
      const identity: string[] = [];

      if (lines[0]) identity.push(lines[0]);

      const focusMatch = content.match(
        /## Current Focus\n([\s\S]*?)(?=\n##|$)/,
      );
      if (focusMatch) {
        const focusLines = focusMatch[1]
          .split("\n")
          .map((l: string) => l.replace(/^[-*]\s*/, "").trim())
          .filter((l: string) => l);
        identity.push("Focus: " + focusLines.join(", "));
      }

      return identity.join("\n");
    }
  } catch {
    // Fall through to default
  }

  return "Frieren — Context Manager for OpenCode";
}

/**
 * Get L1 essential facts (compressed)
 */
function getL1EssentialFacts(db: Database, maxTokens: number = 120): string[] {
  const rows = db
    .query<WisdomRow, []>(
      `SELECT id, type, content, confidence, tags, created_at
       FROM wisdom_entries
       WHERE type = 'decision' AND confidence >= 0.7
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all();

  if (rows.length === 0) return [];

  const entries = rows.map((row) => ({
    content: row.content,
    created_at: row.created_at,
  }));

  return compressL1(entries, maxTokens);
}

/**
 * Get L1 essential facts (uncompressed)
 */
function getL1EssentialFactsRaw(
  db: Database,
  maxTokens: number = 120,
): string[] {
  const MAX_CHARS = maxTokens * 4;

  const rows = db
    .query<WisdomRow, []>(
      `SELECT id, type, content, confidence, tags, created_at
       FROM wisdom_entries
       WHERE type = 'decision' AND confidence >= 0.7
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all();

  if (rows.length === 0) return [];

  const facts: string[] = [];
  let totalChars = 0;

  for (const row of rows) {
    let content = row.content.replace(/\n/g, " ").trim();
    if (content.length > 200) {
      content = content.slice(0, 197) + "...";
    }
    const date = row.created_at.slice(0, 10);
    const fact = `[${date}] ${content}`;

    if (totalChars + fact.length > MAX_CHARS) break;

    facts.push(fact);
    totalChars += fact.length;
  }

  return facts;
}

export const registerWakeupContextTool = (server: McpServer): void => {
  server.registerTool(
    "wisdom_wakeup",
    {
      description:
        "Get compact wake-up context (L0 identity + L1 essential facts). " +
        "Returns ≤200 tokens for system prompt injection. " +
        "L0: identity from soul files. L1: recent high-confidence decisions.",
      inputSchema: {
        max_tokens: z
          .number()
          .int()
          .min(50)
          .max(500)
          .optional()
          .describe("Max tokens for L1 (default 120, L0~50)"),
        include_session: z
          .boolean()
          .optional()
          .describe("Include recent session events in L1"),
        compress: z
          .boolean()
          .optional()
          .describe("Use AAAK-style compression for L1 (default true)"),
      },
    },
    async (args) => {
      const maxTokens = args.max_tokens ?? 120;
      const useCompression = args.compress ?? true;

      const l0 = getL0Identity();

      const { db } = initDb("wisdom");
      const l1Facts = useCompression
        ? getL1EssentialFacts(db, maxTokens)
        : getL1EssentialFactsRaw(db, maxTokens);

      const layers: Record<string, unknown> = {
        L0_identity: l0,
        L1_essential_facts: l1Facts,
        total_token_estimate: Math.ceil(
          (l0.length + l1Facts.join(" ").length) / 4,
        ),
      };

      if (args.include_session) {
        try {
          const { db: sessionDb } = initDb("session");
          const events = sessionDb
            .query<{ content: string; created_at: string }, []>(
              `SELECT content, created_at FROM events 
               ORDER BY created_at DESC LIMIT 5`,
            )
            .all();

          layers.L2_recent_events = events.map((e) => ({
            time: e.created_at.slice(0, 16),
            content: e.content.slice(0, 100),
          }));
        } catch {
          // Session DB may not be initialized
        }
      }

      db.close();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(layers, null, 2),
          },
        ],
      };
    },
  );
};
