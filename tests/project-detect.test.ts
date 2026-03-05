import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";

import { detectProjectId } from "../src/project/detectProjectId.js";

test("detectProjectId returns 16-char hex for git repo", () => {
  const repoRoot = execSync("git rev-parse --show-toplevel", {
    cwd: import.meta.dir,
    encoding: "utf8",
  }).trim();

  try {
    execSync("git remote add origin https://example.com/frieren.git", {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    // ignore if origin already exists
  }

  const projectId = detectProjectId(repoRoot);

  assert.ok(projectId);
  assert.equal(projectId?.length, 16);
  assert.match(projectId ?? "", /^[0-9a-f]{16}$/);
});
