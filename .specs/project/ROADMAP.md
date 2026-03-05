# Frieren — Roadmap

## Phase 1 — Foundation

_Goal: working MCP server skeleton with SQLite plumbing_

- [ ] `1.01` Initialize Bun/TypeScript project (`bun init`, tsconfig, deps)
- [ ] `1.02` Schema design and SQLite setup — nodes, edges, events, embeddings tables across all three planes
- [ ] `1.03` LiteLLM embedding client — `text-embedding-3-small` with 512-dim reduction, retry/error handling
- [ ] `1.04` MCP server skeleton — transport, tool registration, basic health tool
- [ ] `1.05` Config loader — reads `~/.frieren/config.json`, env vars (`AITOOLINGKEY`), defaults
- [ ] `1.06` Project detection utility — git remote URL → deterministic `project_id`

## Phase 2 — Wisdom Plane

_Goal: replaces current Mai decisions/patterns/issues storage with better ergonomics_

- [ ] `2.01` Wisdom schema — `decisions`, `patterns`, `constraints`, `issues` as typed views over base `wisdom` table with provenance fields
- [ ] `2.02` `wisdom_write(type, content, confidence, evidence?)` — write with auto-embedding (background)
- [ ] `2.03` `wisdom_search(query, type_filter?)` — vector similarity + structured filter, returns with provenance
- [ ] `2.04` `wisdom_relate(id1, id2, relationship, strength?)` — explicit graph edge creation
- [ ] `2.05` Background embedding worker — non-blocking async queue, retries, dedup
- [ ] `2.06` Tests: write → search round-trip, provenance fields, embedding dedup

## Phase 3 — Session Plane

_Goal: replaces mai-writer episodic capture_

- [ ] `3.01` Session schema — `events` table with type, content, artifacts, agent_id, project_id, timestamp
- [ ] `3.02` `session_write(event_type, content, artifacts?)` — streaming append, auto-project detection
- [ ] `3.03` `session_recall(query, session_id?, since?)` — temporal + semantic search over recent events
- [ ] `3.04` Rolling retention — background job to prune events older than 60 days
- [ ] `3.05` Tests: write/recall, retention pruning, cross-session queries

## Phase 4 — Codebase Plane

_Goal: first-time project indexing and semantic code search_

- [ ] `4.01` File crawler — walk project root, respect `.gitignore`, collect files by type (TS/JS/Python/MD)
- [ ] `4.02` Code chunker — Tree-sitter AST for TS/JS/Python (function/class level), sliding window fallback for MD
- [ ] `4.03` Dependency graph extractor — parse imports/exports → populate nodes + edges
- [ ] `4.04` Index pipeline — crawl → chunk → embed (async) → graph build → store index state (commit hash)
- [ ] `4.05` `codebase_index(project_id?, root_path?)` — trigger/check index, return status
- [ ] `4.06` Incremental update — `git diff <last_commit>..HEAD` → re-index changed files only
- [ ] `4.07` `codebase_search(query, file_filter?)` — semantic search over code chunks
- [ ] `4.08` `codebase_graph(entry, direction?, depth?)` — dependency traversal (default depth: 3)
- [ ] `4.09` Auto-trigger — detect first session in project, trigger indexing non-blocking
- [ ] `4.10` Tests: index, search, graph traversal, incremental update correctness

## Phase 5 — Unified GraphRAG Retrieval

_Goal: multi-hop queries across all three planes_

- [ ] `5.01` Graph traversal engine — BFS/DFS over edges table with depth limit, edge-type filtering
- [ ] `5.02` Result merger — combine vector, graph, and structured results; deduplicate by entity_id
- [ ] `5.03` Reranker — score blending (recency weight, hop decay, similarity score)
- [ ] `5.04` `memory_search(query, planes?)` — unified search across Codebase + Session + Wisdom
- [ ] `5.05` `memory_history(entity_id, since?)` — temporal audit trail for any entity
- [ ] `5.06` `memory_status()` — index health, staleness, plane sizes, embedding queue depth
- [ ] `5.07` Tests: cross-plane search, multi-hop traversal, reranking correctness

## Phase 6 — OpenCode Integration

_Goal: full drop-in replacement for current Mai MCP_

- [ ] `6.01` Register Frieren as MCP server in `opencode.json` (alongside or replacing Mai)
- [ ] `6.02` Mai data migration — export current decisions/patterns from Mai DB → import into Frieren
- [ ] `6.03` Update OpenCode skills — `mai-context-db-playbook`, `mai-context-patterns`, `episodic-memory-query` → Frieren equivalents
- [ ] `6.04` Agent memory: update `AGENTS.md` memory model section to reference Frieren tools
- [ ] `6.05` Cutover — disable Mai MCP, validate Frieren handles all current use cases
- [ ] `6.06` Documentation — `docs/FRIEREN.md` quick-ref for tool usage

---

## Tool Surface (final)

```typescript
// Codebase Plane
codebase_search(query, project_id?, file_filter?)
codebase_graph(entry, direction?, depth?)
codebase_index(project_id?, root_path?)   // also status check

// Session Plane
session_write(event_type, content, artifacts?)
session_recall(query, session_id?, since?)

// Wisdom Plane
wisdom_write(type, content, confidence, evidence?)
wisdom_search(query, type_filter?)
wisdom_relate(id1, id2, relationship, strength?)

// Unified
memory_search(query, planes?)
memory_history(entity_id, since?)
memory_status()
```
