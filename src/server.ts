import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerStatusTool } from "./mcp/tools/status.js";
import { registerSessionWriteTool } from "./mcp/tools/session/write.js";
import { registerSessionRecallTool } from "./mcp/tools/session/recall.js";
import { registerWisdomWriteTool } from "./mcp/tools/wisdom/write.js";
import { registerWisdomSearchTool } from "./mcp/tools/wisdom/search.js";
import { registerWisdomRelateTool } from "./mcp/tools/wisdom/relate.js";
import { registerCodebaseIndexTool } from "./mcp/tools/codebase/index.js";
import { registerCodebaseSearchTool } from "./mcp/tools/codebase/search.js";
import { registerCodebaseGraphTool } from "./mcp/tools/codebase/graph.js";
import { registerMemorySearchTool } from "./mcp/tools/unified/search.js";
import { registerMemoryHistoryTool } from "./mcp/tools/unified/history.js";

export const createServer = async (): Promise<void> => {
  const server = new McpServer(
    {
      name: "frieren",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerStatusTool(server);
  registerSessionWriteTool(server);
  registerSessionRecallTool(server);
  registerWisdomWriteTool(server);
  registerWisdomSearchTool(server);
  registerWisdomRelateTool(server);
  registerCodebaseIndexTool(server);
  registerCodebaseSearchTool(server);
  registerCodebaseGraphTool(server);
  registerMemorySearchTool(server);
  registerMemoryHistoryTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
};
