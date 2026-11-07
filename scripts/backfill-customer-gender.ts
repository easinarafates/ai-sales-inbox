/**
 * One-off backfill for migration 23: infer gender from the stored name
 * for every existing customer whose gender is still 'unknown'.
 * Run once against Neon:  npx tsx ../../scripts/backfill-customer-gender.ts
 * Prints a summary (total / filled male / filled female / left unknown).
 * Never overwrites a gender that is already male/female, and never
 * touches name_manually_set.
 */
import fs from 'node:fs';
import { neon } from '/home/hatch/workspace/.tools/node_modules/@neondatabase/serverless';
import { inferGenderFromName } from '../apps/api/src/customers/gender';

function parseEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

(async () => {
  const env = parseEnvFile('/home/hatch/workspace/ai-sales-inbox/.env.local');
  const sql = neon(env.DATABASE_URL);
  const rows = await sql.query(
    `SELECT id, workspace_id, name FROM customers WHERE gender = 'unknown' AND name IS NOT NULL`,
  ) as { id: string; workspace_id: string; name: string }[];
  let male = 0;
  let female = 0;
  let leftUnknown = 0;
  for (const row of rows) {
    const inferred = inferGenderFromName(row.name);
    if (inferred === 'unknown') {
      leftUnknown++;
      console.log(`unknown: ${row.name} (${String(row.id).slice(0, 8)})`);
      continue;
    }
    await sql.query(`UPDATE customers SET gender = $1 WHERE id = $2`, [inferred, row.id]);
    if (inferred === 'male') male++;
    else female++;
    console.log(`${inferred}: ${row.name} (${String(row.id).slice(0, 8)})`);
  }
  console.log(`\nBackfill done: ${rows.length} unknown-gender customers with names — ${male} male, ${female} female, ${leftUnknown} left unknown.`);
})().catch((e) => { console.error('BACKFILL ERR', e.message); process.exit(1); });
