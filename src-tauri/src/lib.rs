//! Trellis: windows, the menu, saved connections and one open database per window.

pub mod drivers;
mod lights;
mod store;

use drivers::{common::SAMPLE_SQL, err, Changes, Driver, PageOpts, Ref, R};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use store::Store;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Effect, EffectState};
use tauri::{AppHandle, Emitter, Manager, State, TitleBarStyle, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

struct Session {
    driver: Driver,
    /// The SSH tunnel the driver talks through, kept open as long as the session.
    _tunnel: Option<drivers::ssh::Tunnel>,
}

struct AppState {
    store: Store,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    /// Per window, what stops its running statement; kept apart from the session, which is locked while it runs.
    cancels: std::sync::Mutex<HashMap<String, drivers::Canceller>>,
}

/// Set once the app is quitting, so closing its last workspace does not bring the welcome window back.
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static WINDOWS: AtomicUsize = AtomicUsize::new(0);

async fn session(state: &AppState, window: &Window) -> R<Arc<Mutex<Session>>> {
    state.sessions.lock().await.get(window.label()).cloned().ok_or_else(|| "Not connected.".to_string())
}

/* ---------- connections ---------- */

#[tauri::command]
async fn conns_list(state: State<'_, AppState>) -> R<Vec<Value>> {
    state.store.list()
}

#[tauri::command]
async fn conns_save(state: State<'_, AppState>, form: Value) -> R<Value> {
    state.store.save(form)
}

#[tauri::command]
async fn conns_delete(state: State<'_, AppState>, id: String) -> R<()> {
    state.store.delete(&id)
}

#[tauri::command]
async fn conns_test(state: State<'_, AppState>, form: Value) -> R<drivers::Info> {
    let saved = form.get("id").and_then(Value::as_str).and_then(|id| state.store.get(id).ok());
    let mut merged = saved.unwrap_or(json!({}));
    for (k, v) in form.as_object().cloned().unwrap_or_default() {
        merged[k] = v;
    }
    let (mut d, _tunnel) = Driver::connect(&state.store.config(&merged)?, state.store.known_hosts()).await?;
    d.info().await
}

#[tauri::command]
async fn db_connect(window: Window, state: State<'_, AppState>, id: String) -> R<Value> {
    let conn = state.store.get(&id)?;
    if conn.get("demo") == Some(&json!(true)) && !state.store.demo_file().exists() {
        state.store.reset_demo()?;
    }
    let (mut driver, tunnel) = Driver::connect(&state.store.config(&conn)?, state.store.known_hosts()).await?;
    let info = driver.info().await?;
    state.cancels.lock().unwrap().insert(window.label().to_string(), driver.canceller());
    state.sessions.lock().await.insert(window.label().to_string(), Arc::new(Mutex::new(Session { driver, _tunnel: tunnel })));
    let name = conn.get("name").and_then(Value::as_str).unwrap_or("Trellis");
    let _ = window.set_title(&format!("{name} — Trellis"));
    replace_lights(&window);
    let sample = if conn.get("demo") == Some(&json!(true)) { SAMPLE_SQL } else { "" };
    let mut public = conn.clone();
    if let Some(o) = public.as_object_mut() { o.remove("password"); }
    Ok(json!({ "conn": public, "info": info, "sample": sample }))
}

#[tauri::command]
async fn db_disconnect(window: Window, state: State<'_, AppState>) -> R<()> {
    state.sessions.lock().await.remove(window.label());
    state.cancels.lock().unwrap().remove(window.label());
    let _ = window.set_title("Trellis");
    replace_lights(&window);
    Ok(())
}

#[tauri::command]
async fn db_objects(window: Window, state: State<'_, AppState>) -> R<drivers::Objects> {
    session(&state, &window).await?.lock().await.driver.objects().await
}

#[tauri::command]
async fn db_set_schema(window: Window, state: State<'_, AppState>, schema: String) -> R<()> {
    session(&state, &window).await?.lock().await.driver.set_schema(&schema).await
}

#[tauri::command]
async fn db_all_columns(window: Window, state: State<'_, AppState>) -> R<std::collections::BTreeMap<String, Vec<String>>> {
    session(&state, &window).await?.lock().await.driver.all_columns().await
}

#[tauri::command]
async fn db_structure(window: Window, state: State<'_, AppState>, target: Ref) -> R<drivers::Structure> {
    session(&state, &window).await?.lock().await.driver.structure(&target).await
}

#[tauri::command]
async fn db_page(window: Window, state: State<'_, AppState>, target: Ref, opts: PageOpts) -> R<drivers::Page> {
    session(&state, &window).await?.lock().await.driver.page(&target, &opts).await
}

#[tauri::command]
async fn db_query(window: Window, state: State<'_, AppState>, sql: String) -> R<drivers::QueryResult> {
    session(&state, &window).await?.lock().await.driver.query(&sql).await
}

/// Stops the statement this window is running; its query then ends with the server's cancel error.
#[tauri::command]
async fn db_cancel(window: Window, state: State<'_, AppState>) -> R<()> {
    let c = state.cancels.lock().unwrap().get(window.label()).cloned().ok_or_else(|| "Not connected.".to_string())?;
    c.cancel().await
}

#[tauri::command]
async fn db_preview(window: Window, state: State<'_, AppState>, changes: Changes) -> R<Vec<drivers::Statement>> {
    session(&state, &window).await?.lock().await.driver.preview(&changes)
}

#[tauri::command]
async fn db_apply(window: Window, state: State<'_, AppState>, changes: Changes) -> R<Vec<drivers::Statement>> {
    session(&state, &window).await?.lock().await.driver.apply(&changes).await
}

#[tauri::command]
async fn demo_reset(window: Window, state: State<'_, AppState>) -> R<()> {
    state.sessions.lock().await.remove(window.label());
    state.store.reset_demo()
}

/* ---------- files ---------- */

fn query_dir(app: &AppHandle) -> PathBuf {
    app.path().document_dir().unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default())).join("Trellis Queries")
}

