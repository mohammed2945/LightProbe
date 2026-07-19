SHELL := /bin/sh

DOCKER_COMPOSE ?= docker compose
GCP_COMPOSE = $(DOCKER_COMPOSE) -f demo/docker-compose.yml -f deploy/gcp/docker-compose.gcp.yml
GCP_LOGS_ARGS ?= --tail=200

.PHONY: \
	test fixtures-test typescript-test python-test java-test demo-unit-test \
	payment-deps python-demo-deps payment-test inventory-test \
	build typescript-build payment-build java-build inventory-build \
	redaction-audit readonly-audit bench \
	e2e-node e2e-python e2e-jvm \
	demo-prerequisites demo demo-down \
	gcp-demo-prerequisites gcp-demo-up gcp-demo-status gcp-demo-logs gcp-demo-down

test: fixtures-test typescript-test python-test java-test demo-unit-test

fixtures-test:
	node scripts/validate-fixtures.mjs

typescript-test:
	pnpm run typecheck
	pnpm run test:packages

python-test:
	cd python/sdk && sh ../../scripts/python312.sh -m pytest

java-test:
	@if ! command -v javac >/dev/null 2>&1; then \
		echo "SKIP Java bridge tests (JDK 17+ not installed)"; \
	else \
		major=$$(javac -version 2>&1 | awk '{ split($$2, v, "."); if (v[1] == "1") print v[2]; else print v[1] }'); \
		if [ "$$major" -ge 17 ]; then \
			$(MAKE) -C java/bridge test; \
		else \
			echo "SKIP Java bridge tests (JDK 17+ required; found javac $$major)"; \
		fi; \
	fi

payment-deps:
	@if [ ! -d demo/payment-service/node_modules ]; then \
		echo "Installing payment demo dependencies"; \
		npm --prefix demo/payment-service ci; \
	fi

python-demo-deps:
	@if ! sh scripts/python312.sh -c 'import fastapi, liveprobe, uvicorn' >/dev/null 2>&1; then \
		echo "Installing billing demo dependencies"; \
		sh scripts/python312.sh -m pip install \
			-e "python/sdk" \
			-r demo/billing-worker/requirements.txt; \
	fi

payment-test: payment-deps
	pnpm --filter @liveprobe/sdk-node run build
	npm --prefix demo/payment-service test

inventory-test:
	@if ! command -v javac >/dev/null 2>&1 || ! command -v mvn >/dev/null 2>&1; then \
		echo "SKIP inventory tests (JDK 17+ and Maven required)"; \
	else \
		major=$$(javac -version 2>&1 | awk '{ split($$2, v, "."); if (v[1] == "1") print v[2]; else print v[1] }'); \
		if [ "$$major" -ge 17 ]; then \
			$(MAKE) -C demo/inventory-service test; \
		else \
			echo "SKIP inventory tests (JDK 17+ required; found javac $$major)"; \
		fi; \
	fi

demo-unit-test: payment-test inventory-test

typescript-build:
	pnpm run build

payment-build: payment-deps
	pnpm --filter @liveprobe/sdk-node run build
	npm --prefix demo/payment-service run build

java-build:
	$(MAKE) -C java/bridge jar

inventory-build:
	$(MAKE) -C demo/inventory-service package

build: typescript-build payment-build java-build inventory-build

redaction-audit:
	sh scripts/redaction-audit.sh

readonly-audit:
	node scripts/readonly-audit.mjs

bench:
	pnpm --filter @liveprobe/sdk-node run bench
	sh scripts/python312.sh python/sdk/benchmarks/monitoring_overhead.py

e2e-node: payment-deps
	pnpm --filter @liveprobe/sdk-node run build
	pnpm --filter @liveprobe/broker run build
	npm --prefix demo/payment-service run e2e

e2e-python: python-demo-deps
	pnpm --filter @liveprobe/broker run build
	sh scripts/python312.sh demo/billing-worker/e2e.py

e2e-jvm:
	pnpm --filter @liveprobe/broker run build
	$(MAKE) -C java/bridge jar
	$(MAKE) -C demo/inventory-service package
	node scripts/e2e-jvm.mjs

demo-prerequisites:
	pnpm --filter @liveprobe/sdk-node run build
	$(DOCKER_COMPOSE) -f demo/docker-compose.yml config --quiet

demo: demo-prerequisites
	$(DOCKER_COMPOSE) -f demo/docker-compose.yml --profile mcp build
	$(DOCKER_COMPOSE) -f demo/docker-compose.yml up --detach --wait
	node scripts/print-demo-config.mjs

demo-down:
	$(DOCKER_COMPOSE) -f demo/docker-compose.yml down --remove-orphans

gcp-demo-prerequisites:
	pnpm --filter @liveprobe/sdk-node run build
	$(GCP_COMPOSE) config --quiet

gcp-demo-up: gcp-demo-prerequisites
	$(GCP_COMPOSE) build
	$(GCP_COMPOSE) up --detach --wait --remove-orphans

gcp-demo-status:
	$(GCP_COMPOSE) ps

gcp-demo-logs:
	$(GCP_COMPOSE) logs $(GCP_LOGS_ARGS)

gcp-demo-down:
	$(GCP_COMPOSE) down --remove-orphans
