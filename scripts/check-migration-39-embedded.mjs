#!/usr/bin/env node
// Verifies the embedded SQL in apps/api/src/db/migrate-prod.ts is an
// exact copy of apps/api/src/db/migrations/39-ai-prompt-cache.sql
// (modulo the backtick escaping a template literal needs).
// Run from the repo root: node scripts/check-migration-39-embedded.mjs
import fs from 'node:fs';
const sql = fs.readFileSync('apps/api/src/db/migrations/39-ai-prompt-cache.sql', 'utf8');
const ts = fs.readFileSync('apps/api/src/db/migrate-prod.ts', 'utf8');
const m = ts.match(/const MIGRATION_39_SQL = `([\s\S]*?)`;/);
if (!m) { console.error('FAIL: MIGRATION_39_SQL constant not found'); process.exit(1); }
if (m[1].replace(/\\`/g, '`') === sql) { console.log('OK: embedded migration 39 SQL matches 39-ai-prompt-cache.sql exactly'); process.exit(0); }
console.error('FAIL: embedded SQL differs from 39-ai-prompt-cache.sql — regenerate migrate-prod.ts from the .sql file');
process.exit(1);
