/**
 * Frieren Compression Utility
 *
 * AAAK-style shorthand dialect for compact L1 context.
 * Lossless-ish: compresses text but can be re-expanded by any LLM.
 *
 * Based on template patterns — replaces common phrases with abbreviations.
 */

type CompressionRule = {
  pattern: RegExp;
  replacement: string;
};

// Core compression rules — template-based abbreviations
const COMPRESSION_RULES: CompressionRule[] = [
  // Team/People
  { pattern: /\bKailash Rajh\b/gi, replacement: "KAI" },
  { pattern: /\bKai\b/gi, replacement: "KAI" },
  { pattern: /\bRias Gremory\b/gi, replacement: "RIAS" },
  { pattern: /\bRias\b/gi, replacement: "RIAS" },
  { pattern: /\bMarin Coder\b/gi, replacement: "MARIN" },
  { pattern: /\bMarin\b/gi, replacement: "MARIN" },
  { pattern: /\bXenovia Backend\b/gi, replacement: "XENO" },
  { pattern: /\bXenovia\b/gi, replacement: "XENO" },
  { pattern: /\bMittelt Frontend\b/gi, replacement: "MITTELT" },
  { pattern: /\bMittelt\b/gi, replacement: "MITTELT" },
  { pattern: /\bFrieren\b/gi, replacement: "FRI" },
  { pattern: /\bOpenCode\b/gi, replacement: "OC" },

  // Common patterns
  { pattern: /\bproject\b/gi, replacement: "proj" },
  { pattern: /\bprojects\b/gi, replacement: "projs" },
  { pattern: /\bconfiguration\b/gi, replacement: "config" },
  { pattern: /\bimplementation\b/gi, replacement: "impl" },
  { pattern: /\bdescription\b/gi, replacement: "desc" },
  { pattern: /\breference\b/gi, replacement: "ref" },
  { pattern: /\bfunctionality\b/gi, replacement: "func" },

  // Decision patterns
  { pattern: /\bdecided to\b/gi, replacement: "decided:" },
  { pattern: /\bapproved\b/gi, replacement: "✓" },
  { pattern: /\brejected\b/gi, replacement: "✗" },
  { pattern: /\bdeferred\b/gi, replacement: "→" },
  { pattern: /\bongoing\b/gi, replacement: "◐" },
  { pattern: /\bcompleted\b/gi, replacement: "✓" },

  // Priority patterns
  { pattern: /\bhigh priority\b/gi, replacement: "P0" },
  { pattern: /\bmedium priority\b/gi, replacement: "P1" },
  { pattern: /\blow priority\b/gi, replacement: "P2" },
  { pattern: /\bcritical\b/gi, replacement: "P0" },
  { pattern: /\bimportant\b/gi, replacement: "P1" },

  // Time patterns
  { pattern: /\bToday\b/gi, replacement: "TOD" },
  { pattern: /\bYesterday\b/gi, replacement: "YEST" },
  { pattern: /\bTomorrow\b/gi, replacement: "TOM" },
  { pattern: /\bthis week\b/gi, replacement: "TW" },
  { pattern: /\blast week\b/gi, replacement: "LW" },
  { pattern: /\bthis month\b/gi, replacement: "TM" },
  { pattern: /\blatest\b/gi, replacement: "LATEST" },

  // Context patterns
  { pattern: /\bworking on\b/gi, replacement: "WIP" },
  { pattern: /\bfocus on\b/gi, replacement: "FOCUS" },
  { pattern: /\bstarted\b/gi, replacement: "STARTED" },
  { pattern: /\bfinished\b/gi, replacement: "DONE" },
  { pattern: /\bblocked\b/gi, replacement: "BLK" },
  { pattern: /\bpending\b/gi, replacement: "PEND" },

  // Documentation
  { pattern: /\bdocumentation\b/gi, replacement: "docs" },
  { pattern: /\btechnical specification\b/gi, replacement: "spec" },
  { pattern: /\brequirement\b/gi, replacement: "req" },
  { pattern: /\brequirements\b/gi, replacement: "reqs" },

  // Code patterns
  { pattern: /\bapplication programming interface\b/gi, replacement: "API" },
  { pattern: /\buser interface\b/gi, replacement: "UI" },
  { pattern: /\buser experience\b/gi, replacement: "UX" },
  { pattern: /\btypescript\b/gi, replacement: "TS" },
  { pattern: /\bjavascript\b/gi, replacement: "JS" },
  { pattern: /\bhypertext markup language\b/gi, replacement: "HTML" },
  { pattern: /\bcascading style sheets\b/gi, replacement: "CSS" },
  { pattern: /\bmodel context protocol\b/gi, replacement: "MCP" },

  // Memory/context
  { pattern: /\bmemory system\b/gi, replacement: "MEM" },
  { pattern: /\bsession context\b/gi, replacement: "SESSION" },
  { pattern: /\bcodebase context\b/gi, replacement: "CODE" },
  { pattern: /\bwisdom plane\b/gi, replacement: "WISDOM" },
  { pattern: /\bdecision\b/gi, replacement: "DEC" },
  { pattern: /\bpattern\b/gi, replacement: "PAT" },
  { pattern: /\bconstraint\b/gi, replacement: "CONST" },
  { pattern: /\bissue\b/gi, replacement: "ISS" },
];

