SHELL := /usr/bin/env bash
TF ?= terraform
TF_DIR := infra
WRANGLER ?= npx --yes wrangler@4

.PHONY: help preflight fmt fmt-check init validate plan apply output render-wrangler db-migrate db-migrations-list worker-check check clean

help:
	@printf '%s\n' \
	  'make preflight           Check local tools, token, and Terraform variables' \
	  'make fmt                 Format Terraform files' \
	  'make validate            Initialize and validate Terraform' \
	  'make plan                Create an execution plan' \
	  'make apply               Apply Cloudflare resources' \
	  'make db-migrate          Apply D1 SQL migrations to the remote database' \
	  'make db-migrations-list  List pending remote D1 migrations' \
	  'make check               Run local static checks'

preflight:
	@./scripts/preflight.sh

fmt:
	@$(TF) -chdir=$(TF_DIR) fmt -recursive

fmt-check:
	@$(TF) -chdir=$(TF_DIR) fmt -recursive -check -diff

init:
	@$(TF) -chdir=$(TF_DIR) init

validate: init
	@$(TF) -chdir=$(TF_DIR) validate

plan: preflight init
	@$(TF) -chdir=$(TF_DIR) plan -out=tfplan

apply: preflight init
	@$(TF) -chdir=$(TF_DIR) apply

output:
	@$(TF) -chdir=$(TF_DIR) output

render-wrangler:
	@TERRAFORM_BIN=$(TF) node scripts/render-wrangler-config.mjs >/dev/null

db-migrate: render-wrangler
	@$(WRANGLER) d1 migrations apply DB --remote --config .generated/wrangler.migrations.jsonc

db-migrations-list: render-wrangler
	@$(WRANGLER) d1 migrations list DB --remote --config .generated/wrangler.migrations.jsonc

worker-check:
	@node --check worker/index.mjs
	@node --check app/dist/sw.js
	@node --check scripts/render-wrangler-config.mjs
	@node --check scripts/diagnose-terraform-state.mjs

check: fmt-check worker-check

clean:
	@rm -rf .generated infra/tfplan
