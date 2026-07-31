#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd
)"
APP_DIRECTORY="$(cd -- "${SCRIPT_DIRECTORY}/.." && pwd)"
OUTPUT_DIRECTORY="${APP_DIRECTORY}/candid/generated"
TEMP_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/wagyu-candid-bindings.XXXXXX")"
SOURCE_DIDS=(
  "wagyu-v1.did"
  "wagyu-owner-self-calls-v1.did"
)

cleanup() {
  rm -rf -- "${TEMP_DIRECTORY}"
}
trap cleanup EXIT

for source_name in "${SOURCE_DIDS[@]}"; do
  source_did="${APP_DIRECTORY}/candid/${source_name}"
  didc check "${source_did}"
  didc bind -t js "${source_did}" > "${TEMP_DIRECTORY}/${source_name}.js"
  didc bind -t ts "${source_did}" > "${TEMP_DIRECTORY}/${source_name}.d.ts"
done

mkdir -p -- "${OUTPUT_DIRECTORY}"
for source_name in "${SOURCE_DIDS[@]}"; do
  mv -- "${TEMP_DIRECTORY}/${source_name}.js" \
    "${OUTPUT_DIRECTORY}/${source_name}.js"
  mv -- "${TEMP_DIRECTORY}/${source_name}.d.ts" \
    "${OUTPUT_DIRECTORY}/${source_name}.d.ts"
done
