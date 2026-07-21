# LiveProbe GCP demo operator guide

This is the supported hosted MVP topology. It deploys one GCE VM containing
the broker, the Node/Python/JVM demo services, their traffic generators, and
the private JVM bridge. The database can be either VM-local Postgres for the
least expensive demo or Cloud SQL for a durable pilot. The MCP server runs on
the operator's computer and reaches the broker over HTTP.

This remains a demo deployment. Every `/v1/*` request requires a shared bearer
key, but there is no per-user authorization, key rotation, tenant isolation,
or TLS termination. Cloud SQL mode protects the database, but the broker is
still a single instance.

## Topology

```text
Cursor/Codex -- stdio --> @doomslayer2945/liveprobe-mcp
                           |
                           | HTTP + Authorization: Bearer <key>
                           v
GCE :80 --> broker --> Postgres container or Cloud SQL Auth Proxy --> Cloud SQL
              ^          ^
              |          |
       Node/Python agents + JVM JDI bridge
```

Only SSH and the broker port are exposed by this deployment. Both managed GCP
firewall rules are restricted to the detected operator IPv4 `/32`, or to an
explicit `CLIENT_CIDR` between `/24` and `/32`. Application ports are bound to
VM loopback. JDWP stays on a Docker `internal: true` network and is never
published.

## Prerequisites

- A billing-enabled GCP project
- `gcloud`, authenticated to an account that can manage Compute Engine
- Node.js 20+ and npm on the operator machine
- A clean Git working tree containing the revision to deploy
- Published `@doomslayer2945/liveprobe-mcp@0.1.1`
- A strong `LIVEPROBE_API_KEY` retained by the operator
- A separate 64-character hex `POSTGRES_PASSWORD` retained by the operator

```sh
gcloud auth login
gcloud config set project "<PROJECT_ID>"
npm view @doomslayer2945/liveprobe-mcp@0.1.1 version
git status --short
```

The deployer archives committed `HEAD`; it intentionally rejects modified or
untracked files. Agents report that exact SHA on every ingest and refuse to
start without it.

## Deploy

Generate both credentials once and store them in your password manager. Reuse
them for redeployments unless you intend to rotate every component together.

```sh
export LIVEPROBE_API_KEY="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
PROJECT_ID="<PROJECT_ID>" deploy/gcp/deploy.sh
```

By default the deployment uses:

| Resource | Default |
| --- | --- |
| Region / zone | `us-central1` / `us-central1-a` |
| VM | `liveprobe-demo`, `e2-standard-4`, 40 GB balanced disk |
| Static address | `liveprobe-demo-ip` |
| Broker | external HTTP port `80` |
| Firewall rules | `liveprobe-demo-broker`, `liveprobe-demo-ssh` |
| Database | Postgres 16 in the `liveprobe-demo_postgres-data` volume |

Set `CLIENT_IP` for a specific `/32`, or `CLIENT_CIDR` for a narrowly scoped
NAT pool. They are mutually exclusive. Other supported resource overrides are
defined in `deploy/gcp/lib/common.sh`.

```sh
LIVEPROBE_API_KEY="<existing-shared-key>" \
  POSTGRES_PASSWORD="<existing-database-password>" \
  PROJECT_ID="<PROJECT_ID>" \
  CLIENT_CIDR="68.65.169.128/28" \
  deploy/gcp/deploy.sh
```

The script enables Compute Engine, reserves or reuses the static address,
creates or updates both firewall rules, creates or reuses the VM, uploads the
committed archive, builds the Compose stack, and waits for every service to be
healthy. It then prints the broker URL, deployed SHA, and exact MCP JSON. The
JSON includes `LIVEPROBE_API_KEY`; treat terminal output as sensitive.

### Cloud SQL database

Set `DATABASE_BACKEND=cloud-sql` to provision and use a managed PostgreSQL 16
database. New instances use the Enterprise edition with two vCPUs, 7.5 GiB of
memory, regional high availability, 20 GiB SSD storage with bounded automatic
growth, 14 automated backups, seven days of point-in-time recovery logs,
deletion protection, encrypted connector-only access, and Query Insights.
This is materially more expensive than the local database. For temporary
testing, `CLOUD_SQL_AVAILABILITY_TYPE=zonal` removes cross-zone failover.

```sh
LIVEPROBE_API_KEY="<existing-shared-key>" \
  POSTGRES_PASSWORD="<existing-database-password>" \
  PROJECT_ID="<PROJECT_ID>" \
  DATABASE_BACKEND=cloud-sql \
  CLOUD_SQL_AVAILABILITY_TYPE=regional \
  deploy/gcp/deploy.sh
```

The provisioner creates a dedicated `liveprobe-runtime` service account with
only `roles/cloudsql.client`, attaches it to the VM with the `cloud-platform`
scope, and runs the pinned Cloud SQL Auth Proxy inside the private Compose
network. The database has a public IP but rejects direct database connections;
all connections must use a Cloud SQL connector. Existing instances must
already be PostgreSQL 16 in the selected region.

Cloud SQL starts with a fresh `liveprobe` database. Switching an existing
deployment does not copy data from the VM-local Postgres volume. Export and
restore that data before cutover when it must be retained.

Supported overrides are `CLOUD_SQL_INSTANCE`, `CLOUD_SQL_DATABASE`,
`CLOUD_SQL_USER`, `CLOUD_SQL_AVAILABILITY_TYPE`,
`RUNTIME_SERVICE_ACCOUNT`, and `LIVEPROBE_DB_POOL_SIZE`.

