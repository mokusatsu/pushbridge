#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${RELAYMOCK_HOST:-127.0.0.1}"
PORT="${RELAYMOCK_PORT:-8000}"
ORIGIN="http://${HOST}:${PORT}"
RUNTIME_DIR="${PUSHBALL_RUNTIME_DIR:-${ROOT}/.runtime/smoke}"
PYTHON_BIN="${PYTHON_BIN:-${ROOT}/.runtime/venv/bin/python}"

mkdir -p "${RUNTIME_DIR}"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "Python executable not found: ${PYTHON_BIN}" >&2
  echo "Run 'make setup' or set PYTHON_BIN to a Python environment containing uvicorn." >&2
  exit 2
fi

(
  cd "${RUNTIME_DIR}"
  exec "${PYTHON_BIN}" -m uvicorn relaymock.main:app --host "${HOST}" --port "${PORT}"
) >"${RUNTIME_DIR}/relaymock.log" 2>&1 &
server_pid=$!
trap 'kill "${server_pid}" 2>/dev/null || true' EXIT

ready=false
for _ in {1..30}; do
  if curl --silent --fail "${ORIGIN}/health" >/dev/null; then
    ready=true
    break
  fi
  sleep 0.25
done

if [[ "${ready}" != true ]]; then
  echo "RelayMock did not become ready. Server log:" >&2
  sed -n '1,200p' "${RUNTIME_DIR}/relaymock.log" >&2
  exit 1
fi

API_ORIGIN="${ORIGIN}" node "${ROOT}/apps/web-pwa/tools/api-smoke.mjs"
