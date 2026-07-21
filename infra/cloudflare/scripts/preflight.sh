#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'ERROR: required command not found: %s\n' "$1" >&2
    failures=$((failures + 1))
  fi
}

require_command terraform
require_command node
require_command npx

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  printf 'ERROR: CLOUDFLARE_API_TOKEN is not set.\n' >&2
  failures=$((failures + 1))
fi

if [[ ! -f infra/terraform.tfvars && -z "${TF_VAR_account_id:-}" ]]; then
  printf 'ERROR: copy infra/terraform.tfvars.example to infra/terraform.tfvars or set TF_VAR_account_id.\n' >&2
  failures=$((failures + 1))
fi

if [[ $failures -gt 0 ]]; then
  exit 1
fi

printf 'Preflight checks passed.\n'
