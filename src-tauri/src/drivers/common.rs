//! SQL shared by every engine: names, literals, filters and the statements that apply staged edits.
//! Values are written as escaped literals, so one statement text both runs and shows in the review sheet.

use super::{Changes, Column, Filter, Statement, R};
use serde_json::{json, Value};
use std::time::Instant;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Dialect {
    Sqlite,
    Postgres,
    /// `backslash` is false when the server runs with NO_BACKSLASH_ESCAPES.
    Mysql { backslash: bool },
}

impl Dialect {
    pub fn quote(self, n: &str) -> String {
        match self {
            Dialect::Mysql { .. } => format!("`{}`", n.replace('`', "``")),
            _ => format!("\"{}\"", n.replace('"', "\"\"")),
        }
    }

    pub fn as_text(self, e: &str) -> String {
        match self {
            Dialect::Mysql { .. } => format!("CAST({e} AS CHAR)"),
            _ => format!("CAST({e} AS TEXT)"),
        }
    }

    pub fn like(self) -> &'static str {
        if self == Dialect::Postgres { "ILIKE" } else { "LIKE" }
    }

    pub fn string(self, s: &str) -> String {
        match self {
            Dialect::Mysql { backslash: true } => format!(
                "'{}'",
                s.replace('\\', "\\\\").replace('\'', "\\'").replace('\0', "\\0")
            ),
            _ => format!("'{}'", s.replace('\'', "''").replace('\0', "")),
        }
    }

    pub fn lit(self, v: &Value) -> String {
        match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => match self {
                Dialect::Postgres => if *b { "TRUE".into() } else { "FALSE".into() },
                _ => if *b { "1".into() } else { "0".into() },
            },
            Value::Number(n) => n.to_string(),
            Value::String(s) => self.string(s),
            other => self.string(&other.to_string()),
        }
    }

    pub fn insert_defaults(self, t: &str) -> String {
        match self {
            Dialect::Mysql { .. } => format!("INSERT INTO {t} () VALUES ()"),
            _ => format!("INSERT INTO {t} DEFAULT VALUES"),
        }
    }
}

pub fn where_sql(d: Dialect, filters: &[Filter], columns: &[Column]) -> R<String> {
    let mut parts = Vec::new();
    for f in filters {
        let names: Vec<&str> = if f.col == "*" { columns.iter().map(|c| c.name.as_str()).collect() } else { vec![f.col.as_str()] };
        if names.is_empty() {
            continue;
        }
        let any = f.col == "*";
        let mut conds = Vec::new();
        for name in names {
            let e = d.quote(name);
            conds.push(match f.op.as_str() {
                "contains" => format!("{} {} {}", d.as_text(&e), d.like(), d.string(&format!("%{}%", f.val))),
                "starts" => format!("{} {} {}", d.as_text(&e), d.like(), d.string(&format!("{}%", f.val))),
                "null" => format!("{e} IS NULL"),
                "notnull" => format!("{e} IS NOT NULL"),
                "=" | "!=" | "<" | ">" | "<=" | ">=" => {
                    let op = if f.op == "!=" { "<>" } else { f.op.as_str() };
                    let left = if any { d.as_text(&e) } else { e };
                    format!("{left} {op} {}", d.string(&f.val))
                }
                other => return Err(format!("Unknown filter operator {other}")),
            });
        }
        let joiner = if f.op == "notnull" || f.op == "!=" { " AND " } else { " OR " };
        parts.push(if conds.len() > 1 { format!("({})", conds.join(joiner)) } else { conds.remove(0) });
    }
    Ok(if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) })
}

pub fn change_statements(d: Dialect, table: &str, ch: &Changes) -> Vec<Statement> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<Statement>, sql: String| out.push(Statement { show: format!("{sql};"), sql });
    let key_where = |key: &[Value]| {
        ch.key_cols
            .iter()
            .enumerate()
            .map(|(i, k)| match key.get(i) {
                None | Some(Value::Null) => format!("{} IS NULL", d.quote(k)),
                Some(v) => format!("{} = {}", d.quote(k), d.lit(v)),
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    };
    for ins in &ch.inserts {
        let set: Vec<(&String, &Value)> = ins.set.iter().filter(|(_, v)| !v.is_null()).collect();
        if set.is_empty() {
            push(&mut out, d.insert_defaults(table));
        } else {
            let names = set.iter().map(|(n, _)| d.quote(n)).collect::<Vec<_>>().join(", ");
            let vals = set.iter().map(|(_, v)| d.lit(v)).collect::<Vec<_>>().join(", ");
            push(&mut out, format!("INSERT INTO {table} ({names}) VALUES ({vals})"));
        }
    }
    for up in &ch.updates {
        if up.set.is_empty() {
            continue;
        }
        let set = up.set.iter().map(|(n, v)| format!("{} = {}", d.quote(n), d.lit(v))).collect::<Vec<_>>().join(", ");
        push(&mut out, format!("UPDATE {table} SET {set} WHERE {}", key_where(&up.key)));
    }
    for del in &ch.deletes {
        push(&mut out, format!("DELETE FROM {table} WHERE {}", key_where(&del.key)));
    }
    out
}

const WRITE_WORDS: &[&str] = &[
    "insert", "update", "delete", "create", "drop", "alter", "replace", "truncate", "vacuum", "attach", "detach", "grant",
    "revoke", "rename", "merge", "call",
];

/// True when the SQL, outside its strings and comments, uses a statement that changes data or schema.
pub fn is_write(sql: &str) -> bool {
    let mut clean = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                while let Some(n) = chars.next() {
                    if n == '\'' {
                        if chars.peek() == Some(&'\'') { chars.next(); } else { break; }
                    }
                }
                clean.push(' ');
            }
            '-' if chars.peek() == Some(&'-') => {
                for n in chars.by_ref() {
                    if n == '\n' { break; }
                }
                clean.push(' ');
            }
            _ => clean.push(c.to_ascii_lowercase()),
        }
    }
    clean
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|w| WRITE_WORDS.contains(&w))
}

pub fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Integers beyond 2^53 travel as text so the window never rounds them.
pub fn int(i: i64) -> Value {
    if i.unsigned_abs() <= 9_007_199_254_740_991 { json!(i) } else { json!(i.to_string()) }
}

pub fn float(f: f64) -> Value {
    if f.is_finite() { json!(f) } else { json!(f.to_string()) }
}

pub fn blob(len: usize) -> Value {
    json!({ "$blob": len })
}

/// How a text value from the server becomes JSON, by the column's type.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Int,
    Float,
    Bool,
    Text,
}

pub fn convert(text: &str, kind: Kind) -> Value {
    match kind {
        Kind::Int => text.parse::<i64>().map(int).unwrap_or_else(|_| json!(text)),
        Kind::Float => text.parse::<f64>().map(float).unwrap_or_else(|_| json!(text)),
        Kind::Bool => match text {
            "t" | "true" | "1" => json!(true),
            "f" | "false" | "0" => json!(false),
            _ => json!(text),
        },
        Kind::Text => json!(text),
    }
}

pub fn row_count(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

pub const SAMPLE_SQL: &str = "-- Top players by mission points (example data)
SELECT p.username, p.country, p.level,
       count(*)             AS completed,
       sum(m.reward_points) AS points
FROM mission_progress mp
JOIN players  p ON p.id = mp.player_id
JOIN missions m ON m.id = mp.mission_id
WHERE mp.status = 'completed'
GROUP BY p.id
ORDER BY points DESC
LIMIT 25;";