fn path_of(p: tauri_plugin_dialog::FilePath) -> R<String> {
    p.into_path().map(|p| p.to_string_lossy().into_owned()).map_err(err)
}

/// Picks an SSH private key, starting in ~/.ssh.
#[tauri::command]
async fn dialog_pick_key(app: AppHandle) -> R<Option<String>> {
    let dir = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".ssh");
    match app.dialog().file().set_title("Choose an SSH key").set_directory(dir).blocking_pick_file() {
        Some(p) => Ok(Some(path_of(p)?)),
        None => Ok(None),
    }
}

#[tauri::command]
async fn dialog_open_sqlite(app: AppHandle) -> R<Option<String>> {
    match app.dialog().file().set_title("Open a SQLite database").add_filter("SQLite", &["sqlite", "sqlite3", "db", "db3", "s3db"]).blocking_pick_file() {
        Some(p) => Ok(Some(path_of(p)?)),
        None => Ok(None),
    }
}

#[tauri::command]
async fn dialog_new_sqlite(app: AppHandle) -> R<Option<String>> {
    match app.dialog().file().set_title("New SQLite database").set_file_name("untitled.sqlite").add_filter("SQLite", &["sqlite"]).blocking_save_file() {
        Some(p) => Ok(Some(path_of(p)?)),
        None => Ok(None),
    }
}

#[tauri::command]
async fn file_open_sql(app: AppHandle) -> R<Vec<Value>> {
    let dir = query_dir(&app);
    let mut d = app.dialog().file().set_title("Open SQL files").add_filter("SQL", &["sql", "txt"]);
    d = d.set_directory(if dir.exists() { dir } else { app.path().document_dir().unwrap_or_default() });
    let mut out = Vec::new();
    for p in d.blocking_pick_files().unwrap_or_default() {
        let path = path_of(p)?;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
        out.push(json!({ "path": path, "text": text }));
    }
    Ok(out)
}

#[tauri::command]
async fn file_read_sql(path: String) -> R<Value> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(json!({ "path": path, "text": text }))
}

