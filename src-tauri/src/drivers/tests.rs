//! The same checks against every engine. SQLite always runs; Postgres and MySQL need the test containers
//! (see README) and are skipped when their port does not answer.

use super::*;
use serde_json::json;

fn opts(filters: Vec<(&str, &str, &str)>, sort: Option<(&str, &str)>, limit: i64) -> PageOpts {
    PageOpts {
        filters: filters.into_iter().map(|(c, o, v)| Filter { col: c.into(), op: o.into(), val: v.into() }).collect(),
        sort: sort.map(|(c, d)| Sort { col: c.into(), dir: d.into() }),
        limit,
        offset: 0,
    }
}

fn changes(r: &Ref, v: serde_json::Value) -> Changes {
    let mut v = v;
    v["ref"] = serde_json::to_value(r).unwrap();
    serde_json::from_value(v).unwrap()
}

#[test]
fn common_sql() {
    use common::*;
    let cols = vec![
        Column { name: "a".into(), ty: "".into(), notnull: false, dflt: None, pk: 0 },
        Column { name: "b".into(), ty: "".into(), notnull: false, dflt: None, pk: 0 },
    ];
    let f = vec![Filter { col: "*".into(), op: "contains".into(), val: "x'y".into() }, Filter { col: "a".into(), op: "=".into(), val: "1".into() }];
    assert_eq!(where_sql(Dialect::Postgres, &f, &cols).unwrap(), " WHERE (CAST(\"a\" AS TEXT) ILIKE '%x''y%' OR CAST(\"b\" AS TEXT) ILIKE '%x''y%') AND \"a\" = '1'");
    assert_eq!(Dialect::Mysql { backslash: true }.string("a\\'b"), "'a\\\\\\'b'");
    let ch = changes(&Ref { schema: None, name: "t".into() }, json!({ "keyCols": ["a", "b"], "updates": [{ "key": [1, null], "set": { "c": "it's" } }] }));
    let st = change_statements(Dialect::Postgres, "\"t\"", &ch);
    assert_eq!(st[0].show, "UPDATE \"t\" SET \"c\" = 'it''s' WHERE \"a\" = 1 AND \"b\" IS NULL;");
    assert!(is_write("update x set a = 1"));
    assert!(!is_write("select 'drop table' -- delete\n from t"));
    assert_eq!(int(9007199254740993), json!("9007199254740993"));
}

