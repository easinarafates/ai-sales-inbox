/**
 * Demo seed — ONLY runs when SEED_DEMO=true.
 * Creates one demo workspace + owner user + sample products + knowledge items.
 * Clearly marked demo data; never run against a real workspace.
 */
import bcrypt from 'bcryptjs';
import { config } from './config';
import { pool } from './db/pool';

async function main(): Promise<void> {
  if (!config.seedDemo) {
    console.log('Seed skipped: set SEED_DEMO=true to run the demo seed.');
    return;
  }
  const email = 'demo@example.com';
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount && existing.rowCount > 0) {
    console.log('Demo user already exists — skipping seed.');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ws = await client.query(
      "INSERT INTO workspaces (name, balance_paisa, ai_enabled, practice_mode) VALUES ('Demo Shop', $1, TRUE, TRUE) RETURNING id",
      [config.freeCreditPaisa],
    );
    const workspaceId = ws.rows[0].id as string;
    const passwordHash = await bcrypt.hash('demo1234', 10);
    const user = await client.query(
      'INSERT INTO users (workspace_id, email, password_hash, name) VALUES ($1, $2, $3, $4) RETURNING id',
      [workspaceId, email, passwordHash, 'Demo Owner'],
    );
    await client.query('INSERT INTO members (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
      workspaceId,
      user.rows[0].id,
      'owner',
    ]);
    await client.query(
      "INSERT INTO wallet_transactions (workspace_id, type, amount_paisa) VALUES ($1, 'topup', $2)",
      [workspaceId, config.freeCreditPaisa],
    );
    const products: [string, number, number, string][] = [
      ['ডেমো শাড়ি', 150000, 10, 'সুতির ডেমো শাড়ি — লাল রঙ'],
      ['ডেমো পাঞ্জাবি', 120000, 5, 'সুতির ডেমো পাঞ্জাবি — সাদা'],
      ['ডেমো থ্রি-পিস', 180000, 8, 'ডেমো থ্রি-পিস সেট'],
    ];
    for (const [name, price, stock, description] of products) {
      await client.query(
        'INSERT INTO products (workspace_id, name, price_paisa, stock, description) VALUES ($1, $2, $3, $4, $5)',
        [workspaceId, name, price, stock, description],
      );
    }
    const knowledge: [string, string][] = [
      ['ডেলিভারি', 'ঢাকার ভেতরে ডেলিভারি চার্জ ৬০ টাকা, ঢাকার বাইরে ১২০ টাকা। ডেলিভারি সময় ২-৩ দিন।'],
      ['পেমেন্ট', 'ক্যাশ অন ডেলিভারি এবং বিকাশ — দুটোতেই পেমেন্ট নেওয়া হয়।'],
    ];
    for (const [title, body] of knowledge) {
      await client.query(
        'INSERT INTO knowledge_items (workspace_id, title, body) VALUES ($1, $2, $3)',
        [workspaceId, title, body],
      );
    }
    // Test customer for practice mode (is_test flag — see ai-agent/agent.ts).
    await client.query(
      `INSERT INTO customers (workspace_id, name, channel_identities)
       VALUES ($1, 'Test Customer', '[{"platform":"webchat","senderId":"test-owner","is_test":true}]'::jsonb)`,
      [workspaceId],
    );
    await client.query('COMMIT');
    console.log('Demo seed done.');
    console.log('  Login: demo@example.com / demo1234 (DEMO ONLY — change immediately)');
    console.log(`  Workspace: ${workspaceId} (practice_mode=true, balance ${config.freeCreditPaisa} paisa)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
