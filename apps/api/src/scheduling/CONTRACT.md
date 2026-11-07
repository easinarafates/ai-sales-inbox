# Module B — Phase 2 Backend: Scheduling, Follow-ups/Leads, Analytics, AI Teaching Tools

Owner: Module B. Files owned: `apps/api/src/scheduling/*`, `apps/api/src/leads/*`,
`apps/api/src/followups/*`, `apps/api/src/analytics/*`, `apps/api/src/knowledge/routes.ts`
(additions only), `apps/api/src/db/migrations/02-phase2-engagement.sql`.

All routes are JWT-protected (`requireAuth`) and every query filters by
`workspace_id` through the `query(workspaceId, …)` helper. Bengali
user-facing messages. Prices/stock are never invented — the AI caption and
knowledge-preview prompts are told to use only the data given to them.

## Wiring (coordinator)

```ts
// apps/api/src/index.ts — mount at /api (routers already carry full paths)
import { schedulingRouter } from './scheduling/routes';
import { leadsRouter } from './leads/routes';
import { followupsRouter } from './followups/routes';
import { analyticsRouter } from './analytics/routes';
app.use('/api', schedulingRouter);
app.use('/api', leadsRouter);
app.use('/api', followupsRouter);
app.use('/api', analyticsRouter);
// knowledgeRouter is already mounted at /api.
```

Apply the migration before starting the API:

```bash
psql "$DATABASE_URL" -f apps/api/src/db/migrations/02-phase2-engagement.sql
```

Worker (coordinator wires it; a BullMQ Worker on queue `'scheduled-posts'`):

```ts
// on job { postId, workspaceId } -> publishScheduledPost(workspaceId ?? <lookup>, postId)
// plus a polling sweep (e.g. every minute) as a fallback when Redis is down:
await processDueScheduledPosts();   // scheduled-posts due sweep
await processDueFollowups();        // follow-ups due sweep (no arg = all workspaces)
```

## Routes

### Scheduling — `scheduling/routes.ts`

| Method & path | Body / query | Result |
|---|---|---|
| GET `/scheduled-posts?status=&platform=` | filters | `{posts: [...]}` |
| POST `/scheduled-posts` | `{caption, mediaUrls?, platforms[], scheduledAt?, productIds?}` | 201 `{post}` — `draft` unless `scheduledAt` given, then `scheduled`; also enqueues the publish job |
| GET `/scheduled-posts/calendar?month=YYYY-MM` | — | `{month, days: {[date]: Post[]}}`, dates in Bangladesh time (Asia/Dhaka, UTC+6) |
| GET `/scheduled-posts/:id` | — | `{post, products}` |
| PATCH `/scheduled-posts/:id` | `{caption?, mediaUrls?, scheduledAt?, status?}` | `{post}` — `status` must be `draft`/`scheduled`/`cancelled`; `scheduled` needs a `scheduledAt` |
| DELETE `/scheduled-posts/:id` | — | `{deleted: true}` — draft only, otherwise 400 |
| POST `/scheduled-posts/:id/schedule` | `{scheduledAt}` | `{post}` (status `scheduled`, job enqueued) |
| POST `/scheduled-posts/:id/publish-now` | — | `{post}` after publishing |
| POST `/scheduled-posts/:id/attach-product` | `{productId}` | 201 `{postProduct}` |
| DELETE `/scheduled-posts/:id/products/:productId` | — | `{deleted: true}` |
| POST `/scheduled-posts/:id/ai-caption` | `{productIds?}` | `{caption, aiGenerated}` — Bengali caption + hashtags via `callGroq` from the post caption / product names; with no AI key returns a plain template caption with `aiGenerated: false` and a Bengali note |

Note: the schema's status comment lists `draft | scheduled | publishing | published | failed`;
`cancelled` is additionally accepted by PATCH (cancel) as specified for this module.

### Leads — `leads/routes.ts`

| Method & path | Body | Result |
|---|---|---|
| GET `/leads` | — | `{leads: [{id, customer_id, need, follow_up_at, call_at, outcome, created_at}]}` |
| POST `/leads` | `{customerId, need?, followUpAt?, callAt?}` | 201 `{lead}` (customer must exist in the workspace) |
| PATCH `/leads/:id` | `{need?, followUpAt?, callAt?, outcome?}` | `{lead}` |

`call_at` is the time the customer asked to be called (PDF §4) — added by
migration `02-phase2-engagement.sql`.

### Follow-ups — `followups/routes.ts` + `followups/engine.ts`

| Method & path | Body / query | Result |
|---|---|---|
| GET `/followups?status=` | — | `{followups: [...]}` (includes `customer_id` via the lead) |
| POST `/followups` | `{leadId?, customerId?, message, sendAt}` | 201 `{followup}` — at least one of `leadId`/`customerId`; a bare `customerId` reuses their latest lead or creates one (the `followups` table has no `customer_id` column — the customer is always reached via the lead) |
| PATCH `/followups/:id` | `{message?, sendAt?, status?}` | `{followup}` |
| POST `/followups/:id/send-now` | — | `{followup, stopped, reason}` — smart stop rules still apply |
| POST `/followups/run` | — | `{processed, sent, stopped, failed}` — manual trigger |

