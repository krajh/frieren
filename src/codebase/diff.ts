import { execSync } from "node:child_process";

export const getGitHead = (rootPath: string): string | null => {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
};

export const getChangedFiles = (
  rootPath: string,
  lastCommit: string,
): string[] => {
  try {
    const output = execSync(`git diff --name-only ${lastCommit} HEAD`, {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
};

export const getGitRoot = (fromPath: string): string | null => {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: fromPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
};
