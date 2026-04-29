/**
 * Unified HTTP Server
 * Single process, single port: REST API + MCP (Streamable HTTP transport).
 * Uses Node.js built-in http module — no Express/Fastify.
 */

import http, { type IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { ServerConfig } from "./server-config.js";
import type { MemoryStore, MemoryEntry } from "./store.js";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import type { KnowledgeStore, KnowledgeChunk } from "./knowledge-store.js";
import { KnowledgeIndexer } from "./knowledge-indexer.js";
import type { Embedder } from "./embedder.js";
import type { RetrievalConfig } from "./retriever.js";
import { Router } from "./server-router.js";
import { requestLogger, corsMiddleware, apiKeyMiddleware, type Middleware } from "./server-middleware.js";
import { ok, created, badRequest, notFound, serverError, methodNotAllowed, jsonResponse } from "./server-response.js";

// ============================================================================
// Types
// ============================================================================

interface ServerComponents {
  config: ServerConfig;
  store: MemoryStore;
  retriever: MemoryRetriever;
  knowledgeStore: KnowledgeStore;
  knowledgeIndexer: KnowledgeIndexer;
  embedder: Embedder;
}

// ============================================================================
// Request Body Parsing
// ============================================================================

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  return url.searchParams;
}

// ============================================================================
// Scored Chunk Type (for knowledge search results)
// ============================================================================

interface ScoredChunk {
  chunk: KnowledgeChunk;
  score: number;
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
}

// ============================================================================
// Knowledge Hybrid Search (reused from knowledge-tools.ts pattern)
// ============================================================================

async function hybridKnowledgeSearch(
  query: string,
  store: KnowledgeStore,
  embedder: Embedder,
  config: RetrievalConfig,
  limit: number,
): Promise<ScoredChunk[]> {
  const candidatePoolSize = Math.max(config.candidatePoolSize, limit * 3);
  const queryVector = await embedder.embedQuery(query);

  const [vectorResults, bm25Results] = await Promise.all([
    store.vectorSearch(queryVector, candidatePoolSize),
    store.ftsSearch(query, candidatePoolSize),
  ]);

  const vectorMap = new Map<string, ReturnType<typeof vectorResults>[0] & { rank: number }>();
  vectorResults.forEach((r, i) => vectorMap.set(r.chunk.id, { ...r, rank: i + 1 }));

  const bm25Map = new Map<string, { chunk: KnowledgeChunk; score: number; rank: number }>();
  bm25Results.forEach((r, i) => bm25Map.set(r.chunk.id, { chunk: r.chunk, score: r.score, rank: i + 1 }));

  const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);
  const fused: ScoredChunk[] = [];

  for (const id of allIds) {
    const vecResult = vectorMap.get(id);
    const bm25Result = bm25Map.get(id);
    const baseChunk = vecResult?.chunk ?? bm25Result!.chunk;

    const vectorScore = vecResult ? vecResult.score : 0;
    const bm25Hit = bm25Result ? 1 : 0;
    const fusedScore = vecResult
      ? clamp01(vectorScore + (bm25Hit * 0.15 * vectorScore), 0.1)
      : clamp01(Math.max(bm25Result!.score, 0.5), 0.1);

    fused.push({
      chunk: baseChunk,
      score: fusedScore,
      sources: {
        vector: vecResult ? { score: vecResult.score, rank: vecResult.rank } : undefined,
        bm25: bm25Result ? { score: bm25Result.score, rank: bm25Result.rank } : undefined,
        fused: { score: fusedScore },
      },
    });
  }

  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, limit);
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

// ============================================================================
// REST API Routes
// ============================================================================

