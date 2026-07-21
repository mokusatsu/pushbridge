PYTHON ?= python3
VENV ?= .runtime/venv
PIP := $(VENV)/bin/pip
PYTEST := $(VENV)/bin/pytest
VENV_PYTHON := $(VENV)/bin/python

.PHONY: setup check check-contract check-server check-client smoke sync-contract

setup:
	$(PYTHON) -m venv $(VENV)
	$(PIP) install -e 'services/relaymock[dev]'
	cd apps/web-pwa && npm ci

check: check-contract check-server check-client

check-contract:
	$(PYTHON) scripts/verify-contract.py

check-server:
	$(PYTEST) services/relaymock

check-client:
	cd apps/web-pwa && npm run check

smoke:
	PYTHON_BIN=$(VENV_PYTHON) scripts/fullstack-smoke.sh

sync-contract:
	$(PYTHON) scripts/sync-contract.py
