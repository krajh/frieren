import { mkdirSync } from "node:fs";

export const ensureDir = (path: string): void => {
  mkdirSync(path, { recursive: true });
};
