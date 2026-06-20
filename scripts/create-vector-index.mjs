#!/usr/bin/env node
/**
 * Create IVF_PQ Vector Index CLI
 *
 * Builds an ANN (IVF_PQ) vector index on the `knowledge` table's `vector`
 * column to speed up vector search on large knowledge bases.
 *
 * IMPORTANT: All knowledge bases share ONE `knowledge` table (distinguished by
 * the `filePath` column), so a single index covers all of them. You do NOT
 * pass knowledge base paths here — the index is built on the whole table.
 *
 * WARNING: This is a long-running, CPU/IO-heavy operation that blocks while
 * running. Run it during a maintenance window, not during peak hours.
 *
 * You only need to run this ONCE. New data added later is merged into the
 * existing index incrementally by table.optimize() (the server already calls
 * optimize() every 30 min). --force is only for retraining cluster centroids
 * after a major data distribution shift degrades recall — rarely needed.
 *
 * Usage:
 *   node scripts/create-vector-index.mjs                 # Build index on `knowledge`
 *   node scripts/create-vector-index.mjs --table=memories
 *   node scripts/create-vector-index.mjs --db=/path/to/db
 *   node scripts/create-vector-index.mjs --force         # Drop & rebuild if exists
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { connect, Index } from "@lancedb/lancedb";

// ============================================================================
// Argument Parsing
// ============================================================================

const args = process.argv.slice(2);
const customDb = args.find((a) => a.startsWith("--db="))?.split("=")[1];
const tableName = args.find((a) => a.startsWith("--table="))?.split("=")[1] || "knowledge";
const force = args.includes("--force");

const dbPath = customDb || join(homedir(), ".openclaw", "memory", "pi-memory");

// Minimum rows for IVF_PQ to be meaningful (LanceDB needs enough to train clusters)
const MIN_ROWS = 256;

// ============================================================================
// Main
// ============================================================================

console.log("=".repeat(60));
console.log("Create IVF_PQ Vector Index");
console.log("=".repeat(60));
console.log(`DB path: ${dbPath}`);
console.log(`Table:   ${tableName}`);
console.log("");

const db = await connect(dbPath);
const tables = await db.tableNames();

if (!tables.includes(tableName)) {
  console.error(`Table "${tableName}" not found. Available: ${tables.join(", ") || "(none)"}`);
  process.exit(1);
}

const table = await db.openTable(tableName);

// --- Check existing index ---
const indices = await table.listIndices();
const hasVectorIndex = indices?.some(
  (idx) => idx.indexType === "IVF_PQ" || idx.columns?.includes("vector")
);

if (hasVectorIndex && !force) {
  console.log("✓ Vector index already exists. Use --force to rebuild.");
  process.exit(0);
}

// --- Check row count ---
const rowCount = await table.countRows();
console.log(`Rows: ${rowCount.toLocaleString()}`);

if (rowCount < MIN_ROWS) {
  console.log(`Skip: only ${rowCount} rows (need >= ${MIN_ROWS} for IVF_PQ).`);
  console.log("Small tables already use brute-force search, which is fast enough.");
  process.exit(0);
}

// --- Build index ---
console.log("");
console.log("Building IVF_PQ index (this may take several minutes)...");
const t0 = Date.now();

try {
  await table.createIndex("vector", {
    config: Index.ivfPq({ distanceType: "l2" }),
    replace: force,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ Index created in ${elapsed}s`);
} catch (err) {
  console.error(`✗ Index creation failed: ${err.message}`);
  process.exit(1);
}

// --- Verify ---
const indicesAfter = await table.listIndices();
console.log("");
console.log("Indices now:");
for (const idx of indicesAfter) {
  console.log(`  - ${idx.name} (${idx.indexType}) on [${idx.columns?.join(", ")}]`);
}