/**
 * Compress text using shorthand rules
 */
export function compress(text: string, maxLength: number = 500): string {
  let result = text;

  // Apply compression rules
  for (const rule of COMPRESSION_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // Remove extra whitespace
  result = result.replace(/\s+/g, " ").trim();

  // Truncate if too long
  if (result.length > maxLength) {
    result = result.slice(0, maxLength - 3) + "...";
  }

  return result;
}

/**
 * Decompress shorthand back to natural language
 * Note: This is approximate — not all abbreviations can be expanded perfectly
 */
export function decompress(text: string): string {
  let result = text;

  // Reverse mappings for common abbreviations
  const DECOMPRESS_MAP: Record<string, string> = {
    KAI: "Kai",
    RIAS: "Rias Gremory",
    MARIN: "Marin",
    XENO: "Xenovia",
    MITTELT: "Mittelt",
    FRI: "Frieren",
    OC: "OpenCode",
    P0: "high priority",
    P1: "medium priority",
    P2: "low priority",
    TOD: "Today",
    YEST: "Yesterday",
    TOM: "Tomorrow",
    TW: "this week",
    LW: "last week",
    TM: "this month",
    WIP: "working on",
    FOCUS: "focus on",
    STARTED: "started",
    DONE: "completed",
    BLK: "blocked",
    PEND: "pending",
    API: "API",
    UI: "UI",
    UX: "UX",
    MCP: "MCP",
    MEM: "memory system",
    SESSION: "session context",
    CODE: "codebase context",
    WISDOM: "wisdom plane",
    DEC: "decision",
    PAT: "pattern",
    CONST: "constraint",
    ISS: "issue",
  };

  // Replace abbreviations with expansions
  for (const [abbr, expanded] of Object.entries(DECOMPRESS_MAP)) {
    // Match whole word abbreviations only
    const regex = new RegExp(`\\b${abbr}\\b`, "g");
    result = result.replace(regex, expanded);
  }

  return result;
}

/**
 * Compress a list of wisdom entries into L1 format
 */
export function compressL1(
  entries: Array<{ content: string; created_at: string }>,
  maxTokens: number = 120,
): string[] {
  const MAX_CHARS = maxTokens * 4;
  const compressed: string[] = [];
  let totalChars = 0;

  for (const entry of entries) {
    const compressedEntry = compress(entry.content);
    const line = `[${entry.created_at.slice(0, 10)}] ${compressedEntry}`;

    if (totalChars + line.length > MAX_CHARS) {
      break;
    }

    compressed.push(line);
    totalChars += line.length;
  }

  return compressed;
}

/**
 * Estimate token count for text
 */
export function estimateTokens(text: string): number {
  // Rough estimate: 4 chars per token
  return Math.ceil(text.length / 4);
}

/**
 * Compress with stats
 */
export function compressWithStats(text: string): {
  original: string;
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  ratio: number;
} {
  const compressed = compress(text);
  const originalTokens = estimateTokens(text);
  const compressedTokens = estimateTokens(compressed);

  return {
    original: text,
    compressed,
    originalTokens,
    compressedTokens,
    ratio: originalTokens > 0 ? originalTokens / compressedTokens : 1,
  };
}
