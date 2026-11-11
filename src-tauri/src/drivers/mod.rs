//! One driver per engine behind the same methods. Values reach the window as JSON: text, numbers that fit
//! a JavaScript number, booleans, null, and `{"$blob": length}` for binary data.

pub mod common;
pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub mod ssh;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub type R<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Ref {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub notnull: bool,
    pub dflt: Option<String>,
    pub pk: i64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Filter {
    pub col: String,
    pub op: String,
    #[serde(default)]
    pub val: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Sort {
    pub col: String,
    pub dir: String,
}

#[derive(Deserialize, Debug)]
pub struct PageOpts {
    #[serde(default)]
    pub filters: Vec<Filter>,
    pub sort: Option<Sort>,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Serialize)]
pub struct Row {
    pub key: Vec<Value>,
    pub vals: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    pub total: i64,
    pub approximate: bool,
    pub key_cols: Vec<String>,
    pub editable: bool,
    pub ms: f64,
}

#[derive(Serialize)]
pub struct Obj {
    #[serde(rename = "ref")]
    pub r: Ref,
    pub name: String,
    pub count: Option<i64>,
    pub approximate: bool,
}

#[derive(Serialize)]
pub struct Objects {
    pub schemas: Vec<String>,
    pub tables: Vec<Obj>,
    pub views: Vec<Obj>,
}

#[derive(Serialize)]
pub struct Index {
    pub name: String,
    pub unique: bool,
    pub columns: String,
    pub origin: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fk {
    pub column: String,
    pub table: String,
    pub to: String,
    pub on_delete: String,
}

#[derive(Serialize)]
pub struct Structure {
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub fks: Vec<Fk>,
    pub ddl: String,
}

#[derive(Serialize, Default, Debug)]
pub struct QueryResult {
    pub columns: Option<Vec<String>>,
    pub values: Option<Vec<Vec<Value>>>,
    pub changed: u64,
    pub ms: f64,
    pub write: bool,
    /// The result had more rows than [`common::MAX_ROWS`]; only that many came back.
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct Info {
    pub engine: String,
    pub version: String,
    pub database: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tls: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    #[serde(rename = "ref")]
    pub r: Ref,
    pub key_cols: Vec<String>,
    #[serde(default)]
    pub inserts: Vec<Insert>,
    #[serde(default)]
    pub updates: Vec<Update>,
    #[serde(default)]
    pub deletes: Vec<Delete>,
}

#[derive(Deserialize, Debug)]
pub struct Insert {
    pub set: Map<String, Value>,
}

#[derive(Deserialize, Debug)]
pub struct Update {
    pub key: Vec<Value>,
    pub set: Map<String, Value>,
}

#[derive(Deserialize, Debug)]
pub struct Delete {
    pub key: Vec<Value>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Statement {
    pub sql: String,
    pub show: String,
}

/// What a saved connection or the connection form hands to a driver.
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub engine: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<Value>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
    #[serde(default)]
    pub ssl: Option<bool>,
    #[serde(default)]
    pub file: Option<String>,
    /// Reach the server through an SSH tunnel.
    #[serde(default)]
    pub ssh: Option<bool>,
    #[serde(default)]
    pub ssh_host: Option<String>,
    #[serde(default)]
    pub ssh_port: Option<Value>,
    #[serde(default)]
    pub ssh_user: Option<String>,
    /// auto (the SSH agent, then ~/.ssh keys), key (a key file) or password.
    #[serde(default)]
    pub ssh_auth: Option<String>,
    #[serde(default)]
    pub ssh_key: Option<String>,
    /// The SSH password, or the key's passphrase.
    #[serde(default)]
    pub ssh_password: Option<String>,
    /// Set while tunnelling: the local port that leads to the server.
    #[serde(skip)]
    pub via: Option<u16>,
}

impl Config {
    pub fn text(v: &Option<String>) -> Option<&str> {
        v.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
    pub fn port(&self, default: u16) -> u16 {
        match &self.port {
            Some(Value::Number(n)) => n.as_u64().map(|p| p as u16).unwrap_or(default),
            Some(Value::String(s)) => s.trim().parse().unwrap_or(default),
            _ => default,
        }
    }
    /// disable, prefer, require or verify-full; older saved connections only had an on/off switch.
    pub fn ssl_mode(&self) -> &str {
        match Config::text(&self.ssl_mode) {
            Some(m) => m,
            None if self.ssl == Some(true) => "require",
            None => "prefer",
        }
    }
}

/// Stops the statement a window is running. It works outside the lock the session holds while the statement runs.
#[derive(Clone)]
pub enum Canceller {
    Sqlite(std::sync::Arc<rusqlite::InterruptHandle>),
    Postgres(tokio_postgres::CancelToken, postgres_native_tls::MakeTlsConnector),
    /// MySQL stops a statement with KILL QUERY from a second connection.
    Mysql(mysql_async::Opts, u32),
}

impl Canceller {
    pub async fn cancel(&self) -> R<()> {
        match self {
            Canceller::Sqlite(h) => {
                h.interrupt();
                Ok(())
            }
            Canceller::Postgres(token, tls) => token.cancel_query(tls.clone()).await.map_err(err),
            Canceller::Mysql(opts, id) => {
                use mysql_async::prelude::Queryable;
                let mut c = mysql_async::Conn::new(opts.clone()).await.map_err(err)?;
                c.query_drop(format!("KILL QUERY {id}")).await.map_err(err)?;
                let _ = c.disconnect().await;
                Ok(())
            }
        }
    }
}

pub enum Driver {
    Sqlite(sqlite::Sqlite),
    Postgres(postgres::Pg),
    Mysql(mysql::My),
}

macro_rules! each {
    ($self:ident, $d:ident => $e:expr) => {
        match $self {
            Driver::Sqlite($d) => $e,
            Driver::Postgres($d) => $e,
            Driver::Mysql($d) => $e,
        }
    };
}

impl Driver {
    pub async fn open(cfg: &Config) -> R<Driver> {
        match cfg.engine.as_str() {
            "sqlite" => Ok(Driver::Sqlite(sqlite::Sqlite::open(cfg)?)),
            "postgres" => Ok(Driver::Postgres(postgres::Pg::open(cfg).await?)),
            "mysql" => Ok(Driver::Mysql(mysql::My::open(cfg).await?)),
            other => Err(format!("Unknown engine {other}")),
        }
    }
    /// Opens the driver, through an SSH tunnel when the connection asks for one; the tunnel lives as long as it is
    /// kept. `known_hosts` is where Trellis remembers SSH servers.
    pub async fn connect(cfg: &Config, known_hosts: std::path::PathBuf) -> R<(Driver, Option<ssh::Tunnel>)> {
        if cfg.ssh != Some(true) || cfg.engine == "sqlite" {
            return Ok((Driver::open(cfg).await?, None));
        }
        let tunnel = ssh::open(cfg, if cfg.engine == "mysql" { 3306 } else { 5432 }, known_hosts).await?;
        let mut c = cfg.clone();
        c.via = Some(tunnel.port);
        let driver = Driver::open(&c).await.map_err(|e| format!("{e} (through SSH {})", Config::text(&cfg.ssh_host).unwrap_or("")))?;
        Ok((driver, Some(tunnel)))
    }
    pub fn canceller(&self) -> Canceller {
        each!(self, d => d.canceller())
    }
    pub async fn info(&mut self) -> R<Info> {
        each!(self, d => d.info().await)
    }
    pub async fn objects(&mut self) -> R<Objects> {
        each!(self, d => d.objects().await)
    }
    pub async fn all_columns(&mut self) -> R<BTreeMap<String, Vec<String>>> {
        each!(self, d => d.all_columns().await)
    }
    pub async fn set_schema(&mut self, schema: &str) -> R<()> {
        each!(self, d => d.set_schema(schema).await)
    }
    pub async fn structure(&mut self, r: &Ref) -> R<Structure> {
        each!(self, d => d.structure(r).await)
    }
    pub async fn page(&mut self, r: &Ref, opts: &PageOpts) -> R<Page> {
        each!(self, d => d.page(r, opts).await)
    }
    pub async fn query(&mut self, sql: &str) -> R<QueryResult> {
        each!(self, d => d.query(sql).await)
    }
    pub fn preview(&self, ch: &Changes) -> R<Vec<Statement>> {
        each!(self, d => d.preview(ch))
    }
    pub async fn apply(&mut self, ch: &Changes) -> R<Vec<Statement>> {
        each!(self, d => d.apply(ch).await)
    }
}

#[cfg(test)]
mod tests;