/// Saves to `file`, or asks where when there is none yet or for Save As.
#[tauri::command]
async fn file_save_sql(app: AppHandle, file: Option<String>, text: String, name: Option<String>, save_as: Option<bool>) -> R<Option<String>> {
    let target = match (file.clone(), save_as.unwrap_or(false)) {
        (Some(f), false) => f,
        _ => {
            let dir = query_dir(&app);
            std::fs::create_dir_all(&dir).map_err(err)?;
            let clean: String = name.unwrap_or_else(|| "query".into()).chars().map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c }).collect();
            let mut d = app.dialog().file().set_title("Save query").add_filter("SQL", &["sql"]).set_file_name(format!("{clean}.sql"));
            d = d.set_directory(file.as_ref().and_then(|f| PathBuf::from(f).parent().map(PathBuf::from)).unwrap_or(dir));
            match d.blocking_save_file() {
                Some(p) => path_of(p)?,
                None => return Ok(None),
            }
        }
    };
    std::fs::write(&target, text).map_err(|e| format!("Could not save {target}: {e}"))?;
    Ok(Some(target))
}

/// Files the window may write: only those the person picked in an export dialog.
static EXPORTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Asks where to save an export, offering `name.ext` in Downloads.
#[tauri::command]
async fn file_export_path(app: AppHandle, name: String, ext: String) -> R<Option<String>> {
    let clean: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c }).collect();
    let dir = app.path().download_dir().or_else(|_| app.path().document_dir()).unwrap_or_default();
    let picked = app.dialog().file().set_title("Export").add_filter(ext.to_uppercase(), &[ext.as_str()]).set_file_name(format!("{clean}.{ext}")).set_directory(dir).blocking_save_file();
    let Some(p) = picked else { return Ok(None) };
    let path = path_of(p)?;
    EXPORTS.lock().unwrap().push(path.clone());
    Ok(Some(path))
}

/// Writes (or, with `append`, adds to) an export file picked through [`file_export_path`].
#[tauri::command]
async fn file_write_export(path: String, text: String, append: bool) -> R<()> {
    use std::io::Write;
    if !EXPORTS.lock().unwrap().contains(&path) {
        return Err("Pick the file to export to first.".into());
    }
    let mut f = std::fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(&path).map_err(|e| format!("Could not write {path}: {e}"))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("Could not write {path}: {e}"))
}

#[tauri::command]
async fn file_reveal(app: AppHandle, path: String) -> R<()> {
    app.opener().reveal_item_in_dir(path).map_err(err)
}

#[tauri::command]
async fn clipboard_write(app: AppHandle, text: String) -> R<()> {
    app.clipboard().write_text(text).map_err(err)
}

#[tauri::command]
async fn window_new(app: AppHandle, connect_id: Option<String>) -> R<()> {
    create_window(&app, connect_id).map(|_| ())
}

#[tauri::command]
fn app_info() -> Value {
    json!({ "platform": std::env::consts::OS.replace("macos", "darwin"), "vibrancy": cfg!(target_os = "macos"), "selftest": std::env::var("TRELLIS_SELFTEST").is_ok(), "selftestOnly": std::env::var("TRELLIS_SELFTEST_ONLY").ok() })
}

/* ---------- welcome window ---------- */

/// What the welcome window shows under the logo.
#[tauri::command]
fn about_info() -> Value {
    let built = env!("TRELLIS_BUILT");
    json!({
        "name": "Trellis",
        "version": env!("CARGO_PKG_VERSION"),
        "build": env!("TRELLIS_BUILD"),
        "built": built,
        "developer": env!("CARGO_PKG_AUTHORS"),
        "license": env!("CARGO_PKG_LICENSE"),
        "year": &built[..4.min(built.len())],
    })
}

/* ---------- updates ---------- */

/// Debug builds and self-tests never look for updates: they would replace a build that isn't a release.
fn updates_enabled() -> bool {
    !cfg!(debug_assertions) && std::env::var("TRELLIS_SELFTEST").is_err()
}

async fn find_update(app: &AppHandle) -> R<Option<tauri_plugin_updater::Update>> {
    use tauri_plugin_updater::UpdaterExt;
    app.updater().map_err(err)?.check().await.map_err(err)
}

