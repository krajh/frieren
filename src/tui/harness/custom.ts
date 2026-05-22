import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { HarnessAdapter, SpawnOptions } from "./adapter.js";
import { waitForSpawnResult } from "./adapter.js";
import type { TuiConfig } from "./config.js";

const tokenizeArgv = (command: string): string[] => {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
};

const maybeCreateContextFile = (template: string, prompt: string, options?: SpawnOptions): string | undefined => {
  if (!template.includes("{context_file}")) {
    return options?.contextFiles?.[0];
  }

  const existing = options?.contextFiles?.[0];
  if (existing) {
    return existing;
  }

  const dir = mkdtempSync(join(tmpdir(), "frieren-tui-"));
  const filePath = join(dir, "context.txt");
  writeFileSync(filePath, prompt, "utf8");
  return filePath;
};

const cleanupContextFile = (filePath: string | undefined): void => {
  if (!filePath || !filePath.includes(`${tmpdir()}/frieren-tui-`)) {
    return;
  }

  try {
    rmSync(filePath, { force: true });
    rmSync(dirname(filePath), { force: true, recursive: true });
  } catch {
    // ignore cleanup failures
  }
};

const expandTemplate = (template: string, prompt: string, contextFile?: string): string[] => {
  return tokenizeArgv(template).map((part) => {
    return part
      .replaceAll("{prompt}", prompt)
      .replaceAll("{context_file}", contextFile ?? "");
  });
};

export function createCustomAdapters(config: TuiConfig): HarnessAdapter[] {
  return (config.custom_harnesses ?? []).map((custom) => {
    return {
      name: custom.name,
      id: custom.id,
      detect: () => {
        const argv = tokenizeArgv(custom.detect_command);
        return argv.length > 0 ? Bun.spawnSync(argv).success : false;
      },
      getAvailableAgents: () => ["default"],
      spawn: async (prompt: string, options?: SpawnOptions) => {
        const contextFile = maybeCreateContextFile(custom.spawn_template, prompt, options);

        try {
          const argv = expandTemplate(custom.spawn_template, prompt, contextFile);
          if (argv.length === 0) {
            return { success: false, stderr: "Custom harness template produced no command." };
          }

          const proc = Bun.spawn(argv, {
            cwd: options?.workdir,
            stdio: ["inherit", "pipe", "pipe"],
          });
          const result = await waitForSpawnResult(proc);
          proc.exited.finally(() => cleanupContextFile(contextFile));
          return result;
        } catch (error) {
          cleanupContextFile(contextFile);
          return {
            success: false,
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  });
}
