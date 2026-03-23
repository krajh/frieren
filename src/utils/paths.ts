import { join } from "node:path";

import { loadConfig } from "../config.js";

export const getStorageHome = (): string => loadConfig().storage.home;

export const getWisdomDbPath = (): string =>
  join(getStorageHome(), "wisdom.db");

export const getSessionsDir = (): string => join(getStorageHome(), "sessions");

export const getSessionDbPath = (projectId: string): string =>
  join(getSessionsDir(), `${projectId}.db`);

export const getIndexDir = (): string => join(getStorageHome(), "index");

export const getIndexDbPath = (projectId: string): string =>
  join(getIndexDir(), `${projectId}.db`);

export const getQueueDbPath = (): string =>
  join(getStorageHome(), "queue.db");