## Configure MCP

Use the exact JSON printed by `deploy.sh`. Its shape is:

```json
{
  "mcpServers": {
    "liveprobe": {
      "command": "npx",
      "args": [
        "-y",
        "@doomslayer2945/liveprobe-mcp@0.1.1",
        "--broker-url",
        "http://BROKER_IP:80"
      ],
      "env": {
        "LIVEPROBE_API_KEY": "REDACTED_SHARED_KEY"
      }
    }
  }
}
```

After restarting the MCP client, call `ping_broker`, `list_services`, and
`get_safety_overview`. A healthy connected demo lists `payment-service`,
`billing-worker`, and `inventory-service`, all reporting the deployed commit.
The Node service also uploads its external source maps for that commit.

Suggested first diagnostic prompt:

> List the live services, then investigate the failing free-tier payments,
> legacy billing renewals, and inventory reservations. Use one-hit snapshot
> probes, report only redacted evidence, and remove every probe when finished.

Provide the SHA printed by `deploy.sh` when the MCP workflow asks for
`commit_hash`. A mismatch with the agent-reported SHA produces a warning; it is
not cryptographic bytecode attestation.

## Operate

Use the same project/resource overrides as deployment:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/status.sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/logs.sh
```

Redeploy with the same `LIVEPROBE_API_KEY` and `POSTGRES_PASSWORD`. Deployment
releases are immutable directories under `/opt/liveprobe/releases`;
`/opt/liveprobe/current` points to the active committed revision. Database
state survives Compose replacement in either database mode.

Run a manual backup before upgrades. Local mode creates an off-VM custom-format
dump in the ignored `backups/` directory with owner-only permissions. Cloud SQL
mode creates an on-demand managed backup in addition to its automated backups
and point-in-time recovery logs.

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/backup.sh
pg_restore --list backups/liveprobe-YYYYMMDDTHHMMSSZ.dump
```

To refresh firewall access after changing networks without redeploying:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/refresh-firewall.sh
```

If outbound port 80 is blocked, create an SSH tunnel:

```sh
gcloud compute ssh liveprobe-demo \
  --project="<PROJECT_ID>" \
  --zone=us-central1-a \
  -- -N -L 7070:127.0.0.1:80
```

Point the local MCP server at `http://127.0.0.1:7070` and keep the same API
key.

## Verify

The deployment scripts have static and mocked command-construction tests:

```sh
deploy/gcp/test.sh
docker compose \
  -f demo/docker-compose.yml \
  -f deploy/gcp/docker-compose.gcp.yml \
  config --quiet
```

For a live check from an allowed client address:

```sh
curl --fail "http://BROKER_IP/healthz"
curl --fail "http://BROKER_IP/readyz"
curl --fail \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "http://BROKER_IP/v1/services"
curl --fail \
  -H "Authorization: Bearer ${LIVEPROBE_API_KEY}" \
  "http://BROKER_IP/v1/safety"
```

`/healthz` and `/readyz` are intentionally unauthenticated and expose no
secrets. Readiness returns `503` when Postgres cannot be reached. All `/v1/*`
routes reject missing or incorrect keys with `401`.

## Production path

The single-VM topology is suitable for controlled internal testing after
regular off-VM backups are scheduled. Before storing important evidence or
opening access beyond a narrow operator network, complete these items in order:

1. Use `DATABASE_BACKEND=cloud-sql`, verify a managed backup and a point-in-time
   recovery drill, and migrate any retained local data before cutover.
2. Put the broker behind an HTTPS load balancer with a domain and a managed
   certificate. Keep the VM without a public application port once the load
   balancer or a private access path is in place.
3. Store the broker key and database credential in Secret Manager and grant a
   dedicated VM service account access to only those secrets.
4. Install the Google Cloud Ops Agent and configure log-based alerts, an uptime
   check on `/readyz`, CPU/disk alerts, and database storage/connection alerts.
5. Build immutable images in CI, scan them, push them to Artifact Registry, and
   deploy pinned digests with a tested rollback procedure.
6. Define retention for probe events, expired probes, source maps, and backups.
   Keep one broker replica until cross-instance long-poll notification and
   shared coordination are implemented.
7. Add per-operator identities, key rotation, audit retention, and tenant
   isolation before treating the broker as a multi-user service.

## Destroy and cost control

The VM, disk, static address, Cloud SQL instance, backups, and traffic can
incur charges. Use the same overrides used at deployment:

```sh
PROJECT_ID="<PROJECT_ID>" deploy/gcp/destroy.sh
```

The script stops Compose when possible and deletes the VM and auto-delete disk,
the two managed firewall rules, and the reserved regional static address. It
does not alter unrelated firewall rules, delete the GCP project, or delete a
Cloud SQL instance. Cloud SQL deletion protection remains enabled so database
destruction requires a separate explicit administrative action.

## Security boundaries

- The demo contains deterministic fake data only.
- The bearer key is shared by operators and all agents; compromise requires a
  coordinated key rotation and redeployment.
- Until the Secret Manager increment is complete, the database password is
  retained in root-readable `/etc/liveprobe/deployment.env` on the VM.
- HTTP is unencrypted. Use a trusted path, an SSH tunnel, or add TLS before
  carrying any non-demo data.
- Node and JVM breakpoints can briefly pause an executing thread. Python line
  callbacks add target-process work. Read-only does not mean zero impact.
- Redaction and bounded serialization are defense in depth, not proof that an
  unknown secret cannot be captured.
- Never expose JDWP or the demo application ports to the internet.
