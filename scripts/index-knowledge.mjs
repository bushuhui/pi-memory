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
    const resp = await openai.embeddings.create({ model: embCfg.model, input: batch });
    allEmbeddings.push(...resp.data.map((d) => d.embedding));
  }
  
  return allEmbeddings;
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

async function getFileMetadata(filePath) {
  try {
    const escaped = filePath.replace(/'/g, "''");
    const results = await table.query().filter(`filePath = '${escaped}'`).limit(1).toArray();
    if (results.length === 0) return null;
    return { mtime: results[0].fileMtime || 0, hash: results[0].fileHash || "" };
  } catch {
    return null;
  }
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
    const end = Math.min(start + CHUNK_SIZE, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);
    start += CHUNK_SIZE - CHUNK_OVERLAP;
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

let totalScanned = 0, totalIndexed = 0, totalSkipped = 0, totalErrors = 0;

for (const rootPath of extraPaths) {
  console.log(`Scanning: ${rootPath}`);
  const files = await scanDirectory(rootPath);
  console.log(`Found ${files.length} files`);
  totalScanned += files.length;

  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const progress = `[${i + 1}/${files.length}]`;

    try {
      // Read file
      const stats = await stat(filePath);
      const content = await readFile(filePath, "utf-8");
      const contentHash = createHash("sha256").update(content).digest("hex");

      // Check if unchanged
      if (!forceReindex) {
        const existing = await getFileMetadata(filePath);
        if (existing && existing.mtime === Math.floor(stats.mtimeMs) && existing.hash === contentHash) {
          totalSkipped++;
          continue; // Skip silently
        }
      }

      // Delete old chunks
      await deleteByFilePath(filePath);

      // Chunk
      const chunks = chunkText(content);
      if (chunks.length === 0) continue;

      // Embed
      const embeddings = await embedBatch(chunks);

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
      totalIndexed++;
      console.log(`${progress} Indexed: ${relative(rootPath, filePath)} (${chunks.length} chunks)`);
    } catch (err) {
      totalErrors++;
      console.error(`${progress} Error: ${relative(rootPath, filePath)} — ${err.message || err}`);
    }
  }

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
