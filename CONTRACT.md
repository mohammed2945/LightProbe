# CONTRACT.md — Shared Interface (Backend ↔ Console ↔ Agent)
Changes to this file require sign-off from BOTH workstreams. Everything here
is frozen vocabulary: exact strings, exact shapes.

## Stacks
`arena` · `gauntlet_a` · `gauntlet_b`
Every event, fault row, and data row carries `stack_id`.

## Fault names (`active_faults.fault`)
`db_kill` · `bad_deploy` · `mem_leak` · `surge_poison` · `fare_corrupt` · `double_dispatch`

## Event kinds (`events.kind`)
`request` · `error` · `metric` · `world_tick` · `fault_started` ·
`fault_cleared` · `agent_action` · `invariant_breach` · `narration`

## Service names (`events.service`)
`gateway` · `matching` · `pricing` · `location` · `trips` · `payments` ·
`world` · `ridersim` · `agent`

## Graph topology (console renders exactly this)
gateway → matching, pricing, trips · matching → location · trips → payments ·
matching, pricing, trips, payments → postgres · location → redis

## world_tick payload (1 per second per stack, < 4KB)
```json
{"tick": 412, "surge": 1.2,
 "drivers": [{"id":"d7","x":34,"y":61,"st":"idle|enroute|ontrip"}],
 "riders":  [{"id":"r91","x":58,"y":22,"st":"waiting|matched|riding|stranded",
              "eta_s": 140, "quote": "$14.20"}]}
```
Coordinates are 0–100 grid units.

## Standard event payloads
- request: `{route, status, latency_ms}`
- error: `{message, stack_hint}`
- metric: `{metric_name, value}` — includes `stranded_count` every 5s from world
- agent_action: `{message}` — one human sentence, rendered verbatim in the UI
- invariant_breach: `{invariant, detail}` e.g.
  `{"invariant":"driver_single_trip","detail":"driver_7 active_trips=2"}`

## Gauntlet schedule (run_gauntlet.py fires at BOTH gauntlet stacks)
bad_deploy @0:00 / clear @1:00 · db_kill @1:30 / clear @2:30 ·
mem_leak @3:00 / clear @4:30 · surge_poison @5:00 / clear @6:00 ·
fare_corrupt @6:30 / clear @8:30 · double_dispatch @8:45 / clear @9:45 ·
then janitor gauntlet_b.

## origin_events (ORIGIN engine writes; console renders)
Sequence per incident, `kind` values in order:
```json
{"kind":"slice_ready","incident_id":"inc_123","payload":{"slice":{
  "nodes":[{"id":"n1","label":"pricing/rates.py:88","role":"candidate"},
           {"id":"n2","label":"pricing/refresh.py:41","role":"candidate"},
           {"id":"n7","label":"payments/capture.py:130","role":"manifestation"}],
  "edges":[{"from":"n1","to":"n7"},{"from":"n2","to":"n1"}]}}}
{"kind":"probes_armed","payload":{"node_ids":["n1","n2"]}}
{"kind":"snapshot","payload":{"node_id":"n1","trace_id":"7f3a…",
  "expr":"per_mile_rate","value":"\"2,45\"","population":"failing"}}
{"kind":"exonerated","payload":{"node_ids":["n2"],
  "reason":"values agree with passing population"}}
{"kind":"origin_found","payload":{"origin":"n1","chain":["n1","n7"],
  "confidence":"high"}}
{"kind":"fix_proposed","payload":{"title":"fix: parse locale decimal in rate refresh",
  "diff_summary":"rates.py:88 float(raw.replace(',','.'))",
  "witnessed":"per_mile_rate was \"2,45\" (str); expected 2.45 (float)",
  "pr_url":"https://github.com/…"}}
```

## Scoreboard view (already applied in Supabase)
`stack_health` → `{stack_id, errors_10m, uptime_pct, stranded_now}`

## Who writes what
- Backend services + world + ridersim: `events` (service-role key)
- Console (anon key, RLS-limited): inserts into `active_faults` only; reads everything
- Agent / stub_agent: `agent_action` events + sets `cleared_at` on faults; real agent also writes `origin_events`