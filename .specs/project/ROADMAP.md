# Frieren — Roadmap

**Status: v1.0 complete** — All 6 phases shipped. 33/33 tests passing.

---

## Phase 1 — Foundation ✅

_Goal: working MCP server skeleton with SQLite plumbing_

- [x] `1.01` Initialize Bun/TypeScript project (`bun init`, tsconfig, deps)
- [x] `1.02` Schema design and SQLite setup — nodes, edges, events, embeddings tables across all three planes
- [x] `1.03` LiteLLM embedding client — `text-embedding-3-small` with 512-dim reduction, retry/error handling
- [x] `1.04` MCP server skeleton — transport, tool registration, basic health tool
- [x] `1.05` Config loader — reads `~/.frieren/config.json`, env vars (`AITOOLINGKEY`), defaults
- [x] `1.06` Project detection utility — git remote URL → deterministic `project_id`

## Phase 2 — Wisdom Plane ✅

_Goal: replaces current Mai decisions/patterns/issues storage with better ergonomics_

- [x] `2.01` Wisdom schema — `decisions`, `patterns`, `constraints`, `issues` as typed entries in `wisdom_entries` table with provenance fields
- [x] `2.02` `wisdom_write(type, content, confidence, evidence?)` — write with auto-embedding
- [x] `2.03` `wisdom_search(query, type_filter?)` — vector similarity + keyword fallback, returns with provenance
- [x] `2.04` `wisdom_relate(id1, id2, relationship, strength?)` — explicit graph edge creation
- [x] `2.05` Tests: write → search round-trip, relate, memory_status shape

## Phase 3 — Session Plane ✅

_Goal: replaces mai-writer episodic capture_

- [x] `3.01` Session schema — `sessions` + `session_events` tables with type, content, artifacts, project_id, timestamp
- [x] `3.02` `session_write(event_type, content, artifacts?)` — streaming append, auto-project detection
- [x] `3.03` `session_recall(query, session_id?, since?)` — temporal + semantic search over recent events
- [x] `3.04` Rolling retention — 60-day cleanup runs on DB open
- [x] `3.05` Tests: write/recall, retention pruning, cross-session queries, status shape

## Phase 4 — Codebase Plane ✅

_Goal: first-time project indexing and semantic code search_

- [x] `4.01` File crawler — walk project root, skip `node_modules/`, `.git/`, `dist/`, binary files
- [x] `4.02` Code chunker — regex-based (function/class/module/block), 100-line chunk limit
- [x] `4.03` Dependency graph extractor — parse imports/exports → populate `code_deps` table
- [x] `4.04` Index pipeline — crawl → chunk → embed → graph → store index state (commit hash)
- [x] `4.05` `codebase_index(project_id?, root_path?, force?)` — trigger/check index, return status
- [x] `4.06` Incremental update — `git diff <last_commit>..HEAD` → re-index changed files only
- [x] `4.07` `codebase_search(query, file_filter?)` — semantic search over code chunks
- [x] `4.08` `codebase_graph(entry, direction?, depth?)` — dependency traversal (BFS, default depth 3)
- [x] `4.09` Tests: chunking, keyword search, graph traversal, status shape

## Phase 5 — Unified GraphRAG Retrieval ✅

_Goal: multi-hop queries across all three planes_

- [x] `5.01` `memory_search(query, planes?, limit?)` — parallel search across all planes, BFS graph expansion (wisdom depth 2, codebase depth 1), score = `vector*0.7 + hop_decay*0.3`
- [x] `5.02` `memory_history(entity_id, since?)` — chronological timeline for any entity across all planes
- [x] `5.03` Tests: cross-plane search, graph scoring, plane scoping, history retrieval

## Phase 6 — OpenCode Integration ✅

_Goal: full drop-in replacement for current Mai MCP_

- [x] `6.01` Register Frieren as MCP server in `opencode.json`
- [x] `6.02` README — setup guide, tool reference, storage layout
- [x] `6.03` Update `mai-context-db-playbook` skill — migration notice pointing to Frieren tools
- [x] `6.04` Smoke test — server starts, `tools/list` returns all 11 tools

_Deferred to v1.1_: Mai data migration (6.02 original), full skill rewrites, `AGENTS.md` memory model update, Mai MCP cutover.

---

## Tool Surface (v1.0)

```typescript
// Wisdom Plane
wisdom_write(type, content, confidence?, evidence?, project_id?, tags?)
wisdom_search(query, type_filter?, project_id?, limit?)
wisdom_relate(id1, id2, relationship, strength?)

// Session Plane
session_write(event_type, content, artifacts?, session_id?, project_id?)
session_recall(query, session_id?, project_id?, since?, limit?)

// Codebase Plane
codebase_index(project_id?, root_path?, force?)
codebase_search(query, project_id?, file_filter?, chunk_type?, limit?)
codebase_graph(entry, direction?, depth?, project_id?)

// Unified
memory_search(query, planes?, limit?)
memory_history(entity_id, since?)
memory_status()
```
