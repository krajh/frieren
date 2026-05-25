/**
 * LiteLLM Provider
 *
 * Calls LiteLLM during session compaction to extract structured knowledge:
 *   - Wisdom entries (decisions, patterns, constraints, issues)
 *   - Knowledge Graph triples (subject→predicate→object)
 *
 * Falls back gracefully if LiteLLM is unavailable or returns garbage.
 */

import type { LLMProvider, ExtractionResult } from "./provider.js";
import { parseExtraction } from "./provider.js";
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
    ? `[${timestamp}] [${level}] [litellm] ${message} ${JSON.stringify(meta)}\n`
    : `[${timestamp}] [${level}] [litellm] ${message}\n`;
  try { appendFileSync(LOG_FILE, line); } catch { /* silently drop */ }
};

// ─── Constants ───────────────────────────────────────────────────────────────

const LITELLM_URL = "https://litellm.aitooling.mgsops.net/v1/chat/completions";
const DEFAULT_MODEL = process.env.FRIEREN_LLM_MODEL ?? "gpt-5.4-nano";
const MAX_CONTEXT_CHARS = 4000;
const MAX_TOKENS = 2000;

// ─── Prompt Template ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a structured knowledge extraction engine for a coding agent's memory system. Your job is to analyze session compact summaries and extract durable knowledge.

Rules:
1. Only extract things you are confident are true and useful across sessions
2. **Decisions**: architectural choices, tool selections, feature decisions, design directions
3. **Patterns**: recurring approaches, conventions, implementation idioms, workflow habits
4. **Constraints**: limitations, pre-conditions, project-specific rules, dependency requirements
5. **Issues**: blockers, bugs found (but not yet fixed), problems encountered
6. **Triples**: entity relationships — subject, predicate, object (e.g. "Frieren", "uses", "SQLite")

Be conservative. Quality over quantity. Return valid JSON only with this exact structure:
{
  "wisdom": [
    { "type": "decision|pattern|constraint|issue", "content": "clear description", "confidence": 0.0-1.0 }
  ],
  "triples": [
    { "subject": "entity name", "predicate": "relationship", "object": "entity name", "confidence": 0.0-1.0 }
  ]
}

Rules:
- Only include entries with confidence > 0.3
- Wisdom content should be self-contained sentences or phrases
- Triples represent durable entity relationships, not session-specific details
- If nothing meaningful can be extracted, return {"wisdom": [], "triples": []}`;

function buildUserPrompt(contextText: string): string {
  const truncated = contextText.slice(0, MAX_CONTEXT_CHARS);
  return `Analyze this coding session compact and extract structured knowledge from it.

Session compact:
"""
${truncated}
"""

Return valid JSON only.`;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class LiteLLMProvider implements LLMProvider {
  readonly name = "litellm";

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number = 15_000,
  ) {}

  async extract(contextText: string): Promise<ExtractionResult | null> {
    const trimmed = contextText.trim();
    if (!trimmed) {
      log("info", "Empty context text — nothing to extract");
      return null;
    }

    log("info", "Starting LiteLLM extraction", {
      chars: trimmed.length,
      model: DEFAULT_MODEL,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(LITELLM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(trimmed) },
          ],
          temperature: 0.1,
          max_tokens: MAX_TOKENS,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => "unknown");
        log("error", `LiteLLM returned ${response.status}`, {
          status: response.status,
          error: errText.slice(0, 500),
        });
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        log("error", "LiteLLM returned empty content");
        return null;
      }

      // Parse JSON from response (may be wrapped in markdown code block)
      const parsed = this.parseJSONResponse(content);
      if (!parsed) {
        log("warn", "Failed to parse LLM response as JSON", {
          preview: content.slice(0, 300),
        });
        return null;
      }

      // Validate through Zod
      const result = parseExtraction(parsed);
      if (!result) {
        log("warn", "LLM output failed Zod validation", {
          preview: JSON.stringify(parsed).slice(0, 300),
        });
        return null;
      }

      log("info", "LiteLLM extraction complete", {
        wisdomCount: result.wisdom.length,
        tripleCount: result.triples.length,
        tokensUsed: data.usage?.total_tokens ?? "unknown",
      });

      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        log("error", "LiteLLM request timed out", { timeoutMs: this.timeoutMs });
      } else {
        log("error", "LiteLLM request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  }

  /**
   * Parse JSON from LLM response — handles raw JSON, markdown-fenced JSON,
   * and embedded JSON objects.
   */
  private parseJSONResponse(raw: string): unknown {
    // Try direct parse first
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Not direct JSON
    }

    // Try extracting from ```json ... ``` block
    const jsonBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) {
      try {
        const captured = jsonBlockMatch[1];
        if (captured) return JSON.parse(captured.trim());
      } catch {
        /* fall through */
      }
    }

    // Try extracting top-level JSON object
    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        /* fall through */
      }
    }

    return null;
  }
}
