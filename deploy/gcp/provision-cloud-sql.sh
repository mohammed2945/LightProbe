#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/gcp/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

[[ "${POSTGRES_PASSWORD:-}" =~ ^[0-9a-f]{64}$ ]] ||
  die "set POSTGRES_PASSWORD to a 64-character lowercase hex value (openssl rand -hex 32)"

load_gcp_config
[[ "$DATABASE_BACKEND" == "cloud-sql" ]] ||
  die "provision-cloud-sql.sh requires DATABASE_BACKEND=cloud-sql"

runtime_service_account="${RUNTIME_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud_cmd services enable \
  iam.googleapis.com \
  sqladmin.googleapis.com \
  --project="$PROJECT_ID" \
  --quiet >&2

if ! gcloud_cmd iam service-accounts describe "$runtime_service_account" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud_cmd iam service-accounts create "$RUNTIME_SERVICE_ACCOUNT" \
    --project="$PROJECT_ID" \
    --display-name="LiveProbe runtime" \
    --quiet >&2
fi

gcloud_cmd projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${runtime_service_account}" \
  --role=roles/cloudsql.client \
  --condition=None \
  --quiet >&2

if ! gcloud_cmd sql instances describe "$CLOUD_SQL_INSTANCE" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud_cmd sql instances create "$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --database-version=POSTGRES_16 \
    --edition=enterprise \
    --cpu=2 \
    --memory=7680MiB \
    --availability-type="$CLOUD_SQL_AVAILABILITY_TYPE" \
    --assign-ip \
    --connector-enforcement=REQUIRED \
    --ssl-mode=ENCRYPTED_ONLY \
    --storage-type=SSD \
    --storage-size=20 \
    --storage-auto-increase \
    --storage-auto-increase-limit=100 \
    --backup-start-time=03:00 \
    --retained-backups-count=14 \
    --enable-point-in-time-recovery \
    --retained-transaction-log-days=7 \
    --deletion-protection \
    --insights-config-query-insights-enabled \
    --quiet >&2
else
  database_version="$(
    gcloud_cmd sql instances describe "$CLOUD_SQL_INSTANCE" \
      --project="$PROJECT_ID" \
      --format='value(databaseVersion)'
  )"
  instance_region="$(
    gcloud_cmd sql instances describe "$CLOUD_SQL_INSTANCE" \
      --project="$PROJECT_ID" \
      --format='value(region)'
  )"
  [[ "$database_version" == "POSTGRES_16" ]] ||
    die "existing Cloud SQL instance must use POSTGRES_16: ${database_version:-unknown}"
  [[ "$instance_region" == "$REGION" ]] ||
    die "existing Cloud SQL instance is in ${instance_region:-unknown}, expected ${REGION}"
  gcloud_cmd sql instances patch "$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --availability-type="$CLOUD_SQL_AVAILABILITY_TYPE" \
    --assign-ip \
    --connector-enforcement=REQUIRED \
    --ssl-mode=ENCRYPTED_ONLY \
    --storage-auto-increase \
    --storage-auto-increase-limit=100 \
    --backup-start-time=03:00 \
    --retained-backups-count=14 \
    --enable-point-in-time-recovery \
    --retained-transaction-log-days=7 \
    --deletion-protection \
    --insights-config-query-insights-enabled \
    --quiet >&2
fi

if ! gcloud_cmd sql databases describe "$CLOUD_SQL_DATABASE" \
  --instance="$CLOUD_SQL_INSTANCE" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud_cmd sql databases create "$CLOUD_SQL_DATABASE" \
    --instance="$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --quiet >&2
fi

if [[ "$(
  gcloud_cmd sql users list \
    --instance="$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --filter="name=${CLOUD_SQL_USER}" \
    --format='value(name)' \
    --limit=1
)" == "$CLOUD_SQL_USER" ]]; then
  gcloud_cmd sql users set-password "$CLOUD_SQL_USER" \
    --instance="$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --password="$POSTGRES_PASSWORD" \
    --quiet >&2
else
  gcloud_cmd sql users create "$CLOUD_SQL_USER" \
    --instance="$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --password="$POSTGRES_PASSWORD" \
    --quiet >&2
fi

connection_name="$(
  gcloud_cmd sql instances describe "$CLOUD_SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --format='value(connectionName)'
)"
[[ "$connection_name" == "${PROJECT_ID}:${REGION}:${CLOUD_SQL_INSTANCE}" ]] ||
  die "unexpected Cloud SQL connection name: ${connection_name:-<empty>}"

printf '%s\n' "$connection_name"
