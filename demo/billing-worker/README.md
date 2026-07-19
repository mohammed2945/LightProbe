# Billing worker demo

This FastAPI service reproduces a subscription-renewal failure for a seeded
legacy user. With `BUG=on` (the default), `legacy-user` has `address=None` and
the tax calculation fails. Modern users continue renewing successfully.

The app starts the repository's local Python LiveProbe SDK with `SERVICE_ID`
and `BROKER_URL`. It requires Python 3.12+ because the SDK uses
`sys.monitoring`.

## Run locally

```sh
cd demo/billing-worker
make venv

# In another terminal, from the repository root:
pnpm --filter @liveprobe/broker start

# Back in demo/billing-worker:
make run
make traffic
```

Endpoints:

- `GET /health` reports app, bug, and SDK startup state.
- `POST /renew` accepts `{"user_id":"legacy-user","subtotal_cents":2500}`.
- `GET /stats` exposes monotonic request and renewal counters.

Set `BUG=off` to seed a valid address for the legacy user.

## Automated end-to-end proof

```sh
cd demo/billing-worker
make e2e
```

`e2e.py` starts the built broker, the FastAPI app, and the deterministic
mixed-user traffic generator. It creates a snapshot probe conditioned on
`user.is_legacy == true`, waits for sanitized evidence that
`user.address` is null and `user.is_legacy` is true, then verifies request
counters continue increasing both during and after the probe hit.

The intentionally buggy tax line contains the unique
`LIVEPROBE_BUG_LINE` marker. Keep that statement and marker together so the
line remains directly probeable; the e2e locates it without hard-coding a
fragile line number.

## Container

Build from the repository root so the local SDK is available in the build
context:

```sh
docker build -f demo/billing-worker/Dockerfile \
  -t liveprobe-billing-worker .
```

The image listens on port `8081` and defaults to
`BROKER_URL=http://broker:7070`.
