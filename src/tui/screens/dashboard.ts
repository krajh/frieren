import {
  Box,
  instantiate,
  Text,
  type CliRenderer,
  type Renderable,
  type TextRenderable,
} from "@opentui/core";

import { formatBytes } from "../components/status-bar.js";
import {
  getRecentActivity,
  getStats,
  type FrierenStats,
  type RecentEvent,
} from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";

export interface DashboardHandle {
  root: Renderable;
  refresh: () => FrierenStats;
  applyTheme: () => void;
}

const buildHealthLines = (stats: FrierenStats): string[] => {
  return [
    `Wisdom: ${stats.wisdomCount} entries`,
    `Sessions: ${stats.sessionProjects} projects`,
    `Codebase: ${stats.codebaseProjects} indexed`,
    `KG: ${stats.kgTriples} triples`,
    `Reaper: ${stats.reaperPending} pending`,
    `Disk: ${formatBytes(stats.diskUsageBytes)} total`,
  ];
};

const buildActivityLines = (activity: RecentEvent[]): string[] => {
  if (activity.length === 0) {
    return [
      "Frieren is ready.",
      "Run an agent session to start populating memory.",
    ];
  }

  return activity.map((event) => {
    const stamp = event.timestamp.replace("T", " ").slice(0, 16);
    const summary = event.summary || "(no summary)";
    return `${stamp}  ${event.type}  ${summary}`;
  });
};

const writeLines = (nodes: TextRenderable[], lines: string[], fillTo: number): void => {
  for (let index = 0; index < fillTo; index += 1) {
    nodes[index]!.content = lines[index] ?? "";
  }
};

export function createDashboard(renderer: CliRenderer): DashboardHandle {
  const root = instantiate(
    renderer,
    Box({
      width: "100%",
      height: "100%",
      flexDirection: "row",
      columnGap: 1,
      padding: 1,
    }),
  );

  const healthPanel = instantiate(
    renderer,
    Box({
      flexGrow: 1,
      height: "100%",
      flexDirection: "column",
      border: true,
      borderColor: "#334155",
      title: " Health ",
      paddingX: 1,
      paddingY: 1,
    }),
  );

  const activityPanel = instantiate(
    renderer,
    Box({
      flexGrow: 1,
      height: "100%",
      flexDirection: "column",
      border: true,
      borderColor: "#334155",
      title: " Recent Activity ",
      paddingX: 1,
      paddingY: 1,
    }),
  );

  root.add(healthPanel);
  root.add(activityPanel);

  const healthNodes = Array.from({ length: 7 }, () => {
    const line = instantiate(
      renderer,
      Text({
        content: "",
        fg: "#e2e8f0",
        truncate: true,
      }),
    ) as TextRenderable;
    healthPanel.add(line);
    return line;
  });

  const activityNodes = Array.from({ length: 6 }, () => {
    const line = instantiate(
      renderer,
      Text({
        content: "",
        fg: "#cbd5e1",
        truncate: true,
      }),
    ) as TextRenderable;
    activityPanel.add(line);
    return line;
  });

  const refresh = (): FrierenStats => {
    const theme = getTheme();
    const stats = getStats();
    const healthLines = buildHealthLines(stats);
    const activityLines = buildActivityLines(getRecentActivity(5));

    (healthPanel as Renderable & { borderColor?: string }).borderColor = theme.border;
    (activityPanel as Renderable & { borderColor?: string }).borderColor = theme.border;

    writeLines(healthNodes, healthLines, healthNodes.length);
    writeLines(activityNodes, activityLines, activityNodes.length);
    for (const line of healthNodes) {
      line.fg = theme.fg;
    }
    for (const line of activityNodes) {
      line.fg = theme.fg;
    }

    if (
      stats.wisdomCount === 0 &&
      stats.sessionProjects === 0 &&
      stats.codebaseProjects === 0 &&
      stats.kgTriples === 0 &&
      stats.reaperPending === 0
    ) {
      healthNodes[6]!.content = "Frieren is ready. Run an agent session to start populating memory.";
      healthNodes[6]!.fg = theme.muted;
    }

    return stats;
  };

  refresh();

  return { root, refresh, applyTheme: () => void refresh() };
}
