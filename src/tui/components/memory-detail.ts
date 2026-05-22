import {
  Box,
  ScrollBox,
  Text,
  instantiate,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core";

import { getTheme } from "../lib/theme.js";

export interface MemoryDetailView {
  title: string;
  id?: string;
  metadata?: Array<[string, string | undefined]>;
  content: string;
  related?: string[];
  timeline?: string[];
}

export interface MemoryDetailHandle {
  root: Renderable;
  show: (view: MemoryDetailView) => void;
  hide: () => void;
  isVisible: () => boolean;
  getView: () => MemoryDetailView | null;
  handleKeyPress: (event: KeyEvent) => boolean;
  applyTheme: () => void;
}

const formatSection = (title: string, lines: string[] | undefined): string => {
  if (!lines || lines.length === 0) {
    return `${title}\n  (none)`;
  }

  return `${title}\n${lines.map((line) => `  ${line}`).join("\n")}`;
};

export function createMemoryDetailOverlay(renderer: CliRenderer): MemoryDetailHandle {
  let visible = false;
  let currentView: MemoryDetailView | null = null;

  const root = instantiate(
    renderer,
    Box({
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      flexDirection: "column",
      border: true,
      borderColor: "#7dd3fc",
      backgroundColor: "#020617",
      zIndex: 20,
      paddingX: 1,
      paddingY: 1,
    }),
  );

  const title = instantiate(
    renderer,
    Text({
      content: "",
      fg: "#f8fafc",
      truncate: true,
    }),
  ) as TextRenderable;

  const scroll = instantiate(
    renderer,
    ScrollBox({
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      backgroundColor: "#020617",
      paddingY: 1,
    }),
  ) as ScrollBoxRenderable;

  const body = instantiate(
    renderer,
    Text({
      content: "",
      fg: "#cbd5e1",
    }),
  ) as TextRenderable;

  const actions = instantiate(
    renderer,
    Text({
      content: "[s] Spawn  [r] Relate  [e] Edit meta  [d] Delete  [Enter/Esc] Back",
      fg: "#94a3b8",
      truncate: true,
    }),
  ) as TextRenderable;

  scroll.add(body);
  root.add(title);
  root.add(scroll);
  root.add(actions);
  root.visible = false;

  const applyTheme = (): void => {
    const theme = getTheme();
    (root as Renderable & { borderColor?: string; backgroundColor?: string }).borderColor = theme.accent;
    (root as Renderable & { borderColor?: string; backgroundColor?: string }).backgroundColor = theme.bg;
    title.fg = theme.fg;
    scroll.backgroundColor = theme.bg;
    body.fg = theme.fg;
    actions.fg = theme.muted;
  };

  applyTheme();

  return {
    root,
    show: (view: MemoryDetailView) => {
      visible = true;
      currentView = view;
      title.content = view.title;

      const metadata = (view.metadata ?? [])
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => `${key}: ${value}`);

      body.content = [
        formatSection("Metadata", metadata),
        "",
        "Content",
        view.content,
        "",
        formatSection("Related entries", view.related),
        "",
        formatSection("Timeline", view.timeline),
      ].join("\n");

      root.visible = true;
      scroll.scrollTo(0);
      renderer.requestRender();
    },
    hide: () => {
      visible = false;
      currentView = null;
      root.visible = false;
      renderer.requestRender();
    },
    isVisible: () => visible,
    getView: () => currentView,
    handleKeyPress: (event: KeyEvent): boolean => {
      if (!visible) {
        return false;
      }

      if (
        event.name === "escape" ||
        event.name === "q" ||
        event.name === "enter" ||
        event.name === "return"
      ) {
        visible = false;
        currentView = null;
        root.visible = false;
        renderer.requestRender();
        return true;
      }

      return false;
    },
    applyTheme,
  };
}
