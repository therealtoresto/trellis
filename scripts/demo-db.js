// Builds src-tauri/resources/gamification_demo.sqlite, the example database a first launch opens:
// a small gamification schema with invented players. Run: npm run demo-db
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const DDL = `
CREATE TABLE players (
  id          INTEGER PRIMARY KEY,
  username    TEXT    NOT NULL UNIQUE,
  email       TEXT    NOT NULL,
  country     TEXT,
  level       INTEGER NOT NULL DEFAULT 1,
  xp          INTEGER NOT NULL DEFAULT 0,
  balance     REAL    NOT NULL DEFAULT 0,
  vip         INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  last_seen   TEXT
);
CREATE TABLE missions (
  id             INTEGER PRIMARY KEY,
  title          TEXT    NOT NULL,
  cadence        TEXT    NOT NULL CHECK (cadence IN ('daily', 'weekly', 'season')),
  target         INTEGER NOT NULL,
  reward_points  INTEGER NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  starts_at      TEXT,
  ends_at        TEXT
);
CREATE TABLE mission_progress (
  id          INTEGER PRIMARY KEY,
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mission_id  INTEGER NOT NULL REFERENCES missions(id),
  progress    INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'in_progress',
  updated_at  TEXT    NOT NULL
);
CREATE INDEX idx_progress_player ON mission_progress (player_id, mission_id);
CREATE TABLE rewards (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  cost_points  INTEGER NOT NULL,
  stock        INTEGER
);
CREATE TABLE redemptions (
  id           INTEGER PRIMARY KEY,
  player_id    INTEGER NOT NULL REFERENCES players(id),
  reward_id    INTEGER NOT NULL REFERENCES rewards(id),
  redeemed_at  TEXT    NOT NULL
);
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  player_id   INTEGER NOT NULL REFERENCES players(id),
  event_type  TEXT    NOT NULL,
  amount      REAL,
  payload     TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_events_player ON events (player_id, created_at);
CREATE INDEX idx_events_type ON events (event_type);
CREATE VIEW player_summary AS
SELECT p.id, p.username, p.country, p.level,
       (SELECT count(*) FROM mission_progress mp WHERE mp.player_id = p.id AND mp.status = 'completed') AS missions_done,
       (SELECT round(coalesce(sum(e.amount), 0), 2) FROM events e WHERE e.player_id = p.id AND e.event_type = 'deposit') AS deposits
FROM players p;`;

