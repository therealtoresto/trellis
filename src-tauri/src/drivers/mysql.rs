//! MySQL and MariaDB through mysql_async's text protocol. Without a database in the connection,
//! every non-system schema is listed and the schema picker switches with USE.

use super::common::{self, blob, change_statements, convert, is_write, where_sql, Dialect, Kind};
use super::*;
use mysql_async::consts::ColumnType as T;
use mysql_async::prelude::*;
use mysql_async::{Conn, OptsBuilder, Row as MyRow, SslOpts, Value as MyValue};
use serde_json::json;
use std::time::{Duration, Instant};

const SYSTEM: &str = "('mysql','information_schema','performance_schema','sys')";
const APPROX_OVER: i64 = 200_000;

pub struct My {
    conn: Conn,
    /// How this connection was opened, for the second connection that cancels a statement.
    opts: mysql_async::Opts,
    database: Option<String>,
    d: Dialect,
}

struct Set {
    cols: Vec<mysql_async::Column>,
    rows: Vec<MyRow>,
    changed: u64,
}

fn my_err(e: mysql_async::Error) -> String {
    match e {
        mysql_async::Error::Server(s) => s.message,
        other => other.to_string(),
    }
}

/// A binary string column has charset 63; numbers come as text in this protocol and parse by type.
fn kind_of(c: &mysql_async::Column) -> Option<Kind> {
    match c.column_type() {
        T::MYSQL_TYPE_TINY | T::MYSQL_TYPE_SHORT | T::MYSQL_TYPE_LONG | T::MYSQL_TYPE_LONGLONG | T::MYSQL_TYPE_INT24 | T::MYSQL_TYPE_YEAR => Some(Kind::Int),
        T::MYSQL_TYPE_FLOAT | T::MYSQL_TYPE_DOUBLE => Some(Kind::Float),
        T::MYSQL_TYPE_BLOB | T::MYSQL_TYPE_TINY_BLOB | T::MYSQL_TYPE_MEDIUM_BLOB | T::MYSQL_TYPE_LONG_BLOB | T::MYSQL_TYPE_STRING | T::MYSQL_TYPE_VAR_STRING | T::MYSQL_TYPE_VARCHAR | T::MYSQL_TYPE_BIT | T::MYSQL_TYPE_GEOMETRY
            if c.character_set() == 63 => None,
        _ => Some(Kind::Text),
    }
}

