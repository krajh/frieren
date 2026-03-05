export type ChunkType = "function" | "class" | "module" | "block";

export type CodeChunk = {
  chunk_type: ChunkType;
  name: string | null;
  content: string;
  start_line: number;
  end_line: number;
  language: string;
};

export type FileDep = {
  to_file: string;
  dep_type: "import" | "require" | "dynamic";
};

const MAX_CHUNK_LINES = 100;

const SUPPORTED_CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const SUPPORTED_OTHER_EXTS = new Set([".md", ".json"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
]);

export const shouldSkipFile = (filePath: string): boolean => {
  const parts = filePath.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;

  const ext = filePath.slice(filePath.lastIndexOf("."));
  if (BINARY_EXTS.has(ext)) return true;

  return !SUPPORTED_CODE_EXTS.has(ext) && !SUPPORTED_OTHER_EXTS.has(ext);
};

export const detectLanguage = (filePath: string): string => {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if (ext === ".md") return "markdown";
  if (ext === ".json") return "json";
  return "unknown";
};

const splitAtBoundary = (
  lines: string[],
  startLine: number,
  chunkType: ChunkType,
  name: string | null,
  language: string,
): CodeChunk[] => {
  const chunks: CodeChunk[] = [];
  let offset = 0;

  while (offset < lines.length) {
    const slice = lines.slice(offset, offset + MAX_CHUNK_LINES);
    chunks.push({
      chunk_type: chunkType,
      name: offset === 0 ? name : null,
      content: slice.join("\n"),
      start_line: startLine + offset,
      end_line: startLine + offset + slice.length - 1,
      language,
    });
    offset += MAX_CHUNK_LINES;
  }

  return chunks;
};

// Extract function/class blocks using brace counting to find end
const extractBlock = (
  lines: string[],
  startIdx: number,
): { blockLines: string[]; endIdx: number } => {
  let depth = 0;
  let started = false;
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
        if (started && depth <= 0) {
          return {
            blockLines: lines.slice(startIdx, i + 1),
            endIdx: i,
          };
        }
      }
    }
    // Cap block extraction at 200 lines to avoid infinite loops on malformed code
    if (i - startIdx > 200) break;
    i++;
  }

  // Fallback: take up to MAX_CHUNK_LINES from start
  const end = Math.min(startIdx + MAX_CHUNK_LINES - 1, lines.length - 1);
  return { blockLines: lines.slice(startIdx, end + 1), endIdx: end };
};

export const chunkCode = (
  content: string,
  filePath: string,
): { chunks: CodeChunk[]; deps: FileDep[] } => {
  const language = detectLanguage(filePath);
  const ext = filePath.slice(filePath.lastIndexOf("."));

  // Non-code files: single module chunk if small enough
  if (!SUPPORTED_CODE_EXTS.has(ext)) {
    const lines = content.split("\n");
    if (ext === ".json" && lines.length > 50) {
      return { chunks: [], deps: [] };
    }
    if (lines.length > 200) {
      return { chunks: [], deps: [] };
    }
    return {
      chunks: [
        {
          chunk_type: "module",
          name: null,
          content,
          start_line: 1,
          end_line: lines.length,
          language,
        },
      ],
      deps: [],
    };
  }

  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  const deps: FileDep[] = [];

  // Collect deps
  for (const line of lines) {
    // import ... from "..."
    const importMatch = line.match(
      /^\s*import\s+(?:.+\s+from\s+)?['"]([^'"]+)['"]/,
    );
    if (importMatch?.[1]) {
      deps.push({
        to_file: importMatch[1],
        dep_type: "import",
      });
      continue;
    }
    // require("...")
    const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch?.[1]) {
      deps.push({ to_file: requireMatch[1], dep_type: "require" });
    }
    // dynamic import("...")
    const dynamicMatch = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (dynamicMatch?.[1]) {
      deps.push({ to_file: dynamicMatch[1], dep_type: "dynamic" });
    }
  }

  // Regex patterns for symbol extraction
  // named function declaration: function foo(
  const funcDeclRe = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/;
  // arrow / const function: const foo = (...) => or const foo = async (
  const arrowFuncRe =
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\S+\s*)?=>/;
  // class declaration
  const classRe = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;

  const usedLines = new Set<number>();
  const extractedChunks: Array<{
    startIdx: number;
    endIdx: number;
    name: string;
    type: ChunkType;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const funcMatch = line.match(funcDeclRe) ?? line.match(arrowFuncRe);
    const classMatch = line.match(classRe);

    if (classMatch?.[1]) {
      const { endIdx } = extractBlock(lines, i);
      extractedChunks.push({
        startIdx: i,
        endIdx,
        name: classMatch[1],
        type: "class",
      });
      for (let j = i; j <= endIdx; j++) usedLines.add(j);
      i = endIdx;
    } else if (funcMatch?.[1]) {
      const { endIdx } = extractBlock(lines, i);
      extractedChunks.push({
        startIdx: i,
        endIdx,
        name: funcMatch[1],
        type: "function",
      });
      for (let j = i; j <= endIdx; j++) usedLines.add(j);
      i = endIdx;
    }
  }

  // Emit extracted chunks (split if > MAX_CHUNK_LINES)
  for (const ec of extractedChunks) {
    const blockLines = lines.slice(ec.startIdx, ec.endIdx + 1);
    const sub = splitAtBoundary(
      blockLines,
      ec.startIdx + 1,
      ec.type,
      ec.name,
      language,
    );
    chunks.push(...sub);
  }

  // Remaining lines as block chunks
  const remainingLines: Array<{ line: string; lineNo: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!usedLines.has(i)) {
      remainingLines.push({ line: lines[i] ?? "", lineNo: i + 1 });
    }
  }

  if (remainingLines.length > 0) {
    const blockContent = remainingLines
      .map((r) => r.line)
      .join("\n")
      .trim();
    if (blockContent.length > 0) {
      // Split remaining into MAX_CHUNK_LINES pieces
      let offset = 0;
      while (offset < remainingLines.length) {
        const slice = remainingLines.slice(offset, offset + MAX_CHUNK_LINES);
        chunks.push({
          chunk_type: "block",
          name: null,
          content: slice.map((r) => r.line).join("\n"),
          start_line: slice[0]!.lineNo,
          end_line: slice[slice.length - 1]!.lineNo,
          language,
        });
        offset += MAX_CHUNK_LINES;
      }
    }
  }

  // If no chunks at all, treat file as a single module chunk
  if (chunks.length === 0) {
    const sub = splitAtBoundary(lines, 1, "module", null, language);
    chunks.push(...sub);
  }

  return { chunks, deps };
};
