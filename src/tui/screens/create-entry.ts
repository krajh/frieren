import {
  Box,
  Text,
  TextareaRenderable,
  instantiate,
  type BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type TextRenderable,
} from "@opentui/core";

import { createWisdomEntry } from "../lib/frieren.js";
import { getTheme } from "../lib/theme.js";
import { applyTextareaTheme } from "../lib/theme-helpers.js";
import { promptFor } from "../lib/prompt.js";

type CreateEntryResult = {
  id: string | null;
  message: string;
};

const TYPES = ["decision", "pattern", "constraint", "issue"] as const;
const FIELDS = ["type", "tags", "kind", "realm", "suite", "content", "save", "cancel"] as const;

const formatField = (label: string, value: string, focused: boolean): string => {
  return `${focused ? ">" : " "} ${label}: ${value}`;
};

export function createCreateEntryOverlay(renderer: CliRenderer): {
  root: Renderable;
  isVisible: () => boolean;
  show: () => void;
  hide: () => void;
  applyTheme: () => void;
  handleKeyPress: (event: KeyEvent) => CreateEntryResult | null;
} {
  let visible = false;
  let focusIndex = 0;
  let typeIndex = 0;
  let tags = "";
  let kind = "fact";
  let realm = "project";
  let suite = "";

  const root = instantiate(
    renderer,
    Box({
      position: "absolute",
      top: 1,
      left: 2,
      width: "90%",
      height: "85%",
      padding: 1,
      flexDirection: "column",
      border: true,
      zIndex: 35,
      rowGap: 1,
    }),
  );

  const title = instantiate(renderer, Text({ content: "Create Wisdom Entry" })) as TextRenderable;
  const typeText = instantiate(renderer, Text({ content: "" })) as TextRenderable;
  const tagsText = instantiate(renderer, Text({ content: "" })) as TextRenderable;
  const kindText = instantiate(renderer, Text({ content: "" })) as TextRenderable;
  const realmText = instantiate(renderer, Text({ content: "" })) as TextRenderable;
  const suiteText = instantiate(renderer, Text({ content: "" })) as TextRenderable;
  const helpText = instantiate(renderer, Text({ content: "↑/↓ focus  ←/→ change type  Enter edit/save  Esc cancel" })) as TextRenderable;

  const contentFrame = instantiate(
    renderer,
    Box({
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      border: true,
      title: " Content ",
    }),
  ) as BoxRenderable;

  const editor = new TextareaRenderable(renderer, {
    width: "100%",
    height: "100%",
    initialValue: "",
    wrapMode: "word",
  });

  const actionText = instantiate(renderer, Text({ content: "" })) as TextRenderable;
  const statusText = instantiate(renderer, Text({ content: "" })) as TextRenderable;

  contentFrame.add(editor);
  root.add(title);
  root.add(typeText);
  root.add(tagsText);
  root.add(kindText);
  root.add(realmText);
  root.add(suiteText);
  root.add(helpText);
  root.add(contentFrame);
  root.add(actionText);
  root.add(statusText);
  root.visible = false;

  const reset = (): void => {
    focusIndex = 0;
    typeIndex = 0;
    tags = "";
    kind = "fact";
    realm = "project";
    suite = "";
    editor.setText("");
    statusText.content = "";
  };

  const applyTheme = (): void => {
    const theme = getTheme();
    (root as Renderable & { borderColor?: string; backgroundColor?: string }).borderColor = theme.accent;
    (root as Renderable & { borderColor?: string; backgroundColor?: string }).backgroundColor = theme.bg;
    title.fg = theme.fg;
    typeText.fg = theme.fg;
    tagsText.fg = theme.fg;
    kindText.fg = theme.fg;
    realmText.fg = theme.fg;
    suiteText.fg = theme.fg;
    helpText.fg = theme.muted;
    contentFrame.borderColor = focusIndex === 5 ? theme.accent : theme.border;
    applyTextareaTheme(editor, theme);
    actionText.fg = theme.fg;
    statusText.fg = theme.muted;
  };

  const refresh = (): void => {
    typeText.content = formatField("Type", TYPES[typeIndex] ?? TYPES[0], focusIndex === 0);
    tagsText.content = formatField("Tags", tags || "[]", focusIndex === 1);
    kindText.content = formatField("Kind", kind || "[]", focusIndex === 2);
    realmText.content = formatField("Realm", realm || "[]", focusIndex === 3);
    suiteText.content = formatField("Suite", suite || "[]", focusIndex === 4);
    actionText.content = `${focusIndex === 6 ? ">" : " "} [Save]  ${focusIndex === 7 ? ">" : " "} [Cancel]`;

    if (focusIndex === 5) {
      editor.focus();
    } else {
      editor.blur();
    }

    applyTheme();
    renderer.requestRender();
  };

  const save = (): CreateEntryResult => {
    const id = createWisdomEntry({
      type: TYPES[typeIndex] ?? TYPES[0],
      content: editor.plainText,
      tags: tags.split(",").map((value) => value.trim()).filter(Boolean),
      kind: kind.trim() || undefined,
      realm: realm.trim() || undefined,
      suite: suite.trim() || undefined,
    });

    if (!id) {
      statusText.content = "Save failed.";
      statusText.fg = getTheme().error;
      refresh();
      return { id: null, message: "Save failed." };
    }

    hide();
    return { id, message: `Created wisdom entry ${id}.` };
  };

  const show = (): void => {
    reset();
    visible = true;
    root.visible = true;
    refresh();
  };

  const hide = (): void => {
    visible = false;
    root.visible = false;
    editor.blur();
    renderer.requestRender();
  };

  return {
    root,
    isVisible: () => visible,
    show,
    hide,
    applyTheme,
    handleKeyPress: (event: KeyEvent): CreateEntryResult | null => {
      if (!visible) {
        return null;
      }

      if (focusIndex === 5) {
        if (event.name === "escape") {
          focusIndex = 0;
          refresh();
          return { id: null, message: "" };
        }

        return editor.handleKeyPress(event) ? { id: null, message: "" } : null;
      }

      if (event.name === "escape" || event.name === "q") {
        hide();
        return { id: null, message: "Create entry cancelled." };
      }

      if (event.name === "up" || event.name === "k") {
        focusIndex = ((focusIndex - 1) + FIELDS.length) % FIELDS.length;
        refresh();
        return { id: null, message: "" };
      }

      if (event.name === "down" || event.name === "j" || event.name === "tab") {
        focusIndex = (focusIndex + 1) % FIELDS.length;
        refresh();
        return { id: null, message: "" };
      }

      if ((event.name === "left" || event.name === "h") && focusIndex === 0) {
        typeIndex = ((typeIndex - 1) + TYPES.length) % TYPES.length;
        refresh();
        return { id: null, message: "" };
      }

      if ((event.name === "right" || event.name === "l") && focusIndex === 0) {
        typeIndex = (typeIndex + 1) % TYPES.length;
        refresh();
        return { id: null, message: "" };
      }

      if (event.name === "enter" || event.name === "return") {
        if (focusIndex === 1) {
          tags = promptFor("Tags (comma-separated)", tags);
          refresh();
          return { id: null, message: "" };
        }

        if (focusIndex === 2) {
          kind = promptFor("Kind", kind);
          refresh();
          return { id: null, message: "" };
        }

        if (focusIndex === 3) {
          realm = promptFor("Realm", realm);
          refresh();
          return { id: null, message: "" };
        }

        if (focusIndex === 4) {
          suite = promptFor("Suite", suite);
          refresh();
          return { id: null, message: "" };
        }

        if (focusIndex === 5) {
          editor.focus();
          refresh();
          return { id: null, message: "" };
        }

        if (focusIndex === 6) {
          return save();
        }

        if (focusIndex === 7) {
          hide();
          return { id: null, message: "Create entry cancelled." };
        }
      }

      return { id: null, message: "" };
    },
  };
}
