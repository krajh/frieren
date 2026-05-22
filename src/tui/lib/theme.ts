import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getConfigPath, loadConfig } from "../harness/config.js";

export interface Theme {
  bg: string;
  fg: string;
  accent: string;
  muted: string;
  border: string;
  success: string;
  error: string;
  warning: string;
}

export type ThemeName = "dark" | "light";

export const DARK_THEME: Theme = {
  bg: "#020617",
  fg: "#e2e8f0",
  accent: "#7dd3fc",
  muted: "#94a3b8",
  border: "#334155",
  success: "#4ade80",
  error: "#f87171",
  warning: "#fbbf24",
};

export const LIGHT_THEME: Theme = {
  bg: "#ffffff",
  fg: "#1e293b",
  accent: "#0284c7",
  muted: "#64748b",
  border: "#cbd5e1",
  success: "#16a34a",
  error: "#dc2626",
  warning: "#d97706",
};

const THEME_MAP: Record<ThemeName, Theme> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
};

let currentThemeName: ThemeName = loadConfig().theme === "light" ? "light" : "dark";

const persistTheme = (name: ThemeName): void => {
  const configPath = getConfigPath();
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `theme = "${name}"\n`, "utf8");
    return;
  }

  const current = readFileSync(configPath, "utf8");
  const themePattern = /^theme\s*=\s*"(?:dark|light)"\s*$/m;

  if (themePattern.test(current)) {
    writeFileSync(configPath, current.replace(themePattern, `theme = "${name}"`), "utf8");
    return;
  }

  const next = current.trim().length > 0 ? `theme = "${name}"\n${current}` : `theme = "${name}"\n`;
  writeFileSync(configPath, next, "utf8");
};

export function getThemeName(): ThemeName {
  return currentThemeName;
}

export function getTheme(name?: ThemeName): Theme {
  return THEME_MAP[name ?? currentThemeName];
}

export function setTheme(name: ThemeName): void {
  currentThemeName = name;
  persistTheme(name);
}
