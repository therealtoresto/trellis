#!/bin/bash
# Prints this build's version: major.minor from src-tauri/Cargo.toml, then the commit count as the patch number,
# so every commit on main is its own version (0.2.17, 0.2.18…). src-tauri/build.rs counts the same way.
# With --json it prints the Tauri config override that stamps the version on the bundles.
set -euo pipefail
cd "$(dirname "$0")/.."
base=$(sed -n 's/^version = "\([0-9]*\.[0-9]*\)\.[0-9]*"/\1/p' src-tauri/Cargo.toml | head -1)
version="$base.$(git rev-list --count HEAD)"
if [ "${1:-}" = "--json" ]; then echo "{\"version\":\"$version\"}"; else echo "$version"; fi
