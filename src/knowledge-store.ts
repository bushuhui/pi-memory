/**
 * Knowledge Base Storage Layer (LanceDB)
 * Separate table for document chunks with metadata
 */

import type * as LanceDB from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import { loadLanceDB } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface KnowledgeChunk {
  id: string;
  text: string;
  vector: number[];
  filePath: string;
  fileName: string;
  fileType: string;
  chunkIndex: number;
  timestamp: number;
  fileMtime?: number; // File modification time (ms since epoch)
  fileHash?: string; // Content hash for change detection
  metadata?: string; // JSON string for extensible metadata (headings, tags, etc.)
}

export interface KnowledgeSearchResult {
  chunk: KnowledgeChunk;
  score: number;
}

// ============================================================================
// Knowledge Store
// ============================================================================

const TABLE_NAME = "knowledge";

export class KnowledgeStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private ftsIndexCreated = false;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number
  ) {}

  async init(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);

    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      console.log(`[knowledge-store] opened existing table: ${TABLE_NAME}`);
    } else {
      // Create empty table with schema
      const emptyData: KnowledgeChunk[] = [
        {
          id: randomUUID(),
          text: "placeholder",
          vector: new Array(this.vectorDim).fill(0),
          filePath: "/placeholder",
          fileName: "placeholder",
          fileType: "txt",
          chunkIndex: 0,
          timestamp: Date.now(),
          fileMtime: 0,
          fileHash: "",
        },
      ];
      this.table = await this.db.createTable(TABLE_NAME, emptyData, {
        mode: "overwrite",
      });
      // Delete placeholder
      await this.table.delete(`id = '${emptyData[0].id}'`);
      console.log(`[knowledge-store] created new table: ${TABLE_NAME}`);
    }

    // Create FTS index if not exists
    if (!this.ftsIndexCreated) {
      try {
        await this.table.createIndex({
          type: "fts",
          columns: ["text", "fileName"],
        });
        this.ftsIndexCreated = true;
        console.log(`[knowledge-store] FTS index created`);
      } catch (err: any) {
        if (err?.message?.includes("already exists")) {
          this.ftsIndexCreated = true;
        } else {
          console.warn(`[knowledge-store] FTS index creation failed: ${err}`);
        }
      }
    }
  }

  async addChunks(chunks: Omit<KnowledgeChunk, "id">[]): Promise<void> {
    await this.init();
    if (!this.table) throw new Error("Table not initialized");

    const records = chunks.map((c) => ({
      id: randomUUID(),
      ...c,
    }));

    await this.table.add(records);
    console.log(`[knowledge-store] added ${records.length} chunks`);
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    await this.init();
    if (!this.table) throw new Error("Table not initialized");

    const escapedPath = filePath.replace(/'/g, "''");
    await this.table.delete(`filePath = '${escapedPath}'`);
    console.log(`[knowledge-store] deleted chunks for: ${filePath}`);
  }

  async vectorSearch(
    queryVector: number[],
    limit: number = 10
  ): Promise<KnowledgeSearchResult[]> {
    await this.init();
    if (!this.table) throw new Error("Table not initialized");

    const results = await this.table
      .vectorSearch(queryVector)
      .limit(limit)
      .toArray();

    return results.map((r: any) => {
      // Convert L2 distance to 0-1 similarity score (same as MemoryStore)
      const distance = r._distance ?? 0;
      const score = 1 / (1 + distance);

      return {
        chunk: {
          id: r.id,
          text: r.text,
          vector: r.vector,
          filePath: r.filePath,
          fileName: r.fileName,
          fileType: r.fileType,
          chunkIndex: r.chunkIndex,
          timestamp: r.timestamp,
          fileMtime: r.fileMtime,
          fileHash: r.fileHash,
          metadata: r.metadata,
        },
        score,
      };
    });
  }

  async ftsSearch(query: string, limit: number = 20): Promise<KnowledgeSearchResult[]> {
    await this.init();
    if (!this.table) throw new Error("Table not initialized");

    try {
      const results = await this.table
        .search(query)
        .limit(limit)
        .toArray();

      return results.map((r: any, index: number) => {
        // LanceDB FTS _score is raw BM25 (unbounded). Normalize with sigmoid.
        const rawScore = typeof r._score === "number" ? r._score : 0;
        const normalizedScore = rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 10)) : 0.5;

        return {
          chunk: {
            id: r.id,
            text: r.text,
            vector: r.vector,
            filePath: r.filePath,
            fileName: r.fileName,
            fileType: r.fileType,
            chunkIndex: r.chunkIndex,
            timestamp: r.timestamp,
            fileMtime: r.fileMtime,
            fileHash: r.fileHash,
            metadata: r.metadata,
          },
          score: normalizedScore,
        };
      });
    } catch (err) {
      console.warn(`[knowledge-store] FTS search failed: ${err}`);
      return [];
    }
  }

  async countChunks(): Promise<number> {
    await this.init();
    if (!this.table) return 0;
    return await this.table.countRows();
  }

  async listFiles(): Promise<Array<{ filePath: string; chunkCount: number }>> {
    await this.init();
    if (!this.table) return [];

    const allChunks = await this.table.toArray();
    const fileMap = new Map<string, number>();

    for (const chunk of allChunks) {
      const path = (chunk as any).filePath;
      fileMap.set(path, (fileMap.get(path) || 0) + 1);
    }

    return Array.from(fileMap.entries()).map(([filePath, chunkCount]) => ({
      filePath,
      chunkCount,
    }));
  }

  /**
   * Get file metadata (mtime + hash) for incremental indexing
   */
  async getFileMetadata(
    filePath: string
  ): Promise<{ mtime: number; hash: string } | null> {
    await this.init();
    if (!this.table) return null;

    try {
      const escapedPath = filePath.replace(/'/g, "''");
      const results = await this.table
        .filter(`filePath = '${escapedPath}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return null;

      const chunk = results[0] as any;
      return {
        mtime: chunk.fileMtime || 0,
        hash: chunk.fileHash || "",
      };
    } catch (err) {
      console.warn(`[knowledge-store] getFileMetadata failed: ${err}`);
      return null;
    }
  }
}
