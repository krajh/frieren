import {
  Box,
  ScrollBox,
  Text,
  TextareaRenderable,
  instantiate,
  type CliRenderer,
  type BoxRenderable,
  type KeyEvent,
  type Renderable,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core";

import { detectHarnesses } from "../harness/auto-detect.js";
import type { HarnessAdapter } from "../harness/adapter.js";
import { buildSpawnPrompt } from "../harness/context.js";
import { loadConfig } from "../harness/config.js";
import type { WisdomEntry } from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";

export interface SpawnDialogHandle {
  root: Renderable;
  show(entry: WisdomEntry): void;
  hide(): void;
  handleKeyPress(event: KeyEvent): boolean;
  applyTheme(): void;
  readonly isVisible: boolean;
}

type SpawnState = "ready" | "running" | "failed" | "launched";

const FOCUS_LABELS = ["Harness", "Agent", "Context", "Launch", "Cancel"] as const;

const formatOptions = (label: string, value: string, focused: boolean): string => {
  return `${focused ? ">" : " "} ${label}: ${value}`;
};

export function createSpawnDialog(renderer: CliRenderer): SpawnDialogHandle {
  let visible = false;
  let focusIndex = 0;
  let harnesses: HarnessAdapter[] = [];
  let harnessIndex = 0;
  let agentIndex = 0;
  let currentEntry: WisdomEntry | null = null;
  let state: SpawnState = "ready";
  let statusMessage = "Ready";

  const root = instantiate(
    renderer,
    Box({
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      padding: 1,
      flexDirection: "column",
      border: true,
      borderColor: "#7dd3fc",
      backgroundColor: "#020617",
      zIndex: 30,
      rowGap: 1,
    }),
  );

  const title = instantiate(renderer, Text({ content: "Spawn Session", fg: "#f8fafc" })) as TextRenderable;
  const harnessText = instantiate(renderer, Text({ content: "", fg: "#cbd5e1" })) as TextRenderable;
  const agentText = instantiate(renderer, Text({ content: "", fg: "#cbd5e1" })) as TextRenderable;
  const helpText = instantiate(renderer, Text({ content: "↑/↓ focus  ←/→ cycle  Enter select/edit  Esc cancel", fg: "#94a3b8" })) as TextRenderable;

  const promptFrame = instantiate(
    renderer,
    Box({
      width: "100%",
      height: 12,
      flexDirection: "column",
      border: true,
      borderColor: "#334155",
      title: " Context ",
    }),
  ) as BoxRenderable;

  const promptEditor = new TextareaRenderable(renderer, {
    width: "100%",
    height: "100%",
    initialValue: "",
    wrapMode: "word",
    backgroundColor: "#020617",
    focusedBackgroundColor: "#0f172a",
    textColor: "#cbd5e1",
    focusedTextColor: "#f8fafc",
  });

  const actionText = instantiate(renderer, Text({ content: "", fg: "#e2e8f0" })) as TextRenderable;

  const statusFrame = instantiate(
    renderer,
    ScrollBox({
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      border: true,
      borderColor: "#334155",
      title: " Status ",
      paddingX: 1,
      paddingY: 1,
      backgroundColor: "#020617",
    }),
  ) as ScrollBoxRenderable;

  const statusText = instantiate(renderer, Text({ content: statusMessage, fg: "#94a3b8" })) as TextRenderable;

  promptFrame.add(promptEditor);
  statusFrame.add(statusText);
  root.add(title);
  root.add(harnessText);
  root.add(agentText);
  root.add(helpText);
  root.add(promptFrame);
  root.add(actionText);
  root.add(statusFrame);
  root.visible = false;

  const getAgents = (): string[] => {
    return harnesses[harnessIndex]?.getAvailableAgents() ?? ["default"];
  };

  const syncPromptFocus = (): void => {
    if (focusIndex === 2) {
      promptEditor.focus();
    } else {
      promptEditor.blur();
    }
  };

  const applyTheme = (): void => {
    const theme = getTheme();
    (root as Renderable & { borderColor?: string; backgroundColor?: string }).borderColor = theme.accent;
    (root as Renderable & { borderColor?: string; backgroundColor?: string }).backgroundColor = theme.bg;
    title.fg = theme.fg;
    harnessText.fg = theme.fg;
    agentText.fg = theme.fg;
    helpText.fg = theme.muted;
    promptFrame.borderColor = focusIndex === 2 ? theme.accent : theme.border;
    (promptEditor as unknown as {
      backgroundColor?: string;
      focusedBackgroundColor?: string;
      textColor?: string;
      focusedTextColor?: string;
    }).backgroundColor = theme.bg;
    (promptEditor as unknown as {
      backgroundColor?: string;
      focusedBackgroundColor?: string;
      textColor?: string;
      focusedTextColor?: string;
    }).focusedBackgroundColor = theme.bg;
    (promptEditor as unknown as {
      backgroundColor?: string;
      focusedBackgroundColor?: string;
      textColor?: string;
      focusedTextColor?: string;
    }).textColor = theme.fg;
    (promptEditor as unknown as {
      backgroundColor?: string;
      focusedBackgroundColor?: string;
      textColor?: string;
      focusedTextColor?: string;
    }).focusedTextColor = theme.fg;
    actionText.fg = theme.fg;
    statusFrame.borderColor = theme.border;
    statusFrame.backgroundColor = theme.bg;
  };

  const refresh = (): void => {
    const theme = getTheme();
    const harnessName = harnesses[harnessIndex]?.name ?? "(no harness detected)";
    const agents = getAgents();
    const agentName = agents[agentIndex] ?? "default";

    harnessText.content = formatOptions("Harness", harnessName, focusIndex === 0);
    agentText.content = formatOptions("Agent", agentName, focusIndex === 1);
    promptFrame.borderColor = focusIndex === 2 ? theme.accent : theme.border;

    const launchLabel = state === "failed" ? "Retry" : "Launch";
    const cancelLabel = state === "failed" ? "Back" : "Cancel";
    actionText.content = [
      `${focusIndex === 3 ? ">" : " "} [${launchLabel}]`,
      `${focusIndex === 4 ? ">" : " "} [${cancelLabel}]`,
    ].join("  ");

    statusText.content = statusMessage;
    statusText.fg = state === "failed" ? theme.error : state === "launched" ? theme.success : theme.muted;
    applyTheme();
    syncPromptFocus();
    renderer.requestRender();
  };

  const setHarnessIndex = (nextIndex: number): void => {
    if (harnesses.length === 0) {
      harnessIndex = 0;
      agentIndex = 0;
      return;
    }

    harnessIndex = ((nextIndex % harnesses.length) + harnesses.length) % harnesses.length;
    agentIndex = 0;
  };

  const hide = (): void => {
    visible = false;
    root.visible = false;
    promptEditor.blur();
    renderer.requestRender();
  };

  const launch = async (): Promise<void> => {
    const harness = harnesses[harnessIndex];
    if (!harness) {
      state = "failed";
      statusMessage = "Failed: no installed harness detected.";
      refresh();
      return;
    }

    state = "running";
    statusMessage = `Running ${harness.name}…`;
    refresh();

    const result = await harness.spawn(promptEditor.plainText, {
      agent: getAgents()[agentIndex],
    });

    if (result.success) {
      state = "launched";
      statusMessage = `Launched ${harness.name}${result.pid ? ` (pid ${result.pid})` : ""}.`;
      refresh();
      return;
    }

    state = "failed";
    statusMessage = `Failed: ${result.stderr ?? "Unknown spawn failure."}`;
    statusFrame.scrollTo(0);
    refresh();
  };

  return {
    root,
    show: (entry: WisdomEntry) => {
      const config = loadConfig();
      currentEntry = entry;
      harnesses = detectHarnesses();
      visible = true;
      focusIndex = 0;
      state = "ready";
      statusMessage = harnesses.length > 0 ? "Ready" : "No supported harnesses detected.";
      root.visible = true;
      promptEditor.setText(buildSpawnPrompt(entry));

      const preferredHarnessIndex = harnesses.findIndex((adapter) => adapter.id === config.preferred_harness);
      setHarnessIndex(preferredHarnessIndex >= 0 ? preferredHarnessIndex : 0);

      const preferredAgentIndex = getAgents().findIndex((agent) => agent === config.preferred_agent);
      agentIndex = preferredAgentIndex >= 0 ? preferredAgentIndex : 0;
      refresh();
    },
    hide,
    applyTheme,
    handleKeyPress: (event: KeyEvent): boolean => {
      if (!visible) {
        return false;
      }

      if (focusIndex === 2) {
        if (event.name === "escape") {
          focusIndex = 0;
          refresh();
          return true;
        }

        if ((event.name === "tab" || event.sequence === "\t") && !event.shift) {
          focusIndex = 3;
          refresh();
          return true;
        }

        return promptEditor.handleKeyPress(event);
      }

      if (event.name === "escape" || event.name === "q") {
        hide();
        return true;
      }

      if (event.name === "up" || event.name === "k") {
        focusIndex = ((focusIndex - 1) + FOCUS_LABELS.length) % FOCUS_LABELS.length;
        refresh();
        return true;
      }

      if (event.name === "down" || event.name === "j" || event.name === "tab" || event.sequence === "\t") {
        focusIndex = (focusIndex + 1) % FOCUS_LABELS.length;
        refresh();
        return true;
      }

      if ((event.name === "left" || event.name === "h") && focusIndex === 0) {
        setHarnessIndex(harnessIndex - 1);
        refresh();
        return true;
      }

      if ((event.name === "right" || event.name === "l") && focusIndex === 0) {
        setHarnessIndex(harnessIndex + 1);
        refresh();
        return true;
      }

      if ((event.name === "left" || event.name === "h") && focusIndex === 1) {
        const agents = getAgents();
        agentIndex = ((agentIndex - 1) + agents.length) % agents.length;
        refresh();
        return true;
      }

      if ((event.name === "right" || event.name === "l") && focusIndex === 1) {
        const agents = getAgents();
        agentIndex = (agentIndex + 1) % agents.length;
        refresh();
        return true;
      }

      if (event.name === "enter" || event.name === "return") {
        if (focusIndex === 2) {
          promptEditor.focus();
          refresh();
          return true;
        }

        if (focusIndex === 3) {
          void launch();
          return true;
        }

        if (focusIndex === 4) {
          hide();
          return true;
        }
      }

      if (event.name === "l" && focusIndex === 3) {
        void launch();
        return true;
      }

      if (event.name === "c" && focusIndex === 4) {
        hide();
        return true;
      }

      if (event.name === "e") {
        focusIndex = 2;
        refresh();
        return true;
      }

      return currentEntry !== null;
    },
    get isVisible() {
      return visible;
    },
  };
}