/// Downloads the update, installs it over this copy and starts the new one. `progress` hears the share done, 0 to 1.
async fn install_update(app: AppHandle, update: tauri_plugin_updater::Update, progress: impl Fn(f64) + Send + 'static) -> R<()> {
    let mut got = 0usize;
    update
        .download_and_install(move |chunk, total| { got += chunk; if let Some(t) = total { progress(got as f64 / t as f64); } }, || {})
        .await
        .map_err(err)?;
    QUITTING.store(true, Ordering::SeqCst);
    app.restart()
}

/// The newer release on GitHub, if there is one, and how many database windows a restart would close.
#[tauri::command]
async fn update_check(app: AppHandle) -> R<Option<Value>> {
    if !updates_enabled() {
        return Ok(None);
    }
    let windows = app.webview_windows().keys().filter(|l| l.starts_with("trellis-")).count();
    Ok(find_update(&app).await?.map(|u| json!({ "version": u.version, "current": u.current_version, "notes": u.body, "windows": windows })))
}

/// Installs the newer release and restarts; the window that asked hears the download as `update` events.
#[tauri::command]
async fn update_install(app: AppHandle, window: WebviewWindow) -> R<()> {
    let update = find_update(&app).await?.ok_or_else(|| "Trellis is up to date.".to_string())?;
    let (a, label) = (app.clone(), window.label().to_string());
    install_update(app, update, move |share| { let _ = a.emit_to(label.as_str(), "update", share); }).await
}

/// Trellis → Check for Updates…: says so when there is nothing newer, and asks before installing.
fn check_updates_from_menu(app: &AppHandle) {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let found = if updates_enabled() { find_update(&app).await } else { Ok(None) };
        let version = env!("CARGO_PKG_VERSION");
        match found {
            Ok(None) => app.dialog().message(format!("Trellis {version} is the latest version.")).title("You’re up to date").kind(MessageDialogKind::Info).show(|_| {}),
            Err(e) => app.dialog().message(format!("Couldn’t reach GitHub to check for updates: {e}")).title("Check for Updates").kind(MessageDialogKind::Warning).show(|_| {}),
            Ok(Some(u)) => {
                let a = app.clone();
                let notes = u.body.clone().filter(|b| !b.trim().is_empty()).map(|b| format!("\n\n{}", b.chars().take(600).collect::<String>())).unwrap_or_default();
                app.dialog()
                    .message(format!("Trellis {} is out; you have {version}. Installing it restarts Trellis and closes open windows.{notes}", u.version))
                    .title("Update available")
                    .buttons(MessageDialogButtons::OkCancelCustom("Update and Restart".into(), "Later".into()))
                    .show(move |yes| {
                        if yes {
                            tauri::async_runtime::spawn(async move {
                                if let Err(e) = install_update(a.clone(), u, |_| {}).await {
                                    a.dialog().message(format!("The update failed: {e}")).title("Update failed").kind(MessageDialogKind::Error).show(|_| {});
                                }
                            });
                        }
                    });
            }
        }
    });
}

/// Opens a database in a workspace window and puts the welcome window away.
#[tauri::command]
async fn open_connection_window(app: AppHandle, id: String) -> R<()> {
    create_window(&app, Some(id))?;
    if let Some(w) = app.get_webview_window("welcome") {
        let _ = w.close();
    }
    Ok(())
}

#[tauri::command]
fn show_welcome(app: AppHandle) -> R<()> {
    create_welcome(&app)
}

