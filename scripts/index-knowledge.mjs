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
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { connect } from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { pid } from "node:process";

// ============================================================================
// Single-instance lock
// ============================================================================

const LOCK_FILE = join(homedir(), ".openclaw", "memory", "index-knowledge.lock");

function acquireLock() {
  try {
    const existing = readFileSync(LOCK_FILE, "utf-8").trim();
    const lockPid = parseInt(existing, 10);
    // Check if the locked PID is still alive
    try {
      process.kill(lockPid, 0);
      console.error(`[lock] Another instance (PID ${lockPid}) is already running. Exiting.`);
      process.exit(0);
    } catch {
      // Process not alive — stale lock
      console.error(`[lock] Removing stale lock (PID ${lockPid} no longer alive)`);
    }
  } catch (err) {
    // Lock file doesn't exist — first instance, continue
  }
  writeFileSync(LOCK_FILE, String(pid));
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

acquireLock();
process.on("exit", releaseLock);

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

// Read config from plugin entry (pi-memory)
const pluginConfig = config?.plugins?.entries?.["pi-memory"]?.config || {};
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

const EMBED_BATCH_SIZE = process.env.EMBED_BATCH_SIZE
  ? parseInt(process.env.EMBED_BATCH_SIZE, 10)
  : 10; // Default: send 10 chunks per API call (tunable via env var)

const openai = new OpenAI({
  apiKey: embCfg.apiKey,
  ...(embCfg.baseURL ? { baseURL: embCfg.baseURL } : {}),
});

async function callEmbeddingWithRetry(batch) {
  const retryDelaysMs = [10000, 30000, 60000, 120000, 240000]; // 失败后等待时间（秒）：10, 30, 60, 120, 240
  const maxAttempts = 6;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await openai.embeddings.create({
        model: embCfg.model,
        input: batch,
        encoding_format: 'float'
      });
    } catch (err) {
      lastErr = err;
      const errMsg = err.error || err.message || String(err);
      if (attempt < maxAttempts) {
        const delay = retryDelaysMs[attempt - 1];
        console.warn(`[embed] Attempt ${attempt}/${maxAttempts} failed (${err.status || 'N/A'}): ${errMsg}. Retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  console.error(`\n[embed] All ${maxAttempts} attempts failed. Aborting.`);
  console.error(`[embed] Status: ${lastErr.status || 'N/A'}`);
  console.error(`[embed] Error: ${lastErr.error || lastErr.message || String(lastErr)}`);
  process.exit(1);
}

async function embedBatch(texts) {
  if (!texts || texts.length === 0) return [];

  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const resp = await callEmbeddingWithRetry(batch);
    allEmbeddings.push(...resp.data.map((d) => d.embedding));
  }

  return allEmbeddings;
}

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

// --- Phase 3: Process changed files in small batches ---
// Each batch: read 5 files → chunk → delete old → embed → store
// This keeps memory bounded and keeps the embed API busy from the start.
if (changedFiles.length === 0) {
  console.log("Phase 3: No files need processing. Skipping.");
} else {
  console.log(`Phase 3: Processing ${changedFiles.length} changed files (file batch=5, embed batch=${EMBED_BATCH_SIZE})...`);

  let batchSkipped = 0;
  let batchErrors = 0;
  let totalChunksEmbedded = 0;

  const FILE_BATCH_SIZE = 5;

  for (let i = 0; i < changedFiles.length; i += FILE_BATCH_SIZE) {
    if (shuttingDown) {
      console.log(`\n[interrupt] Stopping during Phase 3. Processed ${i}/${changedFiles.length}.`);
      break;
    }

    const fileBatch = changedFiles.slice(i, i + FILE_BATCH_SIZE);

    // 1. Read and chunk files concurrently
    const results = await Promise.allSettled(
      fileBatch.map(async (entry) => {
        const relPath = relative(entry.root, entry.path);
        try {
          const stats = await stat(entry.path);
          const mtimeSec = Math.floor(stats.mtimeMs / 1000);
          const existing = getFileMetadata(entry.path);

          if (existing && !forceReindex && Math.abs(existing.mtime - mtimeSec) <= 2) {
            return { type: "skipped", path: relPath };
          }

          const content = await readFile(entry.path, "utf-8");
          const contentHash = createHash("sha256").update(content).digest("hex");

          if (existing && existing.hash === contentHash) {
            const escaped = entry.path.replace(/'/g, "''");
            await table.update({
              where: `filePath = '${escaped}'`,
              values: { fileMtime: mtimeSec, fileHash: contentHash },
            });
            fileMetadataCache.set(entry.path, { mtime: mtimeSec, hash: contentHash });
            return { type: "skipped", path: relPath };
          }

          const chunks = chunkText(content);
          if (chunks.length === 0) {
            fileMetadataCache.set(entry.path, { mtime: mtimeSec, hash: contentHash });
            return { type: "empty", path: relPath };
          }

          return {
            type: "ready",
            path: relPath,
            filePath: entry.path,
            mtimeSec,
            contentHash,
            chunks,
          };
        } catch (err) {
          console.error(`\n[p3-read-exception] ${entry.path}: ${err?.message || err}`);
          throw err;
        }
      })
    );

    const readyBatches = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        const r = result.value;
        if (r.type === "skipped" || r.type === "empty") {
          batchSkipped++;
        } else if (r.type === "ready") {
          readyBatches.push(r);
        }
      } else {
        batchErrors++;
        const errMsg = result.reason?.stack || result.reason?.message || String(result.reason);
        console.error(`\n[error] Phase 3 read error: ${errMsg}`);
      }
    }

    if (readyBatches.length > 0) {
      // 2. Delete old chunks for ready files
      for (const fb of readyBatches) {
        await deleteByFilePath(fb.filePath);
      }

      // 3. Embed chunks for this batch
      const batchChunks = [];
      for (const fb of readyBatches) {
        for (const chunk of fb.chunks) {
          batchChunks.push({ fileBatch: fb, text: chunk });
        }
      }

      const embeddings = await embedBatch(batchChunks.map(c => c.text));
      totalChunksEmbedded += batchChunks.length;

      // 4. Store results
      let embIdx = 0;
      for (const fb of readyBatches) {
        const fileEmbeddings = embeddings.slice(embIdx, embIdx + fb.chunks.length);
        const records = fb.chunks.map((text, idx) => ({
          id: randomUUID(),
          text,
          vector: fileEmbeddings[idx],
          filePath: fb.filePath,
          fileName: basename(fb.filePath),
          fileType: extname(fb.filePath).slice(1),
          chunkIndex: idx,
          timestamp: Date.now(),
          fileMtime: fb.mtimeSec,
          fileHash: fb.contentHash,
        }));

        await table.add(records);
        fileMetadataCache.set(fb.filePath, { mtime: fb.mtimeSec, hash: fb.contentHash });
        totalIndexed++;
        maybeLogMemory(totalIndexed);
        embIdx += fb.chunks.length;
      }
    }

    // 5. Progress report every batch
    const processed = Math.min(i + FILE_BATCH_SIZE, changedFiles.length);
    console.log(`  [progress] ${processed}/${changedFiles.length} — indexed:${totalIndexed}, skipped:${batchSkipped}, errors:${batchErrors}, chunks:${totalChunksEmbedded}`);
  }

  totalSkipped += batchSkipped;
  totalErrors += batchErrors;

  if (totalIndexed > 0) {
    console.log(`  Total chunks embedded: ${totalChunksEmbedded}`);
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
