#!/usr/bin/env node
/**
 * Post-attribution verification (standalone, fresh signup — same pattern
 * as scripts/verify-e2e.mjs). Run while the API is up:
 *   node scripts/verify-post-attribution.mjs
 *   API_URL=http://localhost:4001 node scripts/verify-post-attribution.mjs
 *
 * Flow: signup → product → facebook_comment channel → scheduled post +
 * publish-now (stub platform_post_id) → Facebook comment webhook on that
 * post → team order from the resulting conversation → GET
 * /api/analytics/posts.
 *
 * Core proof the gap is fixed: the attributed post shows comments >= 1,
 * chats >= 1 AND orders >= 1 (before this fix chats/orders were always 0).
 * Control: a second post with no comments shows 0 / 0 / 0 (honest zeros,
 * never invented). A second commenter raises chats to >= 2.
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
const API = process.env.API_URL ?? 'http://localhost:4000';
const results = [];
let token = '';
let workspaceId = '';
let product = null;
let postId = '';
let platformPostId = '';
let controlPostId = '';
let conversationId = '';
let customerId = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = await fn();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function sendFbComment(commentId, senderId, senderName, text) {
  return api('/api/webhooks/meta', {
    method: 'POST',
    auth: false,
    body: {
      object: 'page',
      entry: [
        {
          id: 'page-verify-post-attr',
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                message: text,
                comment_id: commentId,
                post_id: platformPostId,
                from: { id: senderId, name: senderName },
              },
            },
          ],
        },
      ],
    },
  });
}

async function main() {
  const stamp = Date.now();
  const email = `postattr+${stamp}@example.com`;

  // 1. Health
  const health = await api('/api/health', { auth: false });
  check('API health', health.status === 200 && health.data?.status === 'ok', JSON.stringify(health.data));

  // 2. Signup (fresh workspace)
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    auth: false,
    body: { name: 'PostAttr Owner', email, password: 'verify1234', workspaceName: 'PostAttr Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';

  // 3. One product
  const p1 = await api('/api/products', {
    method: 'POST',
    body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি — লাল' },
  });
  product = p1.data?.product ?? null;
  check('add product (শাড়ি, ৳1500)', p1.status === 201 && !!product?.id, `status=${p1.status}`);

  // 4. Facebook-comment channel (page that receives the comments)
  const channel = await api('/api/channels', {
    method: 'POST',
    body: { platform: 'facebook_comment', externalId: 'page-verify-post-attr', displayName: 'Verify FB Page' },
  });
  check('connect facebook_comment channel', channel.status === 201, `status=${channel.status}`);

  // 5. Scheduled post + publish-now (stub platform_post_id)
  const sp = await api('/api/scheduled-posts', {
    method: 'POST',
    body: { caption: 'ঈদ অফার! শাড়ি মাত্র ৳১৫০০', platforms: ['facebook'], productIds: [product.id] },
  });
  postId = sp.data?.post?.id ?? '';
  check('create scheduled post (draft)', sp.status === 201 && !!postId, `status=${sp.status}`);
  const pub = await api(`/api/scheduled-posts/${postId}/publish-now`, { method: 'POST' });
  platformPostId = pub.data?.post?.platform_post_id ?? '';
  check('publish-now → published (stub platform id)', pub.status === 200 && pub.data?.post?.status === 'published' && String(platformPostId).startsWith('stub-'), `platform_post_id=${platformPostId}`);

  // 6. Control post: draft, never published, no comments — must stay 0/0/0.
  const ctrl = await api('/api/scheduled-posts', {
    method: 'POST',
    body: { caption: 'কন্ট্রোল পোস্ট — কোনো কমেন্ট নেই', platforms: ['facebook'] },
  });
  controlPostId = ctrl.data?.post?.id ?? '';
  check('create control post (no comments)', ctrl.status === 201 && !!controlPostId, `status=${ctrl.status}`);

  // 7. Facebook comment on the published post → conversation in inbox
  const hook = await sendFbComment(`cmt-${stamp}-1`, 'fb-user-1', 'নুসরাত', 'শাড়িটার দাম কত?');
  check('comment webhook accepted', hook.status === 200, `status=${hook.status}`);
  const detail = await waitFor(async () => {
    const list = await api('/api/inbox');
    const conv = (list.data?.conversations ?? [])[0];
    if (!conv) return null;
    const d = await api(`/api/inbox/${conv.id}`);
    return d.data?.conversation ? d.data : null;
  }, 20000, 'comment conversation').catch((e) => {
    check('comment creates a conversation', false, e.message);
    return null;
  });
  if (detail) {
    conversationId = detail.conversation.id;
    customerId = detail.customer?.id ?? '';
    check('comment creates a conversation', true, `conv=${conversationId.slice(0, 8)}`);
  }

  // 8. Team order from that conversation (the attribution's order link)
  const teamOrder = await api('/api/orders', {
    method: 'POST',
    body: { customerId, conversationId, items: [{ productId: product.id, quantity: 1 }], source: 'team' },
  });
  check('create order from the comment conversation (1 × শাড়ি = ৳1500)', teamOrder.status === 201 && Number(teamOrder.data?.order?.total_paisa) === 150000, `status=${teamOrder.status}, total=${teamOrder.data?.order?.total_paisa}`);

  // 9. THE CORE PROOF: /api/analytics/posts for the attributed post.
  const ap = await api('/api/analytics/posts');
  const row = (ap.data?.posts ?? []).find((p) => p.postId === postId);
  check('analytics posts loads and contains the post', ap.status === 200 && !!row, `posts=${(ap.data?.posts ?? []).length}`);
  if (row) {
    console.log(`   attributed post: comments=${row.comments} chats=${row.chats} orders=${row.orders}`);
    check('attributed post: comments >= 1', Number(row.comments) >= 1, `comments=${row.comments}`);
    check('attributed post: chats >= 1 (was always 0 before the fix)', Number(row.chats) >= 1, `chats=${row.chats}`);
    check('attributed post: orders >= 1 (was always 0 before the fix)', Number(row.orders) >= 1, `orders=${row.orders}`);
  } else {
    check('attributed post: comments >= 1', false, 'post missing from analytics');
    check('attributed post: chats >= 1 (was always 0 before the fix)', false, 'post missing from analytics');
    check('attributed post: orders >= 1 (was always 0 before the fix)', false, 'post missing from analytics');
  }

  // 10. Control post: honest zeros.
  const ctrlRow = (ap.data?.posts ?? []).find((p) => p.postId === controlPostId);
  if (ctrlRow) {
    console.log(`   control post: comments=${ctrlRow.comments} chats=${ctrlRow.chats} orders=${ctrlRow.orders}`);
    check('control post (no comments) shows 0 / 0 / 0', Number(ctrlRow.comments) === 0 && Number(ctrlRow.chats) === 0 && Number(ctrlRow.orders) === 0, `comments=${ctrlRow.comments}, chats=${ctrlRow.chats}, orders=${ctrlRow.orders}`);
  } else {
    check('control post (no comments) shows 0 / 0 / 0', false, 'control post missing from analytics');
  }

  // 11. Second commenter on the same post → chats rises to >= 2.
  await sendFbComment(`cmt-${stamp}-2`, 'fb-user-2', 'রহিম', 'আমার একটা লাগবে!');
  const ap2 = await waitFor(async () => {
    const r = await api('/api/analytics/posts');
    const p = (r.data?.posts ?? []).find((x) => x.postId === postId);
    return p && Number(p.chats) >= 2 ? p : null;
  }, 20000, 'second chat attributed').catch(() => null);
  check('second commenter raises chats to >= 2', !!ap2, ap2 ? `chats=${ap2.chats}` : 'chats stayed < 2');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('Failed:');
    for (const f of failed) console.log(` - ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Verification crashed:', err);
  process.exit(1);
});
