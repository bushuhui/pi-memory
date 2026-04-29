# Changelog

## 1.2.0

- **Rename project to pi-memory** — package name, CLI binary, and all references updated from `memory-lancedb-pro` to `pi-memory`.
- **Standalone HTTP/MCP Server** — full REST API + MCP server with single-port architecture:
  - REST endpoints: `/api/memory/search`, `/api/memory/store`, `/api/memory/list`, `/api/memory/stats`, `/api/memory/:id` (DELETE/PATCH), `/api/knowledge/search`, `/api/knowledge/index`, `/api/knowledge/stats`, `/health`
  - MCP tools: `memory_search`, `memory_store`, `memory_forget`, `knowledge_search`, `knowledge_index` via StreamableHTTP transport (stateless mode)
  - Per-request `McpServer` creation to avoid "already connected" errors
  - Lightweight custom router with URL param extraction (no Express/Fastify dependency)
  - CORS, API key authentication, and request logging middleware
  - CLI: `pi-memory-server` with `--port`, `--host`, `--api-key`, `--no-http`, `--no-mcp` options
  - Configuration layering: CLI args > env vars > `openclaw.json` > defaults
- **Knowledge hybrid retrieval** — `knowledge_search` now uses full hybrid pipeline: vector + BM25 + RRF fusion + cross-encoder reranker (Jina/SiliconFlow/Pinecone) + MMR diversity, matching `memory_recall` quality.
- **Progress counter & elapsed time** — indexer output shows `[i/N]` progress and elapsed time for better visibility.
- **Adapt to OpenClaw 2026.04.15** — API updates for compatibility with latest OpenClaw plugin interface.

## 1.1.0

- **40x knowledge index speedup** — three-phase indexing (scan → mtime-check → process-changed) with empty/small file detection (<200 bytes), hash caching, and graceful SIGINT/SIGTERM shutdown. Re-run index time: 4min → 5.6s.
- **Incremental indexing** — only changed files are re-processed via mtime + hash verification.
- **Index with link support** — knowledge entries can now include link metadata for traceability.
- **Fix: knowledge path handling** — improved path resolution and filtering for knowledge directories.
- **Fix: chunk split method** — more robust text chunking for knowledge documents.
- **Fix: embedding `encoding_format`** — corrected format parameter in embedding API requests.
- **Fix: knowledge queue processing** — resolved queue item handling errors during async embedding.
- **Fix: FTS (Full-Text Search)** — fixed BM25/FTS search failures in knowledge store.
- **Fix: memory search** — resolved search result filtering and scoring issues.
- **Fix: backup errors** — fixed database backup failures.
- **Fix: `index-knowledge.mjs`** — self-contained config reading from `openclaw.json`, batch embedding (max 10), fast directory scanning.
- **Fix: `list-memories.mjs`** — use LanceDB directly instead of TypeScript imports for reliability.

## 1.0.8

- **Docs: clarify Jina API key usage** — separate documentation for embedding vs rerank API keys.
- **Docs: AI-safe install notes** — added warnings against assuming paths/env vars in automated installs.
- **Docs: MCP tool schema fixes** — `execute()` instead of `handler()`, `Type.Object` for params.

## 1.0.7

- Fix: resolve `agentId` from hook context (`ctx?.agentId`) for `before_agent_start` and `agent_end`, restoring per-agent scope isolation when using multi-agent setups.

## 1.0.6

- Fix: auto-recall injection now correctly skips cron prompts wrapped as `[cron:...] run ...` (reduces token usage for cron jobs).
- Fix: JSONL distill extractor filters more transcript/system noise (BOOT.md, HEARTBEAT, CLAUDE_CODE_DONE, queued blocks) to avoid polluting distillation batches.

## 1.0.5

- Add: optional JSONL session distillation workflow (incremental cursor + batch format) via `scripts/jsonl_distill.py`.
- Docs: document the JSONL distiller setup in README (EN) and README_CN (ZH).

## 1.0.4

- Fix: `embedding.dimensions` is now parsed robustly (number / numeric string / env-var string), so it properly overrides hardcoded model dims (fixes Ollama `nomic-embed-text` dimension mismatch).

## 1.0.3

- Fix: `memory-pro reembed` no longer crashes (missing `clampInt` helper).

## 1.0.2

- Fix: pass through `embedding.dimensions` to the OpenAI-compatible `/embeddings` request payload when explicitly configured.
- Chore: unify plugin version fields (`openclaw.plugin.json` now matches `package.json`).

## 1.0.1

- Fix: CLI command namespace updated to `memory-pro`.

## 1.0.0

- Initial npm release.
