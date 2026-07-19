PYTHON ?= python3.12
VENV := .venv
VENV_PYTHON := $(VENV)/bin/python
REPO_ROOT := ../..

.PHONY: venv smoke run traffic e2e docker-build

venv:
	$(PYTHON) -m venv $(VENV)
	$(VENV_PYTHON) -m pip install --upgrade pip
	$(VENV_PYTHON) -m pip install -r requirements.txt -e $(REPO_ROOT)/python/sdk

smoke:
	$(VENV_PYTHON) -m py_compile app.py traffic.py e2e.py

run:
	SERVICE_ID=$${SERVICE_ID:-billing-worker} \
	BROKER_URL=$${BROKER_URL:-http://127.0.0.1:7070} \
	BUG=$${BUG:-on} \
	$(VENV_PYTHON) -m uvicorn app:app --host 127.0.0.1 --port 8081

traffic:
	$(VENV_PYTHON) traffic.py --base-url http://127.0.0.1:8081

e2e:
	$(VENV_PYTHON) e2e.py

docker-build:
	docker build -f Dockerfile -t liveprobe-billing-worker $(REPO_ROOT)
