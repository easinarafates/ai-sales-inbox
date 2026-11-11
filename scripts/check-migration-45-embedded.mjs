#!/usr/bin/env node
// Verifies the embedded SQL in apps/api/src/db/migrate-prod.ts is an
// exact copy of apps/api/src/db/migrations/45-owner-panel-manage.sql
// (modulo the backtick escaping a template literal needs).
// Run from the repo root: node scripts/check-migration-45-embedded.mjs
import fs from 'node:fs';
const sql = fs.readFileSync('apps/api/src/db/migrations/45-owner-panel-manage.sql', 'utf8');
const ts = fs.readFileSync('apps/api/src/db/migrate-prod.ts', 'utf8');
const m = ts.match(/const MIGRATION_45_SQL = `([\s\S]*?)`;/);
if (!m) { console.error('FAIL: MIGRATION_45_SQL constant not found'); process.exit(1); }
if (m[1].replace(/\\`/g, '`') === sql) { console.log('OK: embedded migration 45 SQL matches 45-owner-panel-manage.sql exactly'); process.exit(0); }
console.error('FAIL: embedded SQL differs from 45-owner-panel-manage.sql — regenerate migrate-prod.ts from the .sql file');
process.exit(1);
