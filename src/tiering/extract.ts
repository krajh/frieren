type ExtractType = "text" | "code";

type ExtractMeta = {
  chunkType?: string;
  name?: string;
};

const clamp = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max).trimEnd();

const firstSentence = (content: string): string => {
  const normalized = content.trim();
  if (!normalized) return "";

  const periodIdx = normalized.indexOf(".");
  const newlineIdx = normalized.indexOf("\n");
  const cutCandidates = [periodIdx, newlineIdx].filter((idx) => idx >= 0);
  const cutAt =
    cutCandidates.length > 0
      ? Math.min(...cutCandidates)
      : Math.min(normalized.length - 1, 149);

  return clamp(normalized.slice(0, cutAt + 1), 150);
};

const firstParagraph = (content: string): string => {
  const normalized = content.trim();
  if (!normalized) return "";

  const paragraphBreak = normalized.indexOf("\n\n");
  const paragraph =
    paragraphBreak >= 0 ? normalized.slice(0, paragraphBreak) : normalized;

  return clamp(paragraph, 500);
};

const firstCodeLine = (content: string): string => {
  const lines = content.split("\n");
  let inBlockComment = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (inBlockComment) {
      if (line.includes("*/")) {
        inBlockComment = false;
      }
      continue;
    }

    if (line.startsWith("/*")) {
      if (!line.includes("*/")) {
        inBlockComment = true;
      }
      continue;
    }

    if (line.startsWith("//")) {
      continue;
    }

    return line;
  }

  return content.trim().split("\n")[0]?.trim() ?? "";
};

const leadingCodeCommentBlock = (content: string): string => {
  const lines = content.split("\n");
  const collected: string[] = [];
  let idx = 0;

  while (idx < lines.length && !lines[idx]?.trim()) {
    idx++;
  }

  const first = lines[idx]?.trim() ?? "";
  if (first.startsWith("/*")) {
    for (; idx < lines.length; idx++) {
      const line = lines[idx] ?? "";
      collected.push(line.trimEnd());
      if (line.includes("*/")) {
        break;
      }
    }
    return collected.join("\n").trim();
  }

  while (idx < lines.length) {
    const line = lines[idx]?.trimEnd() ?? "";
    if (!line.trim()) {
      if (collected.length > 0) break;
      idx++;
      continue;
    }
    if (!line.trimStart().startsWith("//")) {
      break;
    }
    collected.push(line);
    idx++;
  }

  return collected.join("\n").trim();
};

export function extractAbstract(
  content: string,
  type: ExtractType,
  meta?: ExtractMeta,
): string {
  if (type === "code") {
    if (meta?.chunkType && meta?.name) {
      return clamp(`${meta.chunkType}: ${meta.name}`, 150);
    }
    return clamp(firstCodeLine(content), 150);
  }

  return firstSentence(content);
}

export function extractSummary(content: string, type: ExtractType): string {
  if (type === "code") {
    const comment = leadingCodeCommentBlock(content);
    const signature = firstCodeLine(content);
    const merged = [comment, signature].filter(Boolean).join("\n");
    return clamp(merged || signature || content.trim(), 500);
  }

  return firstParagraph(content);
}
