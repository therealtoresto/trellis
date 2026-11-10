//! PostgreSQL through tokio-postgres over the simple (text) protocol, the way psql prints values.
//! Column types decide which texts become numbers or booleans. One client per window, so a
//! transaction begun in a query tab stays open in that window.

use super::common::{self, change_statements, convert, is_write, where_sql, Dialect, Kind};
use super::*;
use postgres_native_tls::MakeTlsConnector;
use std::time::{Duration, Instant};
use tokio_postgres::config::SslMode;
use tokio_postgres::{Client, SimpleQueryMessage};

const D: Dialect = Dialect::Postgres;
const APPROX_OVER: i64 = 200_000;

pub struct Pg {
    client: Client,
}

/// One statement's output from the simple protocol.
struct Set {
    cols: Option<Vec<String>>,
    rows: Vec<Vec<Option<String>>>,
    changed: u64,
}

fn pg_err(e: tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => match db.detail() {
            Some(d) => format!("{} ({})", db.message(), d),
            None => db.message().to_string(),
        },
        None => {
            let s = e.to_string();
            match std::error::Error::source(&e) {
                Some(src) => format!("{s}: {src}"),
                None => s,
            }
        }
    }
}

/// Postgres type names (from format_type or the wire) that read as numbers or booleans.
fn kind(ty: &str) -> Kind {
    let t = ty.to_ascii_lowercase();
    let t = t.split('(').next().unwrap_or("").trim();
    match t {
        "smallint" | "integer" | "bigint" | "int2" | "int4" | "int8" | "oid" | "smallserial" | "serial" | "bigserial" => Kind::Int,
        "real" | "double precision" | "float4" | "float8" => Kind::Float,
        "boolean" | "bool" => Kind::Bool,
        _ => Kind::Text,
    }
}

impl Pg {
    pub async fn open(cfg: &Config) -> R<Self> {
        let mut c = tokio_postgres::Config::new();
        c.host(Config::text(&cfg.host).unwrap_or("localhost"));
        c.port(cfg.port(5432));
        if let Some(u) = Config::text(&cfg.user) { c.user(u); }
        if let Some(p) = cfg.password.as_deref().filter(|p| !p.is_empty()) { c.password(p); }
        // Without a database Postgres would look for one named after the user; `postgres` always exists.
        c.dbname(Config::text(&cfg.database).unwrap_or("postgres"));
        c.application_name("Trellis");
        c.connect_timeout(Duration::from_secs(10));
        let mode = cfg.ssl_mode();
        c.ssl_mode(match mode { "disable" => SslMode::Disable, "require" | "verify-full" => SslMode::Require, _ => SslMode::Prefer });
        let verify = mode == "verify-full";
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(!verify)
            .danger_accept_invalid_hostnames(!verify)
            .build()
            .map_err(err)?;
        let (client, connection) = c.connect(MakeTlsConnector::new(tls)).await.map_err(pg_err)?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        client.batch_execute("SET standard_conforming_strings = on").await.map_err(pg_err)?;
        Ok(Pg { client })
    }

    async fn simple(&self, sql: &str) -> R<Vec<Set>> {
        let msgs = self.client.simple_query(sql).await.map_err(pg_err)?;
        let mut sets: Vec<Set> = Vec::new();
        let mut open = false;
        for m in msgs {
            match m {
                SimpleQueryMessage::RowDescription(cols) => {
                    sets.push(Set { cols: Some(cols.iter().map(|c| c.name().to_string()).collect()), rows: vec![], changed: 0 });
                    open = true;
                }
                SimpleQueryMessage::Row(r) => {
                    if !open {
                        sets.push(Set { cols: Some(r.columns().iter().map(|c| c.name().to_string()).collect()), rows: vec![], changed: 0 });
                        open = true;
                    }
                    let row = (0..r.len()).map(|i| r.get(i).map(String::from)).collect();
                    sets.last_mut().unwrap().rows.push(row);
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    if open { sets.last_mut().unwrap().changed = n; } else { sets.push(Set { cols: None, rows: vec![], changed: n }); }
                    open = false;
                }
                _ => {}
            }
        }
        Ok(sets)
    }

