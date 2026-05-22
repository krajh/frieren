import {
  Box,
  Input,
  Text,
  instantiate,
  type CliRenderer,
  type InputRenderable,
  type KeyEvent,
  type Renderable,
  type TextRenderable,
} from "@opentui/core";

import { getTheme } from "../lib/theme.js";

export interface SearchInputHandle {
  root: Renderable;
  focus: () => void;
  blur: () => void;
  isFocused: () => boolean;
  getValue: () => string;
  setValue: (value: string) => void;
  handleKeyPress: (event: KeyEvent) => boolean;
  applyTheme: () => void;
}

export interface SearchInputOptions {
  label?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  debounceMs?: number;
}

const buildLabel = (label: string, focused: boolean): string => {
  return focused ? `${label}*` : label;
};

export function createSearchInput(
  renderer: CliRenderer,
  options: SearchInputOptions = {},
): SearchInputHandle {
  const labelText = options.label ?? "Search";
  let focused = false;
  let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const root = instantiate(
    renderer,
    Box({
      width: "100%",
      flexDirection: "row",
      alignItems: "center",
      border: true,
      borderColor: "#334155",
      paddingX: 1,
      columnGap: 1,
      backgroundColor: "#020617",
    }),
  );

  const label = instantiate(
    renderer,
    Text({
      content: buildLabel(labelText, focused),
      fg: "#94a3b8",
      truncate: true,
    }),
  ) as TextRenderable;

  const input = instantiate(
    renderer,
    Input({
      flexGrow: 1,
      width: "100%",
      value: "",
      placeholder: options.placeholder ?? "Type to filter…",
      backgroundColor: "#020617",
      focusedBackgroundColor: "#020617",
      textColor: "#e2e8f0",
      focusedTextColor: "#f8fafc",
    }),
  ) as InputRenderable;

  root.add(label);
  root.add(input);

  const applyTheme = (): void => {
    const theme = getTheme();
    (root as Renderable & { borderColor?: string; backgroundColor?: string }).borderColor = theme.border;
    (root as Renderable & { borderColor?: string; backgroundColor?: string }).backgroundColor = theme.bg;
    label.fg = theme.muted;
    input.backgroundColor = theme.bg;
    input.focusedBackgroundColor = theme.bg;
    input.textColor = theme.fg;
    input.focusedTextColor = theme.fg;
  };

  applyTheme();

  const sync = (): void => {
    label.content = buildLabel(labelText, focused);
    renderer.requestRender();
  };

  const emitChange = (value: string): void => {
    if (!options.onChange) {
      return;
    }

    if (!options.debounceMs || options.debounceMs <= 0) {
      options.onChange(value);
      return;
    }

    if (debounceTimer) {
      globalThis.clearTimeout(debounceTimer);
    }

    debounceTimer = globalThis.setTimeout(() => {
      debounceTimer = null;
      options.onChange?.(value);
    }, options.debounceMs);
  };

  return {
    root,
    focus: () => {
      focused = true;
      input.focus();
      sync();
    },
    blur: () => {
      focused = false;
      input.blur();
      sync();
    },
    isFocused: () => focused,
    getValue: () => input.value,
    setValue: (value: string) => {
      input.value = value;
      emitChange(input.value);
      sync();
    },
    handleKeyPress: (event: KeyEvent): boolean => {
      if (!focused) {
        return false;
      }

      if (event.name === "escape") {
        focused = false;
        input.blur();
        sync();
        return true;
      }

      const before = input.value;
      const handled = input.handleKeyPress(event);
      const after = input.value;

      if (before !== after) {
        emitChange(after);
      }

      if (event.name === "enter" || event.name === "return") {
        if (debounceTimer) {
          globalThis.clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        options.onChange?.(after);
        focused = false;
        input.blur();
      }

      sync();
      return handled;
    },
    applyTheme,
  };
}
