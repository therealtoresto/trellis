# Trellis

A database client for macOS, Linux and Windows: SQLite, PostgreSQL and MySQL / MariaDB. Its look follows Dendro.
Rust (Tauri 2) talks to the databases; the window is plain HTML, CSS and JavaScript.

## What it does

- **Welcome window** — what Trellis opens with, as in TablePlus: the logo, version and developer on the left, saved
  connections on the right (search, `↵` to open, right-click to edit, duplicate or delete). A connection opens in its
  own workspace window; closing the last one brings the welcome window back (also Window → Welcome, `⌘⇧1`).
- **Connections** — also opened from the Open Connection sheet (`⌘⇧K`) inside a workspace; each has a status color, a tag (local,
  development, staging, production), a safe mode (silent, ask before any write, read only) and an SSL mode
  (disable, prefer, require, verify-full). A server connection can go through an **SSH tunnel**, signing in with the
  SSH agent or `~/.ssh` keys, a key file (with its passphrase) or a password; the database host and port are then as
  the SSH server sees them. SSH servers are trusted on first connect and checked against `~/.ssh/known_hosts` and
  Trellis' own list from then on. Passwords live in the macOS Keychain or, on Linux, the Secret Service
  (GNOME Keyring, KWallet). The connection button in the toolbar
  switches databases; `⌘`-click opens one in a new window. A production window has a red rim.
- **Schemas** — the sidebar shows one schema at a time; switch at its foot or with `⌘⇧P`. On Postgres the switch also
  sets `search_path`, so bare table names work in the SQL editor.
- **Open anything** — `⌘P` (or `⌘K`): tables and views of every schema, schemas, saved queries, commands.
- **Tables** — filters (any column or one, `contains / = / ≠ / < / > / starts with / is NULL`), sorting, resizable
  columns, pages of 50–1000 rows. Large server tables show an estimated count (`~`) instead of a slow `count(*)`.
- **Editing** — double-click or Enter edits a cell, Tab moves on, `⌘⇧N` adds a row, `⌘⌫` marks one for deletion.
  `⌘S` shows the SQL and commits it in one transaction; if a statement fails nothing is applied. Rows are matched by
  primary key (SQLite tables without one use `rowid`); tables without a key are read only.
- **Right-click menus** — on a cell: copy the value, the row as JSON or INSERT, the column name; filter the table by
  the value (= or ≠, NULL-aware); follow its foreign key; edit, set NULL, delete. On a header: sort, copy the name,
  filter on it. On a sidebar table: open, open its structure, `SELECT *` in a new query, copy its name.
- **Foreign keys** — a link mark in the column header; the arrow in a cell (on hover or in the selected row) or the
  link in the inspector opens the referenced table filtered to that row.
- **Structure** — columns, indexes, foreign keys and the definition (`⌘2`).
- **SQL** — highlighting, autocomplete (`table.` lists its columns, `schema.` its tables). `⌘↵` runs the selection or
  the statement at the caret (a faint band marks it when the editor holds several), `⌘⇧↵` runs them all, `⌘.` stops a
  running query on any engine. A result keeps its first 50,000 rows. `⌘S` saves the tab to a
  `.sql` file (`~/Documents/Trellis Queries` by default), `⌘O` opens one.
- **Export** (`⌘⇧E`) — copy a page or a result as CSV or JSON, or save it to a file: a query result as CSV or JSON,
  a whole table (as filtered and sorted) as CSV, JSON or SQL `INSERT`s, read and written 5,000 rows at a time.
- **Sidebar panes** — Items, saved Queries and the History of every query and commit, per connection.
- **Inspector** — every field of the selected row; edit, set NULL, copy as JSON or INSERT (`⌘I`).
- **JSON and arrays** — JSON values (`json`, `jsonb`, or JSON kept in a text column) are coloured in the grid and
  indented in the inspector, where they stay editable; Postgres arrays show each item as a tag in the grid and one item
  a line in the inspector. Changing only the layout is not an edit.