### Analytics — `analytics/routes.ts`

| Method & path | Query | Result |
|---|---|---|
| GET `/analytics/overview?range=today\|yesterday\|7d\|30d` | default `7d` | `{range, conversations, orders, aiHandledPct, humanHandoverCount, avgCostPaisa, orderSource: {ai, product_page, team, website, other}}` |

- `aiHandledPct` = share of conversations in range with `mode='ai'` and no ticket.
- `humanHandoverCount` = conversations currently `mode='human'` with `updated_at` in range
  (proxy — the schema keeps no mode-change history) + tickets created in range.
- `avgCostPaisa` = average `cost_paisa` from `ai_usage_ledger` in range (0 if none).
- Ranges use Bangladesh calendar days (UTC+6); `7d`/`30d` are rolling windows.

### AI teaching tools — `knowledge/routes.ts` (additions; PATCH/DELETE kept)

| Method & path | Body | Result |
|---|---|---|
| POST `/unanswered/:id/teach` | `{answer}` | 201 `{knowledgeItem}` — inserts a `knowledge_items` row (`title` = question, `body` = answer) and marks the unanswered row `taught=true` |
| POST `/knowledge/preview-change` | `{knowledgeId?, instruction}` | `{preview, aiGenerated}` — `callGroq` rewrites the body per the plain-language instruction; **never saves**. Without `knowledgeId`, drafts from the instruction alone. Without an AI key, returns the current body with `aiGenerated: false` and a Bengali note. |
| POST `/knowledge/apply-change` | `{knowledgeId, newBody}` | `{knowledgeItem, versionId}` — previous body saved to `knowledge_versions` first, then updated |
| POST `/knowledge/:id/rollback` | `{versionId}` | `{knowledgeItem}` — restores the body from `knowledge_versions` (current body saved as a new version first, so a rollback can be rolled back) |

## Exported functions

- `scheduling/publisher.ts` — `publishScheduledPost(workspaceId, postId): Promise<ScheduledPostRow>`;
  `processDueScheduledPosts(): Promise<{processed, published, failed}>` (all workspaces).
- `scheduling/queue.ts` — `enqueueScheduledPost(postId, runAt, workspaceId?)`;
  queue name `'scheduled-posts'`; `scheduledPostsQueue` exported for the worker.
- `followups/engine.ts` — `processDueFollowups(workspaceId?): Promise<{processed, sent, stopped, failed}>`;
  `sendFollowup(workspaceId, followupId)` (shared by send-now and the sweep);
  `suggestFollowUpAt(workspaceId, customerId): Promise<Date>` (last interaction + 2 days).
- Follow-up smart rules (see `followups/engine.ts` header): stop (`status='stopped'`)
  if the customer replied after the last follow-up, or after 3 follow-ups with no reply.

## Approval gates — what is NOT live yet

- **Real Meta publishing is LIVE for Facebook (2026-11-07).**
  `publishScheduledPost` sends for real via `sendPagePost` (Graph v21.0,
  the workspace's stored Page token): text → `/{page-id}/feed`, one
  image → `/{page-id}/photos`, several images → unpublished uploads +
  one feed post with `attached_media`, video → `/{page-id}/videos`.
  A post is 'published' only when Graph returns a real post id; a
  failure is logged in `post_publish_logs` with Meta's message and the
  post ends 'failed' (the Schedule page shows the reason). It needs
  `pages_manage_posts` on the Page token — tokens granted before that
  scope was added must have the Page reconnected once (Login with
  Facebook). The cron sweep (`/api/cron/sweep` every 5 min via GitHub
  Actions) publishes due posts; opening the Schedule page also runs a
  lazy sweep for the workspace, so an overdue post publishes then even
  if the cron workflow is broken. NOTE: the GitHub workflow
  `.github/workflows/cron-sweep.yml` must call the Vercel API URL
  (https://ai-sales-inbox-api.vercel.app/api/cron/sweep) — it used to
  call https://api.yearmedia.xyz, which does not serve the API, so the
  sweep never ran until the URL was fixed (edit the file on GitHub;
  the App cannot push workflow files).
- **TikTok scheduling is audit-gated.** Until `TIKTOK_SCHEDULING_AUDITED=true`,
  TikTok posts are recorded in `post_publish_logs` as failed (`TikTok audit pending`)
  and skipped — never published. Per the PDF, TikTok posting is a Phase 3 item
  (after the Content Posting API audit); Facebook/Instagram scheduling is Phase 2.
- **Follow-up delivery is a stub** in the same sense: the message is saved as an
  outbound inbox message; actual delivery to Messenger/Instagram goes through the
  Meta send step once approval exists. Broadcasts must stay inside Meta's
  24-hour messaging window (PDF §4).
- Retries: a failed publish is retried up to **3 attempts total**, then status
  `failed`; every attempt is recorded in `post_publish_logs` so the owner sees why.
