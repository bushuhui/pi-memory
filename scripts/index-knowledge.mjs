#!/usr/bin/env node
/**
 * Knowledge Base Indexer CLI
 * Usage: node scripts/index-knowledge.mjs
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// Read config from openclaw.json
const configPath = join(homedir(), ".openclaw", "openclaw.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));

const extraPaths = config?.agents?.defaults?.memorySearch?.extraPaths || [];
const dbPath = join(homedir(), ".openclaw", "memory", "lancedb-pro");

console.log(`[index-knowledge] Starting indexer...`);
console.log(`[index-knowledge] DB path: ${dbPath}`);
console.log(`[index-knowledge] Knowledge paths: ${extraPaths.join(", ")}`);

// Dynamic import to avoid ESM/CJS issues
const { KnowledgeStore } = await import("../src/knowledge-store.js");
const { KnowledgeIndexer } = await import("../src/knowledge-indexer.js");
const { createEmbedder } = await import("../src/embedder.js");

// Read embedding config from plugin config
const pluginConfigPath = join(
  homedir(),
  ".openclaw",
  "extensions",
  "memory-lancedb-pro",
  "openclaw.plugin.json"
);
const pluginConfig = JSON.parse(readFileSync(pluginConfigPath, "utf-8"));
const embeddingConfig = pluginConfig.config?.embedding;

if (!embeddingConfig) {
  console.error("[index-knowledge] No embedding config found in openclaw.plugin.json");
  process.exit(1);
}

// Create embedder
const embedder = createEmbedder(embeddingConfig);

// Determine vector dimensions
const vectorDim = embeddingConfig.dimensions || 1536;

// Initialize store and indexer
const store = new KnowledgeStore(dbPath, vectorDim);
await store.init();

const indexer = new KnowledgeIndexer(store, embedder, extraPaths);

// Run indexing
console.log(`[index-knowledge] Indexing started...`);
await indexer.indexAll((status) => {
  console.log(`  ${status}`);
});

console.log(`[index-knowledge] Done!`);
