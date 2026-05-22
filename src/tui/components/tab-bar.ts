import {
  Box,
  instantiate,
  Text,
  type CliRenderer,
  type Renderable,
  type TextRenderable,
} from "@opentui/core";

import { getTheme } from "../lib/theme.js";

export interface TabBarProps {
  tabs: string[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

export interface TabBarHandle {
  root: Renderable;
  setActiveIndex: (index: number) => void;
  applyTheme: () => void;
}

export function createTabBar(
  renderer: CliRenderer,
  props: TabBarProps,
): TabBarHandle {
  let activeIndex = props.activeIndex;

  const root = instantiate(
    renderer,
    Box({
      width: "100%",
      flexDirection: "row",
      paddingX: 1,
      paddingY: 0,
      columnGap: 1,
    }),
  );

  const labels: TextRenderable[] = props.tabs.map((tab, index) => {
    const label = instantiate(
        renderer,
        Text({
          content: ` ${index + 1}.${tab} `,
          truncate: true,
          onMouseDown: () => props.onSelect(index),
        }),
    ) as TextRenderable;

    root.add(label);
    return label;
  });

  const applyTheme = (): void => {
    const theme = getTheme();
    const inactiveBg = theme.border;
    (root as Renderable & { backgroundColor?: string }).backgroundColor = theme.bg;

    for (const [tabIndex, label] of labels.entries()) {
      const isActive = tabIndex === activeIndex;
      label.fg = isActive ? theme.bg : theme.fg;
      label.bg = isActive ? theme.accent : inactiveBg;
      label.content = ` ${tabIndex + 1}.${props.tabs[tabIndex]} `;
    }
  };

  const setActiveIndex = (index: number): void => {
    activeIndex = index;
    applyTheme();
  };

  applyTheme();

  return { root, setActiveIndex, applyTheme };
}
