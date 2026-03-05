import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";

import { loadConfig } from "../src/config/loadConfig.js";

test("loadConfig prefers AITOOLINGKEY over file", () => {
  const home = process.env.HOME ?? "";
  const configPath = `${home}/.frieren/config.json`;

  process.env.AITOOLINGKEY = "env-key";
  rmSync(configPath, { force: true });

  const config = loadConfig();

  assert.equal(config.litellm.apiKey, "env-key");
});
