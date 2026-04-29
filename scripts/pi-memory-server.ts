#!/usr/bin/env node
/**
 * pi-memory-server CLI
 * Standalone server for pi-memory HTTP API + MCP.
 *
 * Usage:
 *   pi-memory-server                          # Start with defaults
 *   pi-memory-server --port 9873 --host 0.0.0.0
 *   pi-memory-server --no-mcp                 # REST API only
 *   pi-memory-server --no-http                # MCP only
 *   pi-memory-server --api-key secret         # Require API key
 *   pi-memory-server --help                   # Show help
 */

import { parseArgs } from "node:util";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const { values, positionals } = parseArgs({
  options: {
    port: { type: "string", short: "p" },
    host: { type: "string", short: "h" },
    "api-key": { type: "string" },
    "no-http": { type: "boolean" },
    "no-mcp": { type: "boolean" },
    transport: { type: "string" },
    help: { type: "boolean", short: "H" },
    version: { type: "boolean", short: "v" },
  },
  allowPositionals: true,
});

if (values.version) {
  console.log("pi-memory-server v1.2.0");
  process.exit(0);
}

if (values.help) {
  console.log(`
pi-memory-server v1.2.0

Usage: pi-memory-server [options]

Options:
  -p, --port <port>       HTTP server port (default: 9873)
  -h, --host <host>       HTTP server host (default: 0.0.0.0)
  --api-key <key>         Require API key for all requests
  --no-http               Disable HTTP REST API (MCP only)
  --no-mcp                Disable MCP server (REST API only)
  --transport <transport> MCP transport: streamable-http (default)
  -H, --help              Show this help message
  -v, --version           Show version

Environment Variables:
  PI_MEMORY_EMBED_API_KEY     Embedding API key
  PI_MEMORY_EMBED_BASE_URL    Embedding API base URL
  PI_MEMORY_EMBED_MODEL       Embedding model name
  PI_MEMORY_EMBED_DIMENSIONS  Embedding dimensions
  PI_MEMORY_DB_PATH           Database path
  PI_MEMORY_API_KEY           Server API key
  PI_MEMORY_HTTP_HOST         HTTP host
  PI_MEMORY_HTTP_PORT         HTTP port
  PI_MEMORY_KNOWLEDGE_PATHS   JSON array of knowledge paths
  PI_MEMORY_RERANK_API_KEY    Reranker API key
  PI_MEMORY_RERANK_MODEL      Reranker model
  PI_MEMORY_RERANK_ENDPOINT   Reranker endpoint
  PI_MEMORY_RERANK_PROVIDER   Reranker provider (jina/siliconflow/pinecone)

Config is loaded from ~/.openclaw/openclaw.json (plugins.entries["pi-memory"].config)
Priority: CLI args > env vars > openclaw.json > defaults
`);
  process.exit(0);
}

// ============================================================================
// Build CLI Overrides
// ============================================================================

const cliOverrides: Record<string, unknown> = {};

if (values.port) {
  cliOverrides.server = cliOverrides.server || {};
  cliOverrides.server.http = { port: parseInt(values.port as string, 10) };
}

if (values.host) {
  cliOverrides.server = cliOverrides.server || {};
  cliOverrides.server.http = cliOverrides.server.http || {};
  cliOverrides.server.http.host = values.host;
}

if (values["api-key"]) {
  cliOverrides.server = cliOverrides.server || {};
  cliOverrides.server.apiKey = values["api-key"];
}

if (values["no-http"]) {
  cliOverrides.server = cliOverrides.server || {};
  cliOverrides.server.http = cliOverrides.server.http || {};
  cliOverrides.server.http.enabled = false;
}

if (values["no-mcp"]) {
  cliOverrides.server = cliOverrides.server || {};
  cliOverrides.server.mcp = { enabled: false };
}

// ============================================================================
// Start Server
// ============================================================================

async function main() {
  try {
    const { bootstrap } = await import("../src/server-bootstrap.js");
    const { server } = await bootstrap(cliOverrides as any);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n[pi-memory-server] ${signal} received, shutting down...`);
      server.close(() => {
        console.log("[pi-memory-server] Server closed");
        process.exit(0);
      });
      // Force exit after 5 seconds
      setTimeout(() => process.exit(1), 5000);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    console.error("[pi-memory-server] Failed to start:", err);
    process.exit(1);
  }
}

main();
