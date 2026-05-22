export interface SpawnOptions {
  agent?: string;
  contextFiles?: string[];
  workdir?: string;
}

export interface SpawnResult {
  success: boolean;
  pid?: number;
  stderr?: string;
  sessionId?: string;
}

export interface HarnessAdapter {
  name: string;
  id: string;
  detect(): boolean;
  spawn(prompt: string, options?: SpawnOptions): Promise<SpawnResult>;
  getAvailableAgents(): string[];
}

export interface HarnessRegistry {
  adapters: HarnessAdapter[];
  detectAll(): Promise<HarnessAdapter[]>;
  getAdapter(id: string): HarnessAdapter | undefined;
}

const readStreamText = async (stream: unknown): Promise<string> => {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }

  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
};

export const waitForSpawnResult = async (
  proc: Bun.Subprocess,
  failureTimeoutMs = 300,
): Promise<SpawnResult> => {
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<null>((resolve) => globalThis.setTimeout(() => resolve(null), failureTimeoutMs)),
  ]);

  if (exitCode === null) {
    return {
      success: true,
      pid: proc.pid,
    };
  }

  const stderr = (await readStreamText(proc.stderr)).trim();

  if (exitCode === 0) {
    return {
      success: true,
      pid: proc.pid,
      stderr: stderr || undefined,
    };
  }

  return {
    success: false,
    pid: proc.pid,
    stderr: stderr || `Process exited with code ${exitCode}.`,
  };
};

export function createRegistry(
  adapters: HarnessAdapter[] = [],
): HarnessRegistry {
  return {
    adapters,
    detectAll: async () => adapters.filter((adapter) => adapter.detect()),
    getAdapter: (id: string) => adapters.find((adapter) => adapter.id === id),
  };
}
