# Frieren

> _"She collects magic spells the way others collect memories — slowly, deliberately, across more time than anyone can fathom."_

Personal AI memory system for OpenCode. Three planes of knowledge. GraphRAG-inspired retrieval. Local-first.

## What It Does

- **Codebase Plane** — indexes your project on first entry; semantic code search, dependency graph traversal
- **Session Plane** — captures what happened in each session; temporal recall
- **Wisdom Plane** — stores decisions, patterns, constraints across sessions; permanent, trusted, provenance-tagged

## Why It Exists

The current Mai Context MCP has 20+ tools, fragmented PostgreSQL pools, and outputs that need `[unverified]` tags. Frieren is the redesign: ≤10 clean tools, SQLite, TypeScript, and memory that earns its own trust.

## Status

🚧 In active design/build — see [`.specs/project/PROJECT.md`](.specs/project/PROJECT.md) and [`.specs/project/ROADMAP.md`](.specs/project/ROADMAP.md)

## Tech Stack

- **Runtime**: Bun + TypeScript
- **Protocol**: MCP (OpenCode)
- **Storage**: SQLite (`bun:sqlite` + `sqlite-vec`)
- **Embeddings**: `text-embedding-3-small` via LiteLLM
