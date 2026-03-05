import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const normalizeRemote = (remote: string): string => {
  let normalized = remote.trim().toLowerCase();

  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }

  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
};

const findGitConfig = (start: string): string | null => {
  let current = start;

  while (true) {
    const candidate = join(current, ".git", "config");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
};

const parseOrigin = (config: string): string | null => {
  const lines = config.split("\n");
  let inOrigin = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('[remote "origin"]')) {
      inOrigin = true;
      continue;
    }

    if (inOrigin && line.startsWith("[")) {
      inOrigin = false;
    }

    if (inOrigin && line.startsWith("url")) {
      const [, value] = line.split("=");
      if (!value) {
        return null;
      }
      return value.trim();
    }
  }

  return null;
};

export const detectProjectId = (cwd: string = process.cwd()): string | null => {
  const configPath = findGitConfig(cwd);
  if (!configPath) {
    return null;
  }

  const rawConfig = readFileSync(configPath, "utf8");
  const origin = parseOrigin(rawConfig);
  if (!origin) {
    return null;
  }

  const normalized = normalizeRemote(origin);
  const hash = createHash("sha256").update(normalized).digest("hex");
  return hash.slice(0, 16);
};
