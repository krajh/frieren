import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

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

/**
 * Resolve the path to the real `.git/config` file, handling:
 * - Normal repos:  `{root}/.git/config`
 * - Worktrees:     `{root}/.git` is a file containing `gitdir: /path/to/.git/worktrees/<name>`
 * - Bare repos:    `{root}/config` (no `.git` subdir)
 */
const resolveGitConfigPath = (gitDir: string): string => {
  // gitDir might itself be a worktree gitdir file — follow the chain
  try {
    const stat = readFileSync(gitDir, "utf8");
    // It's a file containing "gitdir: <path>"
    const match = stat.match(/^gitdir:\s*(.+)$/m);
    if (match?.[1]) {
      const linked = match[1].trim();
      // Linked dir is the worktree-specific dir; common dir is two levels up
      const commonDir = join(linked, "..", "..");
      return join(commonDir, "config");
    }
  } catch {
    // It's a directory — fall through
  }
  return join(gitDir, "config");
};

const findGitConfig = (start: string): string | null => {
  let current = start;

  while (true) {
    const gitPath = join(current, ".git");

    // Try .git/config (normal repo) or follow .git file (worktree)
    try {
      const configPath = resolveGitConfigPath(gitPath);
      readFileSync(configPath); // throws if not found
      return configPath;
    } catch {
      // not found here
    }

    // Bare repo: config lives directly in the directory
    const bareConfig = join(current, "config");
    try {
      const content = readFileSync(bareConfig, "utf8");
      // Sanity-check: bare git configs start with [core]
      if (content.includes("[core]") && content.includes("bare = true")) {
        return bareConfig;
      }
    } catch {
      // not a bare repo root
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
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

const getCurrentBranch = (cwd: string): string => {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "HEAD";
  }
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
  const branch = getCurrentBranch(cwd);
  // Include branch so different worktrees of the same repo get distinct IDs
  const hash = createHash("sha256")
    .update(`${normalized}::${branch}`)
    .digest("hex");
  return hash.slice(0, 16);
};
