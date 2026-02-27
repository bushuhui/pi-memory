/**
 * Knowledge Base Indexer
 * Scans directories, extracts content, chunks, and indexes into LanceDB
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename, relative } from "node:path";
import type { KnowledgeStore } from "./knowledge-store.js";
import type { Embedder } from "./embedder.js";

// ============================================================================
// Configuration
// ============================================================================

const SUPPORTED_EXTENSIONS = [".md", ".txt", ".mdx"];
const CHUNK_SIZE = 1000; // characters per chunk
const CHUNK_OVERLAP = 200; // overlap between chunks

// ============================================================================
// Indexer
// ============================================================================

export class KnowledgeIndexer {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly embedder: Embedder,
    private readonly rootPaths: string[]
  ) {}

  /**
   * Index all files in configured paths
   */
  async indexAll(progressCallback?: (status: string) => void): Promise<void> {
    const report = progressCallback || (() => {});

    for (const rootPath of this.rootPaths) {
      report(`Scanning: ${rootPath}`);
      const files = await this.scanDirectory(rootPath);
      report(`Found ${files.length} files in ${rootPath}`);

      for (const filePath of files) {
        try {
          await this.indexFile(filePath, rootPath);
          report(`Indexed: ${relative(rootPath, filePath)}`);
        } catch (err) {
          report(`Error indexing ${filePath}: ${err}`);
        }
      }
    }

    const totalChunks = await this.store.countChunks();
    report(`Indexing complete. Total chunks: ${totalChunks}`);
  }

  /**
   * Index a single file (re-index if already exists)
   */
  async indexFile(filePath: string, rootPath: string): Promise<void> {
    // Delete existing chunks for this file
    await this.store.deleteByFilePath(filePath);

    // Read and chunk content
    const content = await readFile(filePath, "utf-8");
    const chunks = this.chunkText(content);

    if (chunks.length === 0) return;

    // Generate embeddings
    const embeddings = await this.embedder.embedBatch(chunks);

    // Prepare records
    const records = chunks.map((text, idx) => ({
      text,
      vector: embeddings[idx],
      filePath,
      fileName: basename(filePath),
      fileType: extname(filePath).slice(1),
      chunkIndex: idx,
      timestamp: Date.now(),
    }));

    await this.store.addChunks(records);
  }

  /**
   * Recursively scan directory for supported files
   */
  private async scanDirectory(dirPath: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        // Skip hidden files/dirs and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.scanDirectory(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (err) {
      console.warn(`[knowledge-indexer] failed to scan ${dirPath}: ${err}`);
    }

    return files;
  }

  /**
   * Split text into overlapping chunks
   */
  private chunkText(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + CHUNK_SIZE, text.length);
      const chunk = text.slice(start, end).trim();

      if (chunk.length > 50) {
        // Skip very short chunks
        chunks.push(chunk);
      }

      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }

    return chunks;
  }
}
