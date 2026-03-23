#!/usr/bin/env node
/**
 * Knowledge Base Indexer CLI (self-contained, no TS imports)
 * Usage: node scripts/index-knowledge.mjs [--force]
 *
 * Reads extraPaths from openclaw.json, embedding config from openclaw.plugin.json.
 * Supports incremental indexing (mtime + SHA256 hash). Use --force to re-index all.
 */

import { homedir } from "node:os";
import { join, extname, basename, relative } from "node:path";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { connect } from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";

// ============================================================================
// Config
// ============================================================================

const SUPPORTED_EXTENSIONS = [".md", ".txt", ".mdx"];
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const TABLE_NAME = "knowledge";
const forceReindex = process.argv.includes("--force");

// Read main config
const configPath = join(homedir(), ".openclaw", "openclaw.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const extraPaths = config?.agents?.defaults?.memorySearch?.extraPaths || [];
const dbPath = join(homedir(), ".openclaw", "memory", "lancedb-pro");

// Read embedding config from main config (plugins.entries.memory-lancedb-pro.config.embedding)
const embCfg = config?.plugins?.entries?.["memory-lancedb-pro"]?.config?.embedding;

if (!embCfg) {
  console.error("[index-knowledge] No embedding config found in openclaw.plugin.json");
  process.exit(1);
}

const vectorDim = embCfg.dimensions || 1536;

console.log(`[index-knowledge] Starting indexer...`);
console.log(`[index-knowledge] DB path: ${dbPath}`);
console.log(`[index-knowledge] Knowledge paths: ${extraPaths.join(", ")}`);
console.log(`[index-knowledge] Embedding: ${embCfg.model} (dim=${vectorDim})`);
console.log(`[index-knowledge] Force re-index: ${forceReindex}`);
console.log("");

// ============================================================================
// Embedder (inline OpenAI-compatible)
// ============================================================================

const openai = new OpenAI({
  apiKey: embCfg.apiKey,
  ...(embCfg.baseURL ? { baseURL: embCfg.baseURL } : {}),
});

async function embedBatch(texts) {
  if (!texts || texts.length === 0) return [];

  // API may have batch size limits (e.g. Aliyun max 10)
  const BATCH_SIZE = 10;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const resp = await openai.embeddings.create({
      model: embCfg.model,
      input: batch,
      encoding_format: 'float'  // Explicitly use float format to avoid SDK base64 decoding issues
    });
    allEmbeddings.push(...resp.data.map((d) => d.embedding));
  }

  return allEmbeddings;
}

// Semaphore to limit concurrent embedding requests
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.limit) {
      this.current++;
      return;
    }
    await new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.current = Math.max(0, this.current);
    }
  }
}

const embedSemaphore = new Semaphore(3); // Max 3 concurrent embedding calls

async function embedWithSemaphore(texts) {
  await embedSemaphore.acquire();
  try {
    return await embedBatch(texts);
  } finally {
    embedSemaphore.release();
  }
}

// ============================================================================
// LanceDB Store
// ============================================================================

const db = await connect(dbPath);
const tableNames = await db.tableNames();
let table;

if (tableNames.includes(TABLE_NAME)) {
  table = await db.openTable(TABLE_NAME);
  console.log(`[index-knowledge] Opened existing table: ${TABLE_NAME}`);
} else {
  const placeholder = [{
    id: randomUUID(), text: "placeholder", vector: new Array(vectorDim).fill(0),
    filePath: "/placeholder", fileName: "placeholder", fileType: "txt",
    chunkIndex: 0, timestamp: Date.now(), fileMtime: 0, fileHash: "",
  }];
  table = await db.createTable(TABLE_NAME, placeholder, { mode: "overwrite" });
  await table.delete(`id = '${placeholder[0].id}'`);
  console.log(`[index-knowledge] Created new table: ${TABLE_NAME}`);
}

// In-memory cache of file metadata: filePath -> { mtime, hash }
let fileMetadataCache = new Map();

async function loadFileMetadataCache() {
  fileMetadataCache.clear();
  const rows = await table.query().select(["filePath", "fileMtime", "fileHash"]).limit(100000).toArray();
  for (const row of rows) {
    if (row.filePath && row.filePath !== "/placeholder") {
      fileMetadataCache.set(row.filePath, { mtime: row.fileMtime || 0, hash: row.fileHash || "" });
    }
  }
  console.log(`[cache] Loaded ${fileMetadataCache.size} file metadata entries into memory`);
}

function getFileMetadata(filePath) {
  return fileMetadataCache.get(filePath) || null;
}

async function deleteByFilePath(filePath) {
  const escaped = filePath.replace(/'/g, "''");
  await table.delete(`filePath = '${escaped}'`);
}

// ============================================================================
// Chunker
// ============================================================================

function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);

    // Avoid splitting surrogate pairs (emoji and some special chars)
    // If end is at a low surrogate, move back to include the full pair
    if (end < text.length) {
      const code = text.charCodeAt(end);
      if (code >= 0xDC00 && code <= 0xDFFF) {
        // We're at a low surrogate, move back to not split the pair
        end--;
      }
    }

    const chunk = text.slice(start, end);
    const trimmed = chunk.trim();
    if (trimmed.length > 50) chunks.push(trimmed);

    start += CHUNK_SIZE - CHUNK_OVERLAP;

    // If start lands on a low surrogate, skip it
    if (start < text.length) {
      const code = text.charCodeAt(start);
      if (code >= 0xDC00 && code <= 0xDFFF) {
        start++;
      }
    }
  }
  return chunks;
}

