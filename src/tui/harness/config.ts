import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CustomHarnessConfig {
  name: string;
  id: string;
  detect_command: string;
  spawn_template: string;
}

export interface TuiConfig {
  theme?: "dark" | "light";
  preferred_harness?: string;
  preferred_agent?: string;
  custom_harnesses?: CustomHarnessConfig[];
}

const DEFAULT_CONFIG: TuiConfig = {
  preferred_harness: undefined,
  preferred_agent: undefined,
  custom_harnesses: [],
};

export function getConfigPath(): string {
  return join(homedir(), ".frieren", "tui.toml");
}

const normalizeCustomHarness = (value: unknown): CustomHarnessConfig | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CustomHarnessConfig>;

  if (
    typeof candidate.name !== "string" ||
    typeof candidate.id !== "string" ||
    typeof candidate.detect_command !== "string" ||
    typeof candidate.spawn_template !== "string"
  ) {
    return null;
  }

  return {
    name: candidate.name,
    id: candidate.id,
    detect_command: candidate.detect_command,
    spawn_template: candidate.spawn_template,
  };
};

export function loadConfig(): TuiConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as Partial<TuiConfig> | undefined;

    return {
      theme: parsed?.theme === "light" ? "light" : parsed?.theme === "dark" ? "dark" : undefined,
      preferred_harness:
        typeof parsed?.preferred_harness === "string" ? parsed.preferred_harness : undefined,
      preferred_agent:
        typeof parsed?.preferred_agent === "string" ? parsed.preferred_agent : undefined,
      custom_harnesses: Array.isArray(parsed?.custom_harnesses)
        ? parsed.custom_harnesses
            .map((entry) => normalizeCustomHarness(entry))
            .filter((entry): entry is CustomHarnessConfig => entry !== null)
        : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
