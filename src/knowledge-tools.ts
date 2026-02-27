/**
 * Knowledge Base Tools Registration
 * Provides knowledge_search and knowledge_index tools
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { KnowledgeStore } from "./knowledge-store.js";
import type { KnowledgeIndexer } from "./knowledge-indexer.js";
import type { Embedder } from "./embedder.js";

interface KnowledgeToolsContext {
  store: KnowledgeStore;
  indexer: KnowledgeIndexer;
  embedder: Embedder;
}

export function registerAllKnowledgeTools(
  api: OpenClawPluginApi,
  ctx: KnowledgeToolsContext
): void {
  // ==========================================================================
  // knowledge_search - Search indexed knowledge base
  // ==========================================================================

  api.registerTool({
    name: "knowledge_search",
    description:
      "Search the indexed knowledge base (Obsidian vault, documentation, etc.) using semantic vector search. Returns relevant text chunks with file paths.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (natural language or keywords)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 5)",
          default: 5,
        },
      },
      required: ["query"],
    },
    handler: async (params: { query: string; limit?: number }) => {
      try {
        const limit = params.limit || 5;

        // Generate query embedding
        const queryVector = await ctx.embedder.embed(params.query);

        // Vector search
        const results = await ctx.store.vectorSearch(queryVector, limit);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No results found for query: "${params.query}"`,
              },
            ],
          };
        }

        // Format results
        const formatted = results
          .map((r, idx) => {
            const { chunk, score } = r;
            return [
              `[${idx + 1}] ${chunk.fileName} (chunk ${chunk.chunkIndex})`,
              `Path: ${chunk.filePath}`,
              `Score: ${score.toFixed(4)}`,
              `---`,
              chunk.text.slice(0, 500) + (chunk.text.length > 500 ? "..." : ""),
              "",
            ].join("\n");
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} results for: "${params.query}"\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching knowledge base: ${err}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // knowledge_index - Rebuild knowledge base index
  // ==========================================================================

  api.registerTool({
    name: "knowledge_index",
    description:
      "Rebuild the knowledge base index by scanning configured directories and indexing all supported files (.md, .txt, .mdx). This may take several minutes for large vaults.",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const statusMessages: string[] = [];

        await ctx.indexer.indexAll((status) => {
          statusMessages.push(status);
          console.log(`[knowledge_index] ${status}`);
        });

        const summary = statusMessages.slice(-5).join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Knowledge base indexing complete.\n\n${summary}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error indexing knowledge base: ${err}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

  // ==========================================================================
  // knowledge_stats - Show knowledge base statistics
  // ==========================================================================

  api.registerTool({
    name: "knowledge_stats",
    description: "Show statistics about the indexed knowledge base (file count, chunk count, etc.)",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
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
          ``,
          `Recent files:`,
          fileList,
          files.length > 20 ? `  ... and ${files.length - 20} more` : "",
        ].join("\n");

        return {
          content: [
            {
              type: "text",
              text: summary,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error fetching knowledge stats: ${err}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