// ============================================================================
// Scanner
// ============================================================================

async function scanDirectory(dirPath) {
  const files = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        files.push(...await scanDirectory(fullPath));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.includes(ext)) files.push(fullPath);
      }
    }
  } catch (err) {
    console.warn(`[scan] failed: ${dirPath}: ${err}`);
  }
  return files;
}

// ============================================================================
// Index
// ============================================================================

// Load all file metadata into memory once (optimization)
await loadFileMetadataCache();

let totalScanned = 0, totalIndexed = 0, totalSkipped = 0, totalErrors = 0;

// Concurrent file processing
const CONCURRENCY = 5; // Adjust based on performance needs

for (const rootPath of extraPaths) {
  console.log(`Scanning: ${rootPath}`);
  const files = await scanDirectory(rootPath);
  console.log(`Found ${files.length} files`);
  totalScanned += files.length;

  const startTime = Date.now();
  let processedCount = 0;

  // Process files in batches
  let batchCount = 0;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    batchCount++;

    const results = await Promise.allSettled(
      batch.map(async (filePath, batchIdx) => {
        const globalIdx = i + batchIdx;
        const progress = `[${globalIdx + 1}/${files.length}]`;
        const relPath = relative(rootPath, filePath);

        try {
          // Read file
          const stats = await stat(filePath);
          const content = await readFile(filePath, "utf-8");
          const contentHash = createHash("sha256").update(content).digest("hex");

          // Check if unchanged
          const existing = getFileMetadata(filePath);
          if (existing && existing.mtime === Math.floor(stats.mtimeMs) && existing.hash === contentHash) {
            return { type: "skipped", path: relPath };
          }

          // Delete old chunks
          await deleteByFilePath(filePath);

          // Chunk
          const chunks = chunkText(content);
          if (chunks.length === 0) return { type: "empty", path: relPath };

          // Embed
          const embeddings = await embedWithSemaphore(chunks);

          // Store
          const records = chunks.map((text, idx) => ({
            id: randomUUID(),
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

          await table.add(records);
          return { type: "indexed", path: relPath, chunks: chunks.length };
        } catch (err) {
          throw { path: relPath, error: err };
        }
      })
    );

    // Process results
    for (const result of results) {
      if (result.status === "fulfilled") {
        const r = result.value;
        if (r.type === "skipped" || r.type === "empty") {
          totalSkipped++;
        } else if (r.type === "indexed") {
          totalIndexed++;
          processedCount++;
          const msg = `Indexing: ${r.path} (${r.chunks} chunks) [${processedCount}/${files.length}]`;
          process.stdout.write(`\r${msg}`);
        }
      } else {
        totalErrors++;
        const r = result.reason;
        console.error(`\nError: ${r.path} — ${r.error.message || r.error}`);
      }
    }
  }

  // Clear line and show directory completion
  process.stdout.write("\r" + " ".repeat(80) + "\r");
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Finished ${rootPath} in ${elapsed}s`);
}

// ============================================================================
// Orphan Cleanup — remove DB entries for deleted source files
// ============================================================================

console.log("");
console.log("Checking for orphaned entries (deleted source files)...");

// Collect all file paths that exist on disk
const allDiskFiles = new Set();
for (const rootPath of extraPaths) {
  const files = await scanDirectory(rootPath);
  for (const f of files) allDiskFiles.add(f);
}

// Query all distinct filePaths from DB
let orphanDeleted = 0;
try {
  // LanceDB doesn't support SELECT DISTINCT, so we scan and deduplicate
  const SCAN_BATCH = 5000;
  const dbFilePaths = new Set();
  let offset = 0;
  while (true) {
    const rows = await table.query().select(["filePath"]).limit(SCAN_BATCH).toArray();
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.filePath) dbFilePaths.add(row.filePath);
    }
    // LanceDB query().limit() doesn't support offset natively,
    // but since we just need distinct filePaths, one pass is enough
    // if table is small enough. For large tables, this gets all rows.
    break;
  }

  // If table is large, do a full scan to get all unique filePaths
  if (dbFilePaths.size > 0) {
    const allRows = await table.query().select(["filePath"]).limit(100000).toArray();
    for (const row of allRows) {
      if (row.filePath) dbFilePaths.add(row.filePath);
    }
  }

  // Find orphans: in DB but not on disk
  for (const dbPath of dbFilePaths) {
    if (dbPath === "/placeholder") continue;
    if (!allDiskFiles.has(dbPath)) {
      try {
        await deleteByFilePath(dbPath);
        orphanDeleted++;
        console.log(`  Deleted orphan: ${dbPath}`);
      } catch (err) {
        console.warn(`  Failed to delete orphan ${dbPath}: ${err}`);
      }
    }
  }

  if (orphanDeleted === 0) {
    console.log("  No orphaned entries found.");
  } else {
    console.log(`  Cleaned up ${orphanDeleted} orphaned file(s).`);
  }
} catch (err) {
  console.warn(`[orphan-cleanup] Error during cleanup: ${err}`);
}

const totalChunks = await table.countRows();
console.log("");
console.log(`Indexing complete.`);
console.log(`  Scanned: ${totalScanned}`);
console.log(`  Indexed: ${totalIndexed}`);
console.log(`  Skipped: ${totalSkipped}`);
console.log(`  Errors:  ${totalErrors}`);
console.log(`  Orphans removed: ${orphanDeleted}`);
console.log(`  Total chunks in DB: ${totalChunks}`);
