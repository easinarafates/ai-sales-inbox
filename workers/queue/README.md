# Queue worker — Phase 1

BullMQ worker that processes debounced `inbox-messages` jobs by calling the
API's AI agent (`apps/api/src/ai-agent/agent.ts` → `processBatch`).

## How it works

1. A webhook (API) saves each inbound message and calls `enqueueMessage`
   (defined in `apps/api/src/queue/client.ts`, re-exported from `src/queue.ts`).
2. Enqueue uses `jobId: conv-<conversationId>` + 3s delay, so messages from
   the same customer within 3 seconds batch into one job. A duplicate enqueue
   while a job is delayed is ignored — the worker reloads the latest messages
   from the DB when the job runs, so nothing is lost.
3. The worker loads the last 10 inbound messages for the conversation and
   calls `processBatch(workspaceId, conversationId, batchedMessages)`.

## Run

```bash
cd workers/queue
npm install
npm run build
npm start        # or: npm run dev
```

Needs Postgres + Redis (see `infra/docker-compose.yml`) and a `.env` in this
folder (or exported env) with the same values as the API: `DATABASE_URL`,
`REDIS_URL`, `GEMINI_API_KEY`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`,
`AI_MODEL`, `FREE_CREDIT_PAISA`.

## Why the relative import

`src/worker.ts` imports the agent from `../../../apps/api/src/ai-agent/agent`
so there is exactly one copy of the agent logic. The worker's `tsconfig.json`
includes those API sources (no `rootDir`, so `tsc` mirrors them under
`dist/`), and its `package.json` carries the runtime deps the agent needs
(`pg`, `dotenv`). If the API is later published as a package, swap this
import for the package import — the job code does not change.