/// The first thing Trellis shows: the logo and version on the left, saved connections on the right.
fn create_welcome(app: &AppHandle) -> R<()> {
    if let Some(w) = app.get_webview_window("welcome") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let mut b = WebviewWindowBuilder::new(app, "welcome", WebviewUrl::App("welcome.html".into()))
        .title("Welcome to Trellis")
        .inner_size(800.0, 500.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    {
        b = b
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .transparent(true)
            .effects(WindowEffectsConfig { effects: vec![Effect::UnderWindowBackground], state: Some(EffectState::FollowsWindowActiveState), radius: None, color: None, interactive: false });
    }
    let w = b.build().map_err(err)?;
    lights::place_settled(&w);
    Ok(())
}

#[tauri::command]
fn debug_windows(app: AppHandle) -> Value {
    json!(app.webview_windows().iter().map(|(label, w)| json!({ "label": label, "visible": w.is_visible().unwrap_or(false) })).collect::<Vec<_>>())
}

/* ---------- self-test ---------- */

#[tauri::command]
fn selftest_log(text: String) -> R<()> {
    let dir = std::env::var("TRELLIS_SELFTEST").map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(PathBuf::from(dir).join("log.txt")).map_err(err)?;
    writeln!(f, "{text}").map_err(err)
}

/// Where the window buttons are and where they should be, for the self-test.
#[tauri::command]
fn debug_traffic_lights(window: Window) -> Value {
    let centers = window.app_handle().get_webview_window(window.label()).map(|w| lights::measure(&w)).unwrap_or_default();
    let spec = lights::spec(window.label());
    json!({ "centers": centers, "x": spec.x, "centerY": spec.center_y, "onlyClose": spec.only_close })
}

/// The page calls this once it has loaded, when the window has its final layout.
#[tauri::command]
fn place_lights(window: Window) {
    replace_lights(&window);
}

#[tauri::command]
fn selftest_resize(window: Window, width: f64, height: f64) -> R<()> {
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(err)
}

#[tauri::command]
fn selftest_done(app: AppHandle) {
    if std::env::var("TRELLIS_KEEP").is_err() {
        app.exit(0);
    }
}

/* ---------- windows and menu ---------- */

fn create_window(app: &AppHandle, connect: Option<String>) -> R<WebviewWindow> {
    let n = WINDOWS.fetch_add(1, Ordering::SeqCst);
    let label = format!("trellis-{n}");
    let init = format!("window.__TRELLIS_CONNECT__ = {};", serde_json::to_string(&connect).unwrap_or("null".into()));
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Trellis")
        .inner_size(1440.0, 900.0)
        .min_inner_size(780.0, 520.0)
        .initialization_script(&init)
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    {
        b = b
            .title_bar_style(TitleBarStyle::Overlay)
            .hidden_title(true)
            .transparent(true)
            .effects(WindowEffectsConfig { effects: vec![Effect::UnderWindowBackground], state: Some(EffectState::FollowsWindowActiveState), radius: None, color: None, interactive: false });
    }
    if n > 0 {
        b = b.position(120.0 + (n % 6) as f64 * 28.0, 80.0 + (n % 6) as f64 * 28.0);
    }
    let w = b.build().map_err(err)?;
    lights::place_settled(&w);
    Ok(w)
}

/// Puts the window buttons back on the toolbar after AppKit moved them.
fn replace_lights(window: &Window) {
    if let Some(w) = window.app_handle().get_webview_window(window.label()) {
        lights::place(&w);
    }
}

fn focused(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let it = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &it("new-window", "New Window", Some("CmdOrCtrl+N"))?,
            &it("new-query", "New Query Tab", Some("CmdOrCtrl+T"))?,
            &PredefinedMenuItem::separator(app)?,
            &it("open-sql", "Open SQL File…", Some("CmdOrCtrl+O"))?,
            &it("save", "Save", Some("CmdOrCtrl+S"))?,
            &it("save-as", "Save As…", Some("CmdOrCtrl+Shift+S"))?,
            &it("export", "Export…", Some("CmdOrCtrl+Shift+E"))?,
            &PredefinedMenuItem::separator(app)?,
            &it("new-connection", "New Connection…", None)?,
            &it("connections", "Open Connection…", Some("CmdOrCtrl+Shift+K"))?,
            &it("open-file", "Open SQLite File…", Some("CmdOrCtrl+Shift+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &it("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?,
            &it("close-window", "Close Window", Some("CmdOrCtrl+Shift+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let database = Submenu::with_items(
        app,
        "Database",
        true,
        &[
            &it("palette", "Open Anything…", Some("CmdOrCtrl+P"))?,
            &it("schemas", "Switch Schema…", Some("CmdOrCtrl+Shift+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &it("run", "Run Statement", Some("CmdOrCtrl+Enter"))?,
            &it("run-all", "Run All", Some("CmdOrCtrl+Shift+Enter"))?,
            &it("stop", "Stop Query", Some("CmdOrCtrl+."))?,
            &it("commit", "Review and Commit…", None)?,
            &it("discard", "Discard Changes", Some("CmdOrCtrl+Shift+Backspace"))?,
            &PredefinedMenuItem::separator(app)?,
            &it("add-row", "Add Row", Some("CmdOrCtrl+Shift+N"))?,
            &it("filter", "Filter Rows", Some("CmdOrCtrl+F"))?,
            &it("refresh", "Refresh", Some("CmdOrCtrl+R"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &it("view-data", "Show Data", Some("CmdOrCtrl+1"))?,
            &it("view-structure", "Show Structure", Some("CmdOrCtrl+2"))?,
            &PredefinedMenuItem::separator(app)?,
            &it("pane-items", "Items", Some("CmdOrCtrl+Alt+1"))?,
            &it("pane-queries", "Saved Queries", Some("CmdOrCtrl+Alt+2"))?,
            &it("pane-history", "Query History", Some("CmdOrCtrl+Y"))?,
            &PredefinedMenuItem::separator(app)?,
            &it("inspector", "Toggle Inspector", Some("CmdOrCtrl+I"))?,
            &it("sidebar", "Toggle Sidebar", Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &PredefinedMenuItem::separator(app)?, &it("welcome", "Welcome to Trellis", Some("CmdOrCtrl+Shift+1"))?],
    )?;
    let about = Submenu::with_items(
        app,
        "Trellis",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Trellis"), None)?,
            &it("check-updates", "Check for Updates…", None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&about, &file, &edit, &database, &view, &window])
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = match std::env::var("TRELLIS_USERDATA") {
                Ok(d) => PathBuf::from(d),
                Err(_) => app.path().app_data_dir()?,
            };
            let demo = app.path().resolve("gamification_demo.sqlite", tauri::path::BaseDirectory::Resource)?;
            app.manage(AppState { store: Store::new(dir, demo), sessions: Mutex::new(HashMap::new()), cancels: Default::default() });
            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref().to_string();
                match id.as_str() {
                    "new-window" => { let _ = create_window(app, None); }
                    "welcome" => { let _ = create_welcome(app); }
                    "check-updates" => check_updates_from_menu(app),
                    "close-window" => { if let Some(w) = focused(app) { let _ = w.close(); } }
                    _ => {
                        if let Some(w) = focused(app) {
                            let _ = app.emit_to(w.label(), "menu", id);
                        }
                    }
                }
            });
            create_welcome(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) | tauri::WindowEvent::ThemeChanged(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) {
                replace_lights(window);
            }
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                let label = window.label().to_string();
                tauri::async_runtime::block_on(async { state.sessions.lock().await.remove(&label); });
                state.cancels.lock().unwrap().remove(&label);
                // Closing the last workspace brings the welcome window back, as in TablePlus.
                let app = window.app_handle();
                let workspaces = app.webview_windows().keys().filter(|l| l.starts_with("trellis-") && **l != label).count();
                if label.starts_with("trellis-") && workspaces == 0 && !QUITTING.load(Ordering::SeqCst) {
                    let _ = create_welcome(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            conns_list, conns_save, conns_delete, conns_test,
            db_connect, db_disconnect, db_objects, db_set_schema, db_all_columns, db_structure, db_page, db_query, db_cancel, db_preview, db_apply,
            demo_reset, dialog_pick_key, dialog_open_sqlite, dialog_new_sqlite, file_open_sql, file_read_sql, file_save_sql, file_reveal, file_export_path, file_write_export,
            clipboard_write, window_new, app_info, selftest_log, selftest_done, debug_traffic_lights, selftest_resize, about_info, open_connection_window, show_welcome, debug_windows, place_lights,
            update_check, update_install,
        ])
        .build(tauri::generate_context!())
        .expect("Trellis failed to start")
        .run(|app, event| match event {
            // On macOS closing the last window keeps Trellis in the Dock. A quit (⌘Q, the Dock menu) arrives while
            // windows are still open, and goes through. Elsewhere closing the last window quits.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::ExitRequested { code: None, api, .. } if app.webview_windows().is_empty() && !QUITTING.load(Ordering::SeqCst) => api.prevent_exit(),
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => QUITTING.store(true, Ordering::SeqCst),
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows: false, .. } => { let _ = create_welcome(app); }
            _ => {}
        });
}
