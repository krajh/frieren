import type { HarnessAdapter, SpawnOptions } from "./adapter.js";
import { waitForSpawnResult } from "./adapter.js";

const DEFAULT_AGENTS = [
  "marin-coder",
  "akeno-architect",
  "guillotine-reviewer",
  "tsubaki-research",
  "frieren-context",
];

const isInstalled = (): boolean => Bun.spawnSync(["which", "opencode"]).success;

export function createOpenCodeAdapter(): HarnessAdapter {
  return {
    name: "OpenCode",
    id: "opencode",
    detect: isInstalled,
    getAvailableAgents: () => [...DEFAULT_AGENTS],
    spawn: async (prompt: string, options?: SpawnOptions) => {
      try {
        const agent = options?.agent ?? DEFAULT_AGENTS[0] ?? "marin-coder";
        const argv = ["opencode", "run", "--agent", agent, prompt];
        const proc = Bun.spawn(argv, {
          cwd: options?.workdir,
          stdio: ["inherit", "pipe", "pipe"],
        });

        return await waitForSpawnResult(proc);
      } catch (error) {
        return {
          success: false,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
