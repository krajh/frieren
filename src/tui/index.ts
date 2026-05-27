import { createCliRenderer } from "@opentui/core";

import { createApp } from "./app.js";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  screenMode: "alternate-screen",
  clearOnShutdown: true,
  useMouse: true,
});

const app = createApp(renderer);
renderer.root.add(app.root);
renderer.start();
renderer.requestRender();

renderer.on("destroy", () => {
  app.destroy();
});

export { renderer };
