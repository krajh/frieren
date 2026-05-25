/**
 * Extraction Utilities
 *
 * Helpers for deduplicating and persisting extracted wisdom/KG entries
 * through Frieren MCP tools.
 */

import type { ExtractionResult, ExtractedWisdom, ExtractedTriple } from "./provider.js";
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
    ? `[${timestamp}] [${level}] [extraction-utils] ${message} ${JSON.stringify(meta)}\n`
    : `[${timestamp}] [${level}] [extraction-utils] ${message}\n`;
  try { appendFileSync(LOG_FILE, line); } catch { /* silently drop */ }
};

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Function signature for calling Frieren MCP tools through the bridge.
 */
export type FrierenToolFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

// ─── Deduplication ──────────────────────────────────────────────────────────

/**
 * Deduplicate wisdom entries against existing Frieren memory.
 * For each entry, semantic-search Frieren — if a similar entry exists (≥0.85),
 * the candidate is skipped.
 */
export async function deduplicateWisdom(
  entries: ExtractedWisdom[],
  callTool: FrierenToolFn,
): Promise<ExtractedWisdom[]> {
  const deduped: ExtractedWisdom[] = [];

  for (const entry of entries) {
    try {
      const searchResult = await callTool("wisdom_search", {
        query: entry.content,
        type_filter: entry.type,
        limit: 3,
      });

      const isDuplicate = hasCloseMatch(searchResult, entry.content);
      if (isDuplicate) {
        log("info", "Skipping duplicate wisdom", {
          type: entry.type,
          preview: entry.content.slice(0, 80),
        });
        continue;
      }
    } catch (error) {
      // On search failure, be conservative — include the entry
      log("warn", "Dedup search failed, including entry", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    deduped.push(entry);
  }

  return deduped;
}

/**
 * Deduplicate KG triples against existing Frieren knowledge graph.
 * If the same subject+predicate already exists, skip it.
 */
export async function deduplicateTriples(
  triples: ExtractedTriple[],
  callTool: FrierenToolFn,
): Promise<ExtractedTriple[]> {
  const deduped: ExtractedTriple[] = [];

  for (const triple of triples) {
    try {
      const queryResult = await callTool("kg_query", {
        entity: triple.subject,
        predicate: triple.predicate,
        limit: 5,
      });

      // If the query returns results, the relationship already exists
      const queryStr = typeof queryResult === "string"
        ? queryResult
        : JSON.stringify(queryResult);

      if (queryStr.length > 10 && !queryStr.includes("No results") && !queryStr.includes("[]")) {
        log("info", "Skipping existing triple", {
          subject: triple.subject,
          predicate: triple.predicate,
        });
        continue;
      }
    } catch {
      // On failure, be conservative — include the triple
    }

    deduped.push(triple);
  }

  return deduped;
}

/**
 * Check if a wisdom candidate is too similar to existing entries.
 * Uses simple text overlap for now — Frieren's semantic search already
 * handles the heavy lifting by returning relevant results.
 */
function hasCloseMatch(searchResult: unknown, candidate: string): boolean {
  const text = typeof searchResult === "string"
    ? searchResult
    : JSON.stringify(searchResult);

  if (!text || text.length < 20) return false;

  // Simple heuristic: if the search result contains most of the candidate's
  // key terms, it's likely a duplicate
  const words = candidate.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  if (words.length === 0) return false;

  const textLower = text.toLowerCase();
  const matchCount = words.filter((w) => textLower.includes(w)).length;
  const ratio = matchCount / words.length;

  return ratio >= 0.7;
}

// ─── Persistence ────────────────────────────────────────────────────────────

/**
 * Write deduplicated wisdom entries to Frieren.
 * Returns the count of successfully written entries.
 */
export async function writeWisdomEntries(
  entries: ExtractedWisdom[],
  callTool: FrierenToolFn,
): Promise<number> {
  let written = 0;

  for (const entry of entries) {
    try {
      await callTool("wisdom_write", {
        type: entry.type,
        content: entry.content,
        confidence: entry.confidence ?? 0.8,
        tags: ["extracted", "compact"],
        kind: "discovery",
      });
      written++;
    } catch (error) {
      log("error", "Failed to write wisdom entry", {
        type: entry.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return written;
}

/**
 * Write deduplicated KG triples to Frieren.
 * Returns the count of successfully written triples.
 */
export async function writeTriples(
  triples: ExtractedTriple[],
  callTool: FrierenToolFn,
): Promise<number> {
  let written = 0;

  for (const triple of triples) {
    try {
      await callTool("kg_add", {
        subject: triple.subject,
        predicate: triple.predicate,
        object: triple.object,
        confidence: triple.confidence ?? 0.8,
      });
      written++;
    } catch (error) {
      log("error", "Failed to write triple", {
        triple: `${triple.subject} → ${triple.predicate} → ${triple.object}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return written;
}

/**
 * Full write pipeline: deduplicate + persist.
 * Returns a summary of what was written.
 */
export async function persistExtraction(
  result: ExtractionResult,
  callTool: FrierenToolFn,
): Promise<{ wisdomWritten: number; triplesWritten: number }> {
  const [dedupedWisdom, dedupedTriples] = await Promise.all([
    deduplicateWisdom(result.wisdom, callTool),
    deduplicateTriples(result.triples, callTool),
  ]);

  const [wisdomWritten, triplesWritten] = await Promise.all([
    writeWisdomEntries(dedupedWisdom, callTool),
    writeTriples(dedupedTriples, callTool),
  ]);

  log("info", "Extraction persisted", {
    extracted: { wisdom: result.wisdom.length, triples: result.triples.length },
    deduped: { wisdom: result.wisdom.length - dedupedWisdom.length, triples: result.triples.length - dedupedTriples.length },
    written: { wisdom: wisdomWritten, triples: triplesWritten },
  });

  return { wisdomWritten, triplesWritten };
}
