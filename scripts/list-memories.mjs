#!/usr/bin/env node
/**
 * List Memory Contents CLI
 * Usage: node scripts/list-memories.mjs [--scope=default] [--limit=50]
 */

import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const scope = args.find((a) => a.startsWith("--scope="))?.split("=")[1] || "default";
const limit = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "50", 10);

const dbPath = join(homedir(), ".openclaw", "memory", "lancedb-pro");

console.log(`[list-memories] DB path: ${dbPath}`);
console.log(`[list-memories] Scope: ${scope}`);
console.log(`[list-memories] Limit: ${limit}`);
console.log("");

// Dynamic import
const { loadLanceDB } = await import("../src/store.js");

const lancedb = await loadLanceDB();
const db = await lancedb.connect(dbPath);

const tableNames = await db.tableNames();
if (!tableNames.includes("memories")) {
  console.log("[list-memories] No memories table found. Database is empty.");
  process.exit(0);
}

const table = await db.openTable("memories");
const allMemories = await table.toArray();

// Filter by scope
const filtered = allMemories.filter((m) => m.scope === scope);

console.log(`Total memories in scope "${scope}": ${filtered.length}`);
console.log("");

// Sort by timestamp descending
filtered.sort((a, b) => b.timestamp - a.timestamp);

// Display
const toShow = filtered.slice(0, limit);
toShow.forEach((m, idx) => {
  const date = new Date(m.timestamp).toISOString().split("T")[0];
  console.log(`[${idx + 1}] ${date} | ${m.category} | importance=${m.importance.toFixed(2)}`);
  console.log(`    ${m.text.slice(0, 200)}${m.text.length > 200 ? "..." : ""}`);
  console.log("");
});

if (filtered.length > limit) {
  console.log(`... and ${filtered.length - limit} more (use --limit to show more)`);
}
