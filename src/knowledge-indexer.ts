/**
 * Knowledge Base Indexer
 * Scans directories, extracts content, chunks, and indexes into LanceDB
 * Supports incremental indexing based on mtime + content hash
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename, relative } from "node:path";
import { createHash } from "node:crypto";
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

    let totalScanned = 0;
    let totalIndexed = 0;
    let totalSkipped = 0;

    for (const rootPath of this.rootPaths) {
      report(`Scanning: ${rootPath}`);
      const files = await this.scanDirectory(rootPath);
      report(`Found ${files.length} files in ${rootPath}`);
      totalScanned += files.length;

      const startTime = Date.now();

      for (let i = 0; i < files.length; i++) {
        const filePath = files[i];
        const progress = `[${i + 1}/${files.length}]`;
        try {
          const skipped = await this.indexFile(filePath, rootPath);
          if (skipped) {
            totalSkipped++;
          } else {
            totalIndexed++;
            report(`${progress} Indexed: ${relative(rootPath, filePath)}`);
          }
        } catch (err) {
          report(`${progress} Error: ${relative(rootPath, filePath)} — ${err}`);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      report(`Finished ${rootPath} in ${elapsed}s`);
    }

    const totalChunks = await this.store.countChunks();
    report(
      `\nIndexing complete. Scanned: ${totalScanned}, Indexed: ${totalIndexed}, Skipped: ${totalSkipped}, Total chunks: ${totalChunks}`
    );
  }

  /**
   * Index a single file (skip if unchanged based on mtime + hash)
   * @returns true if skipped, false if indexed
   */
  async indexFile(filePath: string, rootPath: string): Promise<boolean> {
    // Get file stats and content
    const stats = await stat(filePath);
    const content = await readFile(filePath, "utf-8");
    const contentHash = createHash("sha256").update(content).digest("hex");

    // Check if file needs re-indexing
    const existing = await this.store.getFileMetadata(filePath);
    if (existing) {
      const mtimeMs = Math.floor(stats.mtimeMs);
      if (existing.mtime === mtimeMs && existing.hash === contentHash) {
        return true; // Skip unchanged file
      }
    }

    // Delete existing chunks for this file
    await this.store.deleteByFilePath(filePath);

    // Chunk content
    const chunks = this.chunkText(content);
    if (chunks.length === 0) return false;

    // Generate embeddings
    const embeddings = await this.embedder.embedBatch(chunks);

    // Prepare records with mtime and hash
    const records = chunks.map((text, idx) => ({
      text,
      vector: embeddings[idx],
      filePath,
      fileName: basename(filePath),
      fileType: extname(filePath).slice(1),
      chunkIndex: idx,
      timestamp: Date.now(),
      fileMtime: Math.floor(stats.mtimeMs),
      fileHash: contentHash,
    }));

    await this.store.addChunks(records);
    return false; // Indexed
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
