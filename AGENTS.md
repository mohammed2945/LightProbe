# AGENTS.md — RideRush / Chaos Arena Backend

## What this project is
The backend for "Chaos Arena — Break the City": a deliberately breakable fake
ride-sharing system (RideRush) used in a live hackathon demo. Six chaos faults
get injected on stage; an AI SRE agent (separate workstream) detects and
resolves them. This code runs live in front of judges and on camera.
Reliability and determinism beat elegance, always.

## Prime directives
1. **Deterministic faults.** Every fault is a flag the services poll — never
   real infra damage. A fault must produce the same visible behavior every
   single run.
2. **Every DB query filters by `STACK_ID`** (env var). Three stacks share one
   Supabase Postgres: `arena`, `gauntlet_a`, `gauntlet_b`. A missing filter is
   a demo-ending bug.
3. **Telemetry can never take a service down.** All Supabase writes are
   fire-and-forget with a 1s timeout, wrapped so failures are swallowed and
   logged locally.
4. **No real resource exhaustion.** The memory-leak fault allocates toward a
   HARD CAP of 150MB and expresses itself as added latency. Never OOM — Cloud
   Run would restart the instance and ruin the demo comparison.
5. **Read /CONTRACT.md before any change.** Fault name strings, event kinds,
   service names, and payload shapes there are frozen — the frontend is built
   against them in parallel. Never rename or extend them unilaterally.

## Stack & conventions
- Python 3.12, FastAPI, httpx, supabase-py. No ORM (raw supabase-py table
  calls), no Alembic, no auth, no test framework — proof scripts in /ops only.
- One folder per service under /services, each with its own Dockerfile
  (identical template, different entrypoint). Shared code in /common,
  installed as a local package or via PYTHONPATH in compose.
- docker-compose.yml for local dev runs everything including a ridersim.
- Type hints on public functions; small modules; comments only where behavior
  is non-obvious (fault hooks, critical sections).
- Env vars (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_KEY, STACK_ID,
  and per-service URLs (MATCHING_URL, PRICING_URL, TRIPS_URL, LOCATION_URL,
  PAYMENTS_URL, GATEWAY_URL).

## System spec

### Services
- **gateway** — rider-facing API. `POST /request_ride {rider_id,x,y,dest_x,
  dest_y}` → calls pricing for a quote, matching for assignment, trips to
  create the trip; returns {trip_id, quote, driver_id?}. `GET /trip/{id}`.
  Generates trace_id (uuid4) if absent; forwards `X-Trace-Id` on every
  downstream call.
- **matching** — assigns nearest idle driver. The assignment path is
  READ driver availability from DB → choose nearest → WRITE assignment.
  Keep read and write as two distinct steps (the race fault depends on it).
- **pricing** — `GET /quote` computes base + per_mile_rate × manhattan
  distance × surge. Owns a background rate-refresh job rewriting
  per_mile_rate rows every 20s.
- **trips** — lifecycle requested→matched→enroute→completed. On completion
  calls payments `/capture`. Hosts the invariant checker (below).
- **location** — driver positions (written by world sim, read by matching).
- **payments** — `POST /capture` recomputes the final charge with FLOAT
  ARITHMETIC on per_mile_rate read FRESH from the DB (this is where the
  fare_corrupt string crashes, in a different service than where it was
  written). Validates fare in (0, 500).

### World & load
- **/world** — city simulator, 100×100 grid, 12 drivers, Manhattan-path
  movement, 1 tick/second. Consumes assignments (poll DB), moves drivers to
  pickups, runs trips, completes via trips service. Marks riders `stranded`
  after 20s unmatched. Emits exactly one `world_tick` event per second
  (payload shape in CONTRACT.md, keep < 4KB) and a
  `metric {metric_name:'stranded_count', value}` every 5s.
- **/services/ridersim** — spawns `POST /request_ride` against GATEWAY_URL,
  ~1 per 4s, random grid points, fresh trace_id each. SPECIAL: if exactly one
  driver is idle, fire TWO concurrent requests (springs the race).

### The six faults (flag names frozen in CONTRACT.md)
| flag | where | exact behavior when active |
|---|---|---|
| db_kill | trips + matching | the DB wrapper raises ConnectionError on every call |
| bad_deploy | gateway | /request_ride handler swapped for a buggy version that raises KeyError on a missing field |
| mem_leak | location | append 1MB bytearrays to a module-level list, cap 150MB; add latency = min(len×6ms, 900ms) to every response |
| surge_poison | pricing | surge multiplier forced to 50.0 (quotes go absurd; payments sanity check then errors) |
| fare_corrupt | pricing | rate-refresh job writes per_mile_rate as the STRING "2,45" instead of float. Pricing itself must NOT error — silent here; payments crashes minutes later |
| double_dispatch | matching | insert time.sleep(0.2) between the availability READ and the assignment WRITE. Nothing else changes |

Fault plumbing: /common/faults.py polls `active_faults` (stack_id == STACK_ID,
cleared_at is null) every 2s, exposes `is_active(name)`, keeps last known
flags through Supabase blips.

### Invariants (in trips, every 5s, emit `invariant_breach` events)
(a) no driver has >1 active trip — this is the ONLY thing that catches
double_dispatch, there are no errors otherwise; (b) all captured fares in
(0, 500); (c) no rider unmatched >45s while idle drivers exist.

### Telemetry (/common/telemetry.py)
`emit(stack_id, service, kind, trace_id, payload)` → insert into Supabase
`events`. Every request handler emits kind='request'
{route, status, latency_ms}; every exception emits kind='error'
{message, stack_hint}.

### Ops (/ops)
- janitor.py — clear all faults for a stack, reset drivers/rates/surge to
  seed, cancel orphan trips, emit fault_cleared.
- run_gauntlet.py — fires the scripted schedule (in CONTRACT.md §gauntlet)
  at gauntlet_a and gauntlet_b simultaneously by inserting/clearing
  active_faults rows; janitors gauntlet_b afterward.
- stub_agent.py — placeholder for the real agent: watch events for STACK_ID;
  on error bursts or invariant_breach during an active fault, wait 8–15s,
  emit 2–3 kind='agent_action' events with audience-facing one-liners, then
  set cleared_at on the fault.
- deploy.sh — gcloud run deploy per service, --allow-unauthenticated,
  --min-instances=1, env per stack. Stacks: arena (everything),
  gauntlet_a (everything), gauntlet_b (everything MINUS stub_agent).

### Seed data
12 drivers, per_mile_rate=2.45, surge=1.0, base_fare=3.50 — seeded per stack.

## Never do
- Never remove or bypass a STACK_ID filter.
- Never let telemetry, fault-polling, or invariant checks raise into a
  request path.
- Never make a fault self-clear (only janitor/agent clear faults).
- Never add dependencies, auth, migrations frameworks, or tests without being
  asked.
- Never rename anything listed in CONTRACT.md.