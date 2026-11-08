#!/usr/bin/env node
/**
 * Seed helper for scripts/verify-per-chat-usage.mjs — NOT a test of its
 * own. Opens the local PGlite data folder (while the API is STOPPED —
 * PGlite allows only one process per folder) and inserts the customers,
 * conversations and ai_usage_ledger rows from the seed JSON, plus one
 * extra customer + conversation with NO ledger rows (so the verifier can
 * assert a no-AI chat has no usage row).
 *
 * Usage: node scripts/seed-usage-verify.mjs <dataDir> <seedJson>
 *   dataDir is relative to apps/api (same as the API's DATABASE_URL).
 * Prints "seeded …" on success.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('/home/hatch/workspace/ai-sales-inbox/apps/api/package.json');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [,, dataDirArg, jsonPath] = process.argv;
if (!dataDirArg || !jsonPath) {
  console.error('usage: node scripts/seed-usage-verify.mjs <dataDir> <seedJson>');
  process.exit(1);
}
const dataDir = path.resolve(ROOT, 'apps/api', dataDirArg);
const seed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const db = new PGlite(dataDir);
await db.waitReady;
try {
  for (const c of seed.customers) {
    await db.query('INSERT INTO customers (id, workspace_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [c.id, seed.workspaceId, c.name]);
  }
  for (const c of seed.conversations) {
    await db.query('INSERT INTO conversations (id, workspace_id, customer_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [c.id, seed.workspaceId, c.customerId]);
  }
  let n = 0;
  for (const r of seed.ledgerRows) {
    await db.query(
      `INSERT INTO ai_usage_ledger (workspace_id, conversation_id, input_tokens, output_tokens, cost_paisa, provider, model, provider_cost_paisa)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [seed.workspaceId, r.conversationId, r.inputTokens, r.outputTokens, r.costPaisa, r.provider, r.model, r.providerCostPaisa],
    );
    n++;
  }
  // A customer + chat with no AI replies at all.
  const noAiCustomerId = crypto.randomUUID();
  const noAiConvId = crypto.randomUUID();
  await db.query('INSERT INTO customers (id, workspace_id, name) VALUES ($1, $2, $3)', [noAiCustomerId, seed.workspaceId, 'No AI Yet']);
  await db.query('INSERT INTO conversations (id, workspace_id, customer_id) VALUES ($1, $2, $3)', [noAiConvId, seed.workspaceId, noAiCustomerId]);
  console.log(`seeded ${n} ledger rows, ${seed.customers.length + 1} customers, ${seed.conversations.length + 1} conversations into ${dataDir}`);
} finally {
  await db.close();
}
