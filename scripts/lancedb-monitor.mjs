#!/usr/bin/env node
/**
 * LanceDB Monitor & Optimize CLI
 * Usage:
 *   node scripts/lancedb-monitor.mjs                   # Show status only
 *   node scripts/lancedb-monitor.mjs --optimize         # Run optimize()
 *   node scripts/lancedb-monitor.mjs --optimize --cleanup-days=7
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";

// ============================================================================
// Argument Parsing
// ============================================================================

const args = process.argv.slice(2);
const doOptimize = args.includes("--optimize");
const cleanupDays = parseInt(
  args.find((a) => a.startsWith("--cleanup-days="))?.split("=")[1] || "1",
  10
);
const customDb = args.find((a) => a.startsWith("--db="))?.split("=")[1];

const dbPath = customDb || join(homedir(), ".openclaw", "memory", "pi-memory");

// ============================================================================
// Helpers
// ============================================================================

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function printTableStatus(table, tableName, label) {
  const stats = await table.stats();
  const { numFragments, numSmallFragments, lengths } = stats.fragmentStats;

  const fragIcon = numFragments > 100 ? "⚠️" : numFragments > 50 ? "⚡" : "✓";
  const smallRatio = numFragments > 0 ? (numSmallFragments / numFragments * 100).toFixed(0) : "0";

  console.log(`  [${label}] ${tableName}`);
  console.log(`    rows:      ${stats.numRows.toLocaleString()}`);
  console.log(`    fragments: ${numFragments.toLocaleString()} (${smallRatio}% small)`);
  console.log(`    size:      ${formatBytes(stats.totalBytes)}`);
  console.log(`    indices:   ${stats.numIndices}`);
  if (lengths) {
    console.log(`    frag size: min=${lengths.min}, p50=${lengths.p50}, p99=${lengths.p99}, max=${lengths.max}`);
  }

  return stats;
}

// ============================================================================
// Main
// ============================================================================

console.log("=".repeat(60));
console.log("LanceDB Monitor");
console.log("=".repeat(60));
console.log(`DB path: ${dbPath}`);
console.log("");

const db = await connect(dbPath);
const tables = await db.tableNames();

if (tables.length === 0) {
  console.log("No tables found. Database is empty.");
  process.exit(0);
}

console.log(`Tables: ${tables.join(", ")}`);
console.log("");

// --- Phase 1: Status ---

console.log("── Before ──────────────────────────────────────────────────");

const allStats = {};
for (const t of tables) {
  const table = await db.openTable(t);
  const label = t === "memories" ? "MEM" : t === "knowledge" ? "KNW" : t.slice(0, 3).toUpperCase();
  const stats = await printTableStatus(table, t, label);
  allStats[t] = stats;
}

console.log("");

// --- Phase 2: Optimize ---

if (!doOptimize) {
  console.log("Run with --optimize to merge fragments and clean up old versions.");
  console.log("Optional: --cleanup-days=N  (default: 1, set 0 to keep only latest)");
  process.exit(0);
}

const totalFragmentsBefore = Object.values(allStats).reduce((s, st) => s + st.fragmentStats.numFragments, 0);

const cutoffDate = new Date(Date.now() - cleanupDays * 24 * 60 * 60 * 1000);
console.log(`── Optimizing (cleanup older than ${cutoffDate.toISOString()}) ──────`);

for (const tableName of tables) {
  const table = await db.openTable(tableName);
  console.log(`  [${tableName}] running optimize()...`);

  try {
    const result = await table.optimize({ cleanupOlderThan: cutoffDate });
    console.log(`  [${tableName}] done`);
    if (result?.numDeletedIndices != null) console.log(`    deleted indices: ${result.numDeletedIndices}`);
  } catch (err) {
    console.log(`  [${tableName}] error: ${err.message}`);
  }
}

console.log("");

// --- Phase 3: Status After ---

console.log("── After ───────────────────────────────────────────────────");

const allStatsAfter = {};
for (const t of tables) {
  const table = await db.openTable(t);
  const label = t === "memories" ? "MEM" : t === "knowledge" ? "KNW" : t.slice(0, 3).toUpperCase();
  const stats = await printTableStatus(table, t, label);
  allStatsAfter[t] = stats;
}

console.log("");

// --- Summary ---

const totalFragmentsAfter = Object.values(allStatsAfter).reduce((s, st) => s + st.fragmentStats.numFragments, 0);
const reduction = totalFragmentsBefore - totalFragmentsAfter;
const pct = totalFragmentsBefore > 0 ? ((reduction / totalFragmentsBefore) * 100).toFixed(1) : "0";

console.log("── Summary ─────────────────────────────────────────────────");
console.log(`Total fragments: ${totalFragmentsBefore.toLocaleString()} → ${totalFragmentsAfter.toLocaleString()} (${reduction >= 0 ? "-" : "+"}${Math.abs(reduction).toLocaleString()}, ${pct}%)`);

if (totalFragmentsAfter > 100) {
  console.log("⚠️  Still above 100 fragments. Consider:");
  console.log("   1. Use batch inserts instead of row-by-row");
  console.log("   2. Run optimize more frequently");
  console.log("   3. Use --cleanup-days=0 to keep only latest version (careful!)");
} else {
  console.log("✓ Fragment count is healthy (≤100).");
}
