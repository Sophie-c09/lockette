# Inventory Growth — Render Background Worker

Moves Inventory Growth batch execution out of Vercel's request-bounded
`process-batch` route and into one dedicated, continuously-running
process on Render. See `src/workers/inventory-growth-worker.ts`'s own
header comment for the full architecture and motivation (a real batch has
been observed taking ~268s end to end — longer than the Vercel route's
own 50s-per-attempt watchdog can ever accommodate).

## Responsibilities

| | Vercel (unchanged) | Render worker |
|---|---|---|
| Web app, admin dashboard, auth | ✅ | — |
| Creating jobs, pause/resume/cancel | ✅ | — |
| Displaying progress/errors | ✅ | — |
| Claiming jobs, discovery, extraction, Playwright | — (when `INVENTORY_WORKER_MODE=external`) | ✅ |
| Job progress, heartbeat, retry/recovery, target completion | — | ✅ |

## Required environment variables (names only — see Render's dashboard for values)

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `INVENTORY_WORKER_MODE` — set to `external` on **both** the worker and
  the Vercel deployment once the worker is live (see below).
- `WORKER_ID` (optional — a fixed identity across restarts; auto-generated if unset)
- `WORKER_IDLE_POLL_INTERVAL_MS`, `WORKER_LEASE_RENEWAL_INTERVAL_MS`,
  `WORKER_BATCH_TIMEOUT_MS`, `WORKER_SHUTDOWN_GRACE_MS`,
  `WORKER_HEARTBEAT_INTERVAL_MS` (optional tuning — see `scraper-config.ts`
  for defaults)
- `MAX_ACTIVE_BROWSERS`, `MAX_EXTRACTION_CONCURRENCY`, `DISCOVERY_CONCURRENCY`
  (optional concurrency tuning, same variables the Vercel app already reads)

Never commit secret values anywhere in this repo — `render.yaml` lists
variable **names** only (`sync: false`); enter real values directly in the
Render dashboard.

## Deploying

1. Push this branch (including `render.yaml`, `Dockerfile.worker`,
   `src/workers/inventory-growth-worker.ts`) to the connected Git remote.
2. In the Render dashboard: **New → Blueprint**, point it at this repo —
   Render reads `render.yaml` and provisions the `inventory-growth-worker`
   background worker service.
3. Fill in every `sync: false` environment variable listed above in the
   Render dashboard (Environment tab).
4. Apply the database migration this worker needs:
   `supabase/migrations/20260805000000_add_inventory_worker_support.sql`
   (via `supabase db push`, or paste its contents into the Supabase SQL
   editor). The worker's core job-processing loop works even without this
   migration (every write it makes is best-effort/tiered-fallback, the
   same posture as every other `scraper_jobs` column in this codebase) —
   only the observational `batch_worker_id` column and the admin
   dashboard's worker-health card depend on it.
5. Deploy the service (Render builds `Dockerfile.worker` and starts
   `npx tsx src/workers/inventory-growth-worker.ts`).
6. Confirm it's alive: check the Render service's logs for
   `[inventory-growth-worker] Starting — worker_id=...`, then check the
   admin dashboard's Inventory Growth card — once `INVENTORY_WORKER_MODE`
   is also set to `external` on Vercel (redeploy required), the card shows
   a "Render worker: online" line.
7. Only once the worker is confirmed online: set `INVENTORY_WORKER_MODE=external`
   on the Vercel project too, and redeploy. Until this step, Vercel keeps
   running batches itself (embedded/local mode) — the two modes are
   mutually exclusive per job (the same `batch_lease_id` mutex either
   caller uses prevents any overlap), but only one should be "actively
   trying" at a time to avoid every dashboard poll tick doing pointless
   lease-claim attempts against a worker that's already handling it.

## Operational health

The admin dashboard (`/admin` → Inventory Growth card, when
`INVENTORY_WORKER_MODE=external`) shows:

- **Render worker: online** — a worker's heartbeat (`inventory_worker_status`
  table) is fresh (within `WORKER_STALE_THRESHOLD_MS`, 90s default).
- **Render worker: stale** — a worker has reported in before, but its last
  heartbeat is old; it may have crashed or be restarting. Jobs stay queued
  and resume automatically once it's back (nothing is lost — see the
  lease/checkpoint model below).
- **Render worker: not configured** — no worker has ever reported in
  (migration not applied yet, or the service was never deployed/started).

Server-side, the same data is available at
`GET /api/admin-scraper/large-scale/metrics` (`workerStatus`, `workers[]`).

## Restart / crash recovery

- The worker's own process crashing (or a manual restart) loses no
  committed progress: every write is guarded by the job's `batch_lease_id`
  (only the current, unexpired lease holder can write), and the job's
  `checkpoint` column persists `seenUrls`/resolved options between units —
  the exact same mechanism the pre-existing pause/resume flow already
  relies on.
- A lease left behind by a crashed worker naturally expires after
  `BATCH_LEASE_DURATION_MS` (90s, `scraper-jobs.ts`) with no renewal
  arriving; once expired, this same worker (on restart) or any future
  additional worker can reclaim the job and continue from its last
  committed checkpoint.

## Known limitation (disclosed, not fixed by this migration)

Playwright's `page.goto()`/browser navigation has no native abort support.
When a batch's own internal watchdog fires (a genuinely hung attempt) or
the worker receives SIGTERM mid-unit, the abort signal propagates and
closes pages/contexts immediately, but if the underlying operation doesn't
respond within its grace period, the attempt's promise can keep running
detached in the background for some time afterward (this has been
observed taking several minutes in a real production run). Its eventual
writes remain safe (same lease, monotonic, never corrupting) — see
`runBatchUnit`'s own comment — but this means "no writes at all after N
seconds" cannot be strictly guaranteed for every real batch, only "no
*unsafe* writes." This is an inherent Playwright/OS-process constraint,
not something this migration's lease model can fully close.
