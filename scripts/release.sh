#!/bin/bash
# Cuts a release: npm run release [patch|minor|major|X.Y.Z]   (patch by default)
# Sets the version in package.json, package-lock.json, src-tauri/Cargo.toml (and Cargo.lock) and
# src-tauri/tauri.conf.json, commits it, tags the commit vX.Y.Z and pushes both. The tag starts the GitHub Actions
# build, which publishes the Ubuntu and macOS files as the release. Naming the current version tags it as it is.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first."; exit 1; }
cur=$(node -p "require('./src-tauri/tauri.conf.json').version")
IFS=. read -r major minor patch <<< "$cur"
case "${1:-patch}" in
  patch) next="$major.$minor.$((patch + 1))" ;;
  minor) next="$major.$((minor + 1)).0" ;;
  major) next="$((major + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) next="$1" ;;
  *) echo "Usage: npm run release [patch|minor|major|X.Y.Z]"; exit 1 ;;
esac
if git rev-parse -q --verify "refs/tags/v$next" >/dev/null || git ls-remote --exit-code --tags origin "v$next" >/dev/null; then
  echo "v$next already exists."; exit 1
fi

if [ "$next" != "$cur" ]; then
  # Only the version lines change; the files keep their layout. package-lock.json names Trellis's version twice.
  CUR="$cur" NEXT="$next" node -e '
    const fs = require("fs"), { CUR, NEXT } = process.env;
    for (const [f, times] of [["package.json", 1], ["package-lock.json", 2], ["src-tauri/tauri.conf.json", 1]]) {
      let s = fs.readFileSync(f, "utf8"), n = 0;
      s = s.replace(new RegExp(`"version": "${CUR.replace(/\./g, "\\.")}"`, "g"), m => n++ < times ? `"version": "${NEXT}"` : m);
      if (n < times) { console.error(`${f}: version ${CUR} not found`); process.exit(1); }
      fs.writeFileSync(f, s);
    }'
  sed -i.bak "s/^version = \"$cur\"/version = \"$next\"/" src-tauri/Cargo.toml && rm src-tauri/Cargo.toml.bak
  (cd src-tauri && cargo update --workspace --offline --quiet)
  git commit -q -am "[RELEASE] - $next"
fi
git tag -a "v$next" -m "Trellis $next"
git push -q origin HEAD "v$next"
echo "Tagged v$next. The build and the release: https://github.com/therealtoresto/trellis/actions/workflows/build.yml"
