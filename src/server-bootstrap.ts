/**
 * Server Bootstrap
 * Initializes all components and starts the unified HTTP/MCP server.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { loadServerConfig, type ServerConfig } from "./server-config.js";
import { Embedder } from "./embedder.js";
import { getVectorDimensions } from "./embedder.js";
import { MemoryStore } from "./store.js";
import { createRetriever } from "./retriever.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { KnowledgeIndexer } from "./knowledge-indexer.js";
import { startServer } from "./server.js";

export interface BootstrappedServer {
  config: ServerConfig;
  embedder: Embedder;
  store: MemoryStore;
  retriever: ReturnType<typeof createRetriever>;
  knowledgeStore: KnowledgeStore;
  knowledgeIndexer: KnowledgeIndexer;
  server: import("node:http").Server;
}

export async function bootstrap(overrides?: Partial<ServerConfig>): Promise<BootstrappedServer> {
  const config = loadServerConfig(overrides);

  console.log(`[bootstrap] Loading pi-memory server v1.2.0`);
  console.log(`[bootstrap] DB: ${config.dbPath}`);
  console.log(`[bootstrap] Embedding: ${config.embedding.model} (${config.embedding.dimensions}dims)`);
  console.log(`[bootstrap] Knowledge paths: ${config.knowledgePaths.length > 0 ? config.knowledgePaths.join(", ") : "(none)"}`);
  console.log(`[bootstrap] HTTP: ${config.server.http.enabled ? `${config.server.http.host}:${config.server.http.port}` : "disabled"}`);
  console.log(`[bootstrap] MCP: ${config.server.mcp.enabled ? `${config.server.mcp.transport} (port ${config.server.http.port})` : "disabled"}`);

  // 1. Create embedder
  const embedder = new Embedder({
    provider: config.embedding.provider,
    apiKey: config.embedding.apiKey,
    model: config.embedding.model,
    baseURL: config.embedding.baseURL,
    dimensions: config.embedding.dimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
    normalized: config.embedding.normalized,
  });

  // 2. Test embedding connection (with exponential backoff for slow-starting services)
  // Wait times: 5s, 10s, 20s, 40s, 80s, 160s (total ~315s ≈ 5 minutes)
  const maxRetries = 7;
  const baseInterval = 5000; // 5s base; actual wait = baseInterval * 2^(attempt-1)
  let embedTest: Awaited<ReturnType<Embedder["test"]>> | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    embedTest = await embedder.test();
    if (embedTest.success) break;
    if (attempt < maxRetries) {
      const waitMs = baseInterval * Math.pow(2, attempt - 1);
      console.log(`[bootstrap] Embedding not ready (attempt ${attempt}/${maxRetries}): ${embedTest.error}. Retrying in ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  if (!embedTest?.success) {
    throw new Error(`Embedding test failed after ${maxRetries} attempts: ${embedTest?.error}`);
  }
  console.log(`[bootstrap] Embedding OK (${embedTest.dimensions}d)`);

  // 3. Create memory store
  const store = new MemoryStore({
    dbPath: config.dbPath,
    vectorDim: embedder.dimensions,
  });

  // 4. Create retriever
  const retrievalConfig = config.retrieval || {};
  const retriever = createRetriever(store, embedder, retrievalConfig);

  // 5. Create knowledge store
  const knowledgeStore = new KnowledgeStore(config.dbPath, embedder.dimensions);

  // 6. Create knowledge indexer
  const knowledgeIndexer = new KnowledgeIndexer(knowledgeStore, embedder, config.knowledgePaths);

  // 7. Start HTTP/MCP server
  const server = await startServer({
    config,
    store,
    retriever,
    knowledgeStore,
    knowledgeIndexer,
    embedder,
  });

  return { config, embedder, store, retriever, knowledgeStore, knowledgeIndexer, server };
}
