import {
  Box,
  Text,
  instantiate,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type TextRenderable,
} from "@opentui/core";

import { createListDetail } from "../components/list-detail.js";
import { createTextCard } from "../components/text-card.js";
import { truncate, formatStamp } from "../lib/format.js";
import { cancelReaperTask, clearCache, getReaperTasks, type ReaperTask } from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";

const STATUS_FILTERS = ["all", "pending", "manifesting", "completed", "failed", "dead", "cancelled"] as const;
const PAGE_SIZE = 50;

export function createReaperScreen(renderer: CliRenderer): {
  root: Renderable;
  refresh: () => void;
  handleKeyPress: (event: KeyEvent) => boolean;
  applyTheme: () => void;
} {
  let filterIndex = 0;
  let page = 0;
  let tasks: ReaperTask[] = [];
  let selectedTaskId: string | null = null;

  const root = instantiate(renderer, Box({ width: "100%", height: "100%", flexDirection: "column", padding: 1, rowGap: 1 }));
  const headerText = instantiate(renderer, Text({ content: "", fg: "#94a3b8", truncate: true })) as TextRenderable;
  const listDetail = createListDetail(renderer, {
    listTitle: "Reaper Queue",
    detailTitle: "Task Detail",
    onSelectionChange: () => updateDetail(),
  });

  root.add(headerText);
  root.add(listDetail.root);

  function getStatusFilter(): string | undefined {
    const value = STATUS_FILTERS[filterIndex];
    return value === "all" ? undefined : value;
  }

  function selectedTask(): ReaperTask | null {
    if (tasks.length === 0) {
      return null;
    }
    return tasks[listDetail.getSelectedIndex()] ?? null;
  }

  function updateHeader(message?: string): void {
    headerText.fg = message ? getTheme().warning : getTheme().muted;
    headerText.content = message
      ? message
      : `Status: ${STATUS_FILTERS[filterIndex]}  |  Page: ${page + 1}  |  Tasks: ${tasks.length}  |  Keys: f filter  [,/.] page  c cancel pending`;
  }

  function updateDetail(): void {
    const task = selectedTask();
    if (!task) {
      listDetail.setDetail(
        createTextCard(
          renderer,
          "No pending or active tasks in the Reaper Realm.",
          "#94a3b8",
        ),
      );
      return;
    }

    selectedTaskId = task.task_id;
    listDetail.setDetail(
      createTextCard(
        renderer,
        [
          `id: ${task.task_id}`,
          `status: ${task.status}`,
          `priority: ${task.priority}`,
          `created: ${formatStamp(task.created_at)}`,
          "",
          "task",
          task.task || "(no payload)",
          "",
          task.result ? `result\n${task.result}` : "result\n(none)",
          "",
          task.error ? `error\n${task.error}` : "error\n(none)",
        ].join("\n"),
      ),
    );
  }

  function refreshData(message?: string): void {
    tasks = getReaperTasks(getStatusFilter(), PAGE_SIZE, page * PAGE_SIZE);
    listDetail.setList(tasks.map((task) => `[${task.status}] p${task.priority} ${truncate(task.task || task.task_id)}`));
    const selectedIndex = selectedTaskId ? tasks.findIndex((task) => task.task_id === selectedTaskId) : 0;
    listDetail.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    updateHeader(message);
    updateDetail();
  }

  refreshData();

  return {
    root,
    refresh: () => refreshData(),
    applyTheme: () => {
      listDetail.applyTheme();
      refreshData();
    },
    handleKeyPress: (event: KeyEvent): boolean => {
      if (event.name === "f") {
        filterIndex = (filterIndex + 1) % STATUS_FILTERS.length;
        page = 0;
        selectedTaskId = null;
        refreshData();
        return true;
      }

      if (event.name === ".") {
        if (tasks.length === PAGE_SIZE) {
          page += 1;
          selectedTaskId = null;
          refreshData();
        }
        return true;
      }

      if (event.name === ",") {
        page = Math.max(0, page - 1);
        selectedTaskId = null;
        refreshData();
        return true;
      }

      if (event.name === "C") {
        clearCache();
        refreshData();
        return true;
      }

      if (event.name === "c") {
        const task = selectedTask();
        if (!task) {
          return true;
        }

        if (task.status !== "pending") {
          updateHeader("Only pending tasks can be cancelled.");
          return true;
        }

        const success = cancelReaperTask(task.task_id);
        refreshData(success ? `Cancelled ${task.task_id}.` : `Failed to cancel ${task.task_id}.`);
        return true;
      }

      return listDetail.handleKeyPress(event);
    },
  };
}
