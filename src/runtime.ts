/**
 * Memory Runtime Provider
 * Implements MemoryPluginRuntime and MemorySearchManager for OpenClaw integration
 *
 * When slots.memory = "pi-memory", this runtime becomes the active memory provider.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { MemoryRetriever } from "./retriever.js";
import type { MemoryStore } from "./store.js";
import type { Embedder } from "./embedder.js";
import type { MemoryScopeManager } from "./scopes.js";

// ============================================================================
// Types (matching OpenClaw's MemorySearchManager interface)
// ============================================================================

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
  citation?: string;
}

export interface MemoryReadResult {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
}

export interface MemoryProviderStatus {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  sources?: Array<"memory" | "sessions">;
  sourceCounts?: Array<{ source: "memory" | "sessions"; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  vector?: { enabled: boolean; available?: boolean; dims?: number };
  fallback?: { from: string; reason?: string };
  custom?: Record<string, unknown>;
}

export interface MemoryEmbeddingProbeResult {
  ok: boolean;
  error?: string;
}

export interface MemorySyncProgressUpdate {
  completed: number;
  total: number;
  label?: string;
}

export interface MemorySearchManager {
  search(query: string, opts?: {
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
    onDebug?: (debug: MemorySearchRuntimeDebug) => void;
  }): Promise<MemorySearchResult[]>;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}

export interface MemorySearchRuntimeDebug {
  backend: "builtin" | "qmd";
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
}

export interface MemoryPluginRuntime {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<{ manager: MemorySearchManager | null; error?: string }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): { backend: "builtin" } | { backend: "qmd"; qmd?: { command?: string } };
  closeAllMemorySearchManagers?(): Promise<void>;
}

// ============================================================================
// LanceDB Memory Search Manager
// ============================================================================

export class LanceDBMemorySearchManager implements MemorySearchManager {
  private retriever: MemoryRetriever;
  private store: MemoryStore;
  private embedder: Embedder;
  private scopeManager: MemoryScopeManager;
  private agentId: string;
  private dbPath: string;

  constructor(params: {
    retriever: MemoryRetriever;
    store: MemoryStore;
    embedder: Embedder;
    scopeManager: MemoryScopeManager;
    agentId: string;
    dbPath: string;
  }) {
    this.retriever = params.retriever;
    this.store = params.store;
    this.embedder = params.embedder;
    this.scopeManager = params.scopeManager;
    this.agentId = params.agentId;
    this.dbPath = params.dbPath;
  }

  async search(query: string, opts?: {
    maxResults?: number;
    minScore?: number;
    onDebug?: (debug: MemorySearchRuntimeDebug) => void;
  }): Promise<MemorySearchResult[]> {
    const maxResults = opts?.maxResults ?? 10;
    const minScore = opts?.minScore ?? 0.3;

    // Report debug info
    if (opts?.onDebug) {
      opts.onDebug({
        backend: "builtin",
        configuredMode: this.retriever.getConfig().mode,
        effectiveMode: this.retriever.getConfig().mode,
      });
    }

    // Determine accessible scopes
    const scopeFilter = this.scopeManager.getAccessibleScopes(this.agentId);

    // Perform hybrid search
    const results = await this.retriever.retrieve({
      query,
      limit: maxResults,
      minScore,
      scopeFilter,
    });

    // Convert to OpenClaw MemorySearchResult format
    return results.map(r => ({
      path: `memory/${r.entry.id.slice(0, 8)}.md`,
      startLine: 1,
      endLine: Math.ceil(r.entry.text.length / 60),
      score: r.score,
      snippet: r.entry.text.slice(0, 200),
      source: "memory" as const,
      citation: `memory/${r.entry.id.slice(0, 8)}.md#L1`,
    }));
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult> {
    const from = params.from ?? 1;
    const lines = params.lines ?? 200;

    // Extract memory ID from path
    let memoryId = params.relPath;
    const match = params.relPath.match(/memory\/([0-9a-f-]+)\.md$/i);
    if (match) {
      memoryId = match[1];
    }

    // Determine accessible scopes
    const scopeFilter = this.scopeManager.getAccessibleScopes(this.agentId);

    // Find the memory by ID
    const allMemories = await this.store.list(scopeFilter, undefined, 1000, 0);
    const matching = allMemories.filter(m =>
      m.id === memoryId ||
      m.id.startsWith(memoryId) ||
      m.id.slice(0, 8) === memoryId
    );

    if (matching.length === 0) {
      throw new Error(`Memory not found: ${params.relPath}`);
    }

    const memory = matching[0];

    // Split content into lines for slicing
    const contentLines = memory.text.split(/\r?\n/);
    const totalLines = contentLines.length;
    const contentSlice = contentLines.slice(from - 1, from - 1 + lines).join("\n");
    const truncated = from - 1 + lines < totalLines;
    const nextFrom = truncated ? from + lines : undefined;

    return {
      text: contentSlice,
      path: params.relPath,
      truncated,
      from,
      lines,
      nextFrom,
    };
  }

  status(): MemoryProviderStatus {
    const config = this.retriever.getConfig();
    return {
      backend: "builtin",
      provider: "lancedb-pro",
      model: config.mode,
      requestedProvider: "lancedb-pro",
      files: 0, // LanceDB doesn't use files
      chunks: 0, // Will be updated when store.stats() is called
      dirty: false,
      dbPath: this.dbPath,
      sources: ["memory"],
      sourceCounts: [{ source: "memory", files: 0, chunks: 0 }],
      cache: { enabled: false },
      fts: { enabled: this.store.hasFtsSupport, available: this.store.hasFtsSupport },
      vector: { enabled: true, available: true },
      custom: {
        storeType: "lancedb",
        retrievalMode: config.mode,
        hasReranker: config.rerank !== "none",
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    // LanceDB doesn't need file sync, but we can update status
    if (params?.progress) {
      params.progress({ completed: 1, total: 1, label: "LanceDB sync (no files)" });
    }
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const testResult = await this.embedder.test();
      return { ok: testResult.success, error: testResult.error };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    // LanceDB always has vector search available
    return true;
  }

  async close(): Promise<void> {
    // LanceDB handles connection cleanup internally
  }
}

// ============================================================================
// LanceDB Memory Runtime Provider
// ============================================================================

export function createLanceDBMemoryRuntime(params: {
  retriever: MemoryRetriever;
  store: MemoryStore;
  embedder: Embedder;
  scopeManager: MemoryScopeManager;
  dbPath: string;
}): MemoryPluginRuntime {
  const managers = new Map<string, LanceDBMemorySearchManager>();

  return {
    async getMemorySearchManager(opts: {
      cfg: OpenClawConfig;
      agentId: string;
      purpose?: "default" | "status";
    }) {
      try {
        // Create or reuse manager for this agent
        const key = opts.agentId;
        let manager = managers.get(key);

        if (!manager) {
          manager = new LanceDBMemorySearchManager({
            retriever: params.retriever,
            store: params.store,
            embedder: params.embedder,
            scopeManager: params.scopeManager,
            agentId: opts.agentId,
            dbPath: params.dbPath,
          });
          managers.set(key, manager);
        }

        return { manager };
      } catch (error) {
        return { manager: null, error: String(error) };
      }
    },

    resolveMemoryBackendConfig(opts: {
      cfg: OpenClawConfig;
      agentId: string;
    }) {
      // LanceDB is always "builtin" backend
      return { backend: "builtin" };
    },

    async closeAllMemorySearchManagers() {
      for (const manager of managers.values()) {
        await manager.close?.();
      }
      managers.clear();
    },
  };
}