/**
 * LLM Provider Abstraction
 *
 * Defines the provider interface for structured knowledge extraction from
 * session compacts, and a factory that reads FRIEREN_LLM_PROVIDER to
 * select the active implementation (opencode | litellm).
 */

import { z } from "zod";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtractedWisdom {
  type: "decision" | "pattern" | "constraint" | "issue";
  content: string;
  confidence: number;
}

export interface ExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface ExtractionResult {
  wisdom: ExtractedWisdom[];
  triples: ExtractedTriple[];
}

export const EMPTY_EXTRACTION: ExtractionResult = {
  wisdom: [],
  triples: [],
};

// ─── Zod Schemas (for runtime validation) ────────────────────────────────────

const WisdomEntrySchema = z.object({
  type: z.enum(["decision", "pattern", "constraint", "issue"]),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const TripleSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const ExtractionSchema = z.object({
  wisdom: z.array(WisdomEntrySchema).default([]),
  triples: z.array(TripleSchema).default([]),
});

/**
 * Parse and validate raw LLM output through the Zod schema.
 * Returns null on parse failure (conservative — quality over quantity).
 */
export function parseExtraction(raw: unknown): ExtractionResult | null {
  const result = ExtractionSchema.safeParse(raw);
  if (!result.success) return null;

  // Filter low-confidence entries
  const wisdom = result.data.wisdom.filter(
    (w) => w.confidence > 0.3 && w.content.trim(),
  );
  const triples = result.data.triples.filter(
    (t) => t.confidence > 0.3 && t.subject.trim() && t.object.trim(),
  );

  return { wisdom, triples };
}

/**
 * JSON Schema (draft-07) for the extraction result.
 * Used by the OpenCode SDK's json_schema output format.
 * Hand-written to avoid dependency issues with zod-to-json-schema.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    wisdom: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["decision", "pattern", "constraint", "issue"],
          },
          content: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["type", "content", "confidence"],
        additionalProperties: false,
      },
    },
    triples: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string", minLength: 1 },
          predicate: { type: "string", minLength: 1 },
          object: { type: "string", minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["subject", "predicate", "object", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["wisdom", "triples"],
  additionalProperties: false,
} as const;

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface LLMProvider {
  readonly name: string;
  extract(contextText: string): Promise<ExtractionResult | null>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export type ProviderKind = "opencode" | "litellm" | "none";

let _provider: LLMProvider | null | undefined = undefined; // lazy singleton

/**
 * Get or create the LLM provider based on FRIEREN_LLM_PROVIDER env var.
 * Returns null if no suitable provider is configured.
 *
 * Reads: FRIEREN_LLM_PROVIDER (default: "opencode") | FRIEREN_LLM_TIMEOUT
 * For litellm: requires AITOOLINGKEY
 */
export async function getLLMProvider(): Promise<{
  provider: LLMProvider | null;
  kind: ProviderKind;
}> {
  if (_provider !== undefined) {
    return { provider: _provider, kind: inferKind(_provider) };
  }

  const kind = (process.env.FRIEREN_LLM_PROVIDER ?? "opencode") as ProviderKind;

  if (kind === "litellm") {
    const apiKey = process.env.AITOOLINGKEY;
    if (!apiKey) {
      _provider = null;
      return { provider: null, kind: "none" };
    }
    // Lazy-import to avoid circular deps — provider.ts is the base, llm-extract imports FROM it
    const { LiteLLMProvider } = await import("./llm-extract.js") as {
      LiteLLMProvider: new (apiKey: string, timeoutMs: number) => LLMProvider;
    };
    const timeout = Number(process.env.FRIEREN_LLM_TIMEOUT) || 15_000;
    _provider = new LiteLLMProvider(apiKey, timeout);
    return { provider: _provider, kind };
  }

  if (kind === "opencode") {
    const { OpenCodeProvider } = await import("./opencode-provider.js") as {
      OpenCodeProvider: new (timeoutMs: number) => LLMProvider;
    };
    const timeout = Number(process.env.FRIEREN_LLM_TIMEOUT) || 15_000;
    _provider = new OpenCodeProvider(timeout);
    return { provider: _provider, kind };
  }

  _provider = null;
  return { provider: null, kind: "none" };
}

function inferKind(p: LLMProvider | null): ProviderKind {
  if (!p) return "none";
  if (p.name === "opencode") return "opencode";
  if (p.name === "litellm") return "litellm";
  return "none";
}

/** Reset cached provider (for testing / config changes). */
export function resetLLMProvider(): void {
  _provider = undefined;
}
