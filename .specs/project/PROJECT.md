# Frieren — Project Specification

## Vision

Frieren is a personal AI memory system for OpenCode — three planes of knowledge (Codebase, Session, Wisdom) with GraphRAG-inspired retrieval, replacing the current Mai Context MCP with a clean, local-first, TypeScript-native system.

Named after the mage who outlives everyone, collecting and preserving memories across centuries.

## For / Solves

**For:** Kai (personal use; packaging-friendly architecture for future team distribution)

**Solves:**

- Current Mai MCP has 20+ tools with poor ergonomics requiring 4 separate skills just to use correctly
- No codebase understanding — agents can't ask "where is auth handled?" or "what breaks if I change this?"
- Three fragmented PostgreSQL pools with internal implementation leaks
- Memory outputs tagged `[unverified]` — architecture-level trust failure
- Python runtime misaligned with the rest of the TypeScript/Bun toolchain

## Goals

| Goal                | Measure                                                             |
| ------------------- | ------------------------------------------------------------------- |
| Clean tool surface  | ≤10 MCP tools (vs 20+ today)                                        |
| Codebase knowledge  | Semantic code search + dependency traversal on any indexed project  |
| Multi-hop retrieval | Graph-traversal queries across decisions, patterns, and issues      |
| Zero-ops storage    | Single SQLite file per data type in `~/.frieren/`                   |
| Fast indexing       | Incremental re-index on subsequent sessions (git-diff based)        |
| Trust by design     | All memory entries carry provenance (source, confidence, timestamp) |

## Tech Stack

| Layer          | Choice                                       | Rationale                                      |
| -------------- | -------------------------------------------- | ---------------------------------------------- |
| Runtime        | Bun + TypeScript                             | Aligned with opencode config toolchain         |
| Protocol       | MCP                                          | Drop-in replacement for current Mai server     |
| Storage        | SQLite (`bun:sqlite`)                        | Zero-ops, local-first, portable                |
| Vector search  | `sqlite-vec` extension                       | In-process, no separate vector DB              |
| Embeddings     | `text-embedding-3-small` via LiteLLM         | Uses existing `AITOOLINGKEY`, good quality     |
| Embedding dims | 512 (reduced from 1536)                      | ~88% quality, significantly smaller storage    |
| Graph          | SQLite nodes + edges tables + recursive CTEs | Graph-native queries without separate graph DB |
| Code parsing   | Tree-sitter (TS/JS/Python)                   | AST-accurate chunking and symbol extraction    |
| NER            | Lightweight rule-based + pattern matching    | Entity extraction without LLM calls per write  |

## Storage Layout

```
~/.frieren/
  config.json          # API endpoint, model, preferences
  wisdom.db            # decisions, patterns, constraints (permanent)
  sessions/
    <project_id>.db    # episodic events per project (rolling 60 days)
  index/
    <project_id>.db    # codebase index per project (regeneratable)
```

## Scope

### v1 — In Scope

- **Three-plane architecture**: Codebase, Session, Wisdom planes with distinct write/query/retention semantics
- **Codebase auto-indexing**: TypeScript, JavaScript, Python, Markdown; triggered on first session entry; incremental git-diff updates
- **GraphRAG-inspired retrieval**: vector similarity + graph traversal (1-3 hops) + structured queries, merged and reranked
- **≤10 tool MCP surface**: replaces all current Mai tooling
- **Project detection**: git remote URL → deterministic `project_id`
- **Provenance on all writes**: source agent, confidence level, timestamp, reasoning
- **Full replacement**: drop-in for current Python Mai MCP server

### v1 — Out of Scope

- Team sharing, export/import, multi-user
- Packaging / distribution tooling
- Community detection (full GraphRAG build phase)
- Web UI or dashboard
- Real-time file watching (git-diff based is sufficient for v1)

### Future (v2+)

- CLI packaging (`bunx frieren init`) for team distribution
- Optional team wisdom sharing via git-committed `.frieren/shared-wisdom.json`
- Community detection for global thematic queries
- Web UI

## Constraints

- **Local-first**: all data in `~/.frieren/`, no external servers or network dependencies beyond LiteLLM
- **Environment**: reads `AITOOLINGKEY` from env (same as existing LiteLLM config)
- **No Python**: entire system is TypeScript/Bun
- **MCP protocol**: must register as an OpenCode MCP server in `opencode.json`
- **Packaging-friendly**: config-driven, path-configurable, no hardcoded personal paths — ready to package later without architectural changes
- **No commits without explicit request**
