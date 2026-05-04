# Frieren OpenCode Bridge

An OpenCode plugin that wraps [Frieren](https://github.com/krajh/frieren) and adds automatic hooks for memory capture and session management.

## What This Does

This bridge connects Frieren's MCP memory server to OpenCode's plugin system, enabling:

- **Automatic memory capture** — Every assistant message is automatically stored as a session event
- **Session idle hooks** — When a session goes idle, auto-extracts patterns and promotes them to wisdom
- **Compaction recovery** — Restores relevant memories after OpenCode compacts session context
- **All Frieren tools** — Full access to all 28 Frieren tools through OpenCode's native plugin interface

## Architecture

```
OpenCode Client
├── chat.message ──► Bridge ──► Frieren MCP (session_write)
├── session.idle ──► Bridge ──► Frieren MCP (memory_commit)
├── session.compacted ──► Bridge ──► Frieren MCP (session_recall)
└── tool calls ──► Bridge ──► Frieren MCP (all 28 tools)
```

The bridge spawns Frieren as a subprocess and communicates via MCP stdio protocol.

## Installation

### 1. Build the bridge

```bash
cd bridge
bun install
bun run build
```

### 2. Add to OpenCode config

Edit `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "/absolute/path/to/frieren/bridge"
  ]
}
```

> Replace `/absolute/path/to/frieren` with the actual path.

### 3. Restart OpenCode

The plugin connects to Frieren automatically on startup.

## Tools Available

All Frieren tools are exposed through the bridge:

| Tool | Description |
|------|-------------|
| `frieren_status` | Storage stats and health |
| `wisdom_write` | Store durable facts/decisions |
| `wisdom_search` | Search wisdom plane |
| `wisdom_relate` | Link wisdom entries |
| `session_write` | Log session events |
| `session_recall` | Retrieve session context |
| `codebase_index` | Index repository |
| `codebase_search` | Search code |
| `codebase_graph` | Dependency graph traversal |
| `memory_search` | Unified cross-plane search |
| `memory_history` | Entity timeline |
| `memory_browse` | Deterministic memory navigation |
| `memory_commit` | Auto-promote patterns to wisdom |
| `retrieval_debug` | Search quality diagnostics |
| `frieren_update` | Update Frieren from git |
| `reaper_enqueue` | Queue background tasks |
| `reaper_dequeue` | Claim queued tasks |
| `kg_add` | Add knowledge graph triples |
| `kg_query` | Query knowledge graph |
| `diary_write` | Write agent diary entries |
| `diary_read` | Read agent diary entries |

## Auto-Capture Behavior

The bridge automatically captures:

1. **Assistant messages** — Stored as `session_write` with `event_type: "note"` after every chat message
2. **Session idle** — Triggers `memory_commit` to extract recurring patterns
3. **Context compaction** — Recalls recent memories to help restore context

All auto-capture operations are **fire-and-forget** — failures are logged but never block chat.

### Toast Notifications

The bridge shows TUI toast notifications for key events:

| Event | Toast Message | Variant |
|-------|--------------|---------|
| Bridge connected | "Connected to Frieren memory server" | success |
| Connection failed | Error details | error |
| Session patterns extracted | "Session patterns extracted to wisdom" | success |
| Context restored | "Session memories restored after compaction" | info |
| Hook errors | Error details | warning |

Notifications auto-dismiss after 3 seconds (5 seconds for errors).

## Configuration

No configuration needed. The bridge:
- Auto-detects Frieren at `../src/index.ts` (relative to bridge directory)
- Uses the same SQLite databases as Frieren (`~/.frieren/`)
- Inherits Frieren's existing config (`~/.frieren/config.json`)

## Troubleshooting

**"Failed to connect to Frieren"**
- Ensure Frieren is installed: `bun install` in the main frieren directory
- Verify the path: `bun /absolute/path/to/frieren/src/index.ts` should start without errors

**Tools not appearing**
- Restart OpenCode fully (plugins load at startup)
- Check OpenCode logs for plugin load errors

## License

MIT (same as Frieren)
