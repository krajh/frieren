# Frieren

Frieren is a local MCP memory server for AI agents. It stores and retrieves knowledge across three planes — Wisdom, Session, and Codebase — enabling agents to build durable memory, recall prior context, and navigate code structure with graph traversal.

## The Three Planes

| Plane        | What it stores                                                         |
| ------------ | ---------------------------------------------------------------------- |
| **Wisdom**   | Durable facts, decisions, patterns, and relationships between concepts |
| **Session**  | Per-session observations, agent episodes, and ephemeral context        |
| **Codebase** | Indexed source files, symbols, and dependency graphs                   |

## Tools

| Tool              | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `wisdom_write`    | Store a durable fact or decision in the wisdom plane         |
| `wisdom_search`   | Search wisdom entries by semantic similarity or keyword      |
| `wisdom_relate`   | Create a typed relationship between two wisdom entries       |
| `session_write`   | Write an observation or episode to the current session       |
| `session_recall`  | Retrieve recent session context by query or entity           |
| `codebase_index`  | Index a local repository (full or incremental via git diff)  |
| `codebase_search` | Search indexed code by semantic similarity or keyword        |
| `codebase_graph`  | BFS traversal of file/symbol dependency graph                |
| `memory_search`   | Unified search across all three planes with GraphRAG scoring |
| `memory_history`  | Cross-plane chronological timeline for an entity             |
| `memory_status`   | Report storage stats and health across all planes            |

## Setup

**Prerequisites:**

- [Bun](https://bun.sh) >= 1.0
- `AITOOLINGKEY` environment variable (used for embedding API calls)

```bash
cd /path/to/frieren
bun install
```

**Register in OpenCode (`opencode.json`):**

```json
"mcp": {
  "frieren": {
    "type": "local",
    "command": "bun",
    "args": ["/path/to/frieren/src/index.ts"],
    "env": {
      "AITOOLINGKEY": "{env:AITOOLINGKEY}"
    },
    "enabled": true
  }
}
```

## Storage

All data is persisted under `~/.frieren/`:

```
~/.frieren/
  config.json                     — Runtime config (auto-created with defaults)
  wisdom.db                       — Wisdom plane (global, permanent)
  sessions/<project_id>.db        — Session plane (per-project, 60-day rolling)
  index/<project_id>.db           — Codebase plane (per-project index)
```

## Tech Stack

- **Runtime**: Bun + TypeScript
- **Protocol**: MCP (stdio)
- **Storage**: SQLite (`bun:sqlite` + `sqlite-vec`)
- **Embeddings**: `text-embedding-3-small` via LiteLLM

## Development

```bash
bun test                  # Run all tests
bunx tsc --noEmit         # Type check
bun src/index.ts          # Start the MCP server manually
```