fn cell(v: Option<&MyValue>, kind: Option<Kind>) -> Value {
    match v {
        None | Some(MyValue::NULL) => Value::Null,
        Some(MyValue::Bytes(b)) => match kind {
            None => blob(b.len()),
            Some(k) => convert(&String::from_utf8_lossy(b), k),
        },
        Some(MyValue::Int(i)) => common::int(*i),
        Some(MyValue::UInt(u)) => if *u <= 9_007_199_254_740_991 { json!(u) } else { json!(u.to_string()) },
        Some(MyValue::Float(f)) => common::float(*f as f64),
        Some(MyValue::Double(f)) => common::float(*f),
        Some(other) => json!(other.as_sql(true).trim_matches('\'').to_string()),
    }
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

impl My {
    pub async fn open(cfg: &Config) -> R<Self> {
        let database = Config::text(&cfg.database).map(String::from);
        let base = OptsBuilder::default()
            .ip_or_hostname(if cfg.via.is_some() { "127.0.0.1" } else { Config::text(&cfg.host).unwrap_or("localhost") })
            .tcp_port(cfg.via.unwrap_or_else(|| cfg.port(3306)))
            .user(Config::text(&cfg.user))
            .pass(cfg.password.as_deref().filter(|p| !p.is_empty()))
            .db_name(database.clone())
            .prefer_socket(false);
        let mode = cfg.ssl_mode();
        let loose = SslOpts::default().with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true);
        let attempts: Vec<Option<SslOpts>> = match mode {
            "disable" => vec![None],
            "require" => vec![Some(loose)],
            "verify-full" => vec![Some(SslOpts::default())],
            // Prefer: TLS when the server offers it, plain otherwise.
            _ => vec![Some(loose), None],
        };
        let mut last = String::new();
        for ssl in attempts {
            let opts: mysql_async::Opts = base.clone().ssl_opts(ssl).into();
            match tokio::time::timeout(Duration::from_secs(10), Conn::new(opts.clone())).await {
                Ok(Ok(mut conn)) => {
                    let sql_mode: Option<String> = conn.query_first("SELECT @@SESSION.sql_mode").await.map_err(my_err)?;
                    let backslash = !sql_mode.unwrap_or_default().contains("NO_BACKSLASH_ESCAPES");
                    return Ok(My { conn, opts, database, d: Dialect::Mysql { backslash } });
                }
                Ok(Err(e)) => last = my_err(e),
                Err(_) => last = "The server did not answer within 10 seconds.".into(),
            }
        }
        Err(last)
    }

    async fn sets(&mut self, sql: &str) -> R<Vec<Set>> {
        Ok(self.sets_capped(sql, usize::MAX).await?.0)
    }

    /// Each result set with at most `cap` rows (the rest are read and dropped); true when rows were dropped.
    async fn sets_capped(&mut self, sql: &str, cap: usize) -> R<(Vec<Set>, bool)> {
        let mut res = self.conn.query_iter(sql).await.map_err(my_err)?;
        let (mut out, mut truncated) = (Vec::new(), false);
        loop {
            let cols = res.columns().map(|c| c.to_vec()).unwrap_or_default();
            let mut rows: Vec<MyRow> = Vec::new();
            while let Some(row) = res.next().await.map_err(my_err)? {
                if rows.len() < cap { rows.push(row); } else { truncated = true; }
            }
            out.push(Set { cols, rows, changed: res.affected_rows() });
            if res.is_empty() { break; }
        }
        Ok((out, truncated))
    }

    async fn rows(&mut self, sql: &str) -> R<Vec<Vec<Value>>> {
        let set = self.sets(sql).await?.into_iter().rev().find(|s| !s.cols.is_empty());
        Ok(match set {
            Some(s) => {
                let kinds: Vec<Option<Kind>> = s.cols.iter().map(kind_of).collect();
                s.rows.iter().map(|r| (0..kinds.len()).map(|i| cell(r.as_ref(i), kinds[i])).collect()).collect()
            }
            None => vec![],
        })
    }

    fn table(&self, r: &Ref) -> String {
        match &r.schema {
            Some(s) => format!("{}.{}", self.d.quote(s), self.d.quote(&r.name)),
            None => self.d.quote(&r.name),
        }
    }

    fn scope(&self) -> String {
        if self.database.is_some() { "TABLE_SCHEMA = DATABASE()".into() } else { format!("TABLE_SCHEMA NOT IN {SYSTEM}") }
    }

    pub async fn info(&mut self) -> R<Info> {
        let r = self.rows("SELECT VERSION(), DATABASE(), CURRENT_USER(), (SELECT VARIABLE_VALUE FROM performance_schema.session_status WHERE VARIABLE_NAME = 'Ssl_version')").await
            .or(self.rows("SELECT VERSION(), DATABASE(), CURRENT_USER(), NULL").await)?;
        let row = r.into_iter().next().unwrap_or_default();
        let v = text(&row[0]);
        let tls = row.get(3).map(text).filter(|s| !s.is_empty()).unwrap_or_else(|| "no TLS".into());
        Ok(Info {
            engine: if v.to_lowercase().contains("mariadb") { "MariaDB" } else { "MySQL" }.into(),
            version: v.split('-').next().unwrap_or("").into(),
            database: { let d = text(&row[1]); if d.is_empty() { "all schemas".into() } else { d } },
            user: Some(text(&row[2])),
            tls: Some(tls),
        })
    }

    pub async fn objects(&mut self) -> R<Objects> {
        let schemas = match &self.database {
            Some(d) => vec![d.clone()],
            None => self.rows(&format!("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN {SYSTEM} ORDER BY SCHEMA_NAME")).await?.iter().map(|r| text(&r[0])).collect(),
        };
        let rows = self.rows(&format!("SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES WHERE {} ORDER BY TABLE_SCHEMA, LOWER(TABLE_NAME)", self.scope())).await?;
        let (mut tables, mut views) = (Vec::new(), Vec::new());
        for r in rows {
            let o = Obj { r: Ref { schema: Some(text(&r[0])), name: text(&r[1]) }, name: text(&r[1]), count: if r[3].is_null() { None } else { Some(common::row_count(Some(&r[3]))) }, approximate: true };
            if text(&r[2]) == "VIEW" { views.push(o) } else { tables.push(o) }
        }
        Ok(Objects { schemas, tables, views })
    }

    /// Without a database in the connection, the schema picker also sets the default for the SQL editor.
    pub async fn set_schema(&mut self, schema: &str) -> R<()> {
        if self.database.is_none() {
            self.conn.query_drop(format!("USE {}", self.d.quote(schema))).await.map_err(my_err)?;
        }
        Ok(())
    }

    async fn columns_of(&mut self, r: &Ref) -> R<Vec<Column>> {
        let (s, n) = (self.d.string(r.schema.as_deref().unwrap_or("")), self.d.string(&r.name));
        let rows = self
            .rows(&format!(
                "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE = 'NO', c.COLUMN_DEFAULT, COALESCE(s.SEQ_IN_INDEX, 0), c.EXTRA
                 FROM information_schema.COLUMNS c
                 LEFT JOIN information_schema.STATISTICS s
                   ON s.TABLE_SCHEMA = c.TABLE_SCHEMA AND s.TABLE_NAME = c.TABLE_NAME AND s.COLUMN_NAME = c.COLUMN_NAME AND s.INDEX_NAME = 'PRIMARY'
                 WHERE c.TABLE_SCHEMA = {s} AND c.TABLE_NAME = {n}
                 ORDER BY c.ORDINAL_POSITION"
            ))
            .await?;
        Ok(rows
            .into_iter()
            .map(|c| {
                let extra = text(&c[5]);
                Column {
                    name: text(&c[0]),
                    ty: if extra.is_empty() { text(&c[1]) } else { format!("{} {}", text(&c[1]), extra) },
                    notnull: common::row_count(Some(&c[2])) == 1,
                    dflt: if c[3].is_null() { None } else { Some(text(&c[3])) },
                    pk: common::row_count(Some(&c[4])),
                }
            })
            .collect())
    }

    pub async fn all_columns(&mut self) -> R<BTreeMap<String, Vec<String>>> {
        let rows = self.rows(&format!("SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE {} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION", self.scope())).await?;
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for r in rows {
            out.entry(format!("{}.{}", text(&r[0]), text(&r[1]))).or_default().push(text(&r[2]));
        }
        Ok(out)
    }

    pub async fn structure(&mut self, r: &Ref) -> R<Structure> {
        let columns = self.columns_of(r).await?;
        let (s, n) = (self.d.string(r.schema.as_deref().unwrap_or("")), self.d.string(&r.name));
        let indexes = self
            .rows(&format!(
                "SELECT INDEX_NAME, MIN(NON_UNIQUE) = 0, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ')
                 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = {s} AND TABLE_NAME = {n}
                 GROUP BY INDEX_NAME ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME"
            ))
            .await?
            .into_iter()
            .map(|i| {
                let name = text(&i[0]);
                Index { origin: if name == "PRIMARY" { "primary key" } else { "index" }.into(), unique: common::row_count(Some(&i[1])) == 1, columns: text(&i[2]), name }
            })
            .collect();
        let own = r.schema.clone().unwrap_or_default();
        let fks = self
            .rows(&format!(
                "SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, rc.DELETE_RULE
                 FROM information_schema.KEY_COLUMN_USAGE k
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                 WHERE k.TABLE_SCHEMA = {s} AND k.TABLE_NAME = {n} AND k.REFERENCED_TABLE_NAME IS NOT NULL"
            ))
            .await?
            .into_iter()
            .map(|f| Fk {
                column: text(&f[0]),
                table: if text(&f[1]) == own { text(&f[2]) } else { format!("{}.{}", text(&f[1]), text(&f[2])) },
                to: text(&f[3]),
                on_delete: text(&f[4]),
            })
            .collect();
        let ddl = self.rows(&format!("SHOW CREATE TABLE {}", self.table(r))).await.ok().and_then(|r| r.into_iter().next()).map(|r| text(&r[1])).unwrap_or_default();
        Ok(Structure { columns, indexes, fks, ddl })
    }

    pub async fn page(&mut self, r: &Ref, opts: &PageOpts) -> R<Page> {
        let t0 = Instant::now();
        let columns = self.columns_of(r).await?;
        if columns.is_empty() {
            return Err(format!("Table {} doesn't exist", self.table(r)));
        }
        let mut pk: Vec<&Column> = columns.iter().filter(|c| c.pk > 0).collect();
        pk.sort_by_key(|c| c.pk);
        let key_cols: Vec<String> = pk.into_iter().map(|c| c.name.clone()).collect();
        let t = self.table(r);
        let w = where_sql(self.d, &opts.filters, &columns)?;
        let mut total = None;
        let mut approximate = false;
        if w.is_empty() {
            let est = self
                .rows(&format!("SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}", self.d.string(r.schema.as_deref().unwrap_or("")), self.d.string(&r.name)))
                .await?
                .into_iter()
                .next()
                .map(|r| common::row_count(r.first()))
                .unwrap_or(0);
            if est > APPROX_OVER { total = Some(est); approximate = true; }
        }
        let total = match total {
            Some(t) => t,
            None => self.rows(&format!("SELECT COUNT(*) FROM {t}{w}")).await?.into_iter().next().map(|r| common::row_count(r.first())).unwrap_or(0),
        };
        let order = match &opts.sort {
            Some(s) => format!(" ORDER BY {} {}", self.d.quote(&s.col), if s.dir == "DESC" { "DESC" } else { "ASC" }),
            None if !key_cols.is_empty() => format!(" ORDER BY {}", key_cols.iter().map(|k| self.d.quote(k)).collect::<Vec<_>>().join(", ")),
            None => String::new(),
        };
        let sets = self.sets(&format!("SELECT * FROM {t}{w}{order} LIMIT {} OFFSET {}", opts.limit.max(1), opts.offset.max(0))).await?;
        let set = sets.into_iter().rev().find(|s| !s.cols.is_empty()).ok_or("The table returned nothing.")?;
        let names: Vec<String> = set.cols.iter().map(|c| c.name_str().to_string()).collect();
        let kinds: Vec<Option<Kind>> = set.cols.iter().map(kind_of).collect();
        let idx: Vec<usize> = key_cols.iter().filter_map(|k| names.iter().position(|n| n == k)).collect();
        let rows = set
            .rows
            .iter()
            .map(|row| {
                let vals: Vec<Value> = (0..kinds.len()).map(|i| cell(row.as_ref(i), kinds[i])).collect();
                Row { key: idx.iter().map(|&i| vals[i].clone()).collect(), vals }
            })
            .collect();
        Ok(Page { columns, rows, total, approximate, editable: !key_cols.is_empty(), key_cols, ms: common::ms(t0) })
    }

    pub async fn query(&mut self, sql: &str) -> R<QueryResult> {
        let t0 = Instant::now();
        let (sets, truncated) = self.sets_capped(sql, common::MAX_ROWS).await?;
        let ms = common::ms(t0);
        let changed = sets.last().map(|s| s.changed).unwrap_or(0);
        let mut out = QueryResult { changed, ms, truncated, write: is_write(sql), ..Default::default() };
        if let Some(set) = sets.into_iter().rev().find(|s| !s.cols.is_empty()) {
            let kinds: Vec<Option<Kind>> = set.cols.iter().map(kind_of).collect();
            out.columns = Some(set.cols.iter().map(|c| c.name_str().to_string()).collect());
            out.values = Some(set.rows.iter().map(|r| (0..kinds.len()).map(|i| cell(r.as_ref(i), kinds[i])).collect()).collect());
        }
        Ok(out)
    }

    pub fn canceller(&self) -> Canceller {
        Canceller::Mysql(self.opts.clone(), self.conn.id())
    }

    pub fn preview(&self, ch: &Changes) -> R<Vec<Statement>> {
        Ok(change_statements(self.d, &self.table(&ch.r), ch))
    }

    pub async fn apply(&mut self, ch: &Changes) -> R<Vec<Statement>> {
        let st = change_statements(self.d, &self.table(&ch.r), ch);
        self.conn.query_drop("START TRANSACTION").await.map_err(my_err)?;
        for s in &st {
            if let Err(e) = self.conn.query_drop(&s.sql).await {
                let _ = self.conn.query_drop("ROLLBACK").await;
                return Err(my_err(e));
            }
        }
        self.conn.query_drop("COMMIT").await.map_err(my_err)?;
        Ok(st)
    }
}
