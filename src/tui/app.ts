import {
  Box,
  instantiate,
  Text,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type TextRenderable,
} from "@opentui/core";

import { createStatusBar } from "./components/status-bar.js";
import { createTabBar } from "./components/tab-bar.js";
import { createCreateEntryOverlay } from "./screens/create-entry.js";
import { createSpawnDialog } from "./screens/spawn-dialog.js";
import { createCodebaseBrowser } from "./screens/codebase-browser.js";
import { createDashboard } from "./screens/dashboard.js";
import { createKGBrowser } from "./screens/kg-browser.js";
import { createReaperScreen } from "./screens/reaper-screen.js";
import { createSessionBrowser } from "./screens/session-browser.js";
import { createWisdomBrowser } from "./screens/wisdom-browser.js";
import { getProjects, getStats, type FrierenStats } from "./lib/frieren.js";
import { getTheme, getThemeName, setTheme } from "./lib/theme.js";
import type { WisdomEntry } from "./lib/frieren.js";

const TABS = ["Dashboard", "Wisdom", "Sessions", "Codebase", "KG", "Reaper"] as const;

type AppHandle = {
  root: Renderable;
  destroy: () => void;
};

type ScreenHandle = {
  root: Renderable;
  refresh: () => void;
  applyTheme: () => void;
  handleKeyPress?: (event: KeyEvent) => boolean;
  getSpawnEntry?: () => WisdomEntry | null;
};

const isTabKey = (event: KeyEvent): boolean =>
  event.name === "tab" || event.sequence === "\t" || event.sequence === "\u001b[Z";

const isRightKey = (event: KeyEvent): boolean =>
  event.name === "right" || event.sequence === "\u001b[C";

const isLeftKey = (event: KeyEvent): boolean =>
  event.name === "left" || event.sequence === "\u001b[D";

const isEscapeKey = (event: KeyEvent): boolean =>
  event.name === "escape" || event.sequence === "\u001b";

const getProjectName = (): string => {
  const [firstProject] = getProjects();
  return firstProject ?? "frieren";
};

const getActiveScreenName = (index: number): string => TABS[index] ?? TABS[0];

