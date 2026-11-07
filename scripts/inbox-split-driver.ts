// Driver for verify-inbox-split.mjs — flips one channel to 'disconnected'
// DIRECTLY against the same PGlite dir the verifier's API boot uses.
// Run AFTER the API boot stops (PGlite is single-process; the API holds
// the lock while it runs), with:
//   USE_PGLITE=true PGLITE_DATA_DIR=<dir> npx tsx scripts/inbox-split-driver.ts <channelId>
// Prints one DRIVER_RESULT JSON line for the verifier to parse.
import { pool } from '../apps/api/src/db/pool';

const [channelId] = process.argv.slice(2);
if (!channelId) {
  console.error('usage: inbox-split-driver.ts <channelId>');
  process.exit(2);
}

async function main(): Promise<void> {
  const r = await pool.query(
    "UPDATE channels SET status = 'disconnected', updated_at = now() WHERE id = $1 RETURNING id, platform, external_id, status",
    [channelId],
  );
  const row = (r.rows[0] as Record<string, unknown> | undefined) ?? null;
  console.log(`DRIVER_RESULT ${JSON.stringify({ disconnected: !!row, row })}`);
  await pool.end();
}

main().catch((err) => {
  console.error('driver failed:', (err as Error).message);
  process.exit(1);
});