    async fn rows(&self, sql: &str) -> R<Vec<Vec<Option<String>>>> {
        Ok(self.simple(sql).await?.into_iter().rev().find(|s| s.cols.is_some()).map(|s| s.rows).unwrap_or_default())
    }

    async fn one(&self, sql: &str) -> R<Option<String>> {
        Ok(self.rows(sql).await?.into_iter().next().and_then(|r| r.into_iter().next()).flatten())
    }

    fn table(&self, r: &Ref) -> String {
        format!("{}.{}", D.quote(r.schema.as_deref().unwrap_or("public")), D.quote(&r.name))
    }

    pub async fn info(&mut self) -> R<Info> {
        let r = self.rows("SELECT current_setting('server_version'), current_database(), current_user").await?;
        let row = r.into_iter().next().unwrap_or_default();
        let get = |i: usize| row.get(i).cloned().flatten().unwrap_or_default();
        let tls = self
            .one("SELECT CASE WHEN ssl THEN version ELSE 'no TLS' END FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
            .await
            .ok()
            .flatten();
        Ok(Info { engine: "PostgreSQL".into(), version: get(0).split(' ').next().unwrap_or("").into(), database: get(1), user: Some(get(2)), tls })
    }

    pub async fn objects(&mut self) -> R<Objects> {
        let schemas = self
            .rows("SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' ORDER BY nspname")
            .await?
            .into_iter()
            .filter_map(|r| r.into_iter().next().flatten())
            .collect();
        let rows = self
            .rows(
                "SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relkind IN ('r','p','v','m','f')
                   AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
                   AND NOT c.relispartition
                 ORDER BY n.nspname, lower(c.relname)",
            )
            .await?;
        let (mut tables, mut views) = (Vec::new(), Vec::new());
        for r in rows {
            let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
            let est: i64 = g(3).parse().unwrap_or(-1);
            let o = Obj { r: Ref { schema: Some(g(0)), name: g(1) }, name: g(1), count: if est >= 0 { Some(est) } else { None }, approximate: true };
            if matches!(g(2).as_str(), "r" | "p" | "f") { tables.push(o) } else { views.push(o) }
        }
        Ok(Objects { schemas, tables, views })
    }

    /// Bare table names in the SQL editor resolve in the schema the sidebar shows.
    pub async fn set_schema(&mut self, schema: &str) -> R<()> {
        let path = if schema == "public" { "public".to_string() } else { format!("{}, public", D.quote(schema)) };
        self.client.batch_execute(&format!("SET search_path TO {path}")).await.map_err(pg_err)
    }

    async fn columns_of(&self, r: &Ref) -> R<Vec<Column>> {
        let sql = format!(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
                    coalesce((SELECT k.n FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n) WHERE k.attnum = a.attnum), 0)
             FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
             WHERE n.nspname = {} AND c.relname = {} AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum",
            D.string(r.schema.as_deref().unwrap_or("public")),
            D.string(&r.name)
        );
        Ok(self
            .rows(&sql)
            .await?
            .into_iter()
            .map(|c| Column {
                name: c[0].clone().unwrap_or_default(),
                ty: c[1].clone().unwrap_or_default(),
                notnull: c[2].as_deref() == Some("t"),
                dflt: c[3].clone(),
                pk: c[4].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
            })
            .collect())
    }

    pub async fn all_columns(&mut self) -> R<BTreeMap<String, Vec<String>>> {
        let rows = self
            .rows("SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position")
            .await?;
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for r in rows {
            let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
            out.entry(format!("{}.{}", g(0), g(1))).or_default().push(g(2));
        }
        Ok(out)
    }

