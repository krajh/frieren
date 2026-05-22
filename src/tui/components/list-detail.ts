import {
  Box,
  ScrollBox,
  Select,
  Text,
  instantiate,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type ScrollBoxRenderable,
  type SelectRenderable,
} from "@opentui/core";

import { getTheme } from "../lib/theme.js";

export interface ListDetailHandle {
  root: Renderable;
  setList: (items: string[]) => void;
  setDetail: (content: Renderable) => void;
  setSelectedIndex: (index: number) => void;
  getSelectedIndex: () => number;
  refresh: () => void;
  handleKeyPress: (event: KeyEvent) => boolean;
  applyTheme: () => void;
}

export interface ListDetailOptions {
  listTitle?: string;
  detailTitle?: string;
  onSelectionChange?: (index: number) => void;
  onSelect?: (index: number) => void;
}

const clampIndex = (value: number, max: number): number => {
  if (max <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(value, max - 1));
};

export function createListDetail(
  renderer: CliRenderer,
  options: ListDetailOptions = {},
): ListDetailHandle {
  let items: string[] = [];
  let detail: Renderable | null = null;

  const root = instantiate(
    renderer,
    Box({
      width: "100%",
      height: "100%",
      flexDirection: "row",
      columnGap: 1,
    }),
  );

  const masterPane = instantiate(
    renderer,
    Box({
      width: "40%",
      height: "100%",
      flexDirection: "column",
      border: true,
      borderColor: "#334155",
      title: ` ${options.listTitle ?? "List"} `,
    }),
  );

  const detailPane = instantiate(
    renderer,
    Box({
      flexGrow: 1,
      height: "100%",
      flexDirection: "column",
      border: true,
      borderColor: "#334155",
      title: ` ${options.detailTitle ?? "Detail"} `,
    }),
  );

  const list = instantiate(
    renderer,
    Select({
      width: "100%",
      height: "100%",
      options: [],
      showDescription: false,
      wrapSelection: false,
      backgroundColor: "#020617",
      textColor: "#cbd5e1",
      selectedBackgroundColor: "#1d4ed8",
      selectedTextColor: "#f8fafc",
      focusedBackgroundColor: "#020617",
      focusedTextColor: "#cbd5e1",
    }),
  ) as SelectRenderable;

  const detailScroll = instantiate(
    renderer,
    ScrollBox({
      width: "100%",
      height: "100%",
      scrollY: true,
      backgroundColor: "#020617",
      paddingX: 1,
      paddingY: 1,
    }),
  ) as ScrollBoxRenderable;

  const emptyDetail = instantiate(
    renderer,
    Text({
      content: "Select an item to inspect detail.",
      fg: "#94a3b8",
    }),
  ) as Renderable & { fg?: string };

  masterPane.add(list);
  detailPane.add(detailScroll);
  detailScroll.add(emptyDetail);
  root.add(masterPane);
  root.add(detailPane);

  const applyTheme = (): void => {
    const theme = getTheme();
    (masterPane as Renderable & { borderColor?: string }).borderColor = theme.border;
    (detailPane as Renderable & { borderColor?: string }).borderColor = theme.border;
    list.backgroundColor = theme.bg;
    list.textColor = theme.fg;
    list.selectedBackgroundColor = theme.accent;
    list.selectedTextColor = theme.bg;
    list.focusedBackgroundColor = theme.bg;
    list.focusedTextColor = theme.fg;
    detailScroll.backgroundColor = theme.bg;
    emptyDetail.fg = theme.muted;
  };

  applyTheme();

  const emitSelection = (): void => {
    if (items.length === 0) {
      return;
    }

    options.onSelectionChange?.(list.getSelectedIndex());
  };

  return {
    root,
    setList: (nextItems: string[]) => {
      items = nextItems;
      const visibleItems = nextItems.length > 0 ? nextItems : ["No items available."];
      list.options = visibleItems.map((item) => ({ name: item, description: "" }));
      list.setSelectedIndex(clampIndex(list.getSelectedIndex(), nextItems.length));
      emitSelection();
      renderer.requestRender();
    },
    setDetail: (content: Renderable) => {
      if (detail) {
        detailScroll.remove(detail.id);
      } else {
        for (const child of detailScroll.getChildren()) {
          detailScroll.remove(child.id);
        }
      }

      detail = content;
      detailScroll.add(content);
      renderer.requestRender();
    },
    setSelectedIndex: (index: number) => {
      list.setSelectedIndex(clampIndex(index, items.length));
      emitSelection();
      renderer.requestRender();
    },
    getSelectedIndex: () => clampIndex(list.getSelectedIndex(), items.length),
    refresh: () => {
      renderer.requestRender();
    },
    handleKeyPress: (event: KeyEvent): boolean => {
      if (items.length === 0) {
        return false;
      }

      if (event.name === "up" || event.name === "k") {
        list.moveUp(1);
        emitSelection();
        renderer.requestRender();
        return true;
      }

      if (event.name === "down" || event.name === "j") {
        list.moveDown(1);
        emitSelection();
        renderer.requestRender();
        return true;
      }

      if (event.name === "enter" || event.name === "return") {
        options.onSelect?.(list.getSelectedIndex());
        renderer.requestRender();
        return true;
      }

      return false;
    },
    applyTheme,
  };
}
