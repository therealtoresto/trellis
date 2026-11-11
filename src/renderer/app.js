// Trellis's window: the connections screen, then tables · grid · inspector for one open database.
(() => {
'use strict';

const api = window.trellis;
// The same script runs the welcome window (logo and saved connections) and the workspace windows.
const WELCOME = document.body.dataset.page === 'welcome';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMac = navigator.platform.includes('Mac');
const MOD = isMac ? '⌘' : 'Ctrl+';
const plural = (n, w) => `${Number(n).toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const fmtMs = ms => ms < 1 ? '<1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
const fmtNum = v => Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
const fmtCount = n => n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : Number(n).toLocaleString();
const ago = t => { const s = (Date.now() - t) / 1000; if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; };
const refKey = ref => (ref.schema ? ref.schema + '.' : '') + ref.name;
const WRITE_RE = /\b(insert|update|delete|create|drop|alter|replace|truncate|vacuum|attach|detach|grant|revoke|rename|merge|call)\b/i;
const isWrite = sql => WRITE_RE.test(sql.replace(/'(?:[^']|'')*'/g, '').replace(/--[^\n]*/g, ''));
const ENV = { local: 'Local', dev: 'Development', staging: 'Staging', production: 'Production' };
const ENGINE = { postgres: { label: 'PostgreSQL', short: 'Pg', port: 5432, user: 'postgres' }, mysql: { label: 'MySQL', short: 'My', port: 3306, user: 'root' }, sqlite: { label: 'SQLite', short: 'Sq' } };

const store = {
  get(k, d) { try { const v = localStorage.getItem('trellis:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('trellis:' + k, JSON.stringify(v)); } catch {} },
};

function fillIcons(root = document) {
  $$('[data-icon]', root).forEach(el => { el.innerHTML = ic(el.dataset.icon); el.removeAttribute('data-icon'); });
}

/* ---------- SQL highlighting ---------- */
const KW = 'SELECT FROM WHERE AND OR NOT NULL IS IN LIKE ILIKE GLOB BETWEEN AS ON JOIN LEFT RIGHT INNER OUTER CROSS FULL NATURAL USING LATERAL GROUP BY ORDER HAVING LIMIT OFFSET FETCH INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE VIEW MATERIALIZED INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES DROP ALTER ADD COLUMN RENAME TO IF EXISTS DISTINCT CASE WHEN THEN ELSE END ASC DESC NULLS FIRST LAST UNION ALL INTERSECT EXCEPT WITH RECURSIVE DEFAULT CHECK CONSTRAINT BEGIN COMMIT ROLLBACK TRANSACTION SAVEPOINT RELEASE PRAGMA EXPLAIN ANALYZE QUERY PLAN INTEGER INT BIGINT SMALLINT TEXT VARCHAR CHAR REAL BLOB NUMERIC DECIMAL BOOLEAN SERIAL TIMESTAMP TIMESTAMPTZ DATE TIME JSON JSONB UUID AUTOINCREMENT AUTO_INCREMENT CASCADE RESTRICT TRIGGER OVER PARTITION WINDOW TRUE FALSE COLLATE NOCASE ESCAPE CAST RETURNING CONFLICT DO NOTHING VACUUM TRUNCATE SHOW DESCRIBE USE SCHEMA GRANT REVOKE INTERVAL ANY SOME FILTER'.split(' ');
const FN = 'COUNT SUM AVG MIN MAX ROUND ABS LENGTH LOWER UPPER SUBSTR SUBSTRING TRIM LTRIM RTRIM COALESCE IFNULL NULLIF DATE TIME DATETIME STRFTIME JULIANDAY UNIXEPOCH NOW CURRENT_DATE DATE_TRUNC DATE_PART EXTRACT TO_CHAR TO_DATE TO_TIMESTAMP DATE_FORMAT DATE_ADD DATE_SUB DATEDIFF JSON_EXTRACT JSON_OBJECT JSON_ARRAY JSONB_BUILD_OBJECT JSON_AGG JSONB_AGG ARRAY_AGG STRING_AGG GROUP_CONCAT CONCAT CONCAT_WS ROW_NUMBER RANK DENSE_RANK NTILE LAG LEAD FIRST_VALUE LAST_VALUE PRINTF FORMAT INSTR POSITION REPLACE SPLIT_PART REGEXP_REPLACE TOTAL TYPEOF RANDOM HEX QUOTE IIF GREATEST LEAST GENERATE_SERIES UNNEST'.split(' ');
const KWS = new Set(KW), FNS = new Set(FN);
let tableNameSet = new Set();

function highlight(src) {
  const re = /(--[^\n]*|#[^\n]*(?=\n|$)|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|''|\\.)*'?)|("(?:[^"]|"")*"?|`[^`]*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)|([\s\S])/g;
  let out = '', m;
  while ((m = re.exec(src))) {
    if (m[1]) out += m[1][0] === '#' && S.info && S.info.engine === 'PostgreSQL' ? esc(m[1]) : `<span class="t-com">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="t-str">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="t-id">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="t-num">${m[4]}</span>`;
    else if (m[5]) {
      const w = m[5], u = w.toUpperCase();
      if (FNS.has(u) && src[re.lastIndex] === '(') out += `<span class="t-fn">${esc(w)}</span>`;
      else if (KWS.has(u)) out += `<span class="t-kw">${esc(w)}</span>`;
      else if (tableNameSet.has(w.toLowerCase())) out += `<span class="t-tbl">${esc(w)}</span>`;
      else out += esc(w);
    } else out += esc(m[6]);
  }
  return out;
}

/* ---------- state ---------- */
const S = {
  conns: [], connFilter: '', form: null, formStatus: null, busy: false,
  conn: null, info: null, sample: '',
  tabs: [], active: null, nextId: 1, queryN: 1,
  inspector: store.get('inspector', true), sidebar: true,
  schema: { schemas: [], tables: [], views: [], columns: {} }, schemaSel: null,
  pane: 'items', filter: '', history: [], saved: [],
};
const schemaOf = t => t.ref.schema || 'main';
const baseName = f => f.split('/').pop().replace(/\.sql$/i, '');
const cur = () => S.tabs.find(t => t.id === S.active) || null;
const isProd = () => S.conn && S.conn.env === 'production';

/* ================================================================
   Connections: the Open Connection sheet and the connection form
   ================================================================ */
const COLORS = ['#e8963c', '#2e9a55', '#7d8590', '#2f6fe4', '#b8893a', '#a3262a', '#8b5cf6'];
const SAFE = { silent: 'Silent — run every query without asking', confirm: 'Ask before any write', readonly: 'Read only — block every write' };
const SSL = { disable: 'Disable', prefer: 'Prefer', require: 'Require', 'verify-full': 'Verify full' };
const safeOf = c => (c && c.safeMode) || (c && c.env === 'production' ? 'confirm' : 'silent');
const sslOf = c => c.sslMode || (c.ssl ? 'require' : 'prefer');
const safeMode = () => safeOf(S.conn);
const colorOf = c => c.color || { local: '#2e9a55', dev: '#2f6fe4', staging: '#e8963c', production: '#a3262a' }[c.env || 'local'];

function blankForm(engine = 'postgres') {
  return { name: '', engine, env: 'local', color: COLORS[3], safeMode: 'silent', sslMode: 'prefer', host: '127.0.0.1', port: ENGINE[engine].port || '', user: ENGINE[engine].user || '', database: '', file: '' };
}

function connSub(c) {
  if (c.engine === 'sqlite') return (c.file || '').split('/').pop() || 'no file chosen';
  return `${c.host || 'localhost'} : ${c.database || (c.engine === 'postgres' ? 'postgres' : 'all schemas')}`;
}

// A connection's avatar: its icon (or its engine's) on a disc in its status color.
const avatar = c => `<span class="eng-badge ${c.engine}" style="--status:${esc(colorOf(c))}" title="${ENGINE[c.engine].label}">${connIcon(c.engine, c.icon)}</span>`;

const envPill = c => `<span class="env-pill" data-env="${esc(c.env || 'local')}">${c.demo ? 'example' : esc(ENV[c.env || 'local'].toLowerCase())}</span>`;

function sheetStatus(kind, text) {
  const el = $('#sheetStatus');
  if (!el) { if (text && kind === 'bad') toast(text, true); return; }
  el.className = 'cf-status ' + (kind || '');
  el.textContent = text || '';
  el.title = text || '';
}

/* ---------- Open Connection ---------- */
async function showOpenConnection(selectId) {
  S.conns = await api.connections();
  const ov = $('#overlay');
  ov.innerHTML = `<div class="scrim" data-scrim><div class="sheet glass-strong" role="dialog" aria-modal="true" aria-label="Open Connection">
    <h2 class="sheet-title">Open Connection</h2>
    <label class="side-search sheet-search">${ic('search')}<input id="ocFilter" placeholder="Search for connection…" autocomplete="off" spellcheck="false"></label>
    <div class="oc-list" id="ocList" role="listbox"></div>
    <div class="sheet-foot">
      <button class="btn big" data-oc="cancel">Cancel</button>
      <span class="cf-status" id="sheetStatus"></span>
      <span class="spacer"></span>
      <button class="btn big" data-oc="new">New…</button>
      <button class="btn primary big" data-oc="open" id="ocOpen">${S.busy ? '<span class="spin"></span>' : ''}Open</button>
    </div>
  </div></div>`;
  const input = $('#ocFilter'), list = $('#ocList');
  const want = selectId || (S.conn && S.conn.id) || store.get('lastConn');
  let shownConns = [], on = 0;
  const draw = () => {
    const f = input.value.trim().toLowerCase();
    shownConns = S.conns.filter(c => !f || `${c.name} ${connSub(c)} ${c.env}`.toLowerCase().includes(f));
    on = Math.min(on, Math.max(0, shownConns.length - 1));
    list.innerHTML = shownConns.length ? shownConns.map((c, i) => `
      <div class="oc-row${i === on ? ' on' : ''}${S.conn && S.conn.id === c.id ? ' current' : ''}" data-i="${i}" role="option" aria-selected="${i === on}">
        ${avatar(c)}
        <span class="cc-text"><span class="cc-name">${esc(c.name || 'Untitled')} ${envPill(c)}</span><span class="cc-sub">${esc(connSub(c))}</span></span>
        <button class="icon-btn oc-edit" data-edit="${i}" title="Edit connection" aria-label="Edit ${esc(c.name)}">${ic('pencil')}</button>
      </div>`).join('')
      : `<div class="oc-empty">${S.conns.length ? 'No connection matches.' : 'No connections yet. Press New… to add one.'}</div>`;
    const el = $('.oc-row.on', list);
    if (el) el.scrollIntoView({ block: 'nearest' });
    $('#ocOpen').disabled = !shownConns.length;
  };
  on = Math.max(0, S.conns.findIndex(c => c.id === want));
  draw();
  const open = () => { const c = shownConns[on]; if (c) connectTo(c.id); };
  const edit = i => { const c = shownConns[i]; if (c) showConnForm({ ...c }, true); };
  input.addEventListener('input', () => { on = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); on = Math.min(on + 1, shownConns.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); on = Math.max(on - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); open(); }
  });
  list.addEventListener('click', e => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return edit(+ed.dataset.edit);
    const r = e.target.closest('.oc-row');
    if (!r) return;
    on = +r.dataset.i;
    if (e.detail >= 2) open(); else markRow(list, on);
  });
  list.addEventListener('contextmenu', e => { const r = e.target.closest('.oc-row'); if (r) { e.preventDefault(); edit(+r.dataset.i); } });
  ov.querySelector('.sheet-foot').addEventListener('click', e => {
    const b = e.target.closest('[data-oc]');
    if (!b) return;
    if (b.dataset.oc === 'cancel') closeOverlay();
    else if (b.dataset.oc === 'new') showConnForm(blankForm(), true);
    else open();
  });
  $('[data-scrim]', ov).addEventListener('mousedown', e => { if (e.target === e.currentTarget && S.conn) closeOverlay(); });
  modalPrimary = open;
  input.focus();
}

/* ---------- Connection form ---------- */
function showConnForm(form, fromList = false) {
  S.form = form;
  const f = form;
  if (!f.sslMode && f.engine !== 'sqlite') f.sslMode = sslOf(f);
  if (!f.safeMode) f.safeMode = safeOf(f);
  if (!f.color) f.color = colorOf(f);
  const eng = ENGINE[f.engine];
  const server = f.engine !== 'sqlite';
  const input = (k, opts = {}) => `<input class="cf-input${opts.mono ? ' mono' : ''}" id="cf-${k}" data-k="${k}" type="${opts.type || 'text'}" value="${esc(f[k] ?? '')}" placeholder="${esc(opts.ph || '')}" autocomplete="off" spellcheck="false">`;
  const select = (k, options) => `<select class="cf-input cf-select" id="cf-${k}" data-k="${k}">${Object.entries(options).map(([v, l]) => `<option value="${v}"${f[k] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const ov = $('#overlay');
  ov.innerHTML = `<div class="scrim" data-scrim><div class="sheet form-sheet glass-strong" role="dialog" aria-modal="true" aria-label="${eng.label} connection">
    <h2 class="sheet-title">${eng.label} Connection</h2>
    <div class="sheet-body">
    ${f.id ? '' : `<div class="seg engine-seg">${Object.entries(ENGINE).map(([k, e]) => `<button class="${f.engine === k ? 'on' : ''}" data-engine="${k}">${e.label}</button>`).join('')}</div>`}
    <div class="cf-box">
      <label class="cf-label" for="cf-name">Name</label><div class="cf-span">${input('name', { ph: server ? 'ENV_8' : 'Notes' })}</div>
      <span class="cf-label">Status color</span>
      <div class="cf-row">
        <div class="swatches">${COLORS.map(c => `<button class="swatch${f.color === c ? ' on' : ''}" data-color="${c}" style="--sw:${c}" aria-label="Color ${c}"></button>`).join('')}</div>
        <label class="cf-label inline" for="cf-env">Tag</label>${select('env', { local: 'local', dev: 'development', staging: 'staging', production: 'production' })}
      </div>
      <span class="cf-label">Icon</span>
      <div class="icon-pick" id="cfIcons" style="--status:${esc(f.color)}">${['auto', ...Object.keys(CONN_ICONS)].map(k => `<button class="icon-opt${(f.icon || 'auto') === k ? ' on' : ''}" data-iconpick="${k}" title="${k === 'auto' ? `${eng.label} (automatic)` : k}" aria-label="${k === 'auto' ? 'Engine icon' : k}">${connIcon(f.engine, k === 'auto' ? null : k)}</button>`).join('')}</div>
      <label class="cf-label" for="cf-safeMode">Safe mode</label><div class="cf-span">${select('safeMode', SAFE)}</div>
    </div>
    <div class="cf-box">
      ${server ? `
        <label class="cf-label" for="cf-host">Host</label>
        <div class="cf-row">${input('host', { ph: '127.0.0.1' })}<label class="cf-label inline" for="cf-port">Port</label><div class="cf-port">${input('port', { ph: String(eng.port) })}</div></div>
        <label class="cf-label" for="cf-user">User</label><div class="cf-span">${input('user', { ph: eng.user })}</div>
        <label class="cf-label" for="cf-password">Password</label><div class="cf-span"><input class="cf-input" id="cf-password" data-k="password" type="password" value="${esc(f.password ?? '')}" placeholder="${f.hasPassword ? 'Stored in Keychain — type to replace' : 'None'}" autocomplete="off"></div>
        <label class="cf-label" for="cf-database">Database</label><div class="cf-span">${input('database', { ph: f.engine === 'mysql' ? 'Empty lists every schema' : 'postgres' })}</div>
        <label class="cf-label" for="cf-sslMode">SSL mode</label><div class="cf-span">${select('sslMode', SSL)}</div>`
      : `
        <label class="cf-label" for="cf-file">File</label>
        <div class="cf-row">${input('file', { ph: '/path/to/database.sqlite', mono: true })}<button class="btn big" data-cf="choose">Choose…</button><button class="btn big" data-cf="newfile">New…</button></div>
        <span></span><p class="cf-note">The file is written after every commit and every write query.${f.demo ? ' This is the example database.' : ''}</p>`}
    </div>
    </div>
    <div class="sheet-foot">
      ${f.id ? `<button class="btn danger big" data-cf="delete">${ic('trash')}Delete</button>` : ''}
      ${fromList ? `<button class="btn big" data-cf="back">${ic('left')}Connections</button>` : '<button class="btn big" data-cf="cancel">Cancel</button>'}
      <span class="cf-status" id="sheetStatus"></span>
      <span class="spacer"></span>
      <button class="btn big" data-cf="save">Save</button>
      <button class="btn big" data-cf="test">Test</button>
      <button class="btn primary big" data-cf="connect">${S.busy ? '<span class="spin"></span>' : ''}Connect</button>
    </div>
  </div></div>`;
  const sheet = $('.sheet', ov);
  sheet.addEventListener('input', e => {
    const k = e.target.dataset.k;
    if (k) f[k] = e.target.value;
  });
  sheet.addEventListener('change', e => { const k = e.target.dataset.k; if (k) f[k] = e.target.value; });
  sheet.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); run('connect'); } });
  const run = async act => {
    if (S.busy) return;
    try {
      if (act === 'cancel') return closeOverlay();
      if (act === 'back') return showOpenConnection(f.id);
      if (act === 'choose' || act === 'newfile') {
        const file = act === 'choose' ? await api.openFile() : await api.newFile();
        if (!file) return;
        f.file = file;
        if (!f.name) f.name = file.split('/').pop().replace(/\.(sqlite3?|db3?|s3db)$/i, '');
        return showConnForm(f, fromList);
      }
      if (act === 'delete') {
        const back = () => showConnForm(f, fromList);
        return showModal({
          title: `Delete “${f.name}”?`, text: 'The saved connection and its Keychain password are removed. The database itself is not touched.',
          actions: [{ label: 'Cancel', run: () => { back(); return false; } }, { label: 'Delete', cls: 'danger', primary: true, run: async () => { await api.deleteConnection(f.id); toast('Connection deleted'); if (WELCOME) { closeOverlay(); renderWelcome(); } else showOpenConnection(); return false; } }],
        });
      }
      const problem = f.engine === 'sqlite' ? (!f.file && 'Choose a SQLite file first.') : (!f.host && 'Enter a host.');
      if (problem) return sheetStatus('bad', problem);
      if (act === 'test') {
        sheetStatus('', 'Testing…');
        const info = await api.testConnection(f);
        sheetStatus('good', `Connected · ${info.engine} ${info.version}${info.tls ? ' · ' + info.tls : ''}`);
      } else if (act === 'save') {
        const saved = await saveForm();
        if (fromList) showOpenConnection(saved.id); else { closeOverlay(); toast('Connection saved'); if (WELCOME) renderWelcome(saved.id); }
      } else if (act === 'connect') {
        const saved = await saveForm();
        await connectTo(saved.id);
      }
    } catch (err) { sheetStatus('bad', err.message); }
  };
  sheet.addEventListener('click', e => {
    const eng2 = e.target.closest('[data-engine]');
    if (eng2) {
      const to = eng2.dataset.engine;
      if (f.engine === to) return;
      if (!f.port || Object.values(ENGINE).some(x => String(x.port) === String(f.port))) f.port = ENGINE[to].port || '';
      if (!f.user || Object.values(ENGINE).some(x => x.user === f.user)) f.user = ENGINE[to].user || '';
      f.engine = to;
      return showConnForm(f, fromList);
    }
    const sw = e.target.closest('[data-color]');
    if (sw) { f.color = sw.dataset.color; $$('.swatch', sheet).forEach(x => x.classList.toggle('on', x === sw)); $('#cfIcons', sheet).style.setProperty('--status', f.color); return; }
    const ip = e.target.closest('[data-iconpick]');
    if (ip) { f.icon = ip.dataset.iconpick === 'auto' ? null : ip.dataset.iconpick; $$('.icon-opt', sheet).forEach(x => x.classList.toggle('on', x === ip)); return; }
    const b = e.target.closest('[data-cf]');
    if (b) run(b.dataset.cf);
  });
  $('[data-scrim]', ov).addEventListener('mousedown', e => { if (e.target === e.currentTarget) closeOverlay(); });
  modalPrimary = () => run('connect');
  const first = $('#cf-name', sheet);
  if (first && !f.name) first.focus();
}

async function saveForm() {
  const f = { ...S.form };
  if (!f.name) f.name = f.engine === 'sqlite' ? (f.file || '').split('/').pop() || 'SQLite' : `${f.database || f.host}`;
  if (f.engine === 'sqlite') { delete f.host; delete f.port; delete f.user; delete f.database; delete f.sslMode; delete f.password; }
  else { delete f.file; f.demo = false; }
  delete f.ssl;
  const saved = await api.saveConnection(f);
  S.conns = await api.connections();
  S.form = { ...saved };
  return saved;
}

async function connectTo(id, force = false) {
  if (S.busy) return;
  // From the welcome window a connection opens in its own workspace window.
  if (WELCOME) {
    store.set('lastConn', id);
    try { await api.openConnectionWindow(id); } catch (e) { sheetStatus('bad', e.message); }
    return;
  }
  if (S.conn && !force && unsavedCount()) return guardPending(() => connectTo(id, true));
  S.busy = true;
  sheetStatus('', 'Connecting…');
  try {
    const r = await api.connect(id);
    S.conn = r.conn; S.info = r.info; S.sample = r.sample;
    store.set('lastConn', id);
    S.busy = false;
    closeOverlay();
    await openWorkspace();
  } catch (e) {
    S.busy = false;
    if (!overlayOpen()) await showOpenConnection(id);
    sheetStatus('bad', e.message);
  }
}

function openManager(blank = false) {
  if (blank) showConnForm(blankForm(), false);
  else showOpenConnection();
}

// Before anything is open the window shows an empty workspace under the Open Connection sheet.
function renderDisconnected() {
  document.documentElement.classList.remove('env-production');
  $('#connName').textContent = 'No connection';
  $('#envTag').hidden = true;
  $('#connEngine').textContent = '';
  $('#connDot').style.background = 'var(--faint)';
  $('#pendingBox').hidden = true;
  $('#sideList').innerHTML = '<div class="side-empty">Open a connection to see its tables.</div>';
  $('#sideFoot').innerHTML = '';
  $('#tabs').innerHTML = '';
  $('#tabBody').innerHTML = `<div class="boot"><div><span class="brand-mark boot-mark" aria-hidden="true">${ic('trellis')}</span><p class="boot-title">No database open</p><p class="boot-sub">Open a saved connection or add a new one.</p><div style="display:flex;gap:8px;justify-content:center"><button class="btn big" data-act="new-connection">${ic('plus')}New connection</button><button class="btn primary big" data-act="open-connection">${ic('plug')}Open connection</button></div></div></div>`;
  $('#inspector').hidden = true;
  $('#layout').classList.add('no-inspector');
  $('#status').innerHTML = '<span>Not connected</span>';
}

/* ================================================================
   Workspace
   ================================================================ */
async function openWorkspace() {
  document.documentElement.classList.toggle('env-production', isProd());
  $('#envTag').hidden = false;
  S.tabs = []; S.active = null; S.queryN = 1; S.filter = ''; $('#tableFilter').value = '';
  S.history = store.get('history:' + S.conn.id, []);
  S.saved = store.get('queries:' + S.conn.id, []);
  S.schemaSel = null;
  renderToolbar();
  $('#tabs').innerHTML = '';
  $('#tabBody').innerHTML = `<div class="boot"><div><div class="spinner"></div>Reading ${esc(S.conn.name)}…</div></div>`;
  try { await loadSchema(); }
  catch (e) { toast(e.message, true); }
  if (S.sample) newQueryTab(S.sample, true, false);
  const first = S.schema.tables.find(t => t.name === 'players' && schemaOf(t) === S.schemaSel) || S.schema.tables.find(t => schemaOf(t) === S.schemaSel);
  if (first) await openTable(first.ref, false);
  else if (!S.sample) newQueryTab('', false, false);
  renderAll();
}

async function loadSchema() {
  const o = await api.objects();
  S.schema.schemas = o.schemas && o.schemas.length ? o.schemas : ['main'];
  S.schema.tables = o.tables;
  S.schema.views = o.views;
  tableNameSet = new Set([...o.tables, ...o.views].map(t => t.name.toLowerCase()));
  if (!S.schema.schemas.includes(S.schemaSel)) await setSchema(pickSchema(), false);
  api.allColumns().then(c => { S.schema.columns = c; }).catch(() => {});
}

// Opens on the schema used last time, else public, else the one with the most tables.
function pickSchema() {
  const list = S.schema.schemas;
  const last = store.get('schema:' + S.conn.id, null);
  if (list.includes(last)) return last;
  const count = sc => S.schema.tables.filter(t => schemaOf(t) === sc).length;
  if (list.includes('public') && count('public')) return 'public';
  return [...list].sort((a, b) => count(b) - count(a))[0] || list[0];
}

async function setSchema(schema, render = true) {
  if (!schema || schema === S.schemaSel) return;
  S.schemaSel = schema;
  store.set('schema:' + S.conn.id, schema);
  if (schema !== 'main') api.setSchema(schema).catch(e => toast(e.message, true));
  if (render) { S.pane = 'items'; renderSide(); renderStatus(); }
}


/* ---------- tabs ---------- */
async function openTable(ref, render = true, view = 'data') {
  if (ref.schema && ref.schema !== S.schemaSel && S.schema.schemas.includes(ref.schema)) await setSchema(ref.schema, false);
  let tab = S.tabs.find(t => t.kind === 'table' && t.key === refKey(ref));
  if (!tab) {
    const obj = [...S.schema.tables, ...S.schema.views].find(t => refKey(t.ref) === refKey(ref));
    const isView = S.schema.views.some(v => refKey(v.ref) === refKey(ref));
    tab = {
      id: S.nextId++, kind: 'table', ref, key: refKey(ref), name: obj ? obj.name : ref.name, isView,
      view, page: 0, limit: 100, sort: null, filters: [{ col: '*', op: 'contains', val: '' }], applied: [],
      pending: { edits: new Map(), deletes: new Map(), inserts: [] }, nextTmp: 1,
      sel: null, widths: [], rows: [], cols: [], keyCols: [], editable: false, total: 0, approximate: false, ms: 0, seq: 0, structure: null,
    };
    S.tabs.push(tab);
    S.active = tab.id;
    if (render) { renderTabs(); renderBody(); }
    await loadTable(tab);
  }
  tab.view = view;
  S.active = tab.id;
  if (render) renderAll();
}

function newQueryTab(sql = '', run = false, render = true, file = null) {
  const tab = { id: S.nextId++, kind: 'query', name: file ? baseName(file) : `Query ${S.queryN++}`, sql, file, saved: file ? sql : '', result: null, error: null, msg: '', sel: null, sort: null, widths: [], editorH: 200, running: false };
  S.tabs.push(tab);
  S.active = tab.id;
  if (run && sql.trim()) execQuery(tab, sql);
  if (render) { renderAll(); focusEditor(); }
  return tab;
}

function activate(id) {
  S.active = id;
  renderAll();
}

function pendingCount(tab) {
  if (!tab || tab.kind !== 'table') return 0;
  const p = tab.pending;
  let n = p.inserts.length + p.deletes.size;
  for (const [k, ed] of p.edits) if (!p.deletes.has(k)) n += Object.keys(ed.set).length;
  return n;
}
const totalPending = () => S.tabs.reduce((s, t) => s + pendingCount(t), 0);
const isDirty = t => t.kind === 'query' && !!t.file && t.sql !== t.saved;
const unsavedCount = () => totalPending() + S.tabs.filter(isDirty).length;

/* ---------- SQL files ---------- */
function rememberQuery(file) {
  S.saved = [{ path: file, name: baseName(file), at: Date.now() }, ...S.saved.filter(q => q.path !== file)].slice(0, 200);
  store.set('queries:' + S.conn.id, S.saved);
  if (S.pane === 'queries') renderSide();
}

async function saveQuery(saveAs = false, tab = cur()) {
  if (!tab || tab.kind !== 'query') return false;
  try {
    const file = await api.saveSql({ file: tab.file, text: tab.sql, name: tab.file ? baseName(tab.file) : tab.name, saveAs });
    if (!file) return false;
    tab.file = file; tab.saved = tab.sql; tab.name = baseName(file);
    rememberQuery(file);
    renderTabs();
    toast(`Saved ${file.split('/').pop()}`);
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

function openQueryText(file, text) {
  const open = S.tabs.find(t => t.kind === 'query' && t.file === file);
  if (open) return activate(open.id);
  newQueryTab(text, false, true, file);
  rememberQuery(file);
}

async function openSqlFiles() {
  try { (await api.openSql()).forEach(f => openQueryText(f.path, f.text)); }
  catch (e) { toast(e.message, true); }
}

async function openSavedQuery(file) {
  try { const f = await api.readSql(file); openQueryText(f.path, f.text); }
  catch {
    showModal({
      title: `${file.split('/').pop()} is gone`, text: `Trellis could not read ${file}. It may have been moved or deleted.`,
      actions: [{ label: 'Keep in list' }, { label: 'Remove from list', primary: true, run: () => { S.saved = S.saved.filter(q => q.path !== file); store.set('queries:' + S.conn.id, S.saved); renderSide(); } }],
    });
  }
}

function closeTab(id, force = false) {
  const tab = S.tabs.find(t => t.id === id);
  if (!tab) return;
  if (isDirty(tab) && !force) {
    showModal({
      title: `Save changes to ${tab.file.split('/').pop()}?`,
      text: 'The query in this tab differs from the file.',
      actions: [{ label: 'Cancel' }, { label: 'Don’t save', cls: 'danger', run: () => closeTab(id, true) }, { label: 'Save', primary: true, kbd: MOD + '↵', run: async () => { if (await saveQuery(false, tab)) closeTab(id, true); } }],
    });
    return;
  }
  const n = pendingCount(tab);
  if (n && !force) {
    showModal({
      title: `Discard ${plural(n, 'change')} to ${tab.name}?`,
      text: 'These edits were never committed. Closing the tab drops them.',
      actions: [{ label: 'Cancel' }, { label: 'Discard and close', cls: 'danger', primary: true, run: () => closeTab(id, true) }],
    });
    return;
  }
  const i = S.tabs.indexOf(tab);
  S.tabs.splice(i, 1);
  if (S.active === id) S.active = (S.tabs[i] || S.tabs[i - 1] || {}).id ?? null;
  renderAll();
}

/* ---------- table data ---------- */
// Moves the highlight in a connection list without rebuilding its rows.
function markRow(list, i) {
  $$('.oc-row', list).forEach(r => { const on = +r.dataset.i === i; r.classList.toggle('on', on); r.setAttribute('aria-selected', on); });
}

const OPS = [['contains', 'contains'], ['=', '='], ['!=', '≠'], ['<', '<'], ['>', '>'], ['starts', 'starts with'], ['null', 'is NULL'], ['notnull', 'is not NULL']];

function setLoading(on) {
  const ws = $('#workspace');
  let bar = $('.loading-bar', ws);
  if (on && !bar) { bar = document.createElement('div'); bar.className = 'loading-bar'; ws.appendChild(bar); }
  if (!on && bar) bar.remove();
}

async function loadTable(tab) {
  const seq = ++tab.seq;
  const slow = setTimeout(() => { if (cur() === tab) setLoading(true); }, 120);
  try {
    const sort = tab.sort && tab.cols[tab.sort.ci] ? { col: tab.cols[tab.sort.ci].name, dir: tab.sort.dir } : null;
    const r = await api.page(tab.ref, { filters: tab.applied, sort, limit: tab.limit, offset: tab.page * tab.limit });
    if (seq !== tab.seq) return;
    if (!r.rows.length && tab.page > 0 && r.total > 0) { tab.page = Math.max(0, Math.ceil(r.total / tab.limit) - 1); clearTimeout(slow); return loadTable(tab); }
    if (tab.cols.length && tab.cols.map(c => c.name).join() !== r.columns.map(c => c.name).join()) tab.widths = [];
    tab.cols = r.columns; tab.rows = r.rows; tab.total = r.total; tab.approximate = r.approximate;
    tab.keyCols = r.keyCols; tab.editable = r.editable && !tab.isView; tab.ms = r.ms; tab.error = null;
  } catch (e) {
    if (seq !== tab.seq) return;
    tab.error = e.message; tab.rows = []; tab.total = 0;
  } finally {
    clearTimeout(slow);
    if (seq === tab.seq) setLoading(false);
  }
}

async function reloadTab(tab) {
  await loadTable(tab);
  if (cur() === tab && tab.view === 'data') refreshGrid();
}

function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function gridModel(tab) {
  if (tab.kind === 'query') {
    const r = tab.result;
    if (!r) return null;
    const idx = r.values.map((_, i) => i);
    if (tab.sort) { const c = tab.sort.ci, d = tab.sort.dir === 'ASC' ? 1 : -1; idx.sort((a, b) => cmp(r.values[a][c], r.values[b][c]) * d); }
    return { cols: r.columns.map(n => ({ name: n, type: '' })), rows: idx.map((i, k) => ({ key: i, vals: r.values[i], orig: r.values[i], rn: k + 1, cls: '', edited: null })) };
  }
  const p = tab.pending, rows = [];
  for (const ins of p.inserts) rows.push({ keyStr: ins.tmp, isNew: true, vals: ins.vals, orig: ins.vals, rn: '+', cls: 'is-new', edited: null });
  tab.rows.forEach((row, i) => {
    const keyStr = JSON.stringify(row.key);
    const ed = p.edits.get(keyStr);
    const vals = ed ? row.vals.map((v, ci) => (ci in ed.set ? ed.set[ci] : v)) : row.vals;
    rows.push({ key: row.key, keyStr, vals, orig: row.vals, rn: tab.page * tab.limit + i + 1, cls: p.deletes.has(keyStr) ? 'is-del' : '', edited: ed ? new Set(Object.keys(ed.set).map(Number)) : null });
  });
  return { cols: tab.cols, rows };
}

// Binary values arrive as {"$blob": length} from Rust and as Uint8Array from the Electron build.
const blobLen = v => v instanceof Uint8Array ? v.length : v && typeof v === 'object' && '$blob' in v ? v.$blob : null;

function shown(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return fmtNum(v);
  if (blobLen(v) !== null) return `BLOB · ${blobLen(v)} B`;
  return String(v);
}

function defaultWidth(c, rows, i) {
  let w = c.name.length * 7.4 + (c.type ? Math.min(c.type.length, 18) * 6.6 + 10 : 0) + (c.pk ? 18 : 0) + 34;
  for (let k = 0; k < Math.min(rows.length, 40); k++) w = Math.max(w, Math.min(shown(rows[k].vals[i]).length, 48) * 7.1 + 24);
  return Math.round(Math.max(64, Math.min(w, 340)));
}

function cellHTML(v, cls, ci) {
  const c = cls.length ? ' ' + cls.join(' ') : '';
  if (v === null || v === undefined) return `<td data-c="${ci}" class="nul${c}"><span class="null">NULL</span></td>`;
  if (blobLen(v) !== null) return `<td data-c="${ci}" class="blob${c}">BLOB · ${blobLen(v)} B</td>`;
  if (typeof v === 'number') return `<td data-c="${ci}" class="num${c}">${fmtNum(v)}</td>`;
  if (typeof v === 'boolean') return `<td data-c="${ci}" class="bool ${v ? 't' : 'f'}${c}">${v}</td>`;
  const s = String(v);
  const t = s.length > 200 ? s.slice(0, 200) + '…' : s;
  const j = s[0] === '{' || s[0] === '[' ? ' json' : '';
  return `<td data-c="${ci}" class="txt${j}${c}">${esc(t)}</td>`;
}

/* Only the rows near the viewport are in the page: a spacer row above and below stands in for the rest, so a
   page of a thousand rows scrolls as lightly as one of fifty. */
const OVERSCAN = 30;
let ROW_H = 0;
const rowH = () => ROW_H || (ROW_H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 26);

function rowWindow(wrap, n) {
  const h = rowH(), top = Math.max(0, wrap.scrollTop - 30), view = wrap.clientHeight || 800;
  const first = Math.floor(top / h), last = Math.ceil((top + view) / h);
  return { start: Math.max(0, first - OVERSCAN), end: Math.min(n, last + OVERSCAN) };
}

function rowHTML(tab, r, ri) {
  const sel = tab.sel && tab.sel.r === ri;
  let h = `<tr data-r="${ri}" class="${r.cls}${sel ? ' sel' : ''}"><td class="rn">${r.rn}</td>`;
  r.vals.forEach((v, ci) => {
    const cls = [];
    if (r.edited && r.edited.has(ci)) cls.push('edited');
    if (sel && tab.sel.c === ci) cls.push('cur');
    h += cellHTML(v, cls, ci);
  });
  return h + '</tr>';
}

function rowsHTML(tab, m, win) {
  const span = m.cols.length + 1, pad = n => n > 0 ? `<tr class="vpad" aria-hidden="true"><td colspan="${span}" style="height:${n * rowH()}px"></td></tr>` : '';
  let h = pad(win.start);
  for (let ri = win.start; ri < win.end; ri++) h += rowHTML(tab, m.rows[ri], ri);
  return h + pad(m.rows.length - win.end);
}

// Draws the rows for the current scroll position; does nothing while the rendered rows still cover the view.
function syncRows(wrap, force = false) {
  const tab = cur(), m = tab && tab.model, win = wrap && wrap._win;
  const tbody = wrap && $('.grid tbody', wrap);
  if (!m || !win || !tbody || $('td.editing', tbody)) return;
  const want = rowWindow(wrap, m.rows.length);
  const h = rowH(), top = wrap.scrollTop, bottom = top + wrap.clientHeight;
  const covered = win.start * h <= Math.max(0, top - 30) && (win.end >= m.rows.length || win.end * h >= bottom);
  if (!force && covered) return;
  wrap._win = want;
  tbody.innerHTML = rowsHTML(tab, m, want);
}

// Puts row ri in the page, scrolling to it first when it is far from the view.
function ensureRow(ri) {
  const wrap = $('#tabBody .grid-wrap');
  if (!wrap || !wrap._win || (ri >= wrap._win.start && ri < wrap._win.end)) return;
  const h = rowH(), head = 30, y = ri * h;
  if (y < wrap.scrollTop) wrap.scrollTop = y;
  else if (y + h + head > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = y + h + head - wrap.clientHeight;
  syncRows(wrap, true);
}

// Rows are measured once from the page, in case the stylesheet's row height is not what the browser draws.
function measureRows(wrap) {
  const tr = $('.grid tbody tr[data-r]', wrap);
  if (!tr) return;
  const h = tr.getBoundingClientRect().height;
  if (h && Math.abs(h - rowH()) > 0.5) { ROW_H = h; syncRows(wrap, true); }
}

function fillGrid(wrap, tab, m) {
  wrap._win = rowWindow(wrap, m.rows.length);
  wrap.innerHTML = gridHTML(tab, m, wrap._win);
  measureRows(wrap);
  if (!wrap._scroll) {
    wrap._scroll = true;
    let queued = false;
    wrap.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; syncRows(wrap); });
    }, { passive: true });
  }
}

function gridHTML(tab, m, win) {
  m.cols.forEach((c, i) => { if (!tab.widths[i]) tab.widths[i] = defaultWidth(c, m.rows, i); });
  const total = 52 + m.cols.reduce((s, _, i) => s + tab.widths[i], 0);
  let h = `<table class="grid" style="width:${total}px"><colgroup><col style="width:52px">${m.cols.map((_, i) => `<col style="width:${tab.widths[i]}px">`).join('')}</colgroup><thead><tr><th class="rn"></th>`;
  m.cols.forEach((c, i) => {
    const s = tab.sort && tab.sort.ci === i ? tab.sort.dir : '';
    const type = c.type ? c.type.toLowerCase().replace(/ (auto_increment|default_generated.*)$/, '') : '';
    h += `<th data-ci="${i}" title="${esc(c.name)}${c.type ? ' · ' + esc(c.type) : ''}"><div class="th-in">${c.pk ? ic('key', 'pk') : ''}<span class="th-name">${esc(c.name)}</span>${type ? `<span class="th-type">${esc(type)}</span>` : ''}<span class="th-sort">${s === 'ASC' ? '▲' : s === 'DESC' ? '▼' : ''}</span></div><span class="rz" data-rz="${i}"></span></th>`;
  });
  h += `</tr></thead><tbody>${rowsHTML(tab, m, win)}</tbody></table>`;
  if (!m.rows.length) h += `<div class="grid-empty">${tab.kind === 'table' && tab.applied.length ? 'No rows match these filters.' : tab.kind === 'table' && tab.editable ? 'This table is empty. Add a row with + Row.' : 'No rows.'}</div>`;
  return h;
}

/* ---------- editing ---------- */
const isEditable = tab => tab && tab.kind === 'table' && tab.editable && tab.view === 'data' && !tab.error && safeMode() !== 'readonly';

function coerce(raw, col) {
  if (raw === 'NULL') return null;
  const t = (col && col.type || '').toLowerCase();
  if (/bool/.test(t)) {
    if (/^(true|t|1|yes)$/i.test(raw)) return true;
    if (/^(false|f|0|no)$/i.test(raw)) return false;
    return raw;
  }
  if (/int|real|floa|doub|num|dec|serial/.test(t) && raw.trim() !== '' && !isNaN(Number(raw))) {
    const n = Number(raw);
    return Number.isSafeInteger(n) || !Number.isInteger(n) ? n : raw;
  }
  return raw;
}

function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b) && String(a).trim() !== '' && String(b).trim() !== '';
  return String(a) === String(b);
}

function stageEdit(tab, ri, ci, val) {
  const row = tab.model.rows[ri];
  if (!row) return;
  if (row.isNew) { const ins = tab.pending.inserts.find(x => x.tmp === row.keyStr); if (ins) ins.vals[ci] = val; return; }
  const ed = tab.pending.edits.get(row.keyStr) || { key: row.key, set: {} };
  if (same(val, row.orig[ci])) delete ed.set[ci]; else ed.set[ci] = val;
  if (Object.keys(ed.set).length) tab.pending.edits.set(row.keyStr, ed); else tab.pending.edits.delete(row.keyStr);
}

function addRow() {
  const tab = cur();
  if (!isEditable(tab)) return;
  const tmp = 'n' + tab.nextTmp++;
  tab.pending.inserts.unshift({ tmp, vals: tab.cols.map(() => null) });
  tab.sel = { r: 0, c: Math.max(0, tab.cols.findIndex(c => !c.pk)) };
  refreshGrid();
  const w = $('#tabBody .grid-wrap');
  if (w) w.scrollTop = 0;
  startEdit(tab.sel.r, tab.sel.c);
}

function toggleDelete() {
  const tab = cur();
  if (!isEditable(tab) || !tab.sel) return;
  const row = tab.model.rows[tab.sel.r];
  if (!row) return;
  if (row.isNew) { tab.pending.inserts = tab.pending.inserts.filter(x => x.tmp !== row.keyStr); tab.sel = null; }
  else if (tab.pending.deletes.has(row.keyStr)) tab.pending.deletes.delete(row.keyStr);
  else tab.pending.deletes.set(row.keyStr, row.key);
  refreshGrid();
}

function discard(tab = cur(), quiet = false) {
  if (!tab || tab.kind !== 'table' || !pendingCount(tab)) return;
  tab.pending = { edits: new Map(), deletes: new Map(), inserts: [] };
  tab.sel = null;
  if (cur() === tab) refreshGrid();
  if (!quiet) toast('Changes discarded');
}

function changesFor(tab) {
  const p = tab.pending, cols = tab.cols;
  const setOf = obj => Object.fromEntries(Object.entries(obj).map(([ci, v]) => [cols[ci].name, v]));
  return {
    ref: tab.ref,
    keyCols: tab.keyCols,
    inserts: [...p.inserts].reverse().map(ins => ({ set: Object.fromEntries(cols.map((c, i) => [c.name, ins.vals[i]]).filter(([, v]) => v !== null && v !== undefined)) })),
    updates: [...p.edits].filter(([k]) => !p.deletes.has(k)).map(([, ed]) => ({ key: ed.key, set: setOf(ed.set) })),
    deletes: [...p.deletes.values()].map(key => ({ key })),
  };
}

async function reviewChanges() {
  const tab = cur();
  const n = pendingCount(tab);
  if (!n) { toast('Nothing to commit'); return; }
  const changes = changesFor(tab);
  let st;
  try { st = await api.preview(changes); } catch (e) { toast(e.message, true); return; }
  showModal({
    title: `Commit ${plural(n, 'change')} to ${tab.name}`,
    text: `${plural(st.length, 'statement')} run in one transaction. If any fails, none are applied.`,
    warning: isProd() ? `${S.conn.name} is a production database.` : safeMode() === 'confirm' ? `${S.conn.name} asks before every write.` : '',
    sql: st.map(s => s.show).join('\n'),
    actions: [
      { label: 'Discard all', cls: 'danger', run: () => discard(tab) },
      { label: 'Cancel' },
      { label: isProd() ? 'Commit to production' : 'Commit', cls: isProd() ? 'prod' : 'commit', kbd: MOD + '↵', primary: true, run: m => commit(tab, changes, n, m) },
    ],
  });
}

async function commit(tab, changes, n, modal) {
  try {
    const st = await api.apply(changes);
    pushHistory(st.map(s => s.show).join('\n'), true, 0);
  } catch (e) {
    if (modal) { modal.error(`Nothing was applied. ${S.info.engine} said: ${e.message}`); return false; }
    toast(e.message, true);
    return false;
  }
  tab.pending = { edits: new Map(), deletes: new Map(), inserts: [] };
  tab.sel = null;
  await afterWrite();
  toast(`Committed ${plural(n, 'change')}`);
  return true;
}

async function afterWrite() {
  try { await loadSchema(); } catch {}
  await Promise.all(S.tabs.filter(t => t.kind === 'table').map(t => { t.structure = null; return loadTable(t); }));
  renderAll();
}

/* ---------- queries ---------- */
async function execQuery(tab, text) {
  const sql = text.trim();
  if (!sql || tab.running) return;
  // Safe mode: read-only connections refuse writes, careful ones ask first.
  if (isWrite(sql) && safeMode() === 'readonly') {
    showModal({ title: `${S.conn.name} is read only`, text: 'Its safe mode blocks every write. Change it in the connection settings to run this.', sql: sql.length > 2000 ? sql.slice(0, 2000) + '\n…' : sql, actions: [{ label: 'OK', primary: true }] });
    return;
  }
  if (isWrite(sql) && safeMode() === 'confirm' && !tab.prodOk) {
    showModal({
      title: `Run a write on ${S.conn.name}?`,
      warning: isProd() ? `${S.conn.name} is a production database.` : `${S.conn.name} asks before every write.`,
      sql: sql.length > 2000 ? sql.slice(0, 2000) + '\n…' : sql,
      actions: [{ label: 'Cancel' }, { label: isProd() ? 'Run on production' : 'Run', cls: isProd() ? 'prod' : 'commit', primary: true, kbd: MOD + '↵', run: () => { tab.prodOk = true; execQuery(tab, text).finally(() => { tab.prodOk = false; }); } }],
    });
    return;
  }
  tab.running = true;
  renderRunButton(tab);
  try {
    const r = await api.query(sql);
    tab.result = r.columns ? { columns: r.columns, values: r.values } : null;
    tab.error = null; tab.sel = null; tab.sort = null; tab.widths = [];
    tab.msg = r.columns
      ? `<span class="good">${plural(r.values.length, 'row')}</span> · ${fmtMs(r.ms)}`
      : `<span class="good">${esc(r.command || 'Query OK')}</span> · ${plural(r.changed, 'row')} affected · ${fmtMs(r.ms)}`;
    pushHistory(sql, true, r.ms);
    if (r.write) afterWrite();
  } catch (e) {
    tab.error = e.message; tab.result = null; tab.msg = '<span class="bad">Error</span>';
    pushHistory(sql, false, 0);
  }
  tab.running = false;
  if (cur() === tab) { renderQueryResult(tab); renderRunButton(tab); renderInspector(); renderStatus(); }
}

function pushHistory(sql, ok, ms) {
  S.history = S.history.filter(h => h.sql !== sql);
  S.history.unshift({ sql, ok, ms, at: Date.now() });
  S.history = S.history.slice(0, 1000);
  if (S.conn) store.set('history:' + S.conn.id, S.history);
  if (S.pane === 'history') renderSide();
}

/* ---------- rendering ---------- */
function renderAll() {
  renderToolbar();
  renderSide();
  renderTabs();
  renderBody();
  renderInspector();
  renderStatus();
}

function renderToolbar() {
  if (!S.conn) return;
  $('#connName').textContent = S.conn.name;
  const env = $('#envTag');
  const e = S.conn.env || 'local';
  env.textContent = S.conn.demo ? 'EXAMPLE' : ENV[e].toUpperCase();
  env.dataset.env = e;
  env.classList.toggle('demo', !!S.conn.demo);
  $('#connDot').dataset.env = e;
  $('#connDot').style.background = colorOf(S.conn);
  $('#connEngine').textContent = `${S.info.engine} ${S.info.version}`;
  renderPending();
  $('#inspectorBtn').classList.toggle('on', S.inspector);
  $('#inspector').hidden = !S.inspector;
  $('#layout').classList.toggle('no-inspector', !S.inspector);
  $('#layout').classList.toggle('no-sidebar', !S.sidebar);
}

function renderPending() {
  const n = pendingCount(cur());
  $('#pendingBox').hidden = !n;
  if (n) $('#pendingCount').textContent = plural(n, 'change');
}

// Server engines report row counts from statistics; small counts are close enough to show plainly.
const isApprox = t => t.approximate && t.count >= 1000;
function countLabel(t) {
  if (t.count == null) return '';
  return isApprox(t) ? `<span class="approx">~</span>${fmtCount(t.count)}` : fmtCount(t.count);
}

const PANE_HINT = { items: 'Search tables', queries: 'Search saved queries', history: 'Search history' };

function renderSide() {
  $$('#sidePanes button').forEach(b => b.classList.toggle('on', b.dataset.pane === S.pane));
  const input = $('#tableFilter');
  input.placeholder = PANE_HINT[S.pane];
  if (S.pane === 'queries') renderQueriesPane();
  else if (S.pane === 'history') renderHistoryPane();
  else renderItemsPane();
}

function renderItemsPane() {
  const f = S.filter.toLowerCase();
  const act = cur();
  const inSchema = t => schemaOf(t) === S.schemaSel;
  const item = (t, kind) => `<button class="side-item${act && act.kind === 'table' && act.key === refKey(t.ref) ? ' active' : ''}" data-ref="${esc(JSON.stringify(t.ref))}" title="${esc(schemaOf(t) + '.' + t.name)}">${ic(kind)}<span class="si-name">${esc(t.name)}</span><span class="si-count">${countLabel(t)}</span></button>`;
  const allT = S.schema.tables.filter(inSchema), allV = S.schema.views.filter(inSchema);
  const tables = allT.filter(t => t.name.toLowerCase().includes(f));
  const views = allV.filter(t => t.name.toLowerCase().includes(f));
  let h = `<div class="side-label">Tables <span>${allT.length}</span></div>`;
  h += tables.length ? tables.map(t => item(t, 'table')).join('') : `<div class="side-empty">${allT.length ? 'No tables match.' : `No tables in ${esc(S.schemaSel)}.`}</div>`;
  if (allV.length) {
    h += `<div class="side-label">Views <span>${allV.length}</span></div>`;
    h += views.length ? views.map(t => item(t, 'view')).join('') : '<div class="side-empty">No views match.</div>';
  }
  // Searching also looks in the other schemas, so a table is found without switching first.
  if (f) {
    const others = [...S.schema.tables, ...S.schema.views].filter(t => !inSchema(t) && t.name.toLowerCase().includes(f)).slice(0, 30);
    if (others.length) h += `<div class="side-label">Other schemas</div>` + others.map(t => `<button class="side-item" data-ref="${esc(JSON.stringify(t.ref))}">${ic(S.schema.views.includes(t) ? 'view' : 'table')}<span class="si-name">${esc(t.name)}<span class="si-sub">${esc(schemaOf(t))}</span></span><span class="si-count">${countLabel(t)}</span></button>`).join('');
  }
  $('#sideList').innerHTML = h;
  const many = S.schema.schemas.length > 1;
  $('#sideFoot').innerHTML = S.schemaSel && S.schemaSel !== 'main'
    ? `<button class="schema-pick" id="schemaPick" title="Switch schema (${MOD}⇧P)" ${many ? '' : 'disabled'}>${ic('schema')}<span class="sp-name">${esc(S.schemaSel)}</span><span class="sp-meta">${many ? `${S.schema.schemas.length} schemas` : ''}</span>${many ? ic('updown') : ''}</button>`
    : '';
}

function renderQueriesPane() {
  const f = S.filter.toLowerCase();
  const list = S.saved.filter(q => !f || q.name.toLowerCase().includes(f) || q.path.toLowerCase().includes(f));
  const openFiles = new Set(S.tabs.filter(t => t.file).map(t => t.file));
  $('#sideList').innerHTML = `<div class="side-label">Saved queries <span>${S.saved.length}</span></div>` + (list.length
    ? list.map(q => `<button class="side-item q${openFiles.has(q.path) ? ' active' : ''}" data-query="${esc(q.path)}" title="${esc(q.path)}">${ic('file')}<span class="si-name"><span class="si-title">${esc(q.name)}</span><span class="si-sub">${esc(q.path.replace(/^\/Users\/[^/]+/, '~').split('/').slice(0, -1).join('/'))}</span></span></button>`).join('')
    : `<div class="side-empty">${S.saved.length ? 'No saved queries match.' : `Queries you save with ${MOD}S or open with ${MOD}O show up here.`}</div>`);
  $('#sideFoot').innerHTML = `<button class="btn foot-btn" data-side="open-sql">${ic('folder')}Open…</button><button class="btn foot-btn" data-side="new-query">${ic('plus')}New</button>`;
}

function dayLabel(t) {
  const d = new Date(t), today = new Date();
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 864e5);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function renderHistoryPane() {
  const f = S.filter.toLowerCase();
  const list = S.history.map((h, i) => ({ h, i })).filter(({ h }) => !f || h.sql.toLowerCase().includes(f)).slice(0, 300);
  let h = '', day = '';
  for (const { h: it, i } of list) {
    const d = dayLabel(it.at);
    if (d !== day) { h += `<div class="side-label">${esc(d)}</div>`; day = d; }
    const time = new Date(it.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    h += `<button class="side-item hist${it.ok ? '' : ' failed'}" data-hist="${i}" title="${esc(it.sql)}"><span class="si-name"><span class="hi-sql">${esc(it.sql.replace(/^--[^\n]*\n/, '').replace(/\s+/g, ' ').trim())}</span><span class="hi-meta"><span>${time}</span>${it.ok ? (it.ms ? `<span>${fmtMs(it.ms)}</span>` : '') : '<span class="hi-bad">failed</span>'}</span></span></button>`;
  }
  $('#sideList').innerHTML = h || `<div class="side-empty">${S.history.length ? 'Nothing in the history matches.' : 'Every query you run and every commit is kept here.'}</div>`;
  $('#sideFoot').innerHTML = S.history.length ? `<button class="btn foot-btn danger" data-side="clear-history">${ic('trash')}Clear history</button>` : '';
}

function renderTabs() {
  $('#tabs').innerHTML = S.tabs.map(t => {
    const icon = t.kind === 'query' ? 'code' : t.isView ? 'view' : 'table';
    return `<button class="tab${t.id === S.active ? ' active' : ''}" data-tab="${t.id}" title="${esc(t.file || (t.ref ? schemaOf(t) + '.' + t.name : t.name))}" role="tab" aria-selected="${t.id === S.active}">${ic(icon)}<span class="tab-name">${esc(t.name)}</span>${pendingCount(t) ? '<span class="tab-dot" title="Uncommitted changes"></span>' : isDirty(t) ? '<span class="tab-dot" title="Unsaved changes"></span>' : ''}<span class="tab-x" data-close="${t.id}" role="button" aria-label="Close ${esc(t.name)}">${ic('x')}</span></button>`;
  }).join('') + `<button class="tab-add" data-act="new-query" title="New SQL query (${MOD}T)" aria-label="New SQL query">${ic('plus')}</button>`;
  const a = $('#tabs .tab.active');
  if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderBody() {
  const body = $('#tabBody');
  const tab = cur();
  body.style.animation = 'none'; void body.offsetWidth; body.style.animation = '';
  if (!tab) {
    body.innerHTML = `<div class="boot"><div><span class="brand-mark boot-mark" aria-hidden="true">${ic('trellis')}</span><p class="boot-title">Nothing open</p><p class="boot-sub">Pick a table on the left, or start a query (${MOD}T).</p><button class="btn primary big" data-act="new-query">${ic('code')}New query</button></div></div>`;
    return;
  }
  if (tab.kind === 'query') return renderQueryTab(tab);
  const foot = '<div class="tab-foot" id="tabFoot"></div>';
  if (tab.view === 'structure') {
    if (!tab.structure) {
      body.innerHTML = `<div class="boot"><div><div class="spinner"></div>Reading the structure…</div></div>${foot}`;
      api.structure(tab.ref).then(s => { tab.structure = s; if (cur() === tab && tab.view === 'structure') { renderBody(); renderInspector(); } })
        .catch(e => { tab.structure = { error: e.message }; if (cur() === tab) renderBody(); });
    } else body.innerHTML = `<div class="structure">${structureHTML(tab)}</div>${foot}`;
    renderFoot(tab);
    return;
  }
  body.innerHTML = `<div class="filterbar" id="filterbar"></div><div class="grid-wrap" tabindex="0" aria-label="Rows of ${esc(tab.name)}"></div>${foot}`;
  renderFilters(tab);
  refreshGrid({ inspector: false, chrome: false });
}

function renderFilters(tab) {
  const colOpts = sel => `<option value="*"${sel === '*' ? ' selected' : ''}>Any column</option>` + tab.cols.map(c => `<option value="${esc(c.name)}"${sel === c.name ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const opOpts = sel => OPS.map(([v, l]) => `<option value="${v}"${sel === v ? ' selected' : ''}>${l}</option>`).join('');
  const active = tab.applied.length;
  $('#filterbar').innerHTML = tab.filters.map((f, i) => `
    <div class="frow" data-fi="${i}">
      <span class="icon-btn" aria-hidden="true">${ic('filter')}</span>
      <select class="fsel" data-f="col" aria-label="Column">${colOpts(f.col)}</select>
      <select class="fsel" data-f="op" aria-label="Operator">${opOpts(f.op)}</select>
      <input class="fval" data-f="val" value="${esc(f.val)}" placeholder="${f.op === 'null' || f.op === 'notnull' ? 'no value needed' : 'Value, then Enter'}" ${f.op === 'null' || f.op === 'notnull' ? 'disabled' : ''} spellcheck="false" autocomplete="off">
      ${tab.filters.length > 1 ? `<button class="icon-btn" data-act="filter-rm" data-fi="${i}" title="Remove this filter" aria-label="Remove filter">${ic('x')}</button>` : ''}
      ${i === tab.filters.length - 1 ? `<button class="icon-btn" data-act="filter-add" title="Add a filter" aria-label="Add filter">${ic('plus')}</button><button class="btn" data-act="filter-apply">Apply</button>${active ? `<button class="btn" data-act="filter-clear">Clear</button><span class="filter-on">${active} active</span>` : ''}` : ''}
    </div>`).join('');
}

function renderFoot(tab) {
  const el = $('#tabFoot');
  if (!el) return;
  const seg = `<div class="seg" role="tablist"><button class="${tab.view === 'data' ? 'on' : ''}" data-view="data" title="${MOD}1">Data</button><button class="${tab.view === 'structure' ? 'on' : ''}" data-view="structure" title="${MOD}2">Structure</button></div>`;
  if (tab.view === 'structure') { el.innerHTML = seg + '<span class="spacer"></span>'; return; }
  const from = tab.total ? tab.page * tab.limit + 1 : 0;
  const to = Math.min(tab.total, (tab.page + 1) * tab.limit);
  const pages = Math.max(1, Math.ceil(tab.total / tab.limit));
  const edit = isEditable(tab);
  const selRow = tab.sel && tab.model && tab.model.rows[tab.sel.r];
  const why = tab.isView ? 'View · read only' : tab.keyCols.length ? 'Read only' : 'No primary key · read only';
  el.innerHTML = `${seg}
    ${edit ? `<button class="btn" data-act="add-row" title="Insert a new row (${MOD}⇧N)">${ic('rowplus')}<span class="lbl">Row</span></button>
    <button class="btn danger" data-act="del-row" ${selRow ? '' : 'disabled'} title="Mark the selected row for deletion (${MOD}⌫)">${ic('trash')}<span class="lbl">${selRow && selRow.cls === 'is-del' ? 'Restore' : 'Delete'}</span></button>` : `<span class="readonly-chip">${why}</span>`}
    <span class="spacer"></span>
    <div class="pager">
      <span>${from.toLocaleString()}–${to.toLocaleString()} of ${tab.approximate ? '~' : ''}${tab.total.toLocaleString()}</span>
      <button class="icon-btn" data-act="page-prev" ${tab.page ? '' : 'disabled'} aria-label="Previous page">${ic('left')}</button>
      <span>${tab.page + 1}/${pages.toLocaleString()}</span>
      <button class="icon-btn" data-act="page-next" ${tab.page + 1 < pages ? '' : 'disabled'} aria-label="Next page">${ic('right')}</button>
      <select data-act="limit" aria-label="Rows per page">${[50, 100, 300, 1000].map(n => `<option value="${n}"${n === tab.limit ? ' selected' : ''}>${n}</option>`).join('')}</select>
    </div>`;
}

function refreshGrid(opts = {}) {
  const tab = cur();
  if (!tab) return;
  if (tab.kind === 'query') renderQueryResult(tab);
  else {
    const wrap = $('#tabBody .grid-wrap');
    if (!wrap) return;
    tab.model = gridModel(tab);
    if (tab.sel && !tab.model.rows[tab.sel.r]) tab.sel = null;
    if (tab.error) { wrap._win = null; wrap.innerHTML = `<div class="q-error"><strong>Could not read ${esc(tab.name)}</strong><code>${esc(tab.error)}</code></div>`; }
    else fillGrid(wrap, tab, tab.model);
    renderFoot(tab);
  }
  if (opts.chrome !== false) { renderPending(); renderTabs(); renderStatus(); }
  if (opts.inspector !== false) renderInspector();
}

function structureHTML(tab) {
  const s = tab.structure;
  if (s.error) return `<div class="q-error"><strong>Could not read the structure</strong><code>${esc(s.error)}</code></div>`;
  const fkBy = Object.fromEntries(s.fks.map(f => [f.column, f]));
  const cols = s.columns.map((c, i) => `<tr>
      <td class="mono" style="color:var(--faint)">${i + 1}</td>
      <td><strong>${esc(c.name)}</strong></td>
      <td class="mono">${esc(c.type || '—')}</td>
      <td>${c.notnull ? '<span class="chip">NOT NULL</span>' : '<span style="color:var(--faint)">nullable</span>'}</td>
      <td class="mono">${c.dflt == null ? '<span style="color:var(--faint)">—</span>' : esc(c.dflt)}</td>
      <td>${c.pk ? `<span class="chip pk">${ic('key')} PK</span> ` : ''}${fkBy[c.name] ? `<span class="chip fk">→ ${esc(fkBy[c.name].table)}.${esc(fkBy[c.name].to)}</span>` : ''}</td>
    </tr>`).join('');
  return `
    <section><h3>Columns · ${s.columns.length}</h3><div class="s-card"><table class="s-table"><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Null</th><th>Default</th><th>Keys</th></tr></thead><tbody>${cols}</tbody></table></div></section>
    <section><h3>Indexes · ${s.indexes.length}</h3>${s.indexes.length ? `<div class="s-card"><table class="s-table"><thead><tr><th>Name</th><th>Columns</th><th>Unique</th><th>Created by</th></tr></thead><tbody>${s.indexes.map(x => `<tr><td class="mono">${esc(x.name)}</td><td class="mono">${esc(x.columns)}</td><td>${x.unique ? '<span class="chip ok">unique</span>' : '—'}</td><td style="color:var(--muted)">${esc(x.origin)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="side-empty" style="padding:0">No indexes.</div>'}</section>
    ${s.fks.length ? `<section><h3>Foreign keys · ${s.fks.length}</h3><div class="s-card"><table class="s-table"><thead><tr><th>Column</th><th>References</th><th>On delete</th></tr></thead><tbody>${s.fks.map(f => `<tr><td class="mono">${esc(f.column)}</td><td class="mono">${esc(f.table)}(${esc(f.to)})</td><td>${esc(f.onDelete)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
    <section><h3>Definition <button class="btn" data-act="copy-ddl" style="margin-left:auto">${ic('copy')}Copy</button></h3><div class="s-card"><pre class="ddl">${highlight(s.ddl || '')}</pre></div></section>`;
}

/* Query tab */
function renderQueryTab(tab) {
  const body = $('#tabBody');
  body.innerHTML = `
    <div class="q-editor" style="height:${tab.editorH}px">
      <div class="gutter" aria-hidden="true"></div>
      <pre class="hl" aria-hidden="true"></pre>
      <textarea class="sql-input" spellcheck="false" wrap="off" autocomplete="off" autocapitalize="off" aria-label="SQL query"></textarea>
      <div class="ac glass-strong" hidden></div>
    </div>
    <div class="hsplit" title="Drag to resize"></div>
    <div class="q-bar">
      <button class="btn primary" data-act="run" id="runBtn"></button>
      <span class="q-msg" id="qmsg"></span>
      <span class="spacer"></span>
      <button class="btn" data-act="copy-csv" title="Copy the result as CSV">${ic('copy')}<span class="lbl">CSV</span></button>
    </div>
    <div class="grid-wrap" tabindex="0" aria-label="Query result"></div>`;
  const ta = $('textarea', body);
  ta.value = tab.sql;
  syncEditor();
  wireEditor(tab, ta);
  renderRunButton(tab);
  renderQueryResult(tab);
}

function renderRunButton(tab) {
  const b = $('#runBtn');
  if (!b || cur() !== tab) return;
  const ta = $('#tabBody textarea.sql-input');
  const selection = ta && ta.selectionStart !== ta.selectionEnd;
  b.disabled = tab.running;
  b.innerHTML = tab.running ? '<span class="spin"></span>Running…' : `${ic('play')}<span id="runLbl">${selection ? 'Run selection' : 'Run'}</span><kbd>${MOD}↵</kbd>`;
}

function syncEditor() {
  const ed = $('#tabBody .q-editor');
  if (!ed) return;
  const ta = $('textarea', ed);
  $('.hl', ed).innerHTML = highlight(ta.value) + '\n ';
  const lines = ta.value.split('\n').length;
  $('.gutter', ed).textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n') + '\n ';
  syncScroll();
}

function syncScroll() {
  const ed = $('#tabBody .q-editor');
  if (!ed) return;
  const ta = $('textarea', ed);
  $('.hl', ed).scrollTop = ta.scrollTop;
  $('.hl', ed).scrollLeft = ta.scrollLeft;
  $('.gutter', ed).scrollTop = ta.scrollTop;
}

function renderQueryResult(tab) {
  const wrap = $('#tabBody .grid-wrap'), msg = $('#qmsg');
  if (!wrap) return;
  tab.model = gridModel(tab);
  wrap._win = null;
  if (tab.error) wrap.innerHTML = `<div class="q-error"><strong>Query failed</strong><code>${esc(tab.error)}</code></div>`;
  else if (!tab.result) wrap.innerHTML = `<div class="grid-empty">${tab.msg ? 'The statement ran and returned no rows.' : `Write a query and press <kbd>${MOD}</kbd> <kbd>↵</kbd> to run it. Select part of it to run only that part.`}</div>`;
  else fillGrid(wrap, tab, tab.model);
  if (msg) msg.innerHTML = tab.msg || '';
}

function focusEditor() {
  const ta = $('#tabBody textarea.sql-input');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

/* Inspector */
function renderInspector() {
  const el = $('#inspector');
  if (el.hidden) return;
  const tab = cur();
  const empty = (icon, msg) => `<div class="insp-empty"><div>${ic(icon)}${msg}</div></div>`;
  if (!tab) { el.innerHTML = empty('rings', 'Open a table to begin.'); return; }
  if (tab.kind === 'table' && tab.view === 'structure') {
    const t = [...S.schema.tables, ...S.schema.views].find(x => refKey(x.ref) === tab.key);
    const s = tab.structure;
    el.innerHTML = `<div class="insp-head">${ic(tab.isView ? 'view' : 'table')}<span class="insp-title">${esc(tab.name)}</span></div>
      <div class="insp-body"><dl class="stat-list">
        <dt>Kind</dt><dd>${tab.isView ? 'View' : 'Table'}</dd>
        <dt>Rows</dt><dd>${t && t.count != null ? (isApprox(t) ? '~' : '') + t.count.toLocaleString() : '—'}</dd>
        <dt>Columns</dt><dd>${s && s.columns ? s.columns.length : tab.cols.length}</dd>
        <dt>Indexes</dt><dd>${s && s.indexes ? s.indexes.length : '—'}</dd>
        <dt>Primary key</dt><dd>${esc(tab.keyCols.join(', ') || '—')}</dd>
      </dl></div>`;
    return;
  }
  const m = tab.model;
  const row = m && tab.sel ? m.rows[tab.sel.r] : null;
  if (!row) { el.innerHTML = empty('inspector', tab.kind === 'query' && !tab.result ? 'Run a query, then select a row to see every field here.' : 'Select a row to see every field here.'); return; }
  const editable = isEditable(tab) && row.cls !== 'is-del';
  const state = row.isNew ? '<span class="chip insp-state new">New</span>' : row.cls === 'is-del' ? '<span class="chip insp-state del">Deleted</span>' : row.edited ? '<span class="chip insp-state edit">Edited</span>' : '';
  const title = row.isNew ? 'New row' : `Row ${row.rn}`;
  const sub = tab.kind === 'table' ? tab.name : 'query result';
  const fields = m.cols.map((c, ci) => {
    const v = row.vals[ci];
    const isNull = v === null || v === undefined;
    const sv = isNull ? '' : shown(v);
    const mono = typeof v === 'number' || /^[[{]/.test(sv) || /int|real|num|dec|serial|uuid/i.test(c.type || '');
    const edited = row.edited && row.edited.has(ci);
    return `<div class="field${edited ? ' edited' : ''}" data-c="${ci}">
      <label class="f-name" for="insp-${ci}">${c.pk ? ic('key', 'pk') : ''}${esc(c.name)} ${c.type ? `<span class="f-type">${esc(c.type.toLowerCase())}</span>` : ''}</label>
      <div class="f-row"><textarea class="f-val${mono ? ' mono' : ''}${isNull ? ' is-null' : ''}" id="insp-${ci}" data-c="${ci}" rows="1" spellcheck="false" ${editable ? '' : 'readonly'} placeholder="${isNull ? 'NULL' : ''}" data-null="${isNull ? 1 : 0}">${esc(sv)}</textarea>${editable && !c.notnull ? `<button class="btn f-null" data-setnull="${ci}" title="Set to NULL">NULL</button>` : ''}</div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="insp-head"><div style="min-width:0"><div class="insp-title">${title}</div><div class="insp-sub">${esc(sub)}</div></div>${state}</div>
    <div class="insp-body">${fields}</div>
    <div class="insp-foot"><button class="btn" data-act="copy-json">${ic('copy')}JSON</button>${tab.kind === 'table' ? `<button class="btn" data-act="copy-insert">${ic('copy')}INSERT</button>` : ''}</div>`;
}

function renderStatus() {
  if (!S.conn) return;
  const tab = cur();
  let mid = '';
  if (tab && tab.kind === 'table') mid = tab.view === 'data' ? `<span>${ic('table')}${tab.approximate ? '~' : ''}${tab.total.toLocaleString()} rows${tab.applied.length ? ' (filtered)' : ''} · ${fmtMs(tab.ms)}</span>` : `<span>${ic('table')}${tab.cols.length} columns</span>`;
  else if (tab && tab.kind === 'query' && tab.result) mid = `<span>${ic('code')}${plural(tab.result.values.length, 'row')} · ${plural(tab.result.columns.length, 'column')}</span>`;
  const n = pendingCount(tab);
  const where = tab && tab.kind === 'table' ? `${schemaOf(tab)}.${tab.name}` : S.schemaSel && S.schemaSel !== 'main' ? S.schemaSel : '';
  $('#status').innerHTML = `<span>${ic('db')}${esc(S.info.engine)} ${esc(S.info.version)} · ${esc(S.info.database || S.conn.name)}${where ? ' · ' + esc(where) : ''}</span><span>${plural(S.schema.tables.length, 'table')}</span>${mid}${n ? `<span style="color:var(--modified)">● ${plural(n, 'uncommitted change')}</span>` : ''}<span class="hint">${MOD}P open anything · ${MOD}↵ run · ${MOD}S commit</span>`;
}

/* ---------- selection & grid interaction ---------- */
const cellEl = (ri, ci) => $(`#tabBody .grid tbody tr[data-r="${ri}"] td[data-c="${ci}"]`);

function selectCell(ri, ci, scroll = true) {
  const tab = cur();
  if (!tab || !tab.model) return;
  const prev = tab.sel;
  tab.sel = { r: ri, c: ci };
  if (scroll) ensureRow(ri);
  if (prev) {
    const pr = $(`#tabBody .grid tbody tr[data-r="${prev.r}"]`);
    if (pr) pr.classList.remove('sel');
    const pc = cellEl(prev.r, prev.c);
    if (pc) pc.classList.remove('cur');
  }
  const tr = $(`#tabBody .grid tbody tr[data-r="${ri}"]`);
  if (tr) tr.classList.add('sel');
  const td = cellEl(ri, ci);
  if (td) { td.classList.add('cur'); if (scroll) td.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  if (!prev || prev.r !== ri) { renderInspector(); if (tab.kind === 'table') renderFoot(tab); }
}

function focusGrid() { const w = $('#tabBody .grid-wrap'); if (w) w.focus({ preventScroll: true }); }

function startEdit(ri, ci, initial) {
  const tab = cur();
  if (!isEditable(tab)) return;
  const row = tab.model.rows[ri];
  if (!row || row.cls === 'is-del') return;
  selectCell(ri, ci);
  const td = cellEl(ri, ci);
  if (!td) return;
  const v = row.vals[ci];
  const isNull = v === null || v === undefined;
  td.classList.add('editing');
  td.innerHTML = `<input class="cell-input" spellcheck="false" autocomplete="off" placeholder="${isNull ? 'NULL' : ''}">`;
  const inp = td.firstChild;
  inp.value = initial !== undefined ? initial : isNull ? '' : shown(v);
  inp.focus();
  if (initial === undefined) inp.select();
  let done = false;
  const finish = (save, move) => {
    if (done) return;
    done = true;
    if (save && !(isNull && inp.value === '')) stageEdit(tab, ri, ci, coerce(inp.value, tab.cols[ci]));
    refreshGrid();
    const n = tab.model.rows.length, nc = tab.cols.length;
    if (move === 'down') selectCell(Math.min(ri + 1, n - 1), ci);
    else if (move === 'right' || move === 'left') {
      let r = ri, c = ci + (move === 'right' ? 1 : -1);
      if (c >= nc) { c = 0; r = Math.min(r + 1, n - 1); }
      if (c < 0) { c = nc - 1; r = Math.max(r - 1, 0); }
      startEdit(r, c);
      return;
    } else if (tab.sel) selectCell(tab.sel.r, tab.sel.c, false);
    focusGrid();
  };
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true, 'down'); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? 'left' : 'right'); }
  });
  inp.addEventListener('blur', () => finish(true));
}

function onGridKey(e) {
  const tab = cur();
  if (!tab || !tab.model || e.target !== e.currentTarget) return;
  const rows = tab.model.rows, nc = tab.model.cols.length;
  if (!rows.length) return;
  const mod = e.metaKey || e.ctrlKey;
  let { r, c } = tab.sel || { r: -1, c: 0 };
  const key = e.key;
  if ((key === 'Backspace' && mod) || key === 'Delete') { e.preventDefault(); toggleDelete(); return; }
  if (key === 'Enter' && tab.sel) { e.preventDefault(); startEdit(r, c); return; }
  const moves = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1], PageDown: [20, 0], PageUp: [-20, 0] };
  if (moves[key]) {
    e.preventDefault();
    if (r < 0) { r = 0; c = 0; } else { r += moves[key][0]; c += moves[key][1]; }
    selectCell(Math.max(0, Math.min(rows.length - 1, r)), Math.max(0, Math.min(nc - 1, c)));
    return;
  }
  if (key === 'Home') { e.preventDefault(); selectCell(Math.max(r, 0), 0); return; }
  if (key === 'End') { e.preventDefault(); selectCell(Math.max(r, 0), nc - 1); return; }
  if (key.length === 1 && !mod && !e.altKey && tab.sel && isEditable(tab)) { e.preventDefault(); startEdit(r, c, key); }
}

let resizing = false;
function startResize(e, i) {
  e.preventDefault(); e.stopPropagation();
  const tab = cur();
  const handle = e.target;
  handle.classList.add('drag');
  const x0 = e.clientX, w0 = tab.widths[i];
  const table = $('#tabBody .grid');
  const col = table.querySelectorAll('colgroup col')[i + 1];
  const move = ev => {
    tab.widths[i] = Math.max(48, Math.round(w0 + ev.clientX - x0));
    col.style.width = tab.widths[i] + 'px';
    table.style.width = 52 + tab.widths.reduce((s, w) => s + w, 0) + 'px';
  };
  const up = () => { handle.classList.remove('drag'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); setTimeout(() => (resizing = false), 0); };
  resizing = true;
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

/* ---------- editor ---------- */
function caretWord(ta) {
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const m = before.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/) || before.match(/()([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!m) return null;
  return { owner: m[1], prefix: m[2], pos };
}

function acCandidates(w) {
  const p = w.prefix.toLowerCase();
  const out = [], seen = new Set();
  const add = (word, kind) => { const k = word.toLowerCase(); if (seen.has(k) || !k.startsWith(p) || k === p) return; seen.add(k); out.push({ word, kind }); };
  const cols = S.schema.columns;
  const keys = Object.keys(cols);
  if (w.owner) {
    const o = w.owner.toLowerCase();
    // `schema.` lists that schema's tables; `table.` lists its columns, from the open schema first.
    if (S.schema.schemas.some(sc => sc.toLowerCase() === o)) {
      [...S.schema.tables, ...S.schema.views].filter(t => schemaOf(t).toLowerCase() === o).forEach(t => add(t.name, 'table'));
      return out.slice(0, 8);
    }
    const key = keys.find(k => k.toLowerCase() === `${(S.schemaSel || '').toLowerCase()}.${o}`) || keys.find(k => k.toLowerCase() === o || k.toLowerCase().endsWith('.' + o));
    (key ? cols[key] : Object.values(cols).flat()).forEach(c => add(c, 'column'));
    return out.slice(0, 8);
  }
  if (!p) return [];
  [...S.schema.tables, ...S.schema.views].filter(t => schemaOf(t) === S.schemaSel).forEach(t => add(t.name, 'table'));
  if (S.schema.schemas.length > 1) S.schema.schemas.forEach(sc => add(sc, 'schema'));
  [...S.schema.tables, ...S.schema.views].forEach(t => add(t.name, 'table'));
  keys.filter(k => k.startsWith(S.schemaSel + '.') || !k.includes('.')).forEach(k => cols[k].forEach(c => add(c, 'column')));
  KW.forEach(k => add(k, 'keyword'));
  FN.forEach(f => add(f, 'function'));
  return out.slice(0, 8);
}

let charW = 0;
function measureChar(ed) {
  if (charW) return charW;
  const s = document.createElement('span');
  s.textContent = 'M'.repeat(40);
  s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
  ed.appendChild(s);
  charW = s.getBoundingClientRect().width / 40 || 7.5;
  s.remove();
  return charW;
}

function wireEditor(tab, ta) {
  const ed = ta.parentElement;
  const ac = $('.ac', ed);
  let items = [], on = 0, word = null;
  const hideAc = () => { ac.hidden = true; items = []; };
  const drawAc = () => { ac.innerHTML = items.map((it, i) => `<div class="ac-item${i === on ? ' on' : ''}" data-i="${i}">${it.kind === 'table' ? ic('table') : it.kind === 'column' ? ic('columns') : it.kind === 'schema' ? ic('schema') : ''}<span>${esc(it.word)}</span><span class="k">${it.kind}</span></div>`).join(''); };
  const showAc = () => {
    word = caretWord(ta);
    items = word ? acCandidates(word) : [];
    if (!items.length) return hideAc();
    on = 0;
    const before = ta.value.slice(0, ta.selectionStart).split('\n');
    const line = before.length - 1, col = before[before.length - 1].length;
    const x = 52 + (col - word.prefix.length) * measureChar(ed) - ta.scrollLeft;
    const y = 10 + (line + 1) * 20 - ta.scrollTop + 2;
    ac.style.left = Math.max(44, Math.min(x, ed.clientWidth - 220)) + 'px';
    ac.style.top = (y + 160 > ed.clientHeight && y > 180 ? y - 20 - items.length * 24 - 10 : y) + 'px';
    drawAc();
    ac.hidden = false;
  };
  const accept = i => {
    const it = items[i];
    if (!it || !word) return;
    ta.focus();
    ta.setSelectionRange(word.pos - word.prefix.length, word.pos);
    const text = it.kind === 'function' ? it.word.toLowerCase() + '(' : it.word;
    if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, word.pos - word.prefix.length, word.pos, 'end');
    hideAc();
    tab.sql = ta.value;
    syncEditor();
  };
  const updateRun = () => renderRunButton(tab);
  ta.addEventListener('input', e => {
    tab.sql = ta.value;
    syncEditor();
    const dirty = isDirty(tab);
    if (dirty !== tab.wasDirty) { tab.wasDirty = dirty; renderTabs(); }
    if (e.inputType && e.inputType.startsWith('insert') && e.data !== ' ' && e.data !== '\n') showAc(); else hideAc();
  });
  ta.addEventListener('scroll', () => { syncScroll(); hideAc(); });
  ta.addEventListener('blur', () => setTimeout(hideAc, 120));
  ta.addEventListener('select', updateRun);
  ta.addEventListener('keyup', updateRun);
  ta.addEventListener('mouseup', updateRun);
  ac.addEventListener('mousedown', e => { const it = e.target.closest('.ac-item'); if (it) { e.preventDefault(); accept(+it.dataset.i); } });
  ta.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (!ac.hidden && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); on = (on + 1) % items.length; drawAc(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); on = (on - 1 + items.length) % items.length; drawAc(); return; }
      if ((e.key === 'Enter' && !mod) || e.key === 'Tab') { e.preventDefault(); accept(on); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideAc(); return; }
    }
    if (mod && e.key === 'Enter') { e.preventDefault(); runActive(); return; }
    if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      if (!document.execCommand('insertText', false, '  ')) ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      return;
    }
    if (e.ctrlKey && e.key === ' ') { e.preventDefault(); showAc(); }
  });
}

function runActive() {
  const tab = cur();
  if (!tab || tab.kind !== 'query') return;
  const ta = $('#tabBody textarea.sql-input');
  const text = ta && ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : tab.sql;
  if (!text.trim()) { toast('Write a query first', true); return; }
  execQuery(tab, text);
}

/* ---------- clipboard ---------- */
function copy(text, msg = 'Copied') {
  api.copy(text).then(() => toast(msg), e => toast(e.message, true));
}
const csvCell = v => v === null || v === undefined ? '' : /[",\n]/.test(shown(v)) ? '"' + shown(v).replace(/"/g, '""') + '"' : shown(v);
const sqlLit = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v).toUpperCase() : "'" + shown(v).replace(/'/g, "''") + "'";
const qid = n => S.info && /MySQL|MariaDB/.test(S.info.engine) ? '`' + n.replace(/`/g, '``') + '`' : '"' + n.replace(/"/g, '""') + '"';

/* ---------- overlays ---------- */
let toastTimer;
function toast(msg, bad = false) {
  clearTimeout(toastTimer);
  let t = $('#toast');
  if (t) t.remove();
  t = document.createElement('div');
  t.id = 'toast';
  t.className = 'toast glass-strong' + (bad ? ' bad' : '');
  t.setAttribute('role', 'status');
  t.innerHTML = `<span class="dot"></span><span>${esc(msg)}</span>`;
  document.body.appendChild(t);
  toastTimer = setTimeout(() => t.remove(), bad ? 5000 : 2600);
}

let modalPrimary = null;
const overlayOpen = () => !!$('#overlay').innerHTML;
function closeOverlay() { $('#overlay').innerHTML = ''; modalPrimary = null; }

function showModal({ title, text, warning, sql, actions }) {
  const ov = $('#overlay');
  ov.innerHTML = `<div class="scrim" data-scrim><div class="modal glass-strong" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}</div>
    ${warning ? `<div class="prod-warning">${esc(warning)}</div>` : ''}
    <div class="modal-body">${sql ? `<pre class="modal-sql">${highlight(sql)}</pre>` : ''}<div class="modal-err" hidden></div></div>
    <div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.cls || ''}" data-mi="${i}">${esc(a.label)}${a.kbd ? `<kbd>${a.kbd}</kbd>` : ''}</button>`).join('')}</div>
  </div></div>`;
  const api2 = { error: msg => { const e = $('.modal-err', ov); e.hidden = false; e.textContent = msg; } };
  let busy = false;
  const run = async i => {
    if (busy) return;
    const a = actions[i];
    busy = true;
    const btn = $(`[data-mi="${i}"]`, ov);
    if (btn && a.run) btn.disabled = true;
    let r = true;
    try { r = a.run ? await a.run(api2) : true; } catch (e) { api2.error(e.message); r = false; }
    busy = false;
    if (btn) btn.disabled = false;
    if (r !== false) closeOverlay();
  };
  $$('[data-mi]', ov).forEach(b => b.addEventListener('click', () => run(+b.dataset.mi)));
  $('[data-scrim]', ov).addEventListener('mousedown', e => { if (e.target === e.currentTarget) closeOverlay(); });
  const prim = actions.findIndex(a => a.primary);
  modalPrimary = prim >= 0 ? () => run(prim) : null;
  const focusBtn = $(`[data-mi="${prim >= 0 ? prim : actions.length - 1}"]`, ov);
  if (focusBtn) focusBtn.focus();
}

function paletteItems(schemasOnly = false) {
  const items = [];
  const count = sc => S.schema.tables.filter(t => schemaOf(t) === sc).length;
  if (S.schema.schemas.length > 1) S.schema.schemas.forEach(sc => items.push({ label: sc, hint: sc === S.schemaSel ? 'Schema · current' : `Schema · ${plural(count(sc), 'table')}`, icon: 'schema', run: () => setSchema(sc), kind: 'schema' }));
  if (schemasOnly) return items;
  // Tables of the open schema rank above namesakes elsewhere.
  S.schema.tables.forEach(t => items.push({ label: t.name, hint: schemaOf(t), schema: true, icon: 'table', run: () => openTable(t.ref), boost: schemaOf(t) === S.schemaSel ? 5 : 0 }));
  S.schema.views.forEach(t => items.push({ label: t.name, hint: schemaOf(t), schema: true, icon: 'view', run: () => openTable(t.ref), boost: schemaOf(t) === S.schemaSel ? 4 : 0 }));
  S.saved.forEach(q => items.push({ label: q.name, hint: 'saved query', icon: 'file', run: () => openSavedQuery(q.path), weak: true }));
  items.push({ label: 'New SQL query', hint: MOD + 'T', icon: 'code', run: () => newQueryTab(), weak: true });
  items.push({ label: 'Open SQL file', hint: MOD + 'O', icon: 'folder', run: openSqlFiles, weak: true });
  if (pendingCount(cur())) items.push({ label: 'Review and commit changes', hint: MOD + 'S', icon: 'check', run: reviewChanges });
  items.push({ label: 'New connection', hint: 'add a database', icon: 'plus', run: () => openManager(true), weak: true });
  items.push({ label: 'Switch connection', hint: MOD + '⇧K', icon: 'plug', run: () => openManager(), weak: true });
  items.push({ label: S.inspector ? 'Hide the inspector' : 'Show the inspector', hint: MOD + 'I', icon: 'inspector', run: toggleInspector, weak: true });
  S.history.slice(0, 6).forEach(h => items.push({ label: h.sql.replace(/^--[^\n]*\n/, '').replace(/\s+/g, ' ').trim().slice(0, 80), hint: 'recent query', icon: 'history', run: () => newQueryTab(h.sql), weak: true }));
  return items;
}

function fuzzy(q, s) {
  s = s.toLowerCase();
  if (!q) return 1;
  const i = s.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return 60 - i * 0.1;
  let k = 0;
  for (const ch of s) if (ch === q[k]) k++;
  return k === q.length ? 10 : 0;
}

function showPalette(schemasOnly = false) {
  if (!S.conn) return;
  if (schemasOnly && S.schema.schemas.length < 2) return toast('This database has one schema');
  const ov = $('#overlay');
  ov.innerHTML = `<div class="scrim" data-scrim><div class="palette glass-strong" role="dialog" aria-modal="true" aria-label="Open anything">
    <div class="pal-input">${ic('search')}<input id="palInput" placeholder="${schemasOnly ? 'Switch to schema…' : 'Open a table, a schema or a query…'}" autocomplete="off" spellcheck="false"></div>
    <div class="pal-list" id="palList" role="listbox"></div>
    <div class="pal-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
  </div></div>`;
  const all = paletteItems(schemasOnly);
  const input = $('#palInput'), list = $('#palList');
  let shownItems = [], on = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shownItems = all.map(it => { const f = fuzzy(q, it.label); return { it, s: f ? f + (it.boost || 0) - (it.weak && !q ? 50 : 0) : 0 }; })
      .filter(x => q ? x.s > 0 : true).sort((a, b) => b.s - a.s).map(x => x.it).slice(0, q ? 60 : 40);
    on = Math.min(on, Math.max(0, shownItems.length - 1));
    list.innerHTML = shownItems.length ? shownItems.map((it, i) => `<div class="pal-item${i === on ? ' on' : ''}" data-i="${i}" role="option">${ic(it.icon)}<span>${esc(it.label)}</span><span class="pi-hint${it.schema ? ' schema' : ''}">${esc(it.hint || '')}</span></div>`).join('') : '<div class="side-empty" style="padding:12px">Nothing matches.</div>';
    const el = $('.pal-item.on', list);
    if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const go = i => { const it = shownItems[i]; if (!it) return; closeOverlay(); it.run(); };
  input.addEventListener('input', () => { on = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); on = Math.min(on + 1, shownItems.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); on = Math.max(on - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(on); }
  });
  list.addEventListener('click', e => { const it = e.target.closest('.pal-item'); if (it) go(+it.dataset.i); });
  $('[data-scrim]', ov).addEventListener('mousedown', e => { if (e.target === e.currentTarget) closeOverlay(); });
  draw();
  input.focus();
}

// The connection button lists every saved connection: click switches this window, ⌘-click opens a new one.
async function showConnMenu() {
  S.conns = await api.connections();
  const ov = $('#overlay');
  const r = $('#connBtn').getBoundingClientRect();
  const row = c => `<button class="menu-conn${c.id === S.conn.id ? ' current' : ''}" data-conn="${esc(c.id)}" title="${esc(connSub(c))} — ${MOD}click opens a new window">${avatar(c)}<span class="cc-text"><span class="cc-name">${esc(c.name)}</span><span class="cc-sub">${esc(connSub(c))}</span></span><span class="conn-dot" style="background:${esc(colorOf(c))}"></span></button>`;
  ov.innerHTML = `<div class="scrim" data-scrim style="background:transparent;animation:none"></div><div class="menu glass-strong" role="menu" style="top:${r.bottom + 8}px;left:${Math.max(16, Math.min(r.left, innerWidth - 330))}px">
    <div class="menu-label">Connections</div>
    ${S.conns.map(row).join('')}
    <div class="menu-sep"></div>
    <button class="menu-item" data-m="new" role="menuitem">${ic('plus')}<span>New connection…</span></button>
    <button class="menu-item" data-m="manage" role="menuitem">${ic('plug')}<span>Manage connections…</span><span class="mi-sub">${MOD}⇧K</span></button>
    <button class="menu-item" data-m="window" role="menuitem">${ic('window')}<span>Open ${esc(S.conn.name)} in a new window</span><span class="mi-sub">${MOD}N</span></button>
    <button class="menu-item" data-m="open" role="menuitem">${ic('folder')}<span>Open a SQLite file…</span><span class="mi-sub">${MOD}⇧O</span></button>
    ${S.conn.demo ? `<button class="menu-item" data-m="reset" role="menuitem">${ic('trellis')}<span>Reset the example database</span></button>` : ''}
    <div class="menu-note">${esc(S.info.engine)} ${esc(S.info.version)}${S.info.user ? ` · signed in as ${esc(S.info.user)}` : ''}<br>${esc(S.conn.engine === 'sqlite' ? S.conn.file : connSub(S.conn))}</div>
  </div>`;
  $('[data-scrim]', ov).addEventListener('mousedown', closeOverlay);
  $$('[data-conn]', ov).forEach(b => b.addEventListener('click', e => {
    closeOverlay();
    const id = b.dataset.conn;
    if (e.metaKey || e.ctrlKey) return api.newWindow(id);
    if (id !== S.conn.id) connectTo(id);
  }));
  $$('[data-m]', ov).forEach(b => b.addEventListener('click', async () => {
    closeOverlay();
    const m = b.dataset.m;
    if (m === 'new') openManager(true);
    else if (m === 'manage') openManager();
    else if (m === 'window') api.newWindow(S.conn.id);
    else if (m === 'open') openSqliteFile();
    else if (m === 'reset') guardPending(async () => { await api.resetDemo(); await connectTo(S.conn.id, true); toast('Example database rebuilt'); });
  }));
}

async function guardPending(fn) {
  const n = totalPending(), files = S.tabs.filter(isDirty).length;
  if (!n && !files) return fn();
  const what = [n ? plural(n, 'uncommitted change') : '', files ? plural(files, 'unsaved query file') : ''].filter(Boolean).join(' and ');
  showModal({ title: `Drop ${what}?`, text: 'Leaving this database closes every tab.', actions: [{ label: 'Cancel' }, { label: 'Leave anyway', cls: 'danger', primary: true, run: async () => { S.tabs.forEach(t => { discard(t, true); if (t.kind === 'query') t.saved = t.sql; }); await fn(); } }] });
}

async function openSqliteFile() {
  const file = await api.openFile().catch(e => { toast(e.message, true); return null; });
  if (!file) return;
  const go = async () => {
    const conns = await api.connections();
    let conn = conns.find(c => c.engine === 'sqlite' && c.file === file);
    if (!conn) conn = await api.saveConnection({ name: file.split('/').pop().replace(/\.(sqlite3?|db3?|s3db)$/i, ''), engine: 'sqlite', env: 'local', file });
    await connectTo(conn.id, true);
  };
  if (S.conn) guardPending(go); else go();
}

function toggleInspector() {
  S.inspector = !S.inspector;
  store.set('inspector', S.inspector);
  renderToolbar();
  renderInspector();
}

/* ---------- events ---------- */
function wireWorkspace() {
  $('#connBtn').onclick = () => (S.conn ? showConnMenu() : showOpenConnection());
  $('#newQueryBtn').onclick = () => newQueryTab();
  $('#refreshBtn').onclick = refresh;
  $('#searchTrigger').onclick = showPalette;
  $('#inspectorBtn').onclick = toggleInspector;
  $('#discardBtn').onclick = () => discard();
  $('#reviewBtn').onclick = reviewChanges;

  $('#tableFilter').addEventListener('input', e => { S.filter = e.target.value; renderSide(); });
  $('#sidePanes').addEventListener('click', e => {
    const b = e.target.closest('[data-pane]');
    if (b) setPane(b.dataset.pane);
  });
  $('#sideList').addEventListener('click', e => {
    const o = e.target.closest('[data-ref]');
    if (o) return openTable(JSON.parse(o.dataset.ref));
    const q = e.target.closest('[data-query]');
    if (q) return openSavedQuery(q.dataset.query);
    const h = e.target.closest('[data-hist]');
    if (h) {
      const it = S.history[+h.dataset.hist];
      if (!it) return;
      // An empty query tab takes the query; otherwise it opens in a new one.
      const tab = cur();
      if (tab && tab.kind === 'query' && !tab.sql.trim() && !tab.file) { tab.sql = it.sql; renderBody(); focusEditor(); }
      else newQueryTab(it.sql);
    }
  });
  $('#sideList').addEventListener('contextmenu', e => {
    const q = e.target.closest('[data-query]');
    if (q) { e.preventDefault(); api.reveal(q.dataset.query).catch(err => toast(err.message, true)); }
  });
  $('#sideFoot').addEventListener('click', e => {
    if (e.target.closest('#schemaPick')) return showPalette(true);
    const b = e.target.closest('[data-side]');
    if (!b) return;
    const a = b.dataset.side;
    if (a === 'open-sql') openSqlFiles();
    else if (a === 'new-query') newQueryTab();
    else if (a === 'clear-history') showModal({
      title: `Clear ${plural(S.history.length, 'query', )} from the history?`, text: `The history of ${S.conn.name} is emptied. Saved query files are not touched.`,
      actions: [{ label: 'Cancel' }, { label: 'Clear history', cls: 'danger', primary: true, run: () => { S.history = []; store.set('history:' + S.conn.id, []); renderSide(); } }],
    });
  });

  $('#tabs').addEventListener('click', e => {
    const x = e.target.closest('[data-close]');
    if (x) { e.stopPropagation(); return closeTab(+x.dataset.close); }
    if (e.target.closest('[data-act="new-query"]')) return newQueryTab();
    const t = e.target.closest('[data-tab]');
    if (t) activate(+t.dataset.tab);
  });
  $('#tabs').addEventListener('auxclick', e => { const t = e.target.closest('[data-tab]'); if (t && e.button === 1) closeTab(+t.dataset.tab); });

  const body = $('#tabBody');
  body.addEventListener('click', async e => {
    const tab = cur();
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'new-query') return S.conn && newQueryTab();
      if (a === 'open-connection') return showOpenConnection();
      if (a === 'new-connection') return showConnForm(blankForm());
      if (!tab) return;
      if (a === 'run') return runActive();
      if (a === 'add-row') return addRow();
      if (a === 'del-row') return toggleDelete();
      if (a === 'page-prev' || a === 'page-next') {
        tab.page += a === 'page-next' ? 1 : -1;
        tab.sel = null;
        await reloadTab(tab);
        const w = $('#tabBody .grid-wrap'); if (w) w.scrollTop = 0;
        return;
      }
      if (a === 'filter-add') { readFilters(tab); tab.filters.push({ col: '*', op: 'contains', val: '' }); renderFilters(tab); return; }
      if (a === 'filter-rm') { readFilters(tab); tab.filters.splice(+act.dataset.fi, 1); renderFilters(tab); return applyFilters(tab); }
      if (a === 'filter-apply') return applyFilters(tab);
      if (a === 'filter-clear') { tab.filters = [{ col: '*', op: 'contains', val: '' }]; renderFilters(tab); return applyFilters(tab, false); }
      if (a === 'copy-ddl') return copy(tab.structure?.ddl || '', 'Definition copied');
      if (a === 'copy-csv') {
        if (!tab.model) return toast('Run a query first', true);
        const csv = [tab.model.cols.map(c => csvCell(c.name)).join(','), ...tab.model.rows.map(r => r.vals.map(csvCell).join(','))].join('\n');
        return copy(csv, `Copied ${plural(tab.model.rows.length, 'row')} as CSV`);
      }
    }
    const v = e.target.closest('[data-view]');
    if (v && tab) return setView(v.dataset.view);
    const th = e.target.closest('th[data-ci]');
    if (th && tab && !resizing && !e.target.closest('.rz')) {
      const ci = +th.dataset.ci;
      tab.sort = !tab.sort || tab.sort.ci !== ci ? { ci, dir: 'ASC' } : tab.sort.dir === 'ASC' ? { ci, dir: 'DESC' } : null;
      tab.sel = null;
      if (tab.kind === 'table') await reloadTab(tab); else refreshGrid();
      return;
    }
    const td = e.target.closest('td[data-c]');
    if (td && tab && !td.classList.contains('editing')) {
      selectCell(+td.parentElement.dataset.r, +td.dataset.c, false);
      focusGrid();
    }
  });
  body.addEventListener('dblclick', e => {
    const td = e.target.closest('td[data-c]');
    if (td && !td.classList.contains('editing')) startEdit(+td.parentElement.dataset.r, +td.dataset.c);
  });
  body.addEventListener('pointerdown', e => {
    const rz = e.target.closest('.rz');
    if (rz) return startResize(e, +rz.dataset.rz);
    const hs = e.target.closest('.hsplit');
    if (hs) {
      e.preventDefault();
      const tab = cur(), ed = $('.q-editor', body), y0 = e.clientY, h0 = tab.editorH;
      hs.classList.add('drag');
      const max = body.clientHeight - 120;
      const move = ev => { tab.editorH = Math.max(80, Math.min(max, h0 + ev.clientY - y0)); ed.style.height = tab.editorH + 'px'; };
      const up = () => { hs.classList.remove('drag'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    }
  });
  body.addEventListener('keydown', e => {
    if (e.target.classList.contains('grid-wrap')) return onGridKey(e);
    if (e.target.classList.contains('fval') && e.key === 'Enter') { e.preventDefault(); applyFilters(cur()); }
  });
  body.addEventListener('change', async e => {
    const tab = cur();
    if (e.target.dataset.act === 'limit') { tab.limit = +e.target.value; tab.page = 0; await reloadTab(tab); return; }
    if (e.target.dataset.f) {
      readFilters(tab);
      if (e.target.dataset.f === 'op') { renderFilters(tab); if (['null', 'notnull'].includes(e.target.value)) applyFilters(tab); }
    }
  });
  body.addEventListener('input', e => { if (e.target.dataset.f === 'val') readFilters(cur()); });

  const insp = $('#inspector');
  insp.addEventListener('change', e => {
    const ta = e.target.closest('textarea[data-c]');
    const tab = cur();
    if (!ta || !isEditable(tab) || !tab.sel) return;
    const ci = +ta.dataset.c;
    if (ta.dataset.null === '1' && ta.value === '') return;
    stageEdit(tab, tab.sel.r, ci, coerce(ta.value, tab.cols[ci]));
    ta.dataset.null = '0';
    ta.classList.remove('is-null');
    refreshGrid({ inspector: false });
    const row = tab.model.rows[tab.sel.r];
    ta.closest('.field').classList.toggle('edited', !!(row && row.edited && row.edited.has(ci)));
    if (tab.sel) selectCell(tab.sel.r, tab.sel.c, false);
  });
  insp.addEventListener('click', e => {
    const tab = cur();
    const n = e.target.closest('[data-setnull]');
    if (n && isEditable(tab) && tab.sel) { stageEdit(tab, tab.sel.r, +n.dataset.setnull, null); refreshGrid(); return; }
    const a = e.target.closest('[data-act]');
    if (!a || !tab || !tab.sel || !tab.model) return;
    const row = tab.model.rows[tab.sel.r];
    const obj = Object.fromEntries(tab.model.cols.map((c, i) => [c.name, blobLen(row.vals[i]) !== null ? shown(row.vals[i]) : row.vals[i]]));
    if (a.dataset.act === 'copy-json') copy(JSON.stringify(obj, null, 2), 'Row copied as JSON');
    if (a.dataset.act === 'copy-insert') copy(`INSERT INTO ${tab.ref.schema ? qid(tab.ref.schema) + '.' : ''}${qid(tab.ref.name)} (${tab.cols.map(c => qid(c.name)).join(', ')}) VALUES (${row.vals.map(sqlLit).join(', ')});`, 'Row copied as INSERT');
  });

  // ⌘C on a selected cell copies its value; everywhere else the system copy runs.
  document.addEventListener('copy', e => {
    const tab = cur();
    if (!inWorkspace() || !tab || !tab.sel || !tab.model || document.activeElement !== $('#tabBody .grid-wrap')) return;
    const row = tab.model.rows[tab.sel.r];
    if (!row) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', shown(row.vals[tab.sel.c]));
    toast('Cell copied');
  });
}

function setPane(pane) {
  if (S.pane !== pane) { S.pane = pane; S.filter = ''; $('#tableFilter').value = ''; }
  if (!S.sidebar) { S.sidebar = true; renderToolbar(); }
  renderSide();
}

function setView(view) {
  const tab = cur();
  if (!tab || tab.kind !== 'table' || tab.view === view) return;
  tab.view = view;
  renderBody(); renderInspector(); renderStatus();
}

async function refresh() {
  try { await loadSchema(); } catch (e) { toast(e.message, true); }
  await Promise.all(S.tabs.filter(t => t.kind === 'table').map(t => { t.structure = null; return loadTable(t); }));
  renderAll();
  toast('Refreshed');
}

function readFilters(tab) {
  if (!tab || tab.kind !== 'table') return;
  $$('#filterbar .frow').forEach(row => {
    const i = +row.dataset.fi;
    tab.filters[i] = { col: $('[data-f="col"]', row).value, op: $('[data-f="op"]', row).value, val: $('[data-f="val"]', row).value };
  });
}

async function applyFilters(tab, read = true) {
  if (read) readFilters(tab);
  tab.applied = tab.filters.filter(f => f.op === 'null' || f.op === 'notnull' || f.val !== '').map(f => ({ ...f }));
  tab.page = 0;
  tab.sel = null;
  await loadTable(tab);
  if (cur() !== tab) return;
  renderFilters(tab);
  refreshGrid();
}

function onMenu(action) {
  if (overlayOpen()) {
    if (action === 'run' && modalPrimary) modalPrimary();
    return;
  }
  if (action === 'connections') return showOpenConnection();
  if (action === 'new-connection') return showConnForm(blankForm());
  if (action === 'open-file') return openSqliteFile();
  if (!S.conn) return;
  const tab = cur();
  switch (action) {
    case 'new-query': return newQueryTab();
    case 'open-sql': return openSqlFiles();
    case 'save': return tab && tab.kind === 'query' ? saveQuery(false) : pendingCount(tab) ? reviewChanges() : toast('Nothing to save');
    case 'save-as': return tab && tab.kind === 'query' ? saveQuery(true) : toast('Save As works on a query tab');
    case 'palette': return showPalette();
    case 'schemas': return showPalette(true);
    case 'run': return runActive();
    case 'commit': return reviewChanges();
    case 'discard': return discard();
    case 'add-row': return addRow();
    case 'refresh': return refresh();
    case 'inspector': return toggleInspector();
    case 'sidebar': S.sidebar = !S.sidebar; return renderToolbar();
    case 'pane-items': return setPane('items');
    case 'pane-queries': return setPane('queries');
    case 'pane-history': return setPane('history');
    case 'view-data': return setView('data');
    case 'view-structure': return setView('structure');
    case 'close-tab': return tab ? closeTab(tab.id) : window.close();
    case 'filter': {
      const f = tab && tab.kind === 'table' && tab.view === 'data' ? $('#filterbar .fval:not([disabled])') : $('#tableFilter');
      if (f) { f.focus(); f.select(); }
    }
  }
}


/* ================================================================
   Welcome window
   ================================================================ */
const W = { list: [], on: 0, selId: null };

async function renderWelcome(selectId) {
  S.conns = await api.connections();
  const f = $('#wlFilter').value.trim().toLowerCase();
  W.list = S.conns.filter(c => !f || `${c.name} ${connSub(c)} ${c.env}`.toLowerCase().includes(f));
  const want = selectId || W.selId || store.get('lastConn');
  const i = W.list.findIndex(c => c.id === want);
  W.on = i >= 0 ? i : Math.min(W.on, Math.max(0, W.list.length - 1));
  drawWelcome();
}

function drawWelcome() {
  const list = $('#wlList');
  W.selId = W.list[W.on] && W.list[W.on].id;
  list.innerHTML = W.list.length ? W.list.map((c, i) => `
    <div class="oc-row wl-row${i === W.on ? ' on' : ''}" data-i="${i}" role="option" aria-selected="${i === W.on}">
      ${avatar(c)}
      <span class="cc-text"><span class="cc-name">${esc(c.name || 'Untitled')} ${envPill(c)}</span><span class="cc-sub">${esc(connSub(c))}</span></span>
      <button class="icon-btn oc-edit" data-edit="${i}" title="Edit connection" aria-label="Edit ${esc(c.name)}">${ic('pencil')}</button>
    </div>`).join('')
    : `<div class="oc-empty">${S.conns.length ? 'No connection matches.' : 'No connections yet.<br>Press + to add one.'}</div>`;
  const el = $('.wl-row.on', list);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function welcomeMenu(e, i) {
  const c = W.list[i];
  if (!c) return;
  W.on = i; drawWelcome();
  const ov = $('#overlay');
  ov.innerHTML = `<div class="scrim" data-scrim style="background:transparent;animation:none;backdrop-filter:none;-webkit-backdrop-filter:none"></div><div class="menu glass-strong" role="menu" style="min-width:200px;top:${Math.min(e.clientY, innerHeight - 170)}px;left:${Math.min(e.clientX, innerWidth - 220)}px">
    <button class="menu-item" data-m="open">${ic('plug')}<span>Open</span><span class="mi-sub">↵</span></button>
    <button class="menu-item" data-m="edit">${ic('pencil')}<span>Edit…</span></button>
    <button class="menu-item" data-m="copy">${ic('copy')}<span>Duplicate</span></button>
    <div class="menu-sep"></div>
    <button class="menu-item danger" data-m="delete">${ic('trash')}<span>Delete…</span></button>
  </div>`;
  $('[data-scrim]', ov).addEventListener('mousedown', closeOverlay);
  $$('[data-m]', ov).forEach(b => b.addEventListener('click', async () => {
    closeOverlay();
    const m = b.dataset.m;
    if (m === 'open') connectTo(c.id);
    else if (m === 'edit') showConnForm({ ...c });
    else if (m === 'copy') { const { id, hasPassword, ...rest } = c; const saved = await api.saveConnection({ ...rest, name: `${c.name} copy` }); renderWelcome(saved.id); toast('Duplicated without the password'); }
    else showModal({
      title: `Delete “${c.name}”?`, text: 'The saved connection and its Keychain password are removed. The database itself is not touched.',
      actions: [{ label: 'Cancel' }, { label: 'Delete', cls: 'danger', primary: true, run: async () => { await api.deleteConnection(c.id); renderWelcome(); toast('Connection deleted'); } }],
    });
  }));
}

async function wireWelcome() {
  const about = await api.about().catch(() => null);
  if (about) {
    $('#wlVersion').textContent = `Version ${about.version}`;
    $('#wlDev').textContent = `© ${about.year} ${(about.developer || '').split(':')[0]} · ${about.license} License`;
  }
  const open = () => { const c = W.list[W.on]; if (c) connectTo(c.id); };
  $('#wlFilter').addEventListener('input', () => { W.on = 0; W.selId = null; renderWelcome(); });
  $('#wlFilter').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); W.on = Math.min(W.on + 1, W.list.length - 1); drawWelcome(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); W.on = Math.max(W.on - 1, 0); drawWelcome(); }
    else if (e.key === 'Enter') { e.preventDefault(); open(); }
  });
  const list = $('#wlList');
  list.addEventListener('click', e => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { const c = W.list[+ed.dataset.edit]; if (c) showConnForm({ ...c }); return; }
    const r = e.target.closest('.wl-row');
    if (!r) return;
    W.on = +r.dataset.i;
    W.selId = W.list[W.on] && W.list[W.on].id;
    if (e.detail >= 2) open(); else markRow(list, W.on);
  });
  list.addEventListener('contextmenu', e => { const r = e.target.closest('.wl-row'); if (r) { e.preventDefault(); welcomeMenu(e, +r.dataset.i); } });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-wl]');
    if (!b) return;
    if (b.dataset.wl === 'new') showConnForm(blankForm());
    else if (b.dataset.wl === 'sqlite') openSqliteFile();
  });
  // Arrows and Enter work without clicking the search field first, and typing goes into it.
  document.addEventListener('keydown', e => {
    if (overlayOpen() || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') { e.preventDefault(); $('#wlFilter').focus(); $('#wlFilter').dispatchEvent(new KeyboardEvent('keydown', { key: e.key })); }
    else if (e.key.length === 1) $('#wlFilter').focus();
  });
  await renderWelcome();
  $('#wlFilter').focus();
}

/* ---------- boot ---------- */
async function boot() {
  const info = await api.info().catch(() => ({ platform: 'web' }));
  if (info.platform === 'darwin') document.documentElement.classList.add('mac');
  if (info.platform === 'darwin' && info.vibrancy) document.documentElement.classList.add('vibrant');
  fillIcons();
  if (api.placeLights) api.placeLights();
  if (WELCOME) {
    api.onMenu(action => {
      if (overlayOpen()) { if (action === 'run' && modalPrimary) modalPrimary(); return; }
      if (action === 'new-connection') showConnForm(blankForm());
      else if (action === 'open-file') openSqliteFile();
      else if (action === 'connections' || action === 'palette') $('#wlFilter').focus();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlayOpen()) { e.preventDefault(); closeOverlay(); } });
    await wireWelcome();
    window.__trellis = { S, W, connectTo, renderWelcome, showConnForm, blankForm };
    if (info.selftest) { const sc = document.createElement('script'); sc.src = 'selftest.js'; document.body.appendChild(sc); }
    return;
  }
  wireWorkspace();
  api.onMenu(onMenu);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlayOpen()) { e.preventDefault(); closeOverlay(); }
  });
  window.addEventListener('beforeunload', e => { if (!api.onCloseRequested && unsavedCount()) { e.preventDefault(); e.returnValue = false; } });
  if (api.onCloseRequested) api.onCloseRequested(() => unsavedCount() > 0, () => {
    const n = totalPending(), files = S.tabs.filter(isDirty).length;
    const what = [n ? plural(n, 'uncommitted change') : '', files ? plural(files, 'unsaved query file') : ''].filter(Boolean).join(' and ');
    showModal({ title: `Close with ${what}?`, text: 'Closing the window drops them.', actions: [{ label: 'Cancel' }, { label: 'Close window', cls: 'danger', primary: true, run: () => api.closeWindow() }] });
  });
  // ⌘K opens the same palette as ⌘P.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k' && !overlayOpen()) { e.preventDefault(); showPalette(); }
  });
  renderDisconnected();
  const connect = (api.connectOnOpen && api.connectOnOpen()) || new URLSearchParams(location.search).get('connect');
  if (connect) await connectTo(connect);
  else await showOpenConnection();
  if (info.selftest) { const sc = document.createElement('script'); sc.src = 'selftest.js'; document.body.appendChild(sc); }
  window.__trellis = { S, connectTo, openTable, newQueryTab, runActive, reviewChanges, showPalette, selectCell, startEdit, stageEdit, refreshGrid, cur, setSchema, setPane, saveQuery, openQueryText, openManager, showConnMenu, showOpenConnection, showConnForm, blankForm };
}

boot();
})();
