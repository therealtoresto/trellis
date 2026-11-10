//! Saved connections: a JSON file in the app's data folder, passwords in the macOS Keychain.

use crate::drivers::{err, Config, R};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const KEYCHAIN_SERVICE: &str = "Trellis";

pub struct Store {
    dir: PathBuf,
    demo_source: PathBuf,
}

fn keychain(id: &str) -> R<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, id).map_err(err)
}

impl Store {
    pub fn new(dir: PathBuf, demo_source: PathBuf) -> Self {
        Store { dir, demo_source }
    }

    fn file(&self) -> PathBuf {
        self.dir.join("connections.json")
    }

    pub fn demo_file(&self) -> PathBuf {
        self.dir.join("Example").join("gamification_demo.sqlite")
    }

    pub fn reset_demo(&self) -> R<()> {
        let target = self.demo_file();
        fs::create_dir_all(target.parent().unwrap()).map_err(err)?;
        fs::copy(&self.demo_source, &target).map_err(|e| format!("Could not copy the example database: {e}"))?;
        Ok(())
    }

    fn write(&self, list: &[Value]) -> R<()> {
        fs::create_dir_all(&self.dir).map_err(err)?;
        let tmp = self.file().with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(list).map_err(err)?).map_err(err)?;
        fs::rename(tmp, self.file()).map_err(err)
    }

    /// The first launch seeds the example database and brings over connections saved by Strata, the Electron build
    /// (without their passwords, which that build encrypted with its own key).
    pub fn list(&self) -> R<Vec<Value>> {
        if let Ok(bytes) = fs::read(self.file()) {
            if let Ok(Value::Array(list)) = serde_json::from_slice(&bytes) {
                return Ok(list);
            }
        }
        if !self.demo_file().exists() {
            self.reset_demo()?;
        }
        let mut list = vec![json!({ "id": "example", "name": "Example", "engine": "sqlite", "env": "local", "file": self.demo_file(), "demo": true })];
        if let Some(home) = std::env::var_os("HOME") {
            let old = Path::new(&home).join("Library/Application Support/Strata/connections.json");
            if let Ok(Value::Array(prev)) = fs::read(&old).map_err(err).and_then(|b| serde_json::from_slice(&b).map_err(err)) {
                for mut c in prev {
                    let demo = c.get("demo") == Some(&json!(true));
                    if demo && c.get("engine") == Some(&json!("sqlite")) {
                        continue;
                    }
                    if let Some(o) = c.as_object_mut() {
                        o.remove("secret");
                        o.insert("hasPassword".into(), json!(false));
                        // Strata let the example be edited into a server connection; it keeps its settings
                        // but gets its own id and a name from its host.
                        if demo {
                            o.remove("demo");
                            o.remove("file");
                            o.insert("id".into(), json!(uuid::Uuid::new_v4().to_string()));
                            if o.get("name") == Some(&json!("Example")) {
                                let host = o.get("host").and_then(Value::as_str).unwrap_or("Server").to_string();
                                o.insert("name".into(), json!(host));
                            }
                        }
                    }
                    list.push(c);
                }
            }
        }
        self.write(&list)?;
        Ok(list)
    }

    pub fn get(&self, id: &str) -> R<Value> {
        self.list()?.into_iter().find(|c| c["id"] == id).ok_or_else(|| "That connection no longer exists.".to_string())
    }

    /// A form carries `password` only when the field was typed in: text replaces the Keychain item,
    /// an empty string removes it.
    pub fn save(&self, form: Value) -> R<Value> {
        let mut list = self.list()?;
        let mut form = match form { Value::Object(m) => m, _ => return Err("Bad connection form.".into()) };
        let password = form.remove("password");
        form.remove("hasPassword");
        let id = form.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        form.insert("id".into(), json!(id));
        let pos = list.iter().position(|c| c["id"] == id.as_str());
        let mut next: Map<String, Value> = pos.and_then(|i| list[i].as_object().cloned()).unwrap_or_default();
        for (k, v) in form {
            next.insert(k, v);
        }
        if let Some(Value::String(p)) = password {
            let entry = keychain(&id)?;
            if p.is_empty() {
                let _ = entry.delete_credential();
                next.insert("hasPassword".into(), json!(false));
            } else {
                entry.set_password(&p).map_err(|e| format!("Could not store the password in Keychain: {e}"))?;
                next.insert("hasPassword".into(), json!(true));
            }
        }
        let next = Value::Object(next);
        match pos {
            Some(i) => list[i] = next.clone(),
            None => list.push(next.clone()),
        }
        self.write(&list)?;
        Ok(next)
    }

    pub fn delete(&self, id: &str) -> R<()> {
        let list: Vec<Value> = self.list()?.into_iter().filter(|c| c["id"] != id).collect();
        if let Ok(e) = keychain(id) {
            let _ = e.delete_credential();
        }
        self.write(&list)
    }

    /// The driver settings for a saved connection, or for a form being tested (its typed password wins).
    pub fn config(&self, conn: &Value) -> R<Config> {
        let mut cfg: Config = serde_json::from_value(conn.clone()).map_err(err)?;
        if cfg.password.is_none() && conn.get("hasPassword") == Some(&json!(true)) {
            if let Some(id) = conn.get("id").and_then(Value::as_str) {
                cfg.password = keychain(id)?.get_password().ok();
            }
        }
        Ok(cfg)
    }
}
