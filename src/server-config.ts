/**
 * Server Configuration
 * Loads config from openclaw.json, environment variables, and CLI args.
 * Priority: CLI args > env vars > openclaw.json > defaults
 */

import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface ServerHttpConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface ServerMcpConfig {
  enabled: boolean;
  transport: "sse" | "stdio";
}

export interface ServerConfig {
  embedding: {
    provider: "openai-compatible";
    apiKey: string;
    model: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
  };
  dbPath: string;
  retrieval: Record<string, unknown>;
  knowledgePaths: string[];
  scopes: Record<string, unknown>;
  enableManagementTools: boolean;
  autoCapture: boolean;
  autoRecall: boolean;
  server: {
    http: ServerHttpConfig;
    mcp: ServerMcpConfig;
    apiKey?: string;
    corsOrigins?: string[];
  };
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS: ServerConfig = {
  embedding: {
    provider: "openai-compatible",
    apiKey: "",
    model: "unsloth/Qwen3-Embedding-0.6B",
    dimensions: 1024,
  },
  dbPath: join(homedir(), ".openclaw", "memory", "pi-memory"),
  retrieval: {},
  knowledgePaths: [],
  scopes: {},
  enableManagementTools: false,
  autoCapture: true,
  autoRecall: true,
  server: {
    http: {
      enabled: true,
      host: "0.0.0.0",
      port: 9873,
    },
    mcp: {
      enabled: true,
      transport: "sse",
    },
    corsOrigins: [],
  },
};

// ============================================================================
// Helpers
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    return process.env[envVar] || `\${${envVar}}`;
  });
}

function resolveEnvInObject(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "string") {
      obj[key] = resolveEnvVars(val) as any;
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      resolveEnvInObject(val as Record<string, unknown>);
    }
  }
}

function getEnv(key: string): string | undefined {
  return process.env[key];
}

function parseEnvInt(key: string, fallback: number): number {
  const v = getEnv(key);
  if (v) {
    const n = parseInt(v, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

function parseEnvBool(key: string, fallback: boolean): boolean {
  const v = getEnv(key);
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

// ============================================================================
// Config Loading
// ============================================================================

function loadOpenclawConfig(): Record<string, unknown> {
  try {
    const path = join(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return (raw.plugins as any)?.entries?.["pi-memory"]?.config ?? {};
  } catch {
    return {};
  }
}

function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (srcVal && typeof srcVal === "object" && !Array.isArray(srcVal) && tgtVal && typeof tgtVal === "object" && !Array.isArray(tgtVal)) {
      result[key] = mergeDeep(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

export function loadServerConfig(cliOverrides?: Partial<ServerConfig>): ServerConfig {
  // Layer 1: defaults
  const config = JSON.parse(JSON.stringify(DEFAULTS)) as ServerConfig;

  // Layer 2: openclaw.json
  const openclawCfg = loadOpenclawConfig();
  if (Object.keys(openclawCfg).length > 0) {
    resolveEnvInObject(openclawCfg);
    // Merge but don't override server-specific defaults from CLI
    const { server: _, ...rest } = openclawCfg as any;
    Object.assign(config, mergeDeep(config, rest));
    // Server section from openclaw.json
    if ((openclawCfg as any).server) {
      config.server = mergeDeep(config.server, (openclawCfg as any).server);
    }
  }

  // Layer 3: environment variables
  const envApiKey = getEnv("PI_MEMORY_EMBED_API_KEY");
  if (envApiKey) config.embedding.apiKey = envApiKey;

  const envBaseURL = getEnv("PI_MEMORY_EMBED_BASE_URL");
  if (envBaseURL) config.embedding.baseURL = envBaseURL;

  const envModel = getEnv("PI_MEMORY_EMBED_MODEL");
  if (envModel) config.embedding.model = envModel;

  const envDims = getEnv("PI_MEMORY_EMBED_DIMENSIONS");
  if (envDims) config.embedding.dimensions = parseInt(envDims, 10);

  const envDbPath = getEnv("PI_MEMORY_DB_PATH");
  if (envDbPath) config.dbPath = envDbPath;

  const envServerApiKey = getEnv("PI_MEMORY_API_KEY");
  if (envServerApiKey) config.server.apiKey = envServerApiKey;

  config.server.http.host = getEnv("PI_MEMORY_HTTP_HOST") || config.server.http.host;
  config.server.http.port = parseEnvInt("PI_MEMORY_HTTP_PORT", config.server.http.port);

  const envKnowledgePaths = getEnv("PI_MEMORY_KNOWLEDGE_PATHS");
  if (envKnowledgePaths) {
    try {
      const parsed = JSON.parse(envKnowledgePaths);
      if (Array.isArray(parsed)) config.knowledgePaths = parsed;
    } catch {}
  }

  const envRerankApiKey = getEnv("PI_MEMORY_RERANK_API_KEY");
  if (envRerankApiKey) {
    config.retrieval = config.retrieval || {};
    (config.retrieval as Record<string, unknown>).rerankApiKey = envRerankApiKey;
  }

  const envRerankProvider = getEnv("PI_MEMORY_RERANK_PROVIDER");
  if (envRerankProvider) {
    config.retrieval = config.retrieval || {};
    (config.retrieval as Record<string, unknown>).rerankProvider = envRerankProvider;
  }

  const envRerankModel = getEnv("PI_MEMORY_RERANK_MODEL");
  if (envRerankModel) {
    config.retrieval = config.retrieval || {};
    (config.retrieval as Record<string, unknown>).rerankModel = envRerankModel;
  }

  const envRerankEndpoint = getEnv("PI_MEMORY_RERANK_ENDPOINT");
  if (envRerankEndpoint) {
    config.retrieval = config.retrieval || {};
    (config.retrieval as Record<string, unknown>).rerankEndpoint = envRerankEndpoint;
  }

  // Layer 4: CLI overrides
  if (cliOverrides) {
    if (cliOverrides.server?.http) {
      if (cliOverrides.server.http.enabled !== undefined) config.server.http.enabled = cliOverrides.server.http.enabled;
      if (cliOverrides.server.http.host) config.server.http.host = cliOverrides.server.http.host;
      if (cliOverrides.server.http.port) config.server.http.port = cliOverrides.server.http.port;
    }
    if (cliOverrides.server?.mcp) {
      if (cliOverrides.server.mcp.enabled !== undefined) config.server.mcp.enabled = cliOverrides.server.mcp.enabled;
      if (cliOverrides.server.mcp.transport) config.server.mcp.transport = cliOverrides.server.mcp.transport;
    }
    if (cliOverrides.server?.apiKey !== undefined) config.server.apiKey = cliOverrides.server.apiKey;
  }

  // Normalize dbPath
  if (config.dbPath.startsWith("~")) {
    config.dbPath = join(homedir(), config.dbPath.slice(1));
  }

  return config;
}
