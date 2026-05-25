/**
 * OpenCode LLM Provider
 *
 * Uses the OpenCode SDK client (provided by the bridge plugin runtime)
 * to extract structured knowledge via transient sessions with json_schema
 * output format — no separate API key needed.
 *
 * Flow: create transient session → prompt with json_schema format → delete session
 */

import type { LLMProvider, ExtractionResult, OpencodeClient } from "./provider.js";
import { EXTRACTION_JSON_SCHEMA, parseExtraction } from "./provider.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Logger ─────────────────────────────────────────────────────────────────

const LOG_DIR = join(homedir(), ".config", "opencode", "logs");
const LOG_FILE = join(LOG_DIR, "frieren-bridge.log");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

const log = (level: string, message: string, meta?: unknown) => {
  const timestamp = new Date().toISOString();
  const line = meta !== undefined
    ? `[${timestamp}] [${level}] [opencode-provider] ${message} ${JSON.stringify(meta)}\n`
    : `[${timestamp}] [${level}] [opencode-provider] ${message}\n`;
  try { appendFileSync(LOG_FILE, line); } catch { /* silently drop */ }
};

// ─── Prompt Template ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a structured knowledge extraction engine for a coding agent's memory system. Your job is to analyze session compact summaries and extract durable knowledge.

Rules:
1. Only extract things you are confident are true and useful across sessions
2. **Decisions**: architectural choices, tool selections, feature decisions, design directions
3. **Patterns**: recurring approaches, conventions, implementation idioms, workflow habits
4. **Constraints**: limitations, pre-conditions, project-specific rules, dependency requirements
5. **Issues**: blockers, bugs found (but not yet fixed), problems encountered
6. **Triples**: entity relationships — subject, predicate, object (e.g. "Frieren", "uses", "SQLite")

Be conservative. Quality over quantity. Return valid JSON only.`;

const MAX_CONTEXT_CHARS = 4000;

function buildUserPrompt(contextText: string): string {
  const truncated = contextText.slice(0, MAX_CONTEXT_CHARS);
  return `Analyze this coding session compact and extract structured knowledge from it.

Session compact:
"""
${truncated}
"""

Return a JSON object matching the schema provided.`;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class OpenCodeProvider implements LLMProvider {
  readonly name = "opencode";

  constructor(
    private readonly client: OpencodeClient,
    private readonly timeoutMs: number = 15_000,
  ) {}

  async extract(contextText: string): Promise<ExtractionResult | null> {
    const trimmed = contextText.trim();
    if (!trimmed) {
      log("info", "Empty context text — nothing to extract");
      return null;
    }

    log("info", "Starting OpenCode extraction", { chars: trimmed.length });

    try {
      // 1. Create transient session
      log("info", "Creating transient extraction session");
      const createResult = await this.client.session.create({
        directory: "/tmp",
        title: "frieren-extract",
      });
      const session = createResult.data;
      if (!session?.id) {
        log("error", "Failed to create transient session");
        return null;
      }
      log("info", "Transient session created", { sessionID: session.id });

      // 2. Prompt with json_schema output format
      log("info", "Sending extraction prompt");
      const promptResult = await this.client.session.prompt({
        sessionID: session.id,
        system: SYSTEM_PROMPT,
        format: {
          type: "json_schema",
          schema: EXTRACTION_JSON_SCHEMA,
          retryCount: 1,
        },
        parts: [{ type: "text", text: buildUserPrompt(trimmed) }],
      });

      const promptData = promptResult.data;
      if (!promptData) {
        log("error", "Extraction prompt returned no data");
        await this.cleanup(session.id);
        return null;
      }

      // Check for structured output error
      const error = promptData.info?.error;
      if (error) {
        log("error", "Extraction prompt returned error", {
          error: typeof error === "object" ? JSON.stringify(error).slice(0, 500) : String(error),
        });
        await this.cleanup(session.id);
        return null;
      }

      // The structured field contains the parsed JSON Schema output
      const structured = (promptData.info as { structured?: unknown }).structured;

      if (!structured) {
        log("warn", "No structured output in response — LLM may not support json_schema format");
        await this.cleanup(session.id);
        return null;
      }

      // 3. Validate through Zod
      const result = parseExtraction(structured);
      if (!result) {
        log("warn", "Structured output failed Zod validation", {
          preview: JSON.stringify(structured).slice(0, 300),
        });
        await this.cleanup(session.id);
        return null;
      }

      log("info", "OpenCode extraction complete", {
        wisdomCount: result.wisdom.length,
        tripleCount: result.triples.length,
      });

      // 4. Delete session
      await this.cleanup(session.id);

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log("error", "OpenCode extraction failed", { error: msg });
      return null;
    }
  }

  private async cleanup(sessionID: string): Promise<void> {
    try {
      await this.client.session.delete({ sessionID });
    } catch (error) {
      log("warn", "Session cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