    pub async fn structure(&mut self, r: &Ref) -> R<Structure> {
        let columns = self.columns_of(r).await?;
        let (s, n) = (D.string(r.schema.as_deref().unwrap_or("public")), D.string(&r.name));
        let kind = self.one(&format!("SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = {s} AND c.relname = {n}")).await?.unwrap_or_default();
        let idx = self
            .rows(&format!(
                "SELECT i.relname, ix.indisunique, ix.indisprimary, pg_get_indexdef(ix.indexrelid),
                        (SELECT string_agg(a.attname, ', ' ORDER BY k.n) FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum),
                        EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid)
                 FROM pg_index ix
                 JOIN pg_class i ON i.oid = ix.indexrelid
                 JOIN pg_class t ON t.oid = ix.indrelid
                 JOIN pg_namespace n ON n.oid = t.relnamespace
                 WHERE n.nspname = {s} AND t.relname = {n}
                 ORDER BY ix.indisprimary DESC, i.relname"
            ))
            .await?;
        let mut extra = Vec::new();
        let indexes = idx
            .into_iter()
            .map(|r| {
                let g = |i: usize| r.get(i).cloned().flatten().unwrap_or_default();
                let by_constraint = g(5) == "t";
                if !by_constraint { extra.push(format!("{};", g(3))); }
                Index {
                    name: g(0),
                    unique: g(1) == "t",
                    columns: if g(4).is_empty() { g(3) } else { g(4) },
                    origin: if g(2) == "t" { "primary key" } else if by_constraint { "constraint" } else { "CREATE INDEX" }.into(),
                }
            })
            .collect();
        let fks = self
            .rows(&format!(
                "SELECT a.attname, fn.nspname, ft.relname, fa.attname, con.confdeltype
                 FROM pg_constraint con
                 JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                 JOIN pg_class ft ON ft.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = ft.relnamespace
                 CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(col, fcol)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col
                 JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fcol
                 WHERE con.contype = 'f' AND n.nspname = {s} AND t.relname = {n}"
            ))
            .await?
            .into_iter()
            .map(|row| {
                let g = |i: usize| row.get(i).cloned().flatten().unwrap_or_default();
                // The referenced table is named bare when it lives in the same schema.
                let same = Some(g(1).as_str()) == r.schema.as_deref().or(Some("public"));
                Fk {
                    column: g(0),
                    table: if same { g(2) } else { format!("{}.{}", g(1), g(2)) },
                    to: g(3),
                    on_delete: match g(4).as_str() { "a" => "NO ACTION", "r" => "RESTRICT", "c" => "CASCADE", "n" => "SET NULL", "d" => "SET DEFAULT", o => o }.to_string(),
                }
            })
            .collect();
        let ddl = if kind == "v" || kind == "m" {
            let def = self.one(&format!("SELECT pg_get_viewdef({}::regclass, true)", D.string(&self.table(r)))).await?.unwrap_or_default();
            format!("CREATE {}VIEW {} AS\n{}", if kind == "m" { "MATERIALIZED " } else { "" }, self.table(r), def.trim())
        } else {
            let cons = self
                .rows(&format!(
                    "SELECT con.conname, pg_get_constraintdef(con.oid, true)
                     FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                     WHERE n.nspname = {s} AND t.relname = {n} AND con.contype IN ('p','u','f','c','x')
                     ORDER BY con.contype = 'p' DESC, con.conname"
                ))
                .await?;
            let mut lines: Vec<String> = columns
                .iter()
                .map(|c| format!("  {} {}{}{}", D.quote(&c.name), c.ty, if c.notnull { " NOT NULL" } else { "" }, c.dflt.as_ref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default()))
                .collect();
            for c in cons {
                lines.push(format!("  CONSTRAINT {} {}", D.quote(c[0].as_deref().unwrap_or("")), c[1].as_deref().unwrap_or("")));
            }
            let mut ddl = format!("CREATE TABLE {} (\n{}\n);", self.table(r), lines.join(",\n"));
            if !extra.is_empty() { ddl.push_str(&format!("\n\n{}", extra.join("\n"))); }
            ddl
        };
        Ok(Structure { columns, indexes, fks, ddl })
    }

    pub async fn page(&mut self, r: &Ref, opts: &PageOpts) -> R<Page> {
        let t0 = Instant::now();
        let columns = self.columns_of(r).await?;
        if columns.is_empty() {
            return Err(format!("relation {} does not exist", self.table(r)));
        }
        let mut pk: Vec<&Column> = columns.iter().filter(|c| c.pk > 0).collect();
        pk.sort_by_key(|c| c.pk);
        let key_cols: Vec<String> = pk.into_iter().map(|c| c.name.clone()).collect();
        let t = self.table(r);
        let w = where_sql(D, &opts.filters, &columns)?;
        let mut total = None;
        let mut approximate = false;
        // Exact counts on huge tables take seconds; statistics are close enough to page through.
        if w.is_empty() {
            let est: i64 = self.one(&format!("SELECT reltuples::bigint FROM pg_class WHERE oid = {}::regclass", D.string(&t))).await?.and_then(|s| s.parse().ok()).unwrap_or(-1);
            if est > APPROX_OVER { total = Some(est); approximate = true; }
        }
        let total = match total {
            Some(t) => t,
            None => self.one(&format!("SELECT count(*) FROM {t}{w}")).await?.and_then(|s| s.parse().ok()).unwrap_or(0),
        };
        let order = match &opts.sort {
            Some(s) => format!(" ORDER BY {} {}", D.quote(&s.col), if s.dir == "DESC" { "DESC" } else { "ASC" }),
            None if !key_cols.is_empty() => format!(" ORDER BY {}", key_cols.iter().map(|k| D.quote(k)).collect::<Vec<_>>().join(", ")),
            None => String::new(),
        };
        let sets = self.simple(&format!("SELECT * FROM {t}{w}{order} LIMIT {} OFFSET {}", opts.limit.max(1), opts.offset.max(0))).await?;
        let set = sets.into_iter().find(|s| s.cols.is_some()).ok_or("The table returned nothing.")?;
        let names = set.cols.unwrap_or_default();
        let kinds: Vec<Kind> = names.iter().map(|n| columns.iter().find(|c| &c.name == n).map(|c| kind(&c.ty)).unwrap_or(Kind::Text)).collect();
        let idx: Vec<usize> = key_cols.iter().filter_map(|k| names.iter().position(|n| n == k)).collect();
        let rows = set
            .rows
            .into_iter()
            .map(|row| {
                let vals: Vec<Value> = row.iter().zip(&kinds).map(|(v, k)| v.as_deref().map(|s| convert(s, *k)).unwrap_or(Value::Null)).collect();
                Row { key: idx.iter().map(|&i| vals[i].clone()).collect(), vals }
            })
            .collect();
        Ok(Page { columns, rows, total, approximate, editable: !key_cols.is_empty(), key_cols, ms: common::ms(t0) })
    }

    pub async fn query(&mut self, sql: &str) -> R<QueryResult> {
        let t0 = Instant::now();
        // Describing a single statement gives the column types; several statements fall back to text.
        let types: Option<Vec<Kind>> = match self.client.prepare(sql).await {
            Ok(st) => Some(st.columns().iter().map(|c| kind(c.type_().name())).collect()),
            Err(_) => None,
        };
        let sets = self.simple(sql).await?;
        let ms = common::ms(t0);
        let changed = sets.last().map(|s| s.changed).unwrap_or(0);
        let mut out = QueryResult { changed, ms, write: is_write(sql), ..Default::default() };
        if let Some(set) = sets.into_iter().rev().find(|s| s.cols.is_some()) {
            let cols = set.cols.unwrap_or_default();
            let kinds = types.filter(|t| t.len() == cols.len()).unwrap_or_else(|| vec![Kind::Text; cols.len()]);
            out.values = Some(
                set.rows
                    .into_iter()
                    .map(|row| row.iter().zip(&kinds).map(|(v, k)| v.as_deref().map(|s| convert(s, *k)).unwrap_or(Value::Null)).collect())
                    .collect(),
            );
            out.columns = Some(cols);
        }
        Ok(out)
    }

    pub fn preview(&self, ch: &Changes) -> R<Vec<Statement>> {
        Ok(change_statements(D, &self.table(&ch.r), ch))
    }

    pub async fn apply(&mut self, ch: &Changes) -> R<Vec<Statement>> {
        let st = change_statements(D, &self.table(&ch.r), ch);
        self.client.batch_execute("BEGIN").await.map_err(pg_err)?;
        for s in &st {
            if let Err(e) = self.client.batch_execute(&s.sql).await {
                let _ = self.client.batch_execute("ROLLBACK").await;
                return Err(pg_err(e));
            }
        }
        self.client.batch_execute("COMMIT").await.map_err(pg_err)?;
        Ok(st)
    }
}
