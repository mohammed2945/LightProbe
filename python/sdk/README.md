# liveprobe

Python 3.12+ runtime agent for LiveProbe using `sys.monitoring`.

```python
import liveprobe

agent = liveprobe.start(
    service_id="billing",
    broker_url="http://127.0.0.1:7070",
    api_key="dev-key",
    commit_sha="abcdef1234567890",
    project_id="billing-repo",
    environment="production",
)
```

`commit_sha` is required unless `LIVEPROBE_COMMIT_SHA` or `GIT_COMMIT` is set.
`api_key` defaults to `LIVEPROBE_API_KEY`.
`project_id` and `environment` default to `LIVEPROBE_PROJECT_ID` and
`LIVEPROBE_ENVIRONMENT`. Configure the same values when issuing the service
credential; service credentials cannot route to another project or environment.

The agent supports `debug`, `info`, `warn`, and `error` log events,
broker-compiled safe expressions for conditions, watches, logs, and metrics,
and optional bounded locals on selected stack frames. Expressions read only
captured dictionaries/sequences; they cannot call Python code, inspect
attributes, or mutate application state. All expression and frame-local output
uses the configured serializer limits and redaction policy.
Numeric expressions use finite IEEE-754 values and reject integer inputs or
results outside the safe integer range so behavior is identical across SDKs.

Portable safety settings are `maxProbeHitsPerSecond`,
`maxProbePauseMsPerSecond`, `safetyCooldownMs`, and
`maxTelemetryBytesPerSecond` (snake-case forms are also accepted), with
matching `LIVEPROBE_*` variables. Existing short names remain compatible.
Heartbeats report the enforced limits and use `pause_budget`,
`instrumentation_failure`, or `agent_worker_failure` when red.
