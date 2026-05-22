import {
  Box,
  instantiate,
  Text,
  type CliRenderer,
  type Renderable,
  type TextRenderable,
} from "@opentui/core";

import type { FrierenStats } from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";

export interface StatusBarProps {
  projectName: string;
  activeScreen: string;
  stats: FrierenStats;
}

export interface StatusBarHandle {
  root: Renderable;
  update: (props: StatusBarProps) => void;
  applyTheme: () => void;
}

const formatStats = (stats: FrierenStats): string => {
  return [
    `W:${stats.wisdomCount}`,
    `S:${stats.sessionProjects}`,
    `C:${stats.codebaseProjects}`,
    `KG:${stats.kgTriples}`,
    `R:${stats.reaperPending}`,
  ].join(" ");
};

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

const buildStatusLine = (props: StatusBarProps): string => {
  return `${props.projectName}  |  ${props.activeScreen}  |  ${formatStats(props.stats)}  |  Disk:${formatBytes(props.stats.diskUsageBytes)}  |  1-6 screens  / search  ? help  q quit`;
};

export function createStatusBar(
  renderer: CliRenderer,
  props: StatusBarProps,
): StatusBarHandle {
  const root = instantiate(
    renderer,
    Box({
      width: "100%",
      paddingX: 1,
      paddingY: 0,
      backgroundColor: "#0f172a",
    }),
  );

  const text = instantiate(
    renderer,
    Text({
      content: buildStatusLine(props),
      truncate: true,
    }),
  ) as TextRenderable;

  root.add(text);

  const applyTheme = (): void => {
    const theme = getTheme();
    (root as Renderable & { backgroundColor?: string }).backgroundColor = theme.border;
    text.fg = theme.fg;
    text.bg = theme.border;
  };

  applyTheme();

  return {
    root,
    update: (nextProps: StatusBarProps) => {
      text.content = buildStatusLine(nextProps);
    },
    applyTheme,
  };
}
