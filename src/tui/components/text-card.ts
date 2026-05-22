import {
  Box,
  Text,
  instantiate,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";

/** Create a simple text card renderable — used for empty states and detail previews. */
export function createTextCard(renderer: CliRenderer, content: string, color = "#cbd5e1"): Renderable {
  return instantiate(renderer, Box({ width: "100%", flexDirection: "column" }, Text({ content, fg: color })));
}
