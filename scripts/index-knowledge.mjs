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

// Read config from plugin entry (memory-lancedb-pro)
const pluginConfig = config?.plugins?.entries?.["memory-lancedb-pro"]?.config || {};
const extraPaths = pluginConfig.knowledgePaths || [];
const dbPathConfig = pluginConfig.dbPath || "~/.openclaw/memory/lancedb-pro";
const dbPath = join(homedir(), dbPathConfig.replace("~/", ""));

// Read embedding config from plugin config
const embCfg = pluginConfig.embedding;

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

const embedSemaphore = new Semaphore(10); // Max 10 concurrent embedding API calls

// ============================================================================
// Graceful Shutdown & Memory Monitoring
// ============================================================================

let shuttingDown = false;
let flushPromise = null;

async function flushAndExit(code = 0) {
  if (flushPromise) {
    await flushPromise;
    process.exit(code);
  }
  // LanceDB writes are synchronous for add/delete, so no explicit flush needed.
  // But we log memory stats for debugging before exit.
  const mem = process.memoryUsage();
  console.log(`\n[shutdown] Memory at exit — RSS: ${(mem.rss / 1024 / 1024).toFixed(0)}MB, Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`);
  process.exit(code);
}

process.on('SIGINT', () => {
  if (shuttingDown) { process.exit(1); }
  shuttingDown = true;
  console.log('\n[interrupt] SIGINT received. Flushing and exiting gracefully...');
  flushAndExit(130);
});

process.on('SIGTERM', () => {
  if (shuttingDown) { process.exit(1); }
  shuttingDown = true;
  console.log('\n[terminate] SIGTERM received. Flushing and exiting gracefully...');
  flushAndExit(143);
});

// Log memory usage every 100 files
const MEMORY_LOG_INTERVAL = 100;
function maybeLogMemory(fileCount) {
  if (fileCount % MEMORY_LOG_INTERVAL === 0) {
    const mem = process.memoryUsage();
    console.log(`\n[mem] File #${fileCount} — RSS: ${(mem.rss / 1024 / 1024).toFixed(0)}MB, Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB, External: ${(mem.external / 1024 / 1024).toFixed(0)}MB`);
  }
}

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
  // Paginated load to avoid OOM on very large tables.
  // LanceDB doesn't support offset, so we load all at once but with a safety cap.
  // For ~100k chunks this is ~10MB in JS heap — safe for default Node.js limits.
  const rows = await table.query().select(["filePath", "fileMtime", "fileHash"]).limit(Number.MAX_SAFE_INTEGER).toArray();
  if (rows.length > 5000000) {
    console.warn(`[cache] WARNING: ${rows.length} rows loaded — consider running with --force on a fresh DB if memory is tight`);
  }
  for (const row of rows) {
    if (row.filePath && row.filePath !== "/placeholder") {
      fileMetadataCache.set(row.filePath, { mtime: normalizeMtime(row.fileMtime), hash: row.fileHash || "" });
    }
  }
  console.log(`[cache] Loaded ${fileMetadataCache.size} unique file metadata entries from ${rows.length} rows`);
}

function getFileMetadata(filePath) {
  return fileMetadataCache.get(filePath) || null;
}

