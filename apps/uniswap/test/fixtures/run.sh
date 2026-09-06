#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture_deps="$(mktemp -d /tmp/neutron-uniswap-fixture.XXXXXX)"
trap 'rm -rf -- "$fixture_deps"' EXIT
cp "$fixture_dir/package.json" "$fixture_dir/package-lock.json" "$fixture_deps/"
npm --prefix "$fixture_deps" ci --ignore-scripts --no-audit --no-fund
NEUTRON_UNISWAP_FIXTURE_DEPS="$fixture_deps" bun "$fixture_dir/contracts.ts"
