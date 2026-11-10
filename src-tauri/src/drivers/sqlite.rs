//! SQLite through rusqlite, straight on the file: every commit and write query lands on disk at once.

use super::common::{self, blob, change_statements, float, int, is_write, where_sql, Dialect};
use super::*;
use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::types::ValueRef;
use rusqlite::{Batch, Connection};
use serde_json::json;
use std::time::Instant;

const D: Dialect = Dialect::Sqlite;

pub struct Sqlite {
    conn: Connection,
    file: String,
}

fn val(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => int(i),
        ValueRef::Real(f) => float(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => blob(b.len()),
    }
}

fn base(file: &str) -> &str {
    file.rsplit('/').next().unwrap_or(file)
}

impl Sqlite {
    pub fn open(cfg: &Config) -> R<Self> {
        let file = Config::text(&cfg.file).ok_or("Choose a SQLite file.")?.to_string();
        let conn = Connection::open(&file).map_err(err)?;
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
            .map_err(|_| format!("{} is not a SQLite database.", base(&file)))?;
        conn.execute_batch("PRAGMA foreign_keys = ON").map_err(err)?;
        Ok(Sqlite { conn, file })
    }

    fn rows(&self, sql: &str) -> R<(Vec<String>, Vec<Vec<Value>>)> {
        let mut st = self.conn.prepare(sql).map_err(err)?;
        let names: Vec<String> = st.column_names().into_iter().map(String::from).collect();
        let n = names.len();
        let mut out = Vec::new();
        let mut rows = st.raw_query();
        while let Some(r) = rows.next().map_err(err)? {
            out.push((0..n).map(|i| val(r.get_ref_unwrap(i))).collect());
        }
        Ok((names, out))
    }

    fn one(&self, sql: &str) -> R<Value> {
        Ok(self.rows(sql)?.1.into_iter().next().and_then(|r| r.into_iter().next()).unwrap_or(Value::Null))
    }

    fn table(&self, r: &Ref) -> String {
        D.quote(&r.name)
    }

    pub async fn info(&mut self) -> R<Info> {
        let v = self.one("SELECT sqlite_version()")?;
        Ok(Info { engine: "SQLite".into(), version: v.as_str().unwrap_or("").into(), database: base(&self.file).into(), user: None, tls: None })
    }

    pub async fn objects(&mut self) -> R<Objects> {
        let (_, rows) = self.rows("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE")?;
        let (mut tables, mut views) = (Vec::new(), Vec::new());
        for r in rows {
            let name = r[0].as_str().unwrap_or("").to_string();
            let count = self.one(&format!("SELECT count(*) FROM {}", D.quote(&name))).ok().and_then(|v| v.as_i64());
            let o = Obj { r: Ref { schema: None, name: name.clone() }, name, count, approximate: false };
            if r[1] == "table" { tables.push(o) } else { views.push(o) }
        }
        Ok(Objects { schemas: vec!["main".into()], tables, views })
    }

    pub async fn set_schema(&mut self, _schema: &str) -> R<()> {
        Ok(())
    }

    fn columns_of(&self, r: &Ref) -> R<Vec<Column>> {
        let (_, rows) = self.rows(&format!("PRAGMA table_info({})", self.table(r)))?;
        Ok(rows
            .into_iter()
            .map(|c| Column {
                name: c[1].as_str().unwrap_or("").into(),
                ty: c[2].as_str().unwrap_or("").into(),
                notnull: c[3].as_i64() == Some(1),
                dflt: c[4].as_str().map(String::from),
                pk: c[5].as_i64().unwrap_or(0),
            })
            .collect())
    }

    pub async fn all_columns(&mut self) -> R<BTreeMap<String, Vec<String>>> {
        let (_, rows) = self.rows("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")?;
        let mut out = BTreeMap::new();
        for r in rows {
            let name = r[0].as_str().unwrap_or("").to_string();
            if let Ok(cols) = self.columns_of(&Ref { schema: None, name: name.clone() }) {
                out.insert(name, cols.into_iter().map(|c| c.name).collect());
            }
        }
        Ok(out)
    }

    pub async fn structure(&mut self, r: &Ref) -> R<Structure> {
        let t = self.table(r);
        let (_, list) = self.rows(&format!("PRAGMA index_list({t})"))?;
        let mut indexes = Vec::new();
        for i in list {
            let name = i[1].as_str().unwrap_or("").to_string();
            let (_, cols) = self.rows(&format!("PRAGMA index_info({})", D.quote(&name)))?;
            indexes.push(Index {
                columns: cols.iter().filter_map(|c| c[2].as_str()).collect::<Vec<_>>().join(", "),
                unique: i[2].as_i64() == Some(1),
                origin: match i[3].as_str() { Some("pk") => "primary key", Some("u") => "UNIQUE constraint", _ => "CREATE INDEX" }.into(),
                name,
            });
        }
        let (_, fk) = self.rows(&format!("PRAGMA foreign_key_list({t})"))?;
        let fks = fk
            .into_iter()
            .map(|f| Fk {
                column: f[3].as_str().unwrap_or("").into(),
                table: f[2].as_str().unwrap_or("").into(),
                to: f[4].as_str().unwrap_or("rowid").into(),
                on_delete: f[6].as_str().unwrap_or("").into(),
            })
            .collect();
        let ddl = self.one(&format!("SELECT sql FROM sqlite_master WHERE name = {}", D.string(&r.name)))?.as_str().unwrap_or("").to_string();
        Ok(Structure { columns: self.columns_of(r)?, indexes, fks, ddl })
    }