- **Updates** — Trellis updates itself from the GitHub releases (see [Install](#install)).

On its first launch Trellis brings over the connections saved by Strata (the earlier Electron build), without
their passwords: type each password once.

## Install

Download the latest version from [Releases](https://github.com/therealtoresto/trellis/releases/latest).

**Ubuntu, Kubuntu or Debian** (22.04 / 12 or newer, x86-64), from the apt repository:

```sh
curl -fsSL https://raw.githubusercontent.com/therealtoresto/trellis/main/scripts/install-linux.sh | bash
```

[The script](scripts/install-linux.sh) adds the repository and its signing key, then runs `apt install trellis`; from
then on `sudo apt upgrade` updates Trellis with the rest of the system. By hand, it is:

```sh
curl -fsSL https://github.com/therealtoresto/trellis/releases/latest/download/trellis.gpg | sudo tee /usr/share/keyrings/trellis.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/trellis.gpg] https://github.com/therealtoresto/trellis/releases/latest/download ./" | sudo tee /etc/apt/sources.list.d/trellis.list
sudo apt update && sudo apt install trellis
```

Or download a file from the release: `sudo apt install ./Trellis_*_amd64.deb`, or the AppImage, which runs without
installing (`chmod +x Trellis_*.AppImage && ./Trellis_*.AppImage`). Passwords go to the Secret Service (GNOME Keyring,
or KWallet on KDE). Closing the last window quits Trellis on Linux. Trellis turns off WebKit's DMA-BUF renderer, which
leaves the window white with some GPUs and drivers; `WEBKIT_DISABLE_DMABUF_RENDERER=0 trellis` tries it anyway. If a
window still stays blank, `TRELLIS_DEVTOOLS=1 trellis` opens the Web Inspector beside it (on any system) to show
whether the page loaded and what failed.

**macOS** (Apple silicon, macOS 11 or newer) with Homebrew:

```sh
brew tap therealtoresto/trellis https://github.com/therealtoresto/trellis
brew trust therealtoresto/trellis
brew install --cask trellis
```

Homebrew asks once to trust a tap from outside its own repositories (`brew trust`). The cask ([Casks/trellis.rb](Casks/trellis.rb)) always installs the newest release and clears the quarantine flag, as
the app is not signed by Apple. Without Homebrew: unzip `Trellis_macos_arm64.zip` from the release, move `Trellis.app`
to Applications, and open it the first time with right-click → Open (or run
`xattr -dr com.apple.quarantine /Applications/Trellis.app`).

**Windows** (10 or 11, x64): run `Trellis_*_x64-setup.exe` from the release; it installs for the current user, no
administrator needed. Or with [Scoop](https://scoop.sh):

```powershell
scoop bucket add trellis https://github.com/therealtoresto/trellis
scoop install trellis/trellis
```

The build is not code-signed, so the first launch of the installer shows SmartScreen's *Windows protected your PC*:
choose *More info → Run anyway*. Passwords go to the Windows Credential Manager. The SSH tunnel uses Windows' own
OpenSSH agent or Pageant for the agent sign-in. Scoop keeps its copy up to date with `scoop update trellis`; the
release workflow writes the new version into [bucket/trellis.json](bucket/trellis.json).

**Updates** come from inside the app: the welcome window shows an *Update to x.y.z* button when a newer release is
out, and **Trellis → Check for Updates…** looks on demand. Either downloads the release, checks its signature,
installs it over the running copy (the `.app`, the AppImage, the Windows installer, or the `.deb` through a password prompt) and restarts.
This works for every copy from 0.3.0 on, however it was installed; Homebrew leaves the app to update itself. Copies
of 0.2.x predate the updater: install 0.3.0 over them once by any of the ways above. An AppImage updates only where
its user may write the file (such as `~/Applications`), and the repository has to stay public for updates to reach
anyone.

### Building on Ubuntu

```sh
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev libdbus-1-dev pkg-config build-essential
curl https://sh.rustup.rs -sSf | sh       # Rust
npm ci
./node_modules/.bin/tauri build --bundles deb appimage   # → src-tauri/target/release/bundle/{deb,appimage}
```

### Releasing

A release is cut by hand, not on every commit:

```sh
npm run release            # 0.2.0 → 0.2.1; or: npm run release minor | major | 0.4.0
```

It sets the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, commits it, tags the
commit `v<version>` and pushes both. The tag starts [the workflow](.github/workflows/build.yml): it builds Ubuntu and
macOS and Windows, opens the Ubuntu and Windows builds as a smoke test, and when all pass publishes the release with the
`.deb`, the `.AppImage`, the zipped macOS app (`Trellis_macos_arm64.zip`, one name for every release), the signed
update files and the apt repository, its notes listing the commits since the last one. The welcome window
shows the version and the build number (the commit count), as in `Version 0.2.1 (18)`. To get the files without a
release, run the Build workflow from the Actions tab: they appear under the run's Artifacts.

Two signing keys live as repository secrets, with their backups outside the repository (`~/.config/trellis-release`
on the maintainer's Mac): `TAURI_SIGNING_PRIVATE_KEY` for the in-app updates and `APT_GPG_KEY` for the apt repository.
The workflow stops early when one is missing.

The apt repository is part of every release: `Packages`, `Release`, its signatures `InRelease` and `Release.gpg`, and
the public key `trellis.gpg`, next to the `.deb` they list. Since `releases/latest/download/` always points at the newest
release, it works as the repository's address. After publishing, the workflow installs the release with
`scripts/install-linux.sh` on a clean Ubuntu to check that this works.

The update files are signed with a key of our own (minisign, not an Apple certificate). Its public half is
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`; the private half is the `TAURI_SIGNING_PRIVATE_KEY` repository
secret, kept with its backup outside the repository. Lose it and installed copies can no longer update themselves, so
keep the backup. The release also carries `latest.json`, which the app reads from
`releases/latest/download/latest.json` to learn about a new version.

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
