# Frieren

Frieren is a local MCP (Model Context Protocol) memory server for AI agents. It gives agents persistent memory across three planes — **Wisdom**, **Session**, and **Codebase** — so they can recall decisions, prior context, and code structure across sessions.

**Fully local. No API keys. No external services.** Embeddings run on-device via a quantized [MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) model (~23 MB, auto-downloaded on first run).

## The Three Planes

| Plane        | What it stores                                                         | Scope           |
| ------------ | ---------------------------------------------------------------------- | --------------- |
| **Wisdom**   | Durable facts, decisions, patterns, and relationships between concepts | Global          |
| **Session**  | Per-session observations, agent episodes, and ephemeral context        | Per-project     |
| **Codebase** | Indexed source files, symbols, and dependency graphs                   | Per-project     |

## Tools

| Tool               | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `wisdom_write`     | Store a durable fact or decision in the wisdom plane         |
| `wisdom_search`    | Search wisdom entries by semantic similarity or keyword      |
| `wisdom_relate`    | Create a typed relationship between two wisdom entries       |
| `session_write`    | Write an observation or episode to the current session       |
| `session_recall`   | Retrieve recent session context by query or entity           |
| `codebase_index`   | Index a local repository (full or incremental via git diff)  |
| `codebase_search`  | Search indexed code by semantic similarity or keyword        |
| `codebase_graph`   | BFS traversal of file/symbol dependency graph                |
| `memory_search`    | Unified search across all three planes with GraphRAG scoring |
| `memory_history`   | Cross-plane chronological timeline for an entity             |
| `frieren_status`   | Report storage stats and health across all planes            |

## Installation

### Prerequisites

- [Bun](https://bun.sh) >= 1.0

### 1. Clone and install

```bash
git clone https://github.com/krajh/frieren.git
cd frieren
bun install
```

### 2. Verify it starts

```bash
bun src/index.ts
```

On first run, Frieren downloads the embedding model (~23 MB) to `~/.cache/`. You'll see download progress in the terminal. Subsequent starts are instant.

### 3. Connect your client

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "frieren": {
      "command": "bun",
      "args": ["/absolute/path/to/frieren/src/index.ts"]
    }
  }
}
```

Restart Claude Desktop after saving.

#### OpenCode

Add to your project's `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "frieren": {
      "type": "local",
      "command": "bun",
      "args": ["/absolute/path/to/frieren/src/index.ts"],
      "enabled": true
    }
  }
}
```

> Replace `/absolute/path/to/frieren` with the actual path to your clone. Run `pwd` inside the repo directory to get it.

## Usage Patterns

_This section is for LLM agents. It covers when to use which tool._

### Starting a session

1. Call `frieren_status` — check what memory exists for the current project.
2. Call `session_recall` with your current task description — surface relevant past context.
3. If working in a codebase, call `codebase_index` (incremental is fast), then `codebase_search` to orient yourself.

### During a session

- Log observations and tool events with `session_write`.
- Store important decisions, constraints, or patterns with `wisdom_write` (these persist permanently).
- Use `memory_search` to search across all planes at once when you need broad recall.

### Ending a session

- Review what happened with `session_recall`.
- Promote key findings to the wisdom plane with `wisdom_write` so they survive the 60-day session window.

### Tool selection guide

| I need to...                                | Use                |
| ------------------------------------------- | ------------------ |
| Remember a decision permanently             | `wisdom_write`     |
| Find something I knew before                | `wisdom_search`    |
| Log what I just did                         | `session_write`    |
| Recall recent context for this project      | `session_recall`   |
| Search everything at once                   | `memory_search`    |
| Understand how a file fits into a codebase  | `codebase_graph`   |
| Find code related to a concept              | `codebase_search`  |
| See how an entity evolved over time         | `memory_history`   |

## Storage

All data lives under `~/.frieren/`:

```
~/.frieren/
  config.json                     — Runtime config (auto-created with defaults)
  wisdom.db                       — Wisdom plane (global, permanent)
  sessions/<project_id>.db        — Session plane (per-project, 60-day rolling)
  index/<project_id>.db           — Codebase plane (per-project)
```

Projects are identified automatically by git remote URL. No manual configuration needed.

## Tech Stack

| Component  | Technology                                                        |
| ---------- | ----------------------------------------------------------------- |
| Runtime    | [Bun](https://bun.sh) + TypeScript                                |
| Protocol   | [MCP](https://modelcontextprotocol.io) (stdio)                    |
| Storage    | SQLite (`bun:sqlite` + `sqlite-vec`)                              |
| Embeddings | `Xenova/all-MiniLM-L6-v2` (local, 384-dim, quantized, no API key) |

## Development

```bash
bun test              # Run all tests
bunx tsc --noEmit     # Type check
bun src/index.ts      # Start the server
```
