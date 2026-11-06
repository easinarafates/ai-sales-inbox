#!/usr/bin/env node
/**
 * Embeddings provider check helper (run by scripts/verify-tiktok-embeddings.mjs).
 * Usage: node scripts/check-embeddings.mjs --mode stub|url-no-key|full
 * Env (set by the caller BEFORE import — config reads env at import time):
 *   DATABASE_URL, JWT_SECRET, TOKEN_ENCRYPTION_KEY (dummy values are fine —
 *   the stub path never touches the DB), EMBEDDING_PROVIDER,
 *   EMBEDDING_API_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL.
 * Prints ONE JSON block between __EMB_JSON_START__ / __EMB_JSON_END__.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'stub';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') });
}

async function main() {
  process.env.JWT_SECRET ??= 'check-jwt-secret';
  process.env.TOKEN_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.DATABASE_URL ??= 'pglite:///tmp/emb-check-unused';

  const dist = (p) => pathToFileURL(path.join(API_DIR, 'dist', p)).href;
  const imageMatch = await import(dist('ai-agent/image-match.js'));
  const embeddings = await import(dist('ai-agent/embeddings-openai.js'));

  const provider = imageMatch.getEmbeddingProvider();
  const providerName = provider.constructor.name;

  if (mode === 'stub') {
    check('default provider is the stub', providerName === 'StubEmbeddingProvider', providerName);
    const r = await imageMatch.matchProductsByImage('00000000-0000-0000-0000-000000000000', 'https://example.com/img.jpg');
    check('stub matchProductsByImage reports available:false', r.available === false && r.matches.length === 0, JSON.stringify(r));
    check('stub message is the honest Bengali note', typeof r.message === 'string' && r.message.includes('ছবি দিয়ে খোঁজা এখনো চালু হয়নি'), r.message ?? '');
  } else if (mode === 'url-no-key') {
    check('URL set but no key → still the stub (no crash)', providerName === 'StubEmbeddingProvider', providerName);
    const r = await imageMatch.matchProductsByImage('00000000-0000-0000-0000-000000000000', 'https://example.com/img.jpg');
    check('URL-without-key reports available:false', r.available === false, JSON.stringify(r));
  } else if (mode === 'full') {
    check('full config → OpenAI-compatible provider (not stub)', providerName === 'OpenAICompatibleEmbeddingProvider', providerName);
    check('provider reports itself configured', typeof provider.isConfigured === 'function' && provider.isConfigured() === true, '');
    // Unreachable URL (connection refused) must return null — no crash, no fake vector.
    const t = await provider.embedText('hello');
    check('embedText to unreachable endpoint returns null (no fake)', t === null, `got=${t === null ? 'null' : typeof t}`);
    const img = await provider.embedImage('https://example.com/img.jpg');
    check('embedImage to unreachable endpoint returns null (no fake)', img === null, `got=${img === null ? 'null' : typeof img}`);
    // matchProductsByImage with a failing provider → available:false, never a fake match.
    const r = await imageMatch.matchProductsByImage('00000000-0000-0000-0000-000000000000', 'https://example.com/img.jpg');
    check('failing provider → available:false, zero matches', r.available === false && r.matches.length === 0, JSON.stringify(r));
  } else {
    check('unknown mode', false, mode);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('__EMB_JSON_START__');
  console.log(JSON.stringify({ mode, passed: results.length - failed.length, total: results.length, checks: results }));
  console.log('__EMB_JSON_END__');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.log('__EMB_JSON_START__');
  console.log(JSON.stringify({ mode, passed: 0, total: 1, checks: [{ name: 'embeddings check crashed', ok: false, detail: err.message }] }));
  console.log('__EMB_JSON_END__');
  process.exit(1);
});
