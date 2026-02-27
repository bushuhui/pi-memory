import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });

async function createSourceDb(sourceDbPath) {
  // Create a minimal LanceDB database with a `memories` table and 1 row.
  const { loadLanceDB } = jiti("../src/store.ts");
  const lancedb = await loadLanceDB();
  const db = await lancedb.connect(sourceDbPath);

  // Create table if missing.
  // LanceDB JS API supports createTable(name, data).
  const row = {
    id: "test_smoke_1",
    text: "hello from smoke test",
    category: "other",
    scope: "global",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: "{}",
    vector: [0, 0, 0, 0],
  };

  try {
    await db.createTable("memories", [row]);
  } catch {
    // If already exists, ignore.
    const table = await db.openTable("memories");
    await table.add([row]);
  }
}

async function runCliSmoke() {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-lancedb-pro-smoke-"));
  const sourceDbPath = path.join(workDir, "source-db");

  await createSourceDb(sourceDbPath);

  const { createMemoryCLI } = jiti("../cli.ts");

  const program = new Command();
  program.exitOverride();

  const context = {
    // Minimal store interface for reembed dry-run.
    store: { dbPath: path.join(workDir, "target-db") },
    retriever: {},
    scopeManager: {},
    migrator: {},
    // Presence required, but dry-run exits before embeddings.
    embedder: {},
  };

  // Register commands under `memory-pro`
  createMemoryCLI(context)({ program });

  // 1) version command should not throw
  await program.parseAsync(["node", "openclaw", "memory-pro", "version"]);

  // 2) reembed dry-run should not crash (regression test for clampInt)
  await program.parseAsync([
    "node",
    "openclaw",
    "memory-pro",
    "reembed",
    "--source-db",
    sourceDbPath,
    "--limit",
    "1",
    "--batch-size",
    "999",
    "--dry-run",
  ]);

  rmSync(workDir, { recursive: true, force: true });
}

runCliSmoke()
  .then(() => {
    console.log("OK: CLI smoke test passed");
  })
  .catch((err) => {
    console.error("FAIL: CLI smoke test failed");
    console.error(err);
    process.exit(1);
  });
