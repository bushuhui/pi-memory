/**
 * Knowledge Base Tools Registration
 * Provides knowledge_search, knowledge_index, knowledge_stats tools
 * 
 * Search uses hybrid retrieval: vector + BM25 + RRF fusion + cross-encoder reranking
 * (same pipeline as memory_recall)
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { KnowledgeStore, KnowledgeSearchResult } from "./knowledge-store.js";
import type { KnowledgeIndexer } from "./knowledge-indexer.js";
import type { Embedder } from "./embedder.js";
import type { RetrievalConfig } from "./retriever.js";
import { DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";

// ============================================================================
// Types
// ============================================================================

interface KnowledgeToolsContext {
  store: KnowledgeStore;
  indexer: KnowledgeIndexer;
  embedder: Embedder;
  retrievalConfig?: Partial<RetrievalConfig>;
}

interface ScoredChunk {
  chunk: KnowledgeSearchResult["chunk"];
  score: number;
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
}

// ============================================================================
// Reranker (shared with retriever.ts pattern)
// ============================================================================

type RerankProvider = "jina" | "siliconflow" | "pinecone";
interface RerankItem { index: number; score: number }

function buildRerankRequest(
  provider: RerankProvider, apiKey: string, model: string,
  query: string, documents: string[], topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "pinecone":
      return {
        headers: { "Content-Type": "application/json", "Api-Key": apiKey, "X-Pinecone-API-Version": "2024-10" },
        body: { model, query, documents: documents.map(text => ({ text })), top_n: topN, rank_fields: ["text"] },
      };
    case "siliconflow":
    case "jina":
    default:
      return {
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: { model, query, documents, top_n: topN },
      };
  }
}

function parseRerankResponse(provider: RerankProvider, data: Record<string, unknown>): RerankItem[] | null {
  switch (provider) {
    case "pinecone": {
      const items = data.data as Array<{ index: number; score: number }> | undefined;
      return Array.isArray(items) ? items.map(r => ({ index: r.index, score: r.score })) : null;
    }
    case "siliconflow":
    case "jina":
    default: {
      const items = data.results as Array<{ index: number; relevance_score: number }> | undefined;
      return Array.isArray(items) ? items.map(r => ({ index: r.index, score: r.relevance_score })) : null;
    }
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm === 0 ? 0 : dot / norm;
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

// ============================================================================
// Hybrid Search Pipeline
// ============================================================================

async function hybridKnowledgeSearch(
  query: string,
  store: KnowledgeStore,
  embedder: Embedder,
  config: RetrievalConfig,
  limit: number,
): Promise<ScoredChunk[]> {
  const candidatePoolSize = Math.max(config.candidatePoolSize, limit * 3);

  // 1. Query embedding (reused for vector search + fallback reranking)
  const queryVector = await embedder.embedQuery(query);

  // 2. Parallel vector + BM25 search
  const [vectorResults, bm25Results] = await Promise.all([
    store.vectorSearch(queryVector, candidatePoolSize),
    store.ftsSearch(query, candidatePoolSize),
  ]);

  // 3. Build maps for RRF fusion
  const vectorMap = new Map<string, KnowledgeSearchResult & { rank: number }>();
  vectorResults.forEach((r, i) => vectorMap.set(r.chunk.id, { ...r, rank: i + 1 }));

  const bm25Map = new Map<string, { chunk: KnowledgeSearchResult["chunk"]; score: number; rank: number }>();
  bm25Results.forEach((r, i) => bm25Map.set(r.chunk.id, {
    chunk: r.chunk, score: r.score, rank: i + 1,
  }));

  // 4. RRF Fusion
  const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);
  const fused: ScoredChunk[] = [];

  for (const id of allIds) {
    const vecResult = vectorMap.get(id);
    const bm25Result = bm25Map.get(id);
    const baseChunk = vecResult?.chunk ?? bm25Result!.chunk;

    // Vector score is distance-based (lower = better), already normalized by LanceDB
    const vectorScore = vecResult ? vecResult.score : 0;
    const bm25Hit = bm25Result ? 1 : 0;

    // Base = vector score; BM25 hit boosts by up to 15%
    // BM25-only results use rank-based score (floor 0.5) for keyword-exact matches
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

  // 5. Min score filter
  const filtered = fused.filter(r => r.score >= config.minScore);

  // 6. Reranking
  const toRerank = filtered.slice(0, limit * 3);
  const reranked = await rerankKnowledgeResults(query, queryVector, toRerank, config);

  // 7. Length normalization (knowledge chunks are ~1000 chars, anchor accordingly)
  const lengthAnchor = config.lengthNormAnchor || 500;
  const lengthNormed = lengthAnchor > 0 ? reranked.map(r => {
    const ratio = r.chunk.text.length / lengthAnchor;
    const logRatio = Math.log2(Math.max(ratio, 1));
    const factor = 1 / (1 + 0.5 * logRatio);
    return { ...r, score: clamp01(r.score * factor, r.score * 0.3) };
  }) : reranked;

  lengthNormed.sort((a, b) => b.score - a.score);

  // 8. Hard min score cutoff
  const hardFiltered = lengthNormed.filter(r => r.score >= (config.hardMinScore || 0.35));

  // 9. MMR diversity (deduplicate near-identical chunks)
  const diverse = applyMMRDiversity(hardFiltered, 0.85);

  return diverse.slice(0, limit);
}

async function rerankKnowledgeResults(
  query: string, queryVector: number[],
  results: ScoredChunk[], config: RetrievalConfig,
): Promise<ScoredChunk[]> {
  if (results.length === 0) return results;

  // Cross-encoder reranking via API
  if (config.rerank === "cross-encoder" && config.rerankApiKey) {
    try {
      const provider = config.rerankProvider || "jina";
      const model = config.rerankModel || "jina-reranker-v2-base-multilingual";
      const endpoint = config.rerankEndpoint || "https://api.jina.ai/v1/rerank";
      const documents = results.map(r => r.chunk.text);

      const { headers, body } = buildRerankRequest(provider, config.rerankApiKey, model, query, documents, results.length);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(endpoint, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        const parsed = parseRerankResponse(provider, data);

        if (parsed) {
          const returnedIndices = new Set(parsed.map(r => r.index));
          const reranked = parsed
            .filter(item => item.index >= 0 && item.index < results.length)
            .map(item => {
              const original = results[item.index];
              // Blend: 60% cross-encoder + 40% original fused
              const blendedScore = clamp01(item.score * 0.6 + original.score * 0.4, original.score * 0.5);
              return {
                ...original,
                score: blendedScore,
                sources: { ...original.sources, reranked: { score: item.score } },
              };
            });

          const unreturned = results
            .filter((_, idx) => !returnedIndices.has(idx))
            .map(r => ({ ...r, score: r.score * 0.8 }));

          return [...reranked, ...unreturned].sort((a, b) => b.score - a.score);
        }
      } else {
        const errText = await response.text().catch(() => "");
        console.warn(`[knowledge-search] rerank API ${response.status}: ${errText.slice(0, 200)}, falling back`);
      }
    } catch (error: any) {
      const msg = error?.name === "AbortError" ? "timed out (5s)" : String(error);
      console.warn(`[knowledge-search] rerank failed: ${msg}, falling back to cosine`);
    }
  }

  // Fallback: cosine similarity reranking
  try {
    const reranked = results.map(result => {
      const vec = result.chunk.vector;
      if (!vec?.length) return result;
      const arr = Array.from(vec as Iterable<number>);
      const cosineScore = cosineSimilarity(queryVector, arr);
      const combinedScore = (result.score * 0.7) + (cosineScore * 0.3);
      return {
        ...result,
        score: clamp01(combinedScore, result.score),
        sources: { ...result.sources, reranked: { score: cosineScore } },
      };
    });
    return reranked.sort((a, b) => b.score - a.score);
  } catch {
    return results;
  }
}

function applyMMRDiversity(results: ScoredChunk[], threshold = 0.85): ScoredChunk[] {
  if (results.length <= 1) return results;
  const selected: ScoredChunk[] = [];
  const deferred: ScoredChunk[] = [];

  for (const candidate of results) {
    const tooSimilar = selected.some(s => {
      const sVec = s.chunk.vector;
      const cVec = candidate.chunk.vector;
      if (!sVec?.length || !cVec?.length) return false;
      const sArr = Array.from(sVec as Iterable<number>);
      const cArr = Array.from(cVec as Iterable<number>);
      return cosineSimilarity(sArr, cArr) > threshold;
    });
    (tooSimilar ? deferred : selected).push(candidate);
  }
  return [...selected, ...deferred];
}

export { hybridKnowledgeSearch };

export function registerAllKnowledgeTools(
  api: OpenClawPluginApi,
  ctx: KnowledgeToolsContext
): void {
  // Merge with defaults
  const retrievalConfig: RetrievalConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...ctx.retrievalConfig,
  };

  // ==========================================================================
  // knowledge_search — Hybrid retrieval (vector + BM25 + reranker)
  // ==========================================================================

  api.registerTool({
    name: "knowledge_search",
    label: "Knowledge Search",
    description:
      "Search the indexed knowledge base (Obsidian vault, documentation, etc.) using hybrid retrieval: " +
      "vector similarity + BM25 keyword search + cross-encoder reranking. Returns relevant text chunks with file paths and scores.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (natural language or keywords)" }),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 5, max: 20)" })),
    }),
    async execute(_toolCallId: string, params: { query: string; limit?: number }) {
      try {
        const limit = Math.min(Math.max(params.limit || 5, 1), 20);

        const results = await hybridKnowledgeSearch(
          params.query, ctx.store, ctx.embedder, retrievalConfig, limit
        );

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No results found for query: "${params.query}"` }],
          };
        }

        const formatted = results
          .map((r, idx) => {
            const sources: string[] = [];
            if (r.sources.vector) sources.push("vector");
            if (r.sources.bm25) sources.push("BM25");
            if (r.sources.reranked) sources.push("reranked");

            return [
              `[${idx + 1}] ${r.chunk.fileName} (chunk ${r.chunk.chunkIndex})`,
              `Path: ${r.chunk.filePath}`,
              `Score: ${(r.score * 100).toFixed(0)}% (${sources.join("+")})`,
              `---`,
              r.chunk.text.slice(0, 500) + (r.chunk.text.length > 500 ? "..." : ""),
              "",
            ].join("\n");
          })
          .join("\n");

        return {
          content: [{ type: "text" as const, text: `Found ${results.length} results for: "${params.query}"\n\n${formatted}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error searching knowledge base: ${err}` }],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // knowledge_index — Rebuild index
  // ==========================================================================

  api.registerTool({
    name: "knowledge_index",
    label: "Knowledge Index",
    description:
      "Rebuild the knowledge base index by scanning configured directories and indexing all supported files (.md, .txt, .mdx). " +
      "Supports incremental updates (skips unchanged files based on mtime + content hash). May take several minutes for large vaults.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, never>) {
      try {
        const statusMessages: string[] = [];
        await ctx.indexer.indexAll((status) => {
          statusMessages.push(status);
          console.log(`[knowledge_index] ${status}`);
        });
        const summary = statusMessages.slice(-5).join("\n");
        return {
          content: [{ type: "text" as const, text: `Knowledge base indexing complete.\n\n${summary}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error indexing knowledge base: ${err}` }],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // knowledge_stats — Statistics
  // ==========================================================================

  api.registerTool({
    name: "knowledge_stats",
    label: "Knowledge Stats",
    description: "Show statistics about the indexed knowledge base (file count, chunk count, retrieval config, etc.)",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, never>) {
      try {
        const totalChunks = await ctx.store.countChunks();
        const files = await ctx.store.listFiles();

        const fileList = files
          .slice(0, 20)
          .map((f) => `  ${f.filePath} (${f.chunkCount} chunks)`)
          .join("\n");

        const summary = [
          `Total files: ${files.length}`,
          `Total chunks: ${totalChunks}`,
          `Retrieval: ${retrievalConfig.mode} (vector ${retrievalConfig.vectorWeight} + BM25 ${retrievalConfig.bm25Weight})`,
          `Reranker: ${retrievalConfig.rerank}${retrievalConfig.rerankModel ? ` (${retrievalConfig.rerankModel})` : ""}`,
          `Min score: ${retrievalConfig.minScore} | Hard min: ${retrievalConfig.hardMinScore}`,
          ``,
          `Indexed files (top 20):`,
          fileList,
          files.length > 20 ? `  ... and ${files.length - 20} more` : "",
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: summary }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error fetching knowledge stats: ${err}` }],
          isError: true,
        };
      }
    },
  });
}