export function createApp(renderer: CliRenderer): AppHandle {
  let activeIndex = 0;
  let helpVisible = false;
  let lastStats: FrierenStats = getStats();
  let transientMessage = "";

  const root = instantiate(
    renderer,
    Box({
      width: "100%",
      height: "100%",
      flexDirection: "column",
    }),
  );

  const tabBar = createTabBar(renderer, {
    tabs: [...TABS],
    activeIndex,
    onSelect: (index) => setActiveIndex(index),
  });

  const content = instantiate(
    renderer,
    Box({
      width: "100%",
      flexGrow: 1,
      position: "relative",
    }),
  );

  const dashboard = createDashboard(renderer);
  const wisdom = createWisdomBrowser(renderer);
  const sessions = createSessionBrowser(renderer);
  const codebase = createCodebaseBrowser(renderer);
  const kg = createKGBrowser(renderer);
  const reaper = createReaperScreen(renderer);
  const createEntry = createCreateEntryOverlay(renderer);
  const spawnDialog = createSpawnDialog(renderer);

  lastStats = dashboard.refresh();

  const screens: ScreenHandle[] = [
    { root: dashboard.root, refresh: () => void dashboard.refresh(), applyTheme: dashboard.applyTheme },
    wisdom,
    sessions,
    codebase,
    kg,
    reaper,
  ];

  for (const screen of screens) {
    screen.root.visible = false;
    content.add(screen.root);
  }

  const statusBar = createStatusBar(renderer, {
    projectName: getProjectName(),
    activeScreen: getActiveScreenName(activeIndex),
    stats: lastStats,
  });

  const helpOverlay = instantiate(
    renderer,
    Box({
      position: "absolute",
      top: 2,
      left: 4,
      width: "70%",
      padding: 1,
      flexDirection: "column",
      border: true,
      zIndex: 10,
    },
    Text({ content: "Help" }),
    Text({ content: "1-6: screens" }),
    Text({ content: "Tab / Shift+Tab / ← →: switch screens" }),
    Text({ content: "/: search if supported" }),
    Text({ content: "T: toggle theme" }),
    Text({ content: "?: toggle help" }),
    Text({ content: "q or Esc: quit / close overlay" })),
  );
  helpOverlay.visible = false;

  const notice = instantiate(
    renderer,
    Text({
      content: "",
      truncate: true,
    }),
  ) as TextRenderable;

  const applyChromeTheme = (): void => {
    const theme = getTheme();
    (root as Renderable & { backgroundColor?: string }).backgroundColor = theme.bg;
    tabBar.applyTheme();
    statusBar.applyTheme();
    spawnDialog.applyTheme();
    createEntry.applyTheme();

    const helpChildren = helpOverlay.getChildren() as TextRenderable[];
    (helpOverlay as Renderable & { borderColor?: string; backgroundColor?: string }).borderColor = theme.accent;
    (helpOverlay as Renderable & { borderColor?: string; backgroundColor?: string }).backgroundColor = theme.border;
    helpChildren[0]!.fg = theme.fg;
    for (const child of helpChildren.slice(1)) {
      child.fg = theme.fg;
    }

    notice.fg = theme.warning;
    notice.bg = theme.bg;
  };

  const refreshChrome = (): void => {
    applyChromeTheme();
    screens.forEach((screen, index) => {
      screen.root.visible = index === activeIndex;
      screen.applyTheme();
    });

    tabBar.setActiveIndex(activeIndex);

    if (activeIndex === 0) {
      lastStats = dashboard.refresh();
    } else {
      screens[activeIndex]?.refresh();
      lastStats = getStats();
    }

    statusBar.update({
      projectName: getProjectName(),
      activeScreen: getActiveScreenName(activeIndex),
      stats: lastStats,
    });

    notice.content = transientMessage;
    helpOverlay.visible = helpVisible;
    renderer.requestRender();
  };

  const setActiveIndex = (index: number): void => {
    activeIndex = ((index % TABS.length) + TABS.length) % TABS.length;
    transientMessage = "";
    refreshChrome();
  };

  const stepTab = (direction: 1 | -1): void => {
    setActiveIndex(activeIndex + direction);
  };

  const toggleHelp = (): void => {
    helpVisible = !helpVisible;
    transientMessage = "";
    refreshChrome();
  };

  const showNotice = (message: string): void => {
    transientMessage = message;
    refreshChrome();
  };

  content.add(helpOverlay);
  content.add(createEntry.root);
  content.add(spawnDialog.root);
  root.add(tabBar.root);
  root.add(content);
  root.add(notice);
  root.add(statusBar.root);

  const refreshInterval = globalThis.setInterval(() => {
    screens[activeIndex]?.refresh();
    lastStats = getStats();
    statusBar.update({
      projectName: getProjectName(),
      activeScreen: getActiveScreenName(activeIndex),
      stats: lastStats,
    });
    renderer.requestRender();
  }, 5000);

  const onKeyPress = (event: KeyEvent): void => {
    if (event.eventType === "release") {
      return;
    }

    if (event.name === "?") {
      toggleHelp();
      return;
    }

    if (spawnDialog.handleKeyPress(event)) {
      return;
    }

    const createEntryResult = createEntry.handleKeyPress(event);
    if (createEntryResult) {
      if (createEntryResult.message) {
        showNotice(createEntryResult.message);
        screens[activeIndex]?.refresh();
      }
      return;
    }

    if (screens[activeIndex]?.handleKeyPress?.(event)) {
      return;
    }

    if (event.name === "s") {
      const entry = screens[activeIndex]?.getSpawnEntry?.();
      if (!entry) {
        showNotice("No entry selected for spawning on this screen.");
        return;
      }

      spawnDialog.show(entry);
      return;
    }

    if (event.name === "n") {
      createEntry.show();
      return;
    }

    if (event.name === "q" || isEscapeKey(event)) {
      renderer.destroy();
      process.exitCode = 0;
      return;
    }

    if (event.name === "T") {
      setTheme(getThemeName() === "dark" ? "light" : "dark");
      showNotice(`Theme: ${getThemeName()}`);
      return;
    }

    if (event.name === "/") {
      showNotice("Search is unavailable on this screen.");
      return;
    }

    if (isTabKey(event)) {
      stepTab(event.shift ? -1 : 1);
      return;
    }

    if (isRightKey(event)) {
      stepTab(1);
      return;
    }

    if (isLeftKey(event)) {
      stepTab(-1);
      return;
    }

    const indexFromDigit = Number.parseInt(event.name, 10);
    if (!Number.isNaN(indexFromDigit) && indexFromDigit >= 1 && indexFromDigit <= 6) {
      setActiveIndex(indexFromDigit - 1);
    }
  };

  renderer.keyInput.on("keypress", onKeyPress);
  refreshChrome();

  return {
    root,
    destroy: () => {
      renderer.keyInput.off("keypress", onKeyPress);
      clearInterval(refreshInterval);
    },
  };
}
