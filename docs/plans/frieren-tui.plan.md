# Frieren-TUI: Plan

## Original Request

> "I want to build a TUI for Frieren to view and manage all the mem layers, and then be able to spawn a new session based on a memory or a saved plan or whatever with whatever harness the user has installed"

## Problem Statement

Frieren's 30+ MCP tools are only accessible through LLM agents. There is no human-facing interface to:

1. **Browse** what's stored across Wisdom, Session, and Codebase planes
2. **Manage** entries (search, inspect, relate, invalidate)
3. **Act on** stored context by spawning a new agent session pre-loaded with relevant memories

This creates a "write-only memory" problem — data goes in but humans can't easily audit, curate, or leverage it without an agent intermediary. The TUI gives humans direct access to their own memory system.

## Design

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  frieren-tui                      │
│  (Bun process, OpenTUI renderer)                 │
├─────────────────────────────────────────────────┤
│  UI Layer        │  @opentui/core components     │
│  State Layer     │  Reactive store (signals)     │
│  Data Layer      │  Direct import of Frieren DB  │
│  Spawn Layer     │  Harness adapters             │
└─────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   ~/.frieren/*.db              MCP Host (spawn)
   (SQLite direct)              opencode / claude / etc.
```

**Key decision: Direct DB access, not MCP client.**

Rationale: Frieren is in the same repo. The TUI imports Frieren's internal DB/query modules directly (e.g., `src/db/`, `src/lib/`) rather than spawning a second Frieren process and talking MCP over stdio. This avoids:
- Serialization overhead for browsing large result sets
- Needing to keep a subprocess alive
- MCP's request/response model being awkward for paginated browsing

The TUI is a **peer binary** in the same package: `bun src/tui/index.ts`.

### User Interface

**Navigation model:** Tab-based top-level screens with vim-style keybindings.

```
[Dashboard] [Wisdom] [Sessions] [Codebase] [KG] [Reaper]
─────────────────────────────────────────────────────────
│                                                       │
│              Active screen content                    │
│                                                       │
─────────────────────────────────────────────────────────
[Status bar: project | plane | entry count | shortcuts]
```

**Global keys:**
- `1-6` or `Tab`/`Shift+Tab`: Switch screens
- `/`: Focus search input
- `Enter`: Open detail view
- `Esc` or `q`: Back / quit
- `s`: Spawn session from current context
- `?`: Help overlay

**List views** use a master-detail split: left pane is a scrollable filtered list, right pane shows preview of selected item.

### Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI framework | OpenTUI (`@opentui/core`) | Native Zig perf, TS bindings, flexbox layout, component model |
| Data access | Direct SQLite import | Same repo, avoids MCP overhead for browsing |
| State management | Simple reactive signals | OpenTUI supports reactive patterns; no need for heavy framework |
| Session spawning | Adapter pattern per harness | Each MCP host has different invocation; adapters normalize this |
| Package structure | `src/tui/` in same repo | Shares types, DB modules, config with server |
| Entry point | `bun src/tui/index.ts` via `"tui"` script | Single command: `bun run tui` |

### Screens

#### 1. Dashboard

Shows at-a-glance health and activity.

```
┌─ Health ──────────────┐  ┌─ Recent Activity ─────────┐
│ Wisdom: 342 entries   │  │ 2m ago  session_write ...  │
│ Sessions: 12 projects │  │ 5m ago  wisdom_write ...   │
│ Codebase: 3 indexed   │  │ 1h ago  kg_add ...         │
│ KG: 89 triples        │  │                            │
│ Reaper: 2 pending     │  │                            │
│ Disk: 48MB total      │  │                            │
└───────────────────────┘  └────────────────────────────┘
```

Data source: `frieren_status` equivalent (direct DB stats query).

#### 2. Wisdom Browser

```
┌─ Search: [____________] Filter: [type ▼] [kind ▼] ────┐
├─ Results (342) ───────────┬─ Preview ─────────────────┤
│ > Pattern: Bun test...    │ **Type:** pattern          │
│   Decision: Use SQLite... │ **Confidence:** 0.9        │
│   Constraint: No ext...   │ **Tags:** testing, bun     │
│   Issue: Memory leak...   │                            │
│                           │ Content:                   │
│                           │ When running bun test...   │
│                           │                            │
│                           │ [s]pawn  [r]elate  [d]el   │
└───────────────────────────┴───────────────────────────┘
```

Operations: search (semantic + keyword), filter by type/kind/tags/project, view detail, create relations, spawn session.

#### 3. Session Browser

```
┌─ Project: [frieren ▼]  Search: [____________] ────────┐
├─ Events ──────────────────┬─ Detail ──────────────────┤
│ > 14:32 milestone: ...    │ event_type: milestone      │
│   14:28 decision: ...     │ content: Completed phase   │
│   14:15 tool_call: ...    │   1 of TUI implementation  │
│   13:50 note: ...         │ artifacts:                 │
│                           │   - src/tui/index.ts       │
│                           │                            │
│                           │ [s]pawn from here          │
└───────────────────────────┴───────────────────────────┘
```

Scoped by project. Filterable by event_type, date range.

#### 4. Codebase Browser

```
┌─ Project: [frieren ▼]  Search: [____________] ────────┐
├─ Files / Chunks ──────────┬─ Code Preview ────────────┤
│ > src/server.ts (fn:3)    │ ```typescript              │
│   src/db/wisdom.ts (fn:5) │ export const createServer  │
│   src/lib/embed.ts (fn:2) │   = async () => {          │
│                           │   ...                      │
│                           │ ```                        │
│                           │                            │
│                           │ Deps: [graph view]         │
└───────────────────────────┴───────────────────────────┘
```

Shows indexed files, chunks, and dependency graph traversal.

#### 5. Memory Detail (overlay/modal)

Full-screen view of a single entry with:
- All metadata fields
- Related entries (via KG or wisdom_relate)
- Timeline (via memory_history)
- Action bar: Spawn, Relate, Edit, Delete

#### 6. Session Spawn

Triggered by pressing `s` on any entry. Presents:

```
┌─ Spawn Session ───────────────────────────────────────┐
│                                                       │
│ Context:                                              │
│   [Wisdom entry: "Pattern: Bun test requires..."]    │
│                                                       │
│ Harness: [OpenCode ▼]  (detected: opencode, claude)  │
│ Agent:   [marin-coder ▼]                             │
│ Prompt:  [Pre-filled from context_______________]    │
│                                                       │
│          [Launch]  [Edit prompt]  [Cancel]            │
└───────────────────────────────────────────────────────┘
```

#### Empty-State Specifications

Every browser screen must handle the "no data" case gracefully:

| Screen | Empty State | Message |
|--------|-------------|---------|
| Dashboard | All counters at zero | "Frieren is ready. Run an agent session to start populating memory." |
| Wisdom Browser | No entries | "No wisdom entries yet. Wisdom accumulates as agents store decisions and patterns during sessions." |
| Session Browser | No projects indexed | "No projects found. Run `frieren_codebase_index()` in an agent session to index a project." |
| Codebase Browser | No indexed projects | "No codebase indexes found. Run `frieren_codebase_index()` to index a project's source code." |
| KG Browser | No triples | "No knowledge graph triples yet. Entries are created automatically through agent interactions." |
| Reaper Browser | No tasks | "No pending or active tasks in the Reaper Realm." |

Each empty state shows in the main content area with centered text + the message above.

#### SpawnResult Shape & Error Handling

```typescript
interface SpawnResult {
  success: boolean;
  harnessId: string;
  pid?: number;           // Process ID of spawned session (if applicable)
  error?: {
    message: string;      // Human-readable error summary
    details?: string;     // stderr output or detailed diagnostics
    code?: string;        // Machine-readable error code (e.g. "NOT_FOUND", "AUTH_FAILED")
  };
}
```

**Spawn dialog error state:** When `spawn()` returns `{ success: false }`, the dialog transitions to an error view showing:
- Error message (prominent, red text)
- Error details in a scrollable area (stderr or diagnostics)
- Retry button (re-runs the same spawn)
- Back button (return to entry detail)

**Security constraint:** All harness adapters MUST use `Bun.spawn()` with argv arrays. Shell string interpolation of memory content is forbidden. Memory content containing shell metacharacters (backticks, `$()`, etc.) MUST NOT reach a shell parser.

### Integration Points

#### Frieren Data Access

The TUI imports Frieren's internal modules directly:

```typescript
import { getWisdomDb } from "../db/wisdom.js";
import { getSessionDb } from "../db/session.js";
import { getCodebaseDb } from "../db/codebase.js";
import { getConfig } from "../config.js";
```

This gives full read/write access to all planes without MCP serialization.

#### Session Spawning — Harness Adapters

Each MCP host is invoked differently. The TUI uses a plugin-style adapter:

```typescript
interface HarnessAdapter {
  id: string;
  name: string;
  detect(): Promise<boolean>;       // Is this harness installed?
  spawn(opts: SpawnOpts): Promise<SpawnResult>;
}

interface SpawnOpts {
  agent?: string;          // e.g. "marin-coder"
  prompt: string;          // Task/context to inject
  workdir?: string;        // Working directory
  context?: MemoryEntry[]; // Entries to include as context
}
```

**Adapters planned:**

| Harness | Detection | Spawn mechanism |
|---------|-----------|-----------------|
| OpenCode | `which opencode` | `opencode run --agent <agent> --prompt <prompt>` |
| Claude CLI | `which claude` | `claude --prompt <prompt>` |
| Claude Desktop | Config file exists | Write to MCP config + open app (limited) |
| Custom | User config | Configurable command template |

Adapter config lives in `~/.frieren/tui.toml`:

```toml
[harness.default]
id = "opencode"

[harness.custom]
command = "my-agent --task {prompt} --context {context_file}"
```

## Acceptance Criteria

1. **AC-1**: `bun run tui` launches the TUI and renders the Dashboard with live stats from all three planes
2. **AC-2**: User can navigate to Wisdom/Session/Codebase browsers and search entries with <200ms response time for keyword search
3. **AC-3**: User can view full detail of any entry including related entries and timeline
4. **AC-4**: User can press `s` on any entry to open the Spawn dialog
5. **AC-5**: At least one harness adapter (OpenCode) successfully spawns a session with context from the selected entry
6. **AC-6**: Harness auto-detection correctly identifies installed MCP hosts
7. **AC-7**: All navigation is keyboard-driven with consistent vim-style bindings
8. **AC-8**: TUI gracefully handles missing/empty databases (fresh install)

## Implementation Plan

### Phase 1: Foundation (scaffold + dashboard)

1. Add `@opentui/core` dependency
2. Create `src/tui/index.ts` entry point + `"tui"` script in package.json
3. Build app shell: tab bar, status bar, screen router, global key handler
4. Implement Dashboard screen with direct DB stats queries
5. Verify renders correctly in standard terminals (kitty, alacritty, tmux)

### Phase 2: Browsers (read path)

6. Build shared `ListDetail` layout component (master-detail split)
7. Implement Wisdom Browser: list, search, filter by type/kind/tags
8. Implement Session Browser: project selector, event list, date filter
9. Implement Codebase Browser: file list, chunk preview, dep graph display
10. Implement Memory Detail overlay with metadata + relations + timeline

### Phase 3: Session Spawning (write path)

11. Define `HarnessAdapter` interface and adapter registry
12. Implement OpenCode adapter (detect + spawn via CLI)
13. Implement Claude CLI adapter
14. Build Spawn dialog UI (harness select, agent select, prompt editor)
15. Context serialization: convert memory entries to prompt-injectable format
16. Add `~/.frieren/tui.toml` config for harness preferences

### Phase 4: Polish + Extended Features

17. KG browser screen (entity graph visualization as ASCII/box art)
18. Reaper queue screen (view pending/manifesting tasks, cancel)
19. Inline entry creation (quick-add wisdom from TUI)
20. Theming support (color schemes via config)
21. Mouse support (optional, OpenTUI supports it)

## Risks & Assumptions

| Risk | Mitigation |
|------|------------|
| OpenTUI TS bindings may be immature | [!] Assumption: `@opentui/core` is stable enough for production use. If wrong, fallback to Ink (React-based TUI) |
| Direct DB import couples TUI to Frieren internals | Keep a thin data-access layer that can be swapped to MCP client if needed |
| Harness CLIs may change flags | Adapter pattern isolates changes to single file per harness |
| Large wisdom DBs may be slow to browse | Paginate all queries, use SQLite LIMIT/OFFSET, lazy-load previews |

## Open Questions

- [x] RESOLVED: `@opentui/core@0.2.15` installs and resolves with Bun 1.3.12. Verified: `bun add @opentui/core` succeeded.
- Should the TUI support write operations (create/edit/delete wisdom entries) in Phase 2, or defer all writes to Phase 3+?
- Should the Spawn dialog support multi-entry context (select several memories to inject), or single-entry only for v1?

## Validation Log

### 2025-01-20 — Plan vs. Intent Validation

**Verdict: PASS**

**Original intent (3 parts):**
1. "TUI for Frieren to view and manage all the mem layers" → ✅ Covered by Dashboard + Wisdom/Session/Codebase browsers + KG + detail views with manage operations (relate, delete, edit)
2. "spawn a new session based on a memory or a saved plan or whatever" → ✅ Covered by Spawn dialog (press `s` on any entry), context serialization, prompt pre-fill from selected entry
3. "with whatever harness the user has installed" → ✅ Covered by HarnessAdapter pattern with auto-detection, multiple adapters (OpenCode, Claude CLI, Custom), and configurable default

**What the plan does well:**
- Directly quotes the original request and traces all design decisions back to it
- The three user intents map cleanly to the three implementation phases (Foundation → Browsers → Spawning)
- Acceptance criteria are specific and testable (AC-1 through AC-8 each verify a concrete user-facing behavior)
- Harness adapter interface is appropriately generic — "whatever harness" is handled by detect+spawn+custom template
- Risks section honestly flags the OpenTUI dependency uncertainty with a fallback path
- Scope is well-bounded: Phase 4 items are clearly labeled as polish, not core

**Minor observations (not failures):**
- "saved plan" from the user's request is implicitly covered (plans are wisdom entries or session artifacts), but could be more explicitly called out in the Spawn dialog description
- Phase 4 items (KG browser, Reaper screen, theming, mouse) are reasonable extensions, not scope creep — they serve "view and manage all the mem layers"
- The BLOCKED ON for OpenTUI is appropriate — this should be resolved before architectural review proceeds

**Ready for architectural review.** The blocker on OpenTUI package existence should be resolved first (quick verification task).

---

### 2025-01-20 — Mode A Contract Review (Guillotine)

**Verdict: CONDITIONAL APPROVE**

Approved with conditions. All P0 criteria pass. Two P1 issues require concrete fix plans before implementation begins. Three P2 flags acknowledged.

---

#### Evidence Base

Reviewed against:
- `src/db/init.ts` — actual DB initialization and path resolution
- `src/config/loadConfig.ts` — config loading, `~/.frieren` path expansion
- `src/utils/paths.ts` — DB path helpers
- `src/db/wisdom-schema.ts` — schema structure
- `package.json` — confirmed `@opentui/core@^0.2.15` already in dependencies
- Live `opencode run --help` output — actual CLI flags
- Live `claude --help` output — actual CLI flags

---

#### P0 — Correctness: PASS

The plan describes a technically sound approach. Direct DB import via `initDb()` is the correct pattern — the existing `src/db/init.ts` already handles WAL mode, sqlite-vec loading, and schema migrations idempotently. The TUI importing these modules as a peer binary is architecturally valid.

The adapter pattern is well-scoped. `HarnessAdapter.detect()` + `spawn()` cleanly isolates per-harness differences.

**One correctness concern (not a block, but must be addressed in implementation):**

The plan proposes (line 217):
```
opencode run --agent <agent> --prompt <prompt>
```

The actual `opencode run` CLI (verified live) takes the message as **positional args**, not `--prompt`. The correct invocation is:
```
opencode run --agent <agent> <message text>
```
This is an implementation detail, not a plan-level flaw, but the OpenCode adapter author must verify flags at implementation time. The adapter pattern correctly isolates this risk.

Similarly, the Claude CLI adapter (line 218) shows `claude --prompt <prompt>`. The actual flag is `-p` / `--print` with the prompt as a positional argument: `claude -p "<prompt>"`. The plan's adapter table is illustrative, not a final spec — acceptable at contract stage.

---

#### P0 — Security: PASS (with one flag)

No hardcoded secrets. Config reads from `~/.frieren/config.json` and `AITOOLINGKEY` env var — consistent with existing server behavior.

**[!] FLAG — Prompt injection surface (P0-adjacent, mitigated by design):**

The Spawn dialog (lines 164–176) takes a memory entry's content and injects it into a harness CLI invocation as a shell argument. If memory content contains shell metacharacters (backticks, `$()`, semicolons), naive string interpolation into a shell command would be exploitable.

**Mitigation required at implementation:** The `spawn()` adapter must use `Bun.spawn()` with an **argv array** (never shell string interpolation). This is a standard Bun pattern and straightforward to enforce, but the plan does not call it out. The implementation spec must explicitly require it.

This does not block the plan — it's a well-understood implementation constraint — but it must be documented as a hard requirement in the adapter interface contract.

---

#### P1 — Robustness: SOFT BLOCK (2 issues)

**[P1-1] Missing database: no explicit handling in AC-8**

AC-8 states "TUI gracefully handles missing/empty databases (fresh install)" but the plan does not specify *what* graceful means. The existing `initDb()` creates databases on first access (line 50: `new Database(getWisdomDbPath())` — Bun SQLite creates the file if absent). However:

- Session and codebase DBs require a `projectId` (line 68: `throw new Error("projectId is required...")`). The TUI's Session Browser and Codebase Browser must handle the case where no projects are indexed yet — the plan shows no empty-state UI for these screens.
- The Dashboard stats query will return zeros, which is fine, but the plan should specify that zero-state renders a helpful message ("No projects indexed yet — run Frieren in a project to get started") rather than an empty list.

**Required before implementation:** Add an empty-state specification to the Session Browser and Codebase Browser screen designs. This is a one-paragraph addition to the plan, not a redesign.

**[P1-2] Harness spawn: no output/error feedback path**

`SpawnResult` (line 208) is defined in the interface but its shape is not specified. When `opencode run` or `claude -p` fails (bad agent name, auth error, network timeout), the TUI has no specified way to surface the error to the user. The Spawn dialog (lines 164–176) shows `[Launch]` but no error state.

**Required before implementation:** Define `SpawnResult` shape (at minimum: `{ success: boolean; pid?: number; error?: string }`). Specify that the Spawn dialog transitions to an error state on failure, showing the stderr output. Without this, spawn failures will be silent.

---

#### P2 — Maintainability: PASS with flags

**[P2-1] Direct DB write access is broader than needed for Phase 2**

The plan states (line 190): "This gives full read/write access to all planes without MCP serialization." Phase 2 is read-only browsing. Giving the TUI write access from day one means a bug in the browser code can corrupt the wisdom DB. The plan's Risks section acknowledges the coupling (line 283) but doesn't propose a mitigation for the write-access scope.

**Suggestion:** In Phase 2, instantiate DBs in read-only mode (`new Database(path, { readonly: true })`). Upgrade to read-write only in Phase 3 when write operations are actually needed. This is a one-line change per DB init call and significantly reduces blast radius during browser development.

**[P2-2] `tui.toml` config format is underdefined**

The TOML config (lines 222–229) shows `[harness.custom]` with a `command` template using `{prompt}` and `{context_file}` placeholders. The plan does not specify:
- How `{context_file}` is created (temp file? named pipe? what format?)
- Whether the file is cleaned up after spawn
- What happens if the template references an undefined placeholder

This is a P2 because it only affects the Custom adapter, which is Phase 3. But it should be resolved before Phase 3 implementation begins.

**[P2-3] OpenTUI fallback path is named but not scoped**

The Risks section (line 282) names Ink as a fallback if OpenTUI proves immature, but gives no trigger criteria. "If wrong" is not actionable. Suggest adding: "If OpenTUI cannot render a scrollable list with keyboard navigation in Phase 1 step 5, switch to Ink before proceeding to Phase 2."

---

#### Acceptance Criteria Assessment

| AC | Testable? | Complete? | Notes |
|----|-----------|-----------|-------|
| AC-1 | ✅ | ✅ | Clear: launch + dashboard renders |
| AC-2 | ✅ | ✅ | <200ms is measurable |
| AC-3 | ✅ | ✅ | Clear |
| AC-4 | ✅ | ✅ | Clear |
| AC-5 | ✅ | ✅ | OpenCode adapter specifically called out |
| AC-6 | ✅ | ⚠️ | "Correctly identifies" needs a test fixture — what if no harness is installed? Should be: "returns empty list without error" |
| AC-7 | ✅ | ✅ | Clear |
| AC-8 | ✅ | ⚠️ | Underspecified — see P1-1 above |

---

#### Conditions for Full Approval

1. **[P1-1]** Add empty-state UI specification for Session Browser and Codebase Browser (no projects indexed).
2. **[P1-2]** Define `SpawnResult` shape and specify error display in the Spawn dialog.
3. **[Implementation constraint, not plan change]** OpenCode and Claude CLI adapters must use `Bun.spawn()` with argv arrays — never shell string interpolation of user-controlled content.

P2 flags (read-only DB in Phase 2, `tui.toml` placeholder spec, OpenTUI fallback trigger) are acknowledged and do not block approval.

**Rias may accept this deliverable and proceed to implementation once conditions 1 and 2 are addressed** (either by updating this plan or by capturing them as explicit implementation notes in the Phase 2/3 task breakdown).

---

### 2025-01-20 — Conditions Cleared (Rias)

Conditions [P1-1] and [P1-2] have been addressed:
- [P1-1] ✅ Empty-state UI specification added for all browser screens (Dashboard, Wisdom, Session, Codebase, KG, Reaper)
- [P1-2] ✅ `SpawnResult` interface fully defined with error shape; Spawn dialog error state specified with retry flow
- Security constraint documented: `Bun.spawn()` with argv arrays required for all adapters

**Status: FULLY APPROVED.** Ready for Phase 4 task breakdown and implementation.
