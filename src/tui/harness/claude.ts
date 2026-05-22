import type { HarnessAdapter, SpawnOptions } from "./adapter.js";
import { waitForSpawnResult } from "./adapter.js";

const isInstalled = (): boolean => Bun.spawnSync(["which", "claude"]).success;

export function createClaudeAdapter(): HarnessAdapter {
  return {
    name: "Claude CLI",
    id: "claude",
    detect: isInstalled,
    getAvailableAgents: () => ["default"],
    spawn: async (prompt: string, options?: SpawnOptions) => {
      try {
        const argv = ["claude", "-p", prompt];
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
