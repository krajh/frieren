# Frieren

![Frieren](https://media1.tenor.com/m/1BPps-lkpKEAAAAC/frieren-frieren-beyond-journey's-end.gif)

Frieren is a local MCP (Model Context Protocol) memory server for AI agents. It gives agents persistent memory across three planes — **Wisdom**, **Session**, and **Codebase** — so they can recall decisions, prior context, and code structure across sessions.

**Fully local. No API keys. No external services.** Embeddings run on-device via a quantized [MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) model (~23 MB, auto-downloaded on first run).

## The Three Planes

| Plane        | What it stores                                                         | Scope       |
| ------------ | ---------------------------------------------------------------------- | ----------- |
| **Wisdom**   | Durable facts, decisions, patterns, and relationships between concepts | Global      |
| **Session**  | Per-session observations, agent episodes, and ephemeral context        | Per-project |
| **Codebase** | Indexed source files, symbols, and dependency graphs                   | Per-project |

## Tools

### Core Tools

| Tool              | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `wisdom_write`    | Store a durable fact or decision in the wisdom plane               |
| `wisdom_search`   | Search wisdom entries by semantic similarity or keyword            |
| `wisdom_relate`   | Create a typed relationship between two wisdom entries             |
| `wisdom_wakeup`   | Compact wake-up context (L0 identity + L1 essential facts)          |
| `session_write`   | Write an observation or episode to the current session             |
| `session_recall`  | Retrieve recent session context by query or entity                 |
| `codebase_index`  | Index a local repository (full or incremental via git diff)        |
| `codebase_search` | Search indexed code by semantic similarity or keyword              |
| `codebase_graph`  | BFS traversal of file/symbol dependency graph                      |
| `memory_search`   | Unified search across all three planes with GraphRAG scoring       |
| `memory_browse`   | Deterministic memory navigation — `ls`, `tree`, `stat`, `find` ops |
| `memory_commit`   | Auto-extract recurring session patterns and promote to wisdom      |
| `memory_history`  | Cross-plane chronological timeline for an entity                   |
| `retrieval_debug` | Query retrieval trajectory logs to diagnose search quality         |
| `frieren_status`  | Report storage stats and health across all planes                  |
| `frieren_update`  | Pull the latest Frieren updates from git and reinstall deps        |

### Knowledge Graph Tools

| Tool         | Description                                           |
| ------------ | ----------------------------------------------------- |
| `kg_add`     | Add temporal triples (subject-predicate-object)       |
| `kg_query`   | Query entity relationships with temporal filtering      |
| `kg_invalidate` | Mark a triple as no longer valid (fact superseded)  |
| `kg_validate`| Validate facts against stored knowledge                |
| `kg_timeline` | Chronological timeline of facts about an entity      |

### Diary Tools

| Tool         | Description                                           |
| ------------ | ----------------------------------------------------- |
| `diary_write`| Write agent diary entries (compressed AAAK format)       |
| `diary_read` | Read recent diary entries for an agent                 |

### Reaper Realm Tools

| Tool            | Description                                      |
| --------------- | ------------------------------------------------ |
| `reaper_enqueue` | Queue background tasks for Shade execution        |
| `reaper_dequeue` | Claim the next pending task (atomic)              |
| `reaper_heartbeat`| Update heartbeat for a manifesting task          |
| `reaper_complete`| Mark a task as completed with results             |
| `reaper_fail`   | Mark a task as failed (auto-retries)              |
| `reaper_status` | Query queue state and task status                 |
| `reaper_cancel` | Cancel a pending or in-flight task                |

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

#### Option A: Direct MCP Connection

**Claude Desktop**

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

**OpenCode (Direct)**

Add to your project's `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "frieren": {
      "type": "local",
      "command": ["bun", "/absolute/path/to/frieren/src/index.ts"],
      "enabled": true
    }
  }
}
```

#### Option B: OpenCode Bridge Plugin (Recommended for OpenCode)

The `bridge/` module provides an OpenCode plugin with durable memory capture and session management.

**1. Build the bridge:**
```bash
cd bridge
bun install
bun run build
```

**2. Add to OpenCode config** (`~/.config/opencode/opencode.json`):
```json
{
  "plugin": [
    "/absolute/path/to/frieren/bridge"
  ]
}
```

**3. Restart OpenCode** — the plugin connects automatically.

**What the bridge adds:**
- ✅ Compaction capture — session compactions persist as durable wisdom entries
- ✅ Session idle hooks — auto-extracts recurrent patterns via `memory_commit`
- ✅ Context injection — relevant wisdom surfaced at session start
- ✅ Toast notifications for key events
- ✅ All 30 Frieren tools via OpenCode's native plugin interface

See [bridge/README.md](bridge/README.md) for full details.

---

> Replace `/absolute/path/to/frieren` with the actual path to your clone. Run `pwd` inside the repo directory to get it.
>
> **Note:** The `command` field must be an array — `["bun", "/path"]`. The `command`/`args` split format is not valid for OpenCode's MCP schema.

## Features

### Tiered Context Loading (L0/L1/L2)

Every search result can be returned at three fidelity levels, controlled by the `fidelity` parameter:

| Level | Content           | Use case                                  |
| ----- | ----------------- | ----------------------------------------- |
| `L0`  | One-line abstract | Quick relevance scanning — minimal tokens |
| `L1`  | Paragraph summary | Planning and decision-making (default)    |
| `L2`  | Full content      | Deep reads when you need exact details    |

Agents can scan `L0` for breadth across many results, then drill to `L2` only for the few that matter. This dramatically reduces token waste on irrelevant results.

### Directory-Aware Codebase Retrieval

`codebase_search` and `memory_search` use a two-phase approach when `directory_first: true` (default):

1. **Phase 1** — Vector search across directory summaries to find the top-3 most relevant directories
2. **Phase 2** — Vector search scoped to those directories for precise, structurally coherent results

Falls back to flat search automatically if directory scoring is inconclusive.

### Memory Browse

`memory_browse` provides deterministic navigation alongside semantic search:

- **`ls`** — List entries in a plane, filterable by type, project, date, and tags
- **`tree`** — Hierarchical directory view of the codebase plane with file/chunk counts
- **`stat`** — Detailed metadata for a specific entry (all fields, relations, timestamps)
- **`find`** — Regex pattern matching across content, tags, and file paths

### Auto Memory Extraction

`memory_commit` analyzes session events across recent sessions, clusters them by semantic similarity, and auto-promotes recurring patterns to durable wisdom entries. When patterns are promoted, it also populates the knowledge graph with structural metadata (project→relates_to→topic triples). Use `dry_run: true` to preview candidates before writing.

### Retrieval Trajectory Logging

Every `memory_search` call logs its retrieval path (vector hits, keyword hits, graph expansions, directories visited). Use `retrieval_debug` to query these logs and diagnose why searches returned what they did. Pass `debug: true` to `memory_search` to include trajectory data in the response.

## Terminal UI (`bun run tui`)

Frieren includes a full-screen terminal UI for browsing and managing all memory planes interactively.

### Features

| Feature           | Key          | Description                                     |
| ----------------- | ------------ | ----------------------------------------------- |
| **Dashboard**     | `1`          | Live health overview of all planes              |
| **Wisdom**        | `2`          | Browse, search, filter, and create entries      |
| **Sessions**      | `3`          | Inspect session history by project              |
| **Codebase**      | `4`          | Browse indexed files and dependency graphs      |
| **KG**            | `5`          | Explore knowledge graph entities and triples    |
| **Reaper**        | `6`          | View and cancel background queue tasks          |

### Keybindings

| Key                  | Action                              |
| -------------------- | ----------------------------------- |
| `1`-`6`              | Switch screens                      |
| `Tab` / `Shift+Tab`  | Next / previous screen              |
| `←` / `→`            | Navigate screens                    |
| `↑` / `↓` / `j` / `k`| Navigate lists                      |
| `Enter`              | Select item / show detail           |
| `/`                  | Focus search input                  |
| `s`                  | Spawn agent session from selection  |
| `n`                  | Create new wisdom entry             |
| `r` / `e` / `d`      | Relate / edit / soft-delete entry   |
| `T`                  | Toggle dark/light theme             |
| `?`                  | Show help overlay                   |
| `q` / `Esc`          | Quit                                |

### Session Spawning

Press `s` on any memory entry to open the Spawn dialog. The TUI auto-detects installed harnesses:

- **OpenCode** — `opencode run --agent <agent> <prompt>`
- **Claude CLI** — `claude -p <prompt>`
- **Custom** — User-defined command templates in `~/.frieren/tui.toml`

All spawning uses `Bun.spawn()` with argv arrays — no shell interpolation.

### Configuration

Create `~/.frieren/tui.toml`:

```toml
theme = "dark"                    # "dark" or "light"
preferred_harness = "opencode"
preferred_agent = "marin-coder"

