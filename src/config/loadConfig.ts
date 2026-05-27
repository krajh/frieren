import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FrierenConfig = {
  litellm: {
    baseUrl: string;
    apiKey: string;
    embeddingModel: string;
  };
  storage: {
    home: string;
  };
  session: {
    retentionDays: number;
  };
  /** Optional human-readable project names keyed by project ID hash */
  project_names?: Record<string, string>;
};

export const DEFAULT_CONFIG: FrierenConfig = {
  litellm: {
    baseUrl: "http://localhost:4000",
    apiKey: "",
    embeddingModel: "text-embedding-3-small",
  },
  storage: {
    home: "~/.frieren",
  },
  session: {
    retentionDays: 60,
  },
};
import { ensureDir } from "../utils/fs.js";

const CONFIG_FILE_NAME = "config.json";

const expandHome = (value: string): string => {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }

  return value;
};

const mergeConfig = (
  base: FrierenConfig,
  override?: Partial<FrierenConfig>,
): FrierenConfig => {
  if (!override) {
    return { ...base };
  }

  return {
    litellm: {
      ...base.litellm,
      ...override.litellm,
    },
    storage: {
      ...base.storage,
      ...override.storage,
    },
    session: {
      ...base.session,
      ...override.session,
    },
    project_names: {
      ...(base.project_names ?? {}),
      ...(override.project_names ?? {}),
    },
  };
};

export const saveProjectName = (projectId: string, name: string): void => {
  const configPath = expandHome(
    join(DEFAULT_CONFIG.storage.home, CONFIG_FILE_NAME),
  );
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const existing: Record<string, string> = (parsed.project_names as Record<string, string>) ?? {};
    if (existing[projectId] === name) return; // already set
    existing[projectId] = name;
    parsed.project_names = existing;
    writeFileSync(configPath, JSON.stringify(parsed, null, 2));
    return;
  } catch {
    // best-effort: fail silently
  }
};

export const loadProjectNames = (): Record<string, string> => {
  const configPath = expandHome(
    join(DEFAULT_CONFIG.storage.home, CONFIG_FILE_NAME),
  );
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (parsed.project_names as Record<string, string>) ?? {};
  } catch {
    return {};
  }
};

export const loadConfig = (): FrierenConfig => {
  const configPath = expandHome(
    join(DEFAULT_CONFIG.storage.home, CONFIG_FILE_NAME),
  );
  let fileConfig: Partial<FrierenConfig> | undefined;

  try {
    ensureDir(expandHome(DEFAULT_CONFIG.storage.home));
    const raw = readFileSync(configPath, "utf8");
    fileConfig = JSON.parse(raw) as Partial<FrierenConfig>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      ensureDir(expandHome(DEFAULT_CONFIG.storage.home));
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    } else if (!(error instanceof Error) || !("code" in error)) {
      throw error;
    }
  }

  const merged = mergeConfig(DEFAULT_CONFIG, fileConfig);
  const apiKey = process.env.AITOOLINGKEY ?? merged.litellm.apiKey;

  return {
    litellm: {
      ...merged.litellm,
      apiKey,
    },
    storage: {
      home: expandHome(merged.storage.home),
    },
    session: {
      retentionDays: merged.session.retentionDays,
    },
  };
};