async function createDemo(file) {
  const SQL = await initSqlJs();
  const d = new SQL.Database();
  d.exec(DDL);
  let s = 20261110 >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pick = a => a[Math.floor(rnd() * a.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const BASE = Date.UTC(2026, 10, 10, 9, 30, 0);
  const at = (maxDays, minDays = 0) => new Date(BASE - (minDays + rnd() * (maxDays - minDays)) * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const money = v => Math.round(v * 100) / 100;

  d.exec('BEGIN');
  const A = ['nova', 'kai', 'luna', 'rex', 'mira', 'zed', 'ivy', 'max', 'orin', 'sol', 'tara', 'vex', 'yuki', 'bo', 'juno', 'ash', 'lev', 'nika', 'oleh', 'dana', 'finn', 'ines', 'rafa', 'sasha'];
  const B = ['spin', 'ace', 'wolf', 'byte', 'fox', 'star', 'volt', 'ray', 'jet', 'rook', 'pike', 'lynx', 'flux', 'mint', 'dash', 'echo'];
  const C = ['UA', 'PL', 'DE', 'BR', 'MX', 'CA', 'GB', 'ES', 'PT', 'TR', 'IN', 'CL', 'SE', 'NL'];
  const used = new Set();
  const NP = 240;
  let st = d.prepare('INSERT INTO players (id, username, email, country, level, xp, balance, vip, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= NP; i++) {
    let u;
    do { u = pick(A) + '_' + pick(B) + (rnd() < 0.6 ? int(1, 99) : ''); } while (used.has(u));
    used.add(u);
    const level = int(1, 42);
    const vip = level > 30 && rnd() < 0.6 ? 1 : rnd() < 0.06 ? 1 : 0;
    st.run([i, u, u.replace(/_/g, '.') + '@example.com', rnd() < 0.04 ? null : pick(C), level, level * 250 + int(0, 249), money(rnd() * rnd() * 2400), vip, at(420, 30), rnd() < 0.08 ? null : at(29)]);
  }
  st.free();

  const M = [
    ['Log in 3 days in a row', 'daily', 3, 50], ['Place 20 bets', 'daily', 20, 80], ['Spin 100 times', 'daily', 100, 120],
    ['Win on 5 different slots', 'weekly', 5, 200], ['Deposit twice this week', 'weekly', 2, 250], ['Try a live table', 'weekly', 1, 90],
    ['Hit a 10x multiplier', 'weekly', 1, 300], ['Play 5 tournaments', 'weekly', 5, 350], ['Weekend warrior: 50 spins', 'weekly', 50, 180],
    ['Reach level 10', 'season', 10, 500], ['Reach level 25', 'season', 25, 1200], ['Refer a friend', 'season', 1, 400],
    ['Complete 30 daily missions', 'season', 30, 1500], ['Collect 10 achievements', 'season', 10, 900], ['Win a tournament', 'season', 1, 2000],
    ['Bet on 3 sports in a day', 'daily', 3, 70], ['Open 5 mystery boxes', 'weekly', 5, 160], ['Climb 3 leaderboard spots', 'weekly', 3, 220],
  ];
  const WIN = { daily: ['2026-11-10 00:00:00', '2026-11-10 23:59:59'], weekly: ['2026-11-09 00:00:00', '2026-11-15 23:59:59'], season: ['2026-09-01 00:00:00', '2026-11-30 23:59:59'] };
  st = d.prepare('INSERT INTO missions (id, title, cadence, target, reward_points, active, starts_at, ends_at) VALUES (?,?,?,?,?,?,?,?)');
  M.forEach((m, i) => {
    const off = i === 5 || i === 13;
    st.run([i + 1, m[0], m[1], m[2], m[3], off ? 0 : 1, off ? '2026-10-01 00:00:00' : WIN[m[1]][0], off ? '2026-10-31 23:59:59' : WIN[m[1]][1]]);
  });
  st.free();

  st = d.prepare('INSERT INTO mission_progress (player_id, mission_id, progress, status, updated_at) VALUES (?,?,?,?,?)');
  const pairs = new Set();
  while (pairs.size < 720) {
    const p = int(1, NP), mi = int(1, M.length), key = p + ':' + mi;
    if (pairs.has(key)) continue;
    pairs.add(key);
    const target = M[mi - 1][2];
    const done = rnd() < 0.45;
    st.run([p, mi, done ? target : int(0, Math.max(0, target - 1)), done ? 'completed' : rnd() < 0.15 ? 'expired' : 'in_progress', at(40)]);
  }
  st.free();

  const R = [['25 free spins', 'free_spins', 300, null], ['50 free spins', 'free_spins', 550, null], ['€5 bonus', 'bonus', 500, 400], ['€10 bonus', 'bonus', 950, 250],
    ['€25 bonus', 'bonus', 2200, 60], ['Double XP for 24h', 'boost', 400, null], ['Mystery box', 'box', 650, 120], ['5% cashback', 'cashback', 1500, 80],
    ['VIP lounge pass', 'vip', 5000, 10], ['Gold avatar frame', 'cosmetic', 800, null], ['Tournament ticket', 'ticket', 1100, 200], ['Bonus wheel spin', 'spin', 250, null]];
  st = d.prepare('INSERT INTO rewards (id, name, kind, cost_points, stock) VALUES (?,?,?,?,?)');
  R.forEach((r, i) => st.run([i + 1, ...r]));
  st.free();
  st = d.prepare('INSERT INTO redemptions (player_id, reward_id, redeemed_at) VALUES (?,?,?)');
  Array.from({ length: 150 }, () => [int(1, NP), int(1, R.length), at(90)]).sort((a, b) => a[2].localeCompare(b[2])).forEach(r => st.run(r));
  st.free();

  const games = ['neon_reels', 'orchard_spins', 'cosmic_crash', 'mega_mines', 'blackjack_live', 'roulette_eu', 'penalty_shootout'];
  const evs = [];
  for (let i = 0; i < 1800; i++) {
    const x = rnd(), p = int(1, NP), t = at(60);
    if (x < 0.3) evs.push([p, 'login', null, JSON.stringify({ device: pick(['ios', 'android', 'web']) }), t]);
    else if (x < 0.65) { const stake = money(0.2 + rnd() * rnd() * 50); evs.push([p, 'bet', stake, JSON.stringify({ game: pick(games), stake }), t]); }
    else if (x < 0.8) evs.push([p, 'win', money(rnd() * rnd() * 400), JSON.stringify({ game: pick(games), multiplier: money(1 + rnd() * rnd() * 30) }), t]);
    else if (x < 0.92) evs.push([p, 'deposit', money(10 + rnd() * 490), JSON.stringify({ method: pick(['card', 'bank', 'wallet', 'crypto']) }), t]);
    else if (x < 0.97) evs.push([p, 'level_up', null, JSON.stringify({ to: int(2, 42) }), t]);
    else evs.push([p, 'withdrawal', money(20 + rnd() * 900), JSON.stringify({ method: pick(['card', 'bank']) }), t]);
  }
  evs.sort((a, b) => a[4].localeCompare(b[4]));
  st = d.prepare('INSERT INTO events (player_id, event_type, amount, payload, created_at) VALUES (?,?,?,?,?)');
  evs.forEach(e => st.run(e));
  st.free();
  d.exec('COMMIT');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(d.export()));
  d.close();
  return file;
}

const out = path.join(__dirname, '..', 'src-tauri', 'resources', 'gamification_demo.sqlite');
createDemo(out).then(f => console.log(`wrote ${path.relative(process.cwd(), f)}`));