// Normalize mtime: old entries stored milliseconds (>1e12), new ones store seconds
function normalizeMtime(rawMtime) {
  if (!rawMtime) return 0;
  return rawMtime > 1e12 ? Math.floor(rawMtime / 1000) : rawMtime;
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

      // Follow symbolic links by using stat() instead of lstat()
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      // If it's a symbolic link, resolve it and check the target
      if (entry.isSymbolicLink()) {
        try {
          const realStats = await stat(fullPath);
          isDir = realStats.isDirectory();
          isFile = realStats.isFile();
        } catch (err) {
          // Broken symlink or inaccessible, skip
          console.warn(`[scan] Skipping broken symlink: ${fullPath}`);
          continue;
        }
      }

      if (isDir) {
        files.push(...await scanDirectory(fullPath));
      } else if (isFile) {
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
// Index — Three-phase approach
// Phase 1: Scan all directories → collect file paths
// Phase 2: Parallel mtime check on ALL files → filter changed
// Phase 3: Process only changed files (read, embed, store)
// ============================================================================

await loadFileMetadataCache();

let totalScanned = 0, totalIndexed = 0, totalSkipped = 0, totalErrors = 0;

const SCAN_CONCURRENCY = 100; // High concurrency for lightweight stat() calls
const EMBED_CONCURRENCY = 10; // Balance between throughput and resource contention

// --- Phase 1: Scan ALL directories ---
console.log("Phase 1: Scanning directories...");
const allFiles = [];
for (const rootPath of extraPaths) {
  if (shuttingDown) break;
  const files = await scanDirectory(rootPath);
  totalScanned += files.length;
  allFiles.push(...files.map(f => ({ path: f, root: rootPath })));
  console.log(`  ${rootPath}: ${files.length} files`);
}
console.log(`  Total: ${allFiles.length} files`);

// --- Phase 1.5: Pre-scan small/empty files to avoid repeated full reads ---
// Files that are too short to produce chunks (< ~60 bytes) are detected here
// so Phase 2 can skip them via hash comparison.
console.log("Phase 1.5: Detecting empty files (fast pre-scan)...");
const EMPTY_THRESHOLD = 200; // bytes (covers files too short to produce chunks with >50 trimmed chars)
let emptyFileCount = 0;
for (const file of allFiles) {
  if (fileMetadataCache.has(file.path)) continue; // already in DB cache
  try {
    const stats = await stat(file.path);
    if (stats.size < EMPTY_THRESHOLD) {
      const content = await readFile(file.path, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");
      const chunks = chunkText(content);
      if (chunks.length === 0) {
        const mtimeSec = Math.floor(stats.mtimeMs / 1000);
        fileMetadataCache.set(file.path, { mtime: mtimeSec, hash });
        emptyFileCount++;
      }
    }
  } catch { /* ignore inaccessible files */ }
}
console.log(`  Found ${emptyFileCount} empty files, added to cache`);

// --- Phase 2: Parallel mtime check on ALL files ---
console.log(`Phase 2: Checking mtime for ${allFiles.length} files (concurrency=${SCAN_CONCURRENCY})...`);
const changedFiles = [];
let lastReported = 0;

for (let i = 0; i < allFiles.length; i += SCAN_CONCURRENCY) {
  if (shuttingDown) break;
  const batch = allFiles.slice(i, i + SCAN_CONCURRENCY);

  const results = await Promise.allSettled(
    batch.map(async (entry) => {
      const stats = await stat(entry.path);
      const mtimeSec = Math.floor(stats.mtimeMs / 1000);
      const existing = getFileMetadata(entry.path);
      return { entry, mtimeSec, existing };
    })
  );

  for (let bi = 0; bi < results.length; bi++) {
    const result = results[bi];
    const entry = batch[bi];
    if (result.status === "fulfilled") {
      const { mtimeSec, existing } = result.value;
      if (existing && !forceReindex && Math.abs(existing.mtime - mtimeSec) <= 2) {
        totalSkipped++;
      } else {
        changedFiles.push(entry);
      }
    } else {
      totalErrors++;
      console.error(`\n[error] stat failed: ${entry.path}: ${result.reason}`);
    }
  }

  // Progress report
  const checked = Math.min(i + SCAN_CONCURRENCY, allFiles.length);
  if (checked - lastReported >= allFiles.length / 10 || checked === allFiles.length) {
    lastReported = checked;
    const pct = ((checked / allFiles.length) * 100).toFixed(0);
    process.stdout.write(`\r  Checked ${checked}/${allFiles.length} (${pct}%) — ${changedFiles.length} changed, ${totalSkipped} unchanged`);
  }
}
console.log(`\r  ${allFiles.length} files checked: ${changedFiles.length} changed, ${totalSkipped} unchanged${" ".repeat(40)}`);

// --- Phase 3: Process only changed files ---
if (changedFiles.length === 0) {
  console.log("Phase 3: No files need processing. Skipping.");
} else {
  console.log(`Phase 3: Processing ${changedFiles.length} changed files (concurrency=${EMBED_CONCURRENCY})...`);
  let processedCount = 0;

  for (let i = 0; i < changedFiles.length; i += EMBED_CONCURRENCY) {
    if (shuttingDown) {
      console.log(`\n[interrupt] Stopping. Processed ${processedCount}/${changedFiles.length} changed files.`);
      break;
    }
    const batch = changedFiles.slice(i, i + EMBED_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        const relPath = relative(entry.root, entry.path);
        try {
          // Re-check mtime (file may have changed between phase 2 and phase 3)
          const stats = await stat(entry.path);
          const mtimeSec = Math.floor(stats.mtimeMs / 1000);
          const existing = getFileMetadata(entry.path);
          // Skip if unchanged AND not forced — double safety since Phase 2 already filtered
          if (existing && !forceReindex && Math.abs(existing.mtime - mtimeSec) <= 2) {
            return { type: "skipped", path: relPath };
          }

          const content = await readFile(entry.path, "utf-8");
          const contentHash = createHash("sha256").update(content).digest("hex");

          // Verify hash against old entry (mtime drifted but content same)
          if (existing && existing.hash === contentHash) {
            const escaped = entry.path.replace(/'/g, "''");
            await table.update({
              where: `filePath = '${escaped}'`,
              values: { fileMtime: mtimeSec, fileHash: contentHash },
            });
            fileMetadataCache.set(entry.path, { mtime: mtimeSec, hash: contentHash });
            return { type: "skipped", path: relPath };
          }

          // Delete old chunks
          await deleteByFilePath(entry.path);

          // Chunk
          const chunks = chunkText(content);
          if (chunks.length === 0) {
            // Record hash so we skip this empty file on future runs
            fileMetadataCache.set(entry.path, { mtime: mtimeSec, hash: contentHash });
            return { type: "empty", path: relPath };
          }

          // Embed
          const embeddings = await embedWithSemaphore(chunks);

          // Store
          const records = chunks.map((text, idx) => ({
            id: randomUUID(),
            text,
            vector: embeddings[idx],
            filePath: entry.path,
            fileName: basename(entry.path),
            fileType: extname(entry.path).slice(1),
            chunkIndex: idx,
            timestamp: Date.now(),
            fileMtime: mtimeSec,
            fileHash: contentHash,
          }));

          await table.add(records);
          fileMetadataCache.set(entry.path, { mtime: mtimeSec, hash: contentHash });

          return { type: "indexed", path: relPath, chunks: chunks.length };
        } catch (err) {
          console.error(`\n[p3-exception] ${entry.path}: ${err?.message || err}`);
          throw err;
        }
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const r = result.value;
        if (r.type === "skipped" || r.type === "empty") {
          totalSkipped++;
        } else if (r.type === "indexed") {
          totalIndexed++;
          processedCount++;
          maybeLogMemory(processedCount);
          const msg = `Indexing: ${r.path} (${r.chunks} chunks) [${processedCount}/${changedFiles.length}]`;
          process.stdout.write(`\n${msg}`);
        }
      } else {
        totalErrors++;
        const r = result.reason;
        const errMsg = r?.stack || r?.message || String(r);
        console.error(`\n[error] Phase 3 batch error: ${errMsg}`);
      }
    }
  }
  console.log("");
}

// ============================================================================
// Orphan Cleanup — remove DB entries for deleted source files
// ============================================================================

// Skip orphan cleanup if we didn't complete a full scan (e.g. interrupted)
let orphanDeleted = 0;
if (!shuttingDown) {
  console.log("Checking for orphaned entries (deleted source files)...");
  const allDiskFiles = new Set(allFiles.map(f => f.path));

  try {
    const dbFilePaths = new Set();
    const allRows = await table.query().select(["filePath"]).limit(Number.MAX_SAFE_INTEGER).toArray();
    for (const row of allRows) {
      if (row.filePath) dbFilePaths.add(row.filePath);
    }

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
} else {
  console.log("Skipping orphan cleanup (interrupted — scan was incomplete).");
}

const totalChunks = await table.countRows();
console.log("");
console.log(`Indexing complete.`);
console.log(`  Scanned: ${totalScanned}`);
console.log(`  Indexed: ${totalIndexed}`);
console.log(`  Skipped: ${totalSkipped}`);
console.log(`  Errors:  ${totalErrors}`);
console.log(`  Orphans removed: ${orphanDeleted}`);
const mem = process.memoryUsage();
console.log(`  Peak RSS: ${(mem.rss / 1024 / 1024).toFixed(0)}MB, Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`);
console.log(`  Total chunks in DB: ${totalChunks}`);
