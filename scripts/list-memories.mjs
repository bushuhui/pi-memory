#!/usr/bin/env node
/**
 * List Memory Contents CLI
 * Usage: node scripts/list-memories.mjs [--scope=default] [--limit=50] [--category=fact]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";

const args = process.argv.slice(2);
const scope = args.find((a) => a.startsWith("--scope="))?.split("=")[1] || null;
const limit = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "50", 10);
const category = args.find((a) => a.startsWith("--category="))?.split("=")[1] || null;

const dbPath = join(homedir(), ".openclaw", "memory", "lancedb-pro");

console.log(`[list-memories] DB path: ${dbPath}`);
console.log(`[list-memories] Scope: ${scope || "(all)"}`);
console.log(`[list-memories] Category: ${category || "(all)"}`);
console.log(`[list-memories] Limit: ${limit}`);
console.log("");

const db = await connect(dbPath);
const tableNames = await db.tableNames();

if (!tableNames.includes("memories")) {
  console.log("No memories table found. Database is empty.");
  process.exit(0);
}

const table = await db.openTable("memories");
const allMemories = await table.query().toArray();

// Filter
let filtered = allMemories;
if (scope) {
  filtered = filtered.filter((m) => m.scope === scope);
}
if (category) {
  filtered = filtered.filter((m) => m.category === category);
}

// Sort by timestamp descending
filtered.sort((a, b) => b.timestamp - a.timestamp);

// Collect scopes and categories for summary
const scopes = new Set(allMemories.map((m) => m.scope));
const categories = new Set(allMemories.map((m) => m.category));
console.log(`Total memories: ${allMemories.length}`);
console.log(`Scopes: ${[...scopes].join(", ")}`);
console.log(`Categories: ${[...categories].join(", ")}`);
console.log(`Filtered: ${filtered.length}`);
console.log("─".repeat(60));
console.log("");

// Display
const toShow = filtered.slice(0, limit);
toShow.forEach((m, idx) => {
  const date = new Date(m.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const imp = typeof m.importance === "number" ? m.importance.toFixed(2) : "?";
  console.log(`[${idx + 1}] ${date} | ${m.scope}:${m.category} | importance=${imp}`);
  console.log(`    ID: ${m.id}`);
  const text = typeof m.text === "string" ? m.text : String(m.text);
  console.log(`    ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
  console.log("");
});

if (filtered.length > limit) {
  console.log(`... and ${filtered.length - limit} more (use --limit=${filtered.length} to show all)`);
}