    pub async fn page(&mut self, r: &Ref, opts: &PageOpts) -> R<Page> {
        let t0 = Instant::now();
        let columns = self.columns_of(r)?;
        let is_view = self.one(&format!("SELECT type FROM sqlite_master WHERE name = {}", D.string(&r.name)))? == "view";
        let mut pk: Vec<&Column> = columns.iter().filter(|c| c.pk > 0).collect();
        pk.sort_by_key(|c| c.pk);
        let pk: Vec<String> = pk.into_iter().map(|c| c.name.clone()).collect();
        let w = where_sql(D, &opts.filters, &columns)?;
        let t = self.table(r);
        let total = common::row_count(Some(&self.one(&format!("SELECT count(*) FROM {t}{w}"))?));
        let order = match &opts.sort {
            Some(s) => format!(" ORDER BY {} {}", D.quote(&s.col), if s.dir == "DESC" { "DESC" } else { "ASC" }),
            None => String::new(),
        };
        let limit = format!(" LIMIT {} OFFSET {}", opts.limit.max(1), opts.offset.max(0));
        // A table without a primary key is edited by rowid; a view or a WITHOUT ROWID table is read only.
        let mut key_cols = if is_view { vec![] } else if pk.is_empty() { vec!["rowid".to_string()] } else { pk.clone() };
        let use_rowid = !is_view && pk.is_empty();
        let rows = if use_rowid {
            match self.rows(&format!("SELECT rowid AS \"__trellis_rowid\", * FROM {t}{w}{order}{limit}")) {
                Ok((_, rows)) => rows.into_iter().map(|mut v| { let k = v.remove(0); Row { key: vec![k], vals: v } }).collect(),
                Err(_) => {
                    key_cols.clear();
                    self.rows(&format!("SELECT * FROM {t}{w}{order}{limit}"))?.1.into_iter().map(|v| Row { key: vec![], vals: v }).collect()
                }
            }
        } else {
            let (names, rows) = self.rows(&format!("SELECT * FROM {t}{w}{order}{limit}"))?;
            let idx: Vec<usize> = key_cols.iter().filter_map(|k| names.iter().position(|n| n == k)).collect();
            rows.into_iter().map(|v| Row { key: idx.iter().map(|&i| v[i].clone()).collect(), vals: v }).collect()
        };
        Ok(Page { columns, rows, total, approximate: false, editable: !key_cols.is_empty(), key_cols, ms: common::ms(t0) })
    }

    pub async fn query(&mut self, sql: &str) -> R<QueryResult> {
        let t0 = Instant::now();
        let mut out = QueryResult { write: is_write(sql), ..Default::default() };
        let mut batch = Batch::new(&self.conn, sql);
        while let Some(mut st) = batch.next().map_err(err)? {
            let n = st.column_count();
            if n > 0 {
                let names: Vec<String> = st.column_names().into_iter().map(String::from).collect();
                let mut values = Vec::new();
                let mut rows = st.raw_query();
                while let Some(r) = rows.next().map_err(err)? {
                    values.push((0..n).map(|i| val(r.get_ref_unwrap(i))).collect());
                }
                out.columns = Some(names);
                out.values = Some(values);
            } else {
                out.changed = st.raw_execute().map_err(err)? as u64;
            }
        }
        out.ms = common::ms(t0);
        Ok(out)
    }

    pub fn preview(&self, ch: &Changes) -> R<Vec<Statement>> {
        Ok(change_statements(D, &self.table(&ch.r), ch))
    }

    pub async fn apply(&mut self, ch: &Changes) -> R<Vec<Statement>> {
        let st = change_statements(D, &self.table(&ch.r), ch);
        self.conn.execute_batch("SAVEPOINT trellis_commit").map_err(err)?;
        for s in &st {
            if let Err(e) = self.conn.execute_batch(&s.sql) {
                let _ = self.conn.execute_batch("ROLLBACK TO trellis_commit; RELEASE trellis_commit");
                return Err(err(e));
            }
        }
        self.conn.execute_batch("RELEASE trellis_commit").map_err(err)?;
        Ok(st)
    }
}
