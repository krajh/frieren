import type { HarnessAdapter } from "./adapter.js";
import { createRegistry } from "./adapter.js";
import { createClaudeAdapter } from "./claude.js";
import { loadConfig } from "./config.js";
import { createCustomAdapters } from "./custom.js";
import { createOpenCodeAdapter } from "./opencode.js";

export function detectHarnesses(): HarnessAdapter[] {
  const config = loadConfig();
  const adapters = [
    createOpenCodeAdapter(),
    createClaudeAdapter(),
    ...createCustomAdapters(config),
  ];

  return createRegistry(adapters).adapters.filter((adapter) => adapter.detect());
}