#[tokio::test]
async fn sqlite() {
    let dir = std::env::temp_dir().join(format!("trellis-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("demo.sqlite");
    std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/gamification_demo.sqlite"), &file).unwrap();
    let cfg = Config { engine: "sqlite".into(), file: Some(file.to_string_lossy().into()), ..Default::default() };
    let mut d = Driver::open(&cfg).await.unwrap();
    let o = d.objects().await.unwrap();
    assert_eq!(o.tables.iter().find(|t| t.name == "players").unwrap().count, Some(240));
    assert!(o.views.iter().any(|v| v.name == "player_summary"));
    let players = Ref { schema: None, name: "players".into() };
    let p = d.page(&players, &opts(vec![("country", "null", "")], None, 100)).await.unwrap();
    assert!(p.total > 0);
    assert_eq!(p.key_cols, vec!["id"]);
    d.apply(&changes(&players, json!({ "keyCols": ["id"], "updates": [{ "key": [3], "set": { "country": "PL" } }] }))).await.unwrap();
    let e = d.apply(&changes(&players, json!({ "keyCols": ["id"], "deletes": [{ "key": [6] }] }))).await.unwrap_err();
    assert!(e.contains("FOREIGN KEY"), "{e}");
    d.query("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('a'), ('b')").await.unwrap();
    drop(d);
    let mut d = Driver::open(&cfg).await.unwrap();
    let p = d.page(&players, &opts(vec![("id", "=", "3")], None, 1)).await.unwrap();
    assert_eq!(p.rows[0].vals[3], json!("PL"));
    let notes = Ref { schema: None, name: "notes".into() };
    let p = d.page(&notes, &opts(vec![], None, 10)).await.unwrap();
    assert_eq!(p.key_cols, vec!["rowid"]);
    let rid = p.rows[1].key[0].clone();
    d.apply(&changes(&notes, json!({ "keyCols": ["rowid"], "updates": [{ "key": [rid], "set": { "body": "B" } }] }))).await.unwrap();
    let q = d.query("SELECT body FROM notes ORDER BY rowid").await.unwrap();
    assert_eq!(q.values.unwrap()[1][0], json!("B"));
    let q = d.query("UPDATE notes SET body = body").await.unwrap();
    assert_eq!(q.changed, 2);
    assert!(q.write && q.columns.is_none());
    let v = d.page(&Ref { schema: None, name: "player_summary".into() }, &opts(vec![], Some(("deposits", "DESC")), 5)).await.unwrap();
    assert!(!v.editable);
    let s = d.structure(&Ref { schema: None, name: "events".into() }).await.unwrap();
    assert!(s.fks.iter().any(|f| f.column == "player_id"));
    let _ = std::fs::remove_dir_all(dir);
}

const PG: &[&str] = &[
    "DROP TABLE IF EXISTS orders, customers CASCADE",
    "CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL, email text UNIQUE, vip boolean NOT NULL DEFAULT false, meta jsonb, joined_at timestamptz NOT NULL DEFAULT now(), balance numeric(10,2) DEFAULT 0, big bigint, ratio double precision)",
    "CREATE TABLE orders (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers(id), total numeric(10,2) NOT NULL, placed_at date NOT NULL)",
    "CREATE INDEX orders_customer ON orders (customer_id)",
    "INSERT INTO customers (name, email, vip, meta, balance, big, ratio) SELECT 'Customer ' || g, 'c' || g || '@example.com', g % 7 = 0, jsonb_build_object('tier', g % 3), g * 1.5, 9007199254740993, g / 4.0 FROM generate_series(1, 130) g",
    "INSERT INTO orders (customer_id, total, placed_at) SELECT (g % 130) + 1, g * 3.25, date '2026-01-01' + g FROM generate_series(1, 300) g",
    "CREATE OR REPLACE VIEW vip_customers AS SELECT id, name FROM customers WHERE vip",
    "CREATE SCHEMA IF NOT EXISTS cjm",
    "CREATE TABLE IF NOT EXISTS cjm.cj_event_types (event_type_id serial PRIMARY KEY, event_type_name text)",
];

const MY: &[&str] = &[
    "DROP VIEW IF EXISTS vip_customers",
    "DROP TABLE IF EXISTS orders",
    "DROP TABLE IF EXISTS customers",
    "CREATE TABLE customers (id int AUTO_INCREMENT PRIMARY KEY, name varchar(80) NOT NULL, email varchar(120) UNIQUE, vip tinyint(1) NOT NULL DEFAULT 0, meta json, joined_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, balance decimal(10,2) DEFAULT 0, big bigint, ratio double)",
    "CREATE TABLE orders (id int AUTO_INCREMENT PRIMARY KEY, customer_id int NOT NULL, total decimal(10,2) NOT NULL, placed_at date NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id))",
    "INSERT INTO customers (name, email, vip, meta, balance, big, ratio) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 130) SELECT CONCAT('Customer ', n), CONCAT('c', n, '@example.com'), n % 7 = 0, JSON_OBJECT('tier', n % 3), n * 1.5, 9007199254740993, n / 4.0 FROM g",
    "INSERT INTO orders (customer_id, total, placed_at) WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 300) SELECT (n % 130) + 1, n * 3.25, DATE_ADD('2026-01-01', INTERVAL n DAY) FROM g",
    "CREATE VIEW vip_customers AS SELECT id, name FROM customers WHERE vip",
];

async fn server(engine: &str, port: u16, user: &str, ssl: &str) -> Option<Driver> {
    let cfg = Config { engine: engine.into(), host: Some("127.0.0.1".into()), port: Some(json!(port)), user: Some(user.into()), password: Some("strata".into()), database: Some("shop".into()), ssl_mode: Some(ssl.into()), ..Default::default() };
    for _ in 0..30 {
        if let Ok(d) = Driver::open(&cfg).await { return Some(d); }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_err() { return None; }
    }
    None
}

async fn check_server(engine: &str, port: u16, user: &str, schema: &str, ssl: &str) {
    let Some(mut d) = server(engine, port, user, ssl).await else {
        eprintln!("skip {engine}: no server on {port}");
        return;
    };
    for sql in if engine == "postgres" { PG } else { MY } {
        d.query(sql).await.unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let info = d.info().await.unwrap();
    assert!(!info.version.is_empty());
    let o = d.objects().await.unwrap();
    assert!(o.schemas.contains(&schema.to_string()));
    let customers = o.tables.iter().find(|t| t.name == "customers").unwrap().r.clone();
    assert!(o.views.iter().any(|v| v.name == "vip_customers"));

    let p = d.page(&customers, &opts(vec![], None, 50)).await.unwrap();
    assert_eq!((p.total, p.rows.len()), (130, 50));
    assert_eq!(p.key_cols, vec!["id"]);
    assert_eq!(p.rows[0].key[0], json!(1));
    let col = |n: &str| p.columns.iter().position(|c| c.name == n).unwrap();
    assert_eq!(p.rows[0].vals[col("big")], json!("9007199254740993"), "unsafe bigint stays text");
    assert!(p.rows[0].vals[col("meta")].as_str().unwrap().contains("tier"));
    assert_eq!(p.rows[0].vals[col("ratio")], json!(0.25));
    if engine == "postgres" { assert_eq!(p.rows[6].vals[col("vip")], json!(true)); }

    let p = d.page(&customers, &opts(vec![("*", "contains", "customer 12")], Some(("id", "DESC")), 50)).await.unwrap();
    assert_eq!(p.total, 11, "any-column contains, case-insensitive");
    let p = d.page(&customers, &opts(vec![("id", ">", "120")], None, 50)).await.unwrap();
    assert_eq!(p.total, 10);

    let mut ch = changes(&customers, json!({
        "keyCols": ["id"],
        "inserts": [{ "set": { "name": "New person", "email": "new@example.com" } }],
        "updates": [{ "key": [2], "set": { "name": "O'Brien \\ back" } }],
        "deletes": [{ "key": [130] }],
    }));
    assert!(d.preview(&ch).unwrap()[1].show.contains("O"));
    // Customer 130 has orders, so the delete fails and nothing is applied.
    assert!(d.apply(&ch).await.is_err());
    let p = d.page(&customers, &opts(vec![("id", "=", "2")], None, 5)).await.unwrap();
    assert_eq!(p.rows[0].vals[1], json!("Customer 2"), "rolled back");
    ch.deletes.clear();
    d.apply(&ch).await.unwrap();
    let p = d.page(&customers, &opts(vec![("id", "=", "2")], None, 5)).await.unwrap();
    assert_eq!(p.rows[0].vals[1], json!("O'Brien \\ back"), "quotes and backslashes survive");
    let p = d.page(&customers, &opts(vec![("name", "starts", "New")], None, 5)).await.unwrap();
    assert_eq!(p.total, 1);

    let q = d.query("SELECT count(*) AS n FROM orders").await.unwrap();
    assert_eq!(q.values.unwrap()[0][0], json!(300));
    let q = d.query("UPDATE orders SET total = total WHERE id < 5; SELECT id FROM orders ORDER BY id LIMIT 3").await.unwrap();
    assert_eq!(q.values.unwrap().len(), 3);
    let q = d.query("UPDATE orders SET total = total + 1 WHERE id <= 10").await.unwrap();
    assert!(q.columns.is_none() && q.write);
    assert_eq!(q.changed, 10);
    assert!(d.query("SELECT * FROM nope").await.is_err());

    let orders = o.tables.iter().find(|t| t.name == "orders").unwrap().r.clone();
    let s = d.structure(&orders).await.unwrap();
    assert!(s.fks.iter().any(|f| f.column == "customer_id" && f.table == "customers"));
    assert!(!s.indexes.is_empty());
    assert!(s.ddl.to_uppercase().contains("CREATE TABLE"));
    let all = d.all_columns().await.unwrap();
    assert!(all[&format!("{schema}.customers")].contains(&"email".to_string()));
    d.set_schema(schema).await.unwrap();
    if engine == "postgres" {
        d.set_schema("cjm").await.unwrap();
        let q = d.query("SELECT count(*) FROM cj_event_types").await.unwrap();
        assert!(q.values.is_some(), "search_path follows the schema picker");
    }
    eprintln!("ok {engine} {} {} ({})", info.engine, info.version, info.tls.unwrap_or_default());
}

#[tokio::test]
async fn postgres() {
    check_server("postgres", 55432, "postgres", "public", "prefer").await;
}

#[tokio::test]
async fn mysql() {
    check_server("mysql", 53306, "root", "shop", "prefer").await;
}

/// A long statement stops when its canceller fires from another task, and the connection still works after.
async fn check_cancel(engine: &str, port: u16, user: &str, sleep_sql: &str) {
    let Some(mut d) = server(engine, port, user, "prefer").await else {
        eprintln!("skip {engine} cancel: no server on {port}");
        return;
    };
    let c = d.canceller();
    let t = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        c.cancel().await
    });
    let t0 = std::time::Instant::now();
    let r = d.query(sleep_sql).await;
    t.await.unwrap().unwrap();
    assert!(t0.elapsed().as_secs() < 5, "{engine}: the statement ran on after the cancel");
    // MySQL's KILL QUERY makes SLEEP return 1 rather than fail; Postgres fails the statement.
    if engine == "postgres" { assert!(r.is_err()); }
    assert!(d.query("SELECT 1").await.is_ok(), "{engine}: the connection still works");
}

#[tokio::test]
async fn sqlite_cancel_and_cap() {
    let cfg = Config { engine: "sqlite".into(), file: Some(":memory:".into()), ..Default::default() };
    let mut d = Driver::open(&cfg).await.unwrap();
    let q = d.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60000) SELECT i FROM n").await.unwrap();
    assert!(q.truncated);
    assert_eq!(q.values.unwrap().len(), common::MAX_ROWS);
    let c = d.canceller();
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        tokio::runtime::Runtime::new().unwrap().block_on(c.cancel())
    });
    let r = d.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n").await;
    t.join().unwrap().unwrap();
    assert!(r.unwrap_err().contains("interrupt"));
}

#[tokio::test]
async fn postgres_cancel() {
    check_cancel("postgres", 55432, "postgres", "SELECT pg_sleep(30)").await;
}

#[tokio::test]
async fn mysql_cancel() {
    check_cancel("mysql", 53306, "root", "SELECT SLEEP(30)").await;
}
