# Trellis

A database client for macOS and Linux: SQLite, PostgreSQL and MySQL / MariaDB. Its look follows Dendro.
Rust (Tauri 2) talks to the databases; the window is plain HTML, CSS and JavaScript.

## What it does

- **Welcome window** — what Trellis opens with, as in TablePlus: the logo, version and developer on the left, saved
  connections on the right (search, `↵` to open, right-click to edit, duplicate or delete). A connection opens in its
  own workspace window; closing the last one brings the welcome window back (also Window → Welcome, `⌘⇧1`).
- **Connections** — also opened from the Open Connection sheet (`⌘⇧K`) inside a workspace; each has a status color, a tag (local,
  development, staging, production), a safe mode (silent, ask before any write, read only) and an SSL mode
  (disable, prefer, require, verify-full). Passwords live in the macOS Keychain. The connection button in the toolbar
  switches databases; `⌘`-click opens one in a new window. A production window has a red rim.
- **Schemas** — the sidebar shows one schema at a time; switch at its foot or with `⌘⇧P`. On Postgres the switch also
  sets `search_path`, so bare table names work in the SQL editor.
- **Open anything** — `⌘P` (or `⌘K`): tables and views of every schema, schemas, saved queries, commands.
- **Tables** — filters (any column or one, `contains / = / ≠ / < / > / starts with / is NULL`), sorting, resizable
  columns, pages of 50–1000 rows. Large server tables show an estimated count (`~`) instead of a slow `count(*)`.
- **Editing** — double-click or Enter edits a cell, Tab moves on, `⌘⇧N` adds a row, `⌘⌫` marks one for deletion.
  `⌘S` shows the SQL and commits it in one transaction; if a statement fails nothing is applied. Rows are matched by
  primary key (SQLite tables without one use `rowid`); tables without a key are read only.
- **Structure** — columns, indexes, foreign keys and the definition (`⌘2`).
- **SQL** — highlighting, autocomplete (`table.` lists its columns, `schema.` its tables), `⌘↵` runs the query or the
  selection, results copy as CSV. `⌘S` saves the tab to a `.sql` file (`~/Documents/Trellis Queries` by default),
  `⌘O` opens one.
- **Sidebar panes** — Items, saved Queries and the History of every query and commit, per connection.
- **Inspector** — every field of the selected row; edit, set NULL, copy as JSON or INSERT (`⌘I`).

On its first launch Trellis brings over the connections saved by Strata (the earlier Electron build), without
their passwords: type each password once.

## Install

GitHub Actions builds Trellis for Ubuntu and macOS on every push to `main`: open the latest
[Build run](https://github.com/therealtoresto/trellis/actions/workflows/build.yml) and download `trellis-ubuntu` or
`trellis-macos` under Artifacts (needs a GitHub login). Tagged versions also land on
[Releases](https://github.com/therealtoresto/trellis/releases).

**Ubuntu 22.04 or newer** (x86-64):

```sh
sudo apt install ./Trellis_0.2.0_amd64.deb
```

Or run the AppImage without installing: `chmod +x Trellis_*.AppImage && ./Trellis_*.AppImage`. Passwords go to the
Secret Service (GNOME Keyring on Ubuntu). Closing the last window quits Trellis on Linux.

**macOS** (Apple silicon): unzip `Trellis-macos-arm64.zip` and move `Trellis.app` to Applications. The build is not
signed, so the first launch needs right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Trellis.app`.

### Building on Ubuntu

```sh
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev libdbus-1-dev pkg-config build-essential
curl https://sh.rustup.rs -sSf | sh       # Rust
npm ci
./node_modules/.bin/tauri build --bundles deb appimage   # → src-tauri/target/release/bundle/{deb,appimage}
```

### Releasing

Bump `version` in `package.json` and `src-tauri/tauri.conf.json`, then push a tag; the workflow attaches the builds to a
draft release, which you publish on GitHub.

```sh
git tag v0.3.0 && git push origin v0.3.0
```

## Build and run

Needs Rust (`brew install rust`) and Node for the Tauri CLI.

```sh
npm install
npm run dev            # run from source
npm test               # Rust driver tests: SQLite always, Postgres and MySQL when the test containers run
npm run install-app    # release build, copied to /Applications/Trellis.app
npm run icon           # rebuild the app icons from assets/icon.png (rendered from assets/icon.svg)
npm run demo-db        # rebuild the example database in src-tauri/resources
```

The driver tests expect these throwaway servers:

```sh
docker run -d --name trellis-pg -e POSTGRES_PASSWORD=strata -e POSTGRES_DB=shop -p 55432:5432 postgres:16-alpine
docker run -d --name trellis-mysql -e MYSQL_ROOT_PASSWORD=strata -e MYSQL_DATABASE=shop -p 53306:3306 mysql:8.4
```

`TRELLIS_SELFTEST=<dir> TRELLIS_USERDATA=<tmp dir> src-tauri/target/debug/trellis` drives a window through the main
flows (`src/renderer/selftest.js`) and writes one line per step to `<dir>/log.txt`.

## Layout

- `src-tauri/src/drivers` — one driver per engine with the same methods (`objects`, `page`, `query`, `structure`,
  `apply`…); `common.rs` writes names, literals, filters and the statements that apply staged edits.
- `src-tauri/src/lib.rs` — commands, windows and the menu. `store.rs` keeps saved connections and the Keychain.
- `src/renderer` — the window. `bridge.js` is its only door to Rust.

## License

MIT — see [LICENSE](LICENSE).
