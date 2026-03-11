import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const FRIEREN_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const runCommand = async (
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

export const registerUpdateTool = (server: McpServer): void => {
  server.registerTool(
    "frieren_update",
    {
      description:
        "Pull the latest Frieren updates from git and reinstall dependencies. A server restart is required for changes to take effect.",
      inputSchema: {},
    },
    async () => {
      const pull = await runCommand("git", ["pull"], FRIEREN_ROOT);

      if (pull.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                step: "git_pull",
                output: pull.stderr.trim() || pull.stdout.trim(),
              }),
            },
          ],
        };
      }

      const alreadyUpToDate = pull.stdout.includes("Already up to date");

      const install = await runCommand("bun", ["install"], FRIEREN_ROOT);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: alreadyUpToDate ? "up_to_date" : "updated",
              git: pull.stdout.trim(),
              deps: install.stdout.trim() || install.stderr.trim(),
              note: alreadyUpToDate
                ? "Frieren is already on the latest version."
                : "Update applied. Restart the Frieren MCP server for changes to take effect.",
            }),
          },
        ],
      };
    },
  );
};