[[custom_harnesses]]
name = "Codex"
id = "codex"
detect_command = "which codex"
spawn_template = "codex --agent {agent} {prompt}"
```

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
- Use `memory_browse` to deterministically explore memory structure (`ls`, `tree`, `stat`, `find`).

### Ending a session

- Review what happened with `session_recall`.
- Run `memory_commit` to auto-extract recurring patterns and promote them to wisdom.
- Promote any remaining key findings manually with `wisdom_write` so they survive the 60-day session window.

### Tool selection guide

| I need to...                               | Use               |
| ------------------------------------------ | ----------------- |
| Remember a decision permanently            | `wisdom_write`    |
| Find something I knew before               | `wisdom_search`   |
| Log what I just did                        | `session_write`   |
| Recall recent context for this project     | `session_recall`  |
| Search everything at once                  | `memory_search`   |
| Understand how a file fits into a codebase | `codebase_graph`  |
| Find code related to a concept             | `codebase_search` |
| Browse memory structure deterministically  | `memory_browse`   |
| Auto-promote session patterns to wisdom    | `memory_commit`   |
| Diagnose why a search returned bad results | `retrieval_debug` |
| See how an entity evolved over time        | `memory_history`  |

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

## Updating

```bash
bun run update
```

Pulls the latest changes from git and reinstalls dependencies. If you're connected via MCP, you can also call the `frieren_update` tool directly from your AI assistant — it runs the same steps and returns structured output. Either way, **restart the MCP server** after updating for changes to take effect.

## Development

```bash
bun test              # Run all tests
bunx tsc --noEmit     # Type check
bun src/index.ts      # Start the server
```

## Troubleshooting

**`Cannot find module '../build/Release/sharp-linux-x64.node'` (Linux)**

`@xenova/transformers` pulls in `sharp` as a transitive dependency. On Linux, `bun install` does not build native bindings by default. Fix it by installing the prebuilt binary explicitly:

```bash
npm install --platform=linux --arch=x64 sharp@0.32.6
```

This installs the pre-built Linux x64 binary without requiring C++ build tools. Run it once after `bun install` — no rebuild needed on subsequent starts.

**Tools not appearing after config**

- Restart OpenCode fully (MCP servers connect at startup)
- Verify the path resolves: `bun /absolute/path/to/frieren/src/index.ts`
- Confirm `command` in `opencode.json` is an array: `["bun", "/path/to/src/index.ts"]`

**Codebase search returns no results**

Run `frieren_codebase_index({})` once to build the initial index. Re-index after large refactors with `frieren_codebase_index({ force: true })`.
