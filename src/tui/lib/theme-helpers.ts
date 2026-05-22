import { TextareaRenderable } from "@opentui/core";
import { type Theme } from "./theme.js";

// Properties that exist on TextareaRenderable but may not be in the type declarations.
// We access them via a narrowed type to avoid `as unknown` casts.
export interface TextareaThemeProps {
  backgroundColor?: string;
  focusedBackgroundColor?: string;
  textColor?: string;
  focusedTextColor?: string;
}

/** Apply theme colors to a TextareaRenderable safely. */
export function applyTextareaTheme(editor: TextareaRenderable, theme: Theme): void {
  const props = editor as unknown as TextareaThemeProps;
  props.backgroundColor = theme.bg;
  props.focusedBackgroundColor = theme.bg;
  props.textColor = theme.fg;
  props.focusedTextColor = theme.fg;
}
