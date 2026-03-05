import { setTimeout as sleep } from "node:timers/promises";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 250;

export const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < MAX_RETRIES) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown error");
      attempt += 1;
      if (attempt >= MAX_RETRIES) {
        break;
      }
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Embedding request failed");
};