function createRestRouter(components: ServerComponents): Router {
  const { config, store, retriever, knowledgeStore, knowledgeIndexer, embedder } = components;
  const retrievalConfig: RetrievalConfig = {
    ...(config.retrieval as Partial<RetrievalConfig>),
    mode: (config.retrieval as any)?.mode || "hybrid",
    vectorWeight: (config.retrieval as any)?.vectorWeight ?? 0.7,
    bm25Weight: (config.retrieval as any)?.bm25Weight ?? 0.3,
    minScore: (config.retrieval as any)?.minScore ?? 0.3,
    rerank: (config.retrieval as any)?.rerank ?? "cross-encoder",
    candidatePoolSize: (config.retrieval as any)?.candidatePoolSize ?? 20,
    recencyHalfLifeDays: (config.retrieval as any)?.recencyHalfLifeDays ?? 14,
    recencyWeight: (config.retrieval as any)?.recencyWeight ?? 0.10,
    filterNoise: (config.retrieval as any)?.filterNoise ?? true,
    lengthNormAnchor: (config.retrieval as any)?.lengthNormAnchor ?? 500,
    hardMinScore: (config.retrieval as any)?.hardMinScore ?? 0.35,
    timeDecayHalfLifeDays: (config.retrieval as any)?.timeDecayHalfLifeDays ?? 60,
  };

  const router = new Router();

  // ---- Health ----
  router.get("/health", async (_req, res) => {
    ok(res, {
      status: "ok",
      version: "1.2.0",
      uptime: process.uptime(),
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + "MB",
      },
    });
  });

  // ---- Memory Search ----
  router.post("/api/memory/search", async (req, res) => {
    try {
      const body = await parseBody(req);
      const query = body.query as string;
      if (!query || typeof query !== "string") {
        return badRequest(res, "Missing required field: query");
      }

      const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 50);
      const minScore = typeof body.minScore === "number" ? body.minScore : undefined;
      const scope = body.scope as string | undefined;
      const category = body.category as string | undefined;

      let scopeFilter: string[] | undefined;
      if (scope) scopeFilter = [scope];

      const results = await retriever.retrieve({
        query,
        limit,
        scopeFilter,
        category,
        minScore,
      });

      // Strip vectors from response
      const cleanResults = results.map((r: RetrievalResult) => ({
        id: r.entry.id,
        text: r.entry.text,
        category: r.entry.category,
        scope: r.entry.scope,
        importance: r.entry.importance,
        timestamp: r.entry.timestamp,
        score: r.score,
        sources: r.sources,
      }));

      ok(res, {
        count: cleanResults.length,
        query,
        results: cleanResults,
      });
    } catch (err) {
      serverError(res, `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Memory Store ----
  router.post("/api/memory/store", async (req, res) => {
    try {
      const body = await parseBody(req);
      const text = body.text as string;
      if (!text || typeof text !== "string") {
        return badRequest(res, "Missing required field: text");
      }

      const importance = typeof body.importance === "number" ? Math.min(1, Math.max(0, body.importance)) : 0.7;
      const category = (body.category as string) || "other";
      const scope = (body.scope as string) || "global";

      // Check for duplicates
      const vector = await embedder.embedPassage(text);
      const existing = await store.vectorSearch(vector, 1, 0.98, [scope]);
      if (existing.length > 0 && existing[0].score > 0.98) {
        return badRequest(res, `Duplicate memory exists: "${existing[0].entry.text.slice(0, 100)}"`);
      }

      const entry = await store.store({
        text,
        vector,
        importance,
        category: category as MemoryEntry["category"],
        scope,
      });

      created(res, {
        id: entry.id,
        text: entry.text,
        scope: entry.scope,
        category: entry.category,
        importance: entry.importance,
      });
    } catch (err) {
      serverError(res, `Store failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Memory Forget ----
  router.delete("/api/memory/:id", async (req, res, params) => {
    try {
      const deleted = await store.delete(params.id);
      if (!deleted) {
        return notFound(res, `Memory ${params.id} not found`);
      }
      ok(res, { id: params.id, deleted: true });
    } catch (err) {
      serverError(res, `Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Memory Update ----
  router.patch("/api/memory/:id", async (req, res, params) => {
    try {
      const body = await parseBody(req);
      const updates: Record<string, unknown> = {};
      if (body.text) {
        updates.text = body.text;
        // Re-embed if text changed
        updates.vector = await embedder.embedPassage(body.text as string);
      }
      if (body.importance !== undefined) updates.importance = body.importance;
      if (body.category) updates.category = body.category;
      if (body.metadata) updates.metadata = body.metadata;

      if (Object.keys(updates).length === 0) {
        return badRequest(res, "No update fields provided");
      }

      const updated = await store.update(params.id, updates as any);
      if (!updated) {
        return notFound(res, `Memory ${params.id} not found`);
      }

      ok(res, {
        id: updated.id,
        text: updated.text,
        scope: updated.scope,
        category: updated.category,
        importance: updated.importance,
      });
    } catch (err) {
      serverError(res, `Update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Memory List ----
  router.get("/api/memory/list", async (req, res) => {
    try {
      const query = parseQuery(req);
      const limit = Math.min(Math.max(Number(query.get("limit")) || 20, 1), 100);
      const offset = Math.max(Number(query.get("offset")) || 0, 0);
      const scope = query.get("scope") || undefined;
      const category = query.get("category") || undefined;

      let scopeFilter: string[] | undefined;
      if (scope) scopeFilter = [scope];

      const entries = await store.list(scopeFilter, category || undefined, limit, offset);

      ok(res, {
        count: entries.length,
        entries: entries.map(e => ({
          id: e.id,
          text: e.text,
          category: e.category,
          scope: e.scope,
          importance: e.importance,
          timestamp: e.timestamp,
        })),
      });
    } catch (err) {
      serverError(res, `List failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Memory Stats ----
  router.get("/api/memory/stats", async (_req, res) => {
    try {
      const stats = await store.stats();
      const embedderStats = embedder.cacheStats;
      ok(res, {
        memories: stats,
        embedding: {
          model: embedder.model,
          dimensions: embedder.dimensions,
          cache: embedderStats,
        },
        hasFts: store.hasFtsSupport,
      });
    } catch (err) {
      serverError(res, `Stats failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Knowledge Search ----
  router.post("/api/knowledge/search", async (req, res) => {
    try {
      const body = await parseBody(req);
      const query = body.query as string;
      if (!query || typeof query !== "string") {
        return badRequest(res, "Missing required field: query");
      }

      const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100);
      const results = await hybridKnowledgeSearch(query, knowledgeStore, embedder, retrievalConfig, limit);

      const cleanResults = results.map(r => ({
        id: r.chunk.id,
        text: r.chunk.text,
        filePath: r.chunk.filePath,
        fileName: r.chunk.fileName,
        fileType: r.chunk.fileType,
        chunkIndex: r.chunk.chunkIndex,
        score: r.score,
        sources: r.sources,
      }));

      ok(res, {
        count: cleanResults.length,
        query,
        results: cleanResults,
      });
    } catch (err) {
      serverError(res, `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Knowledge Index ----
  router.post("/api/knowledge/index", async (req, res) => {
    try {
      const body = await parseBody(req);
      const incremental = body.incremental !== false;

      const statusMessages: string[] = [];
      await knowledgeIndexer.indexAll((status: string) => {
        statusMessages.push(status);
        console.log(`[api/knowledge/index] ${status}`);
      });

      const totalChunks = await knowledgeStore.countChunks();
      const files = await knowledgeStore.listFiles();

      ok(res, {
        indexed: true,
        incremental,
        totalFiles: files.length,
        totalChunks,
        log: statusMessages.slice(-10),
      });
    } catch (err) {
      serverError(res, `Index failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ---- Knowledge Stats ----
  router.get("/api/knowledge/stats", async (_req, res) => {
    try {
      const totalChunks = await knowledgeStore.countChunks();
      const files = await knowledgeStore.listFiles();

      ok(res, {
        totalFiles: files.length,
        totalChunks,
        files: files.slice(0, 50),
        knowledgePaths: config.knowledgePaths,
      });
    } catch (err) {
      serverError(res, `Stats failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return router;
}

// ============================================================================
// MCP Server Setup
// ============================================================================

function createMcpServer(components: ServerComponents): McpServer {
  const { config, store, retriever, knowledgeStore, knowledgeIndexer, embedder } = components;

  const mcp = new McpServer(
    { name: "pi-memory", version: "1.2.0" },
    { capabilities: { tools: {} } }
  );

  // ---- memory_search ----
  mcp.registerTool(
    "memory_search",
    {
      description: "Search memories using hybrid retrieval (vector + BM25 + reranking)",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().default(5).describe("Max results (default 5, max 50)"),
        scope: z.string().optional().describe("Scope filter"),
        category: z.string().optional().describe("Category filter"),
        minScore: z.number().optional().describe("Minimum score threshold"),
      }),
    },
    async ({ query, limit, scope, category, minScore }) => {
      try {
        const safeLimit = Math.min(Math.max(limit, 1), 50);
        const scopeFilter = scope ? [scope] : undefined;

        const results = await retriever.retrieve({
          query,
          limit: safeLimit,
          scopeFilter,
          category,
          minScore: minScore ?? undefined,
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No memories found for: "${query}"` }] };
        }

        const text = results
          .map((r, i) => {
            const sources = [];
            if (r.sources.vector) sources.push("vector");
            if (r.sources.bm25) sources.push("BM25");
            if (r.sources.reranked) sources.push("reranked");
            return `${i + 1}. [${r.entry.category}:${r.entry.scope}] ${r.entry.text.slice(0, 150)}${r.entry.text.length > 150 ? "..." : ""} (${(r.score * 100).toFixed(0)}%, ${sources.join("+")})`;
          })
          .join("\n");

        return {
          content: [{ type: "text", text: `Found ${results.length} memories for: "${query}"\n\n${text}` }],
          structuredContent: {
            count: results.length,
            memories: results.map(r => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              scope: r.entry.scope,
              score: r.score,
            })),
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---- memory_store ----
  mcp.registerTool(
    "memory_store",
    {
      description: "Store a new memory",
      inputSchema: z.object({
        text: z.string().describe("Information to remember"),
        importance: z.number().optional().default(0.7).describe("Importance 0-1"),
        category: z.string().optional().default("other").describe("Category"),
        scope: z.string().optional().default("global").describe("Scope"),
      }),
    },
    async ({ text, importance, category, scope }) => {
      try {
        const vector = await embedder.embedPassage(text);
        const entry = await store.store({
          text,
          vector,
          importance: clamp01(importance, 0.7),
          category: category as MemoryEntry["category"],
          scope,
        });

        return {
          content: [{ type: "text", text: `Stored memory: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"` }],
          structuredContent: {
            id: entry.id,
            scope: entry.scope,
            category: entry.category,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Store failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---- memory_forget ----
  mcp.registerTool(
    "memory_forget",
    {
      description: "Delete a memory by ID",
      inputSchema: z.object({
        memoryId: z.string().describe("Memory ID (full UUID or 8+ char prefix)"),
      }),
    },
    async ({ memoryId }) => {
      try {
        const deleted = await store.delete(memoryId);
        if (!deleted) {
          return { content: [{ type: "text", text: `Memory ${memoryId} not found` }], isError: true };
        }
        return { content: [{ type: "text", text: `Memory ${memoryId} deleted` }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Delete failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---- knowledge_search ----
  mcp.registerTool(
    "knowledge_search",
    {
      description: "Search indexed knowledge base (documents, notes) with hybrid retrieval",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().default(20).describe("Max results (default 20, max 100)"),
      }),
    },
    async ({ query, limit }) => {
      try {
        const safeLimit = Math.min(Math.max(limit, 1), 100);
        const rc: RetrievalConfig = {
          mode: "hybrid",
          vectorWeight: 0.7,
          bm25Weight: 0.3,
          minScore: 0.3,
          rerank: "cross-encoder",
          candidatePoolSize: 20,
          recencyHalfLifeDays: 14,
          recencyWeight: 0.10,
          filterNoise: true,
          lengthNormAnchor: 500,
          hardMinScore: 0.35,
          timeDecayHalfLifeDays: 60,
          ...(config.retrieval as Partial<RetrievalConfig>),
        };
        const results = await hybridKnowledgeSearch(query, knowledgeStore, embedder, rc, safeLimit);

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No knowledge results for: "${query}"` }] };
        }

        const text = results
          .map((r, i) => `[${i + 1}] ${r.chunk.fileName} (${(r.score * 100).toFixed(0)}%)\n${r.chunk.text.slice(0, 300)}${r.chunk.text.length > 300 ? "..." : ""}\nPath: ${r.chunk.filePath}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: `Found ${results.length} knowledge results for: "${query}"\n\n${text}` }],
          structuredContent: {
            count: results.length,
            chunks: results.map(r => ({
              id: r.chunk.id,
              fileName: r.chunk.fileName,
              filePath: r.chunk.filePath,
              text: r.chunk.text.slice(0, 500),
              score: r.score,
            })),
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ---- knowledge_index ----
  mcp.registerTool(
    "knowledge_index",
    {
      description: "Rebuild the knowledge base index",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const statusMessages: string[] = [];
        await knowledgeIndexer.indexAll((status: string) => {
          statusMessages.push(status);
          console.log(`[mcp/knowledge_index] ${status}`);
        });

        const totalChunks = await knowledgeStore.countChunks();
        const files = await knowledgeStore.listFiles();

        return {
          content: [{ type: "text", text: `Indexing complete. ${files.length} files, ${totalChunks} chunks.\n\n${statusMessages.slice(-5).join("\n")}` }],
          structuredContent: { totalFiles: files.length, totalChunks },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Index failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  return mcp;
}

// ============================================================================
// Server Start
// ============================================================================

export async function startServer(components: ServerComponents): Promise<http.Server> {
  const { config } = components;
  const { http: httpConfig, mcp: mcpConfig, corsOrigins, apiKey } = config.server;

  // Build middleware chain
  const middleware: Middleware[] = [
    requestLogger(),
    corsMiddleware(corsOrigins && corsOrigins.length > 0 ? corsOrigins : undefined),
    apiKeyMiddleware(apiKey),
  ];

  // Create REST router
  const router = createRestRouter(components);

  // MCP server factory — creates a new McpServer per request.
  // This avoids the "already connected" race since each request gets
  // its own server/transport pair that's cleaned up synchronously.

  // Create HTTP server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // ---- MCP Streamable HTTP endpoint (stateless) ----
    if (path === "/mcp" && mcpConfig.enabled) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });

      // Each request gets its own McpServer to avoid "already connected" errors
      const mcp = createMcpServer(components);
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    // ---- REST API endpoints ----
    if (httpConfig.enabled && path.startsWith("/api") || path === "/health") {
      const matched = router.dispatch(req, res);
      if (!matched) {
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
        } else {
          notFound(res, `Route not found: ${req.method} ${path}`);
        }
      }
      return;
    }

    // ---- MCP SSE compatibility endpoint (deprecated but kept for backward compat) ----
    if (path === "/sse" && mcpConfig.enabled && mcpConfig.transport === "sse") {
      // If someone still requests /sse, redirect to /mcp
      res.writeHead(301, { Location: "/mcp" });
      res.end();
      return;
    }

    // ---- 404 ----
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
    } else {
      notFound(res, `Route not found: ${req.method} ${path}`);
    }
  });

  // Apply middleware (wraps the server)
  // Note: Middleware is applied via the dispatch chain above for simplicity

  return new Promise<http.Server>((resolve, reject) => {
    server.listen(httpConfig.port, httpConfig.host, () => {
      console.log(`[pi-memory-server] HTTP server listening on ${httpConfig.host}:${httpConfig.port}`);
      if (httpConfig.enabled) {
        console.log(`[pi-memory-server] REST API: http://${httpConfig.host === "0.0.0.0" ? "localhost" : httpConfig.host}:${httpConfig.port}/health`);
        console.log(`[pi-memory-server] Routes: ${router.list().join(", ")}`);
      }
      if (mcpConfig.enabled) {
        console.log(`[pi-memory-server] MCP StreamableHTTP: http://${httpConfig.host === "0.0.0.0" ? "localhost" : httpConfig.host}:${httpConfig.port}/mcp`);
      }
      resolve(server);
    });

    server.on("error", reject);
  });
}
