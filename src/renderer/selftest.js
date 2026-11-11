// Loaded only when Trellis starts with TRELLIS_SELFTEST=<dir>: drives this window through the main flows
// and writes one line per step to <dir>/log.txt, then quits. Postgres and MySQL come from the test containers.
(async () => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const T = window.__trellis;
  const step = async (name, fn) => {
    try { await trellis.selftestLog(`${name}: ${JSON.stringify(await fn())}`); }
    catch (e) { await trellis.selftestLog(`${name}: FAILED ${e && e.message ? e.message : e}`); }
  };
  window.addEventListener('error', e => trellis.selftestLog(`console: ${e.message}`));
  window.addEventListener('unhandledrejection', e => trellis.selftestLog(`console: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
  await sleep(600);

  // The window buttons must sit on the middle line of the bar beside them, after every event that makes AppKit move them.
  const lights = async (label, barSel = '.toolbar') => {
    await sleep(350);
    const d = await trellis.debugLights();
    const bar = $(barSel).getBoundingClientRect();
    const mid = bar.top + bar.height / 2;
    const off = d.centers.map(([, y]) => Math.round((y - mid) * 10) / 10);
    const count = d.onlyClose ? 1 : 3;
    const ok = d.centers.length === count && off.every(o => Math.abs(o) <= 1) && (!d.onlyClose || Math.abs(d.centers[0][0] - d.centers[0][1]) <= 1);
    await trellis.selftestLog(`lights ${label}: ${ok ? 'OK' : 'OFF'} bar middle ${mid}, buttons ${JSON.stringify(d.centers.map(([x, y]) => [Math.round(x), Math.round(y * 10) / 10]))}, off by ${JSON.stringify(off)}`);
  };
  const phase = (v) => { try { if (v === undefined) return localStorage.getItem('trellis:selftest-phase'); localStorage.setItem('trellis:selftest-phase', v); } catch { return null; } };

  // Welcome window: the launch window. It hands the chosen connection to a new workspace window and closes.
  if (document.body.dataset.page === 'welcome') {
    if (phase() === 'reopen') {
      await trellis.selftestLog(`welcome back after the last workspace closed: ${JSON.stringify(await trellis.debugWindows())}`);
      phase('');
      await trellis.selftestLog('done');
      return trellis.selftestDone();
    }
    phase('');
    await step('welcome lists connections', async () => [...document.querySelectorAll('.wl-row .cc-name')].map(x => x.innerText.replace(/\s+/g, ' ')));
    await step('welcome shows the build', async () => [$('#wlVersion').textContent, $('#wlDev').textContent]);
    await step('welcome offers an update', async () => {
      // The real check is off in test builds; a pretend release shows where the button goes.
      const real = trellis.updateCheck;
      trellis.updateCheck = async () => ({ version: '9.9.9', current: '0.0.0', notes: '', windows: 0 });
      await T.offerUpdate(); trellis.updateCheck = real;
      const b = $('#wlUpdate'), r = b.getBoundingClientRect(), side = $('.wl-side').getBoundingClientRect();
      const ok = !b.hidden && b.textContent === 'Update to 9.9.9' && r.left >= side.left && r.right <= side.right && r.height > 20;
      b.hidden = true;
      return { ok, text: b.textContent, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    });
    // In the short welcome window a form's buttons must sit fully inside it, and its fields must scroll.
    const formFits = async () => {
      await sleep(250);
      const sheet = $('.sheet').getBoundingClientRect(), save = $('[data-cf="save"]').getBoundingClientRect(), body = $('.sheet-body');
      const inside = save.top >= sheet.top && save.bottom <= sheet.bottom - 4 && sheet.bottom <= innerHeight;
      const scrolls = body.scrollHeight <= body.clientHeight || (body.scrollTop = 999, body.scrollTop > 0);
      const title = $('.sheet-title').textContent;
      $('[data-cf="cancel"]').click();
      return { title, buttonsInside: inside, fieldsScroll: scrolls, ok: inside && scrolls };
    };
    await step('new connection form', async () => { $('.wl-action[data-wl="new"]').click(); return formFits(); });
    await step('sqlite connection form', async () => { const i = T.W.list.findIndex(c => c.engine === 'sqlite'); $$('.wl-row [data-edit]')[i].click(); return formFits(); });
    await lights('welcome', '.wl-bar');
    await trellis.selftestLog(`windows at launch: ${JSON.stringify(await trellis.debugWindows())}`);
    await step('double click opens a connection', async () => {
      const row = $$('.wl-row')[T.W.list.findIndex(c => c.id === 'example')];
      const click = detail => row.querySelector('.cc-name').dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
      click(1); click(2);
      await sleep(400);
      return { stillHere: document.body.dataset.page, windows: await trellis.debugWindows() };
    });
    return;
  }

  // Workspace window, opened from the welcome window with the example connection.
  for (let i = 0; i < 50 && !T.S.conn; i++) await sleep(100);
  await sleep(300);
  await trellis.selftestLog(`workspace opened on ${T.S.conn && T.S.conn.name}: ${JSON.stringify(await trellis.debugWindows())}`);

  // A large result keeps only the rows near the view in the page, and scrolling, selecting and the last row still work.
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  const bigGrid = async () => {
    await step('large result', async () => {
      T.newQueryTab("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) SELECT i, 'row ' || i AS label, i * 1.5 AS v, printf('%040d', i) AS pad FROM n");
      T.runActive();
      for (let i = 0; i < 50 && !(T.cur().result); i++) await sleep(100);
      await sleep(200);
      const w = $('#tabBody .grid-wrap');
      const rows = () => $$('#tabBody .grid tbody tr[data-r]');
      const drawn = rows().length;
      const firstShown = () => { const top = w.getBoundingClientRect().top + 31; const tr = rows().find(r => r.getBoundingClientRect().bottom > top); return tr && tr.querySelector('td[data-c="1"]').textContent; };
      w.scrollTop = w.scrollHeight / 2; await frame(); await frame();
      const middle = firstShown();
      const t0 = performance.now(); let worst = 0;
      for (let k = 0; k < 120; k++) { const t = performance.now(); w.scrollTop += 700; await frame(); worst = Math.max(worst, performance.now() - t); }
      const perFrame = Math.round((performance.now() - t0) / 120 * 10) / 10;
      w.scrollTop = w.scrollHeight; await frame(); await frame();
      const last = rows().pop().querySelector('td[data-c="1"]').textContent;
      T.selectCell(0, 1); await frame();
      const top = { scrollTop: w.scrollTop, cur: $('#tabBody td.cur') && $('#tabBody td.cur').textContent };
      T.selectCell(14999, 2); await frame();
      const jump = $('#tabBody td.cur') && $('#tabBody td.cur').parentElement.querySelector('td[data-c="1"]').textContent;
      const ok = drawn < 150 && /row 1\d{4}/.test(middle) && last === 'row 20000' && top.cur === 'row 1' && jump === 'row 15000';
      return { ok, drawn, total: T.cur().result.values.length, rowHeight: rows()[0].getBoundingClientRect().height, middle, last, top, jump, msPerScrollFrame: perFrame, worstFrame: Math.round(worst) };
    });
  };
  // JSON reads as coloured JSON in the grid and opens up indented in the inspector, and so do Postgres arrays (shown
  // here by letting the SQLite result pass for a Postgres one).
  const jsonCells = async () => {
    await step('json and arrays', async () => {
      const engine = T.S.info.engine;
      T.S.info.engine = 'PostgreSQL';
      T.newQueryTab(`SELECT json_object('id', 7, 'tags', json_array('a', 'b'), 'ok', json('true'), 'none', json('null')) AS doc, '{1,2,"a b",NULL}' AS arr, 'plain' AS t`);
      T.runActive();
      for (let i = 0; i < 50 && !(T.cur().result); i++) await sleep(100);
      await sleep(200);
      if ($('#inspector').hidden) $('#inspectorBtn').click();
      T.cur().sel = null; T.selectCell(0, 0); await sleep(200);
      const tds = $$('#tabBody .grid tbody td[data-c]');
      const codes = $$('#inspector .f-code');
      const aligned = codes.map(c => { const [pre, ta] = c.children; return Math.abs(pre.getBoundingClientRect().height - ta.getBoundingClientRect().height) <= 1 && ta.scrollHeight <= ta.clientHeight + 1; });
      const types = $$('#inspector .f-type').map(x => x.textContent);
      T.S.info.engine = engine;
      const r = {
        grid: tds.map(td => td.className + ': ' + td.textContent),
        keys: tds[0].querySelectorAll('.j-key').length, tags: tds[1].querySelectorAll('.a-item').length,
        inspector: codes.map(c => c.querySelector('textarea').value), types, aligned, hidden: $('#inspector').hidden, html: codes.length ? undefined : $('#inspector').innerText.slice(0, 200),
      };
      r.ok = r.keys === 4 && r.tags === 4 && codes.length === 2 && aligned.every(Boolean) && r.inspector[1] === '{\n  1,\n  2,\n  "a b",\n  NULL\n}';
      return r;
    });
  };
  // A long query stops on ⌘. (or the Stop button) and a huge result keeps its first 50,000 rows.
  const stopAndCap = async () => {
    await step('stop a running query', async () => {
      T.newQueryTab('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n');
      T.runActive();
      await sleep(400);
      const button = $('#runBtn').textContent;
      const t0 = performance.now();
      T.stopQuery(T.cur());
      for (let i = 0; i < 100 && T.cur().running; i++) await sleep(50);
      const r = { button, running: T.cur().running, msg: $('#qmsg').textContent, error: T.cur().error, ms: Math.round(performance.now() - t0), after: $('#runBtn').textContent };
      r.ok = /Stop/.test(button) && !r.running && r.msg === 'Stopped' && !r.error && /Run/.test(r.after);
      return r;
    });
    await step('run the statement at the caret', async () => {
      T.newQueryTab('SELECT 1 AS first;\n\nSELECT 2 AS second;');
      await sleep(100);
      const ta = $('#tabBody textarea.sql-input');
      const run = async (pos, all) => {
        ta.focus(); ta.setSelectionRange(pos, pos); ta.dispatchEvent(new KeyboardEvent('keyup'));
        const label = $('#runLbl').textContent, band = !$('.stmt-band').hidden;
        T.cur().result = null; T.runActive(all);
        for (let i = 0; i < 50 && !T.cur().result; i++) await sleep(50);
        return { label, band, col: T.cur().result && T.cur().result.columns[0] };
      };
      const r = { line1: await run(3), line3: await run(22), all: await run(3, true) };
      r.ok = r.line1.col === 'first' && r.line3.col === 'second' && r.line1.label === 'Run statement' && r.line1.band && r.all.col === 'second';
      return r;
    });
    await step('huge result is capped', async () => {
      T.newQueryTab('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60000) SELECT i FROM n');
      T.runActive();
      for (let i = 0; i < 100 && !T.cur().result; i++) await sleep(100);
      const r = { rows: T.cur().result && T.cur().result.values.length, msg: $('#qmsg').textContent };
      r.ok = r.rows === 50000 && /the first 50,000 only/.test(r.msg);
      return r;
    });
  };
  // Export writes whole tables in pieces and query results at once; the file dialog and the disk are stood in for.
  const exports = async () => {
    await step('export a table and a result', async () => {
      const real = { path: trellis.exportPath, write: trellis.writeExport };
      const files = {};
      trellis.exportPath = async (name, ext) => `/tmp/${name}.${ext}`;
      trellis.writeExport = async (path, text, append) => { files[path] = (append ? files[path] || '' : '') + text; };
      try {
        await T.openTable({ name: 'players' }); await sleep(400);
        const total = T.cur().total;
        for (const f of ['csv', 'json', 'sql']) await T.exportTab(T.cur(), f);
        T.newQueryTab("SELECT 1 AS n, 'a,b' AS s, json_object('k', 1) AS j, 1.23456789 AS x"); T.runActive();
        for (let i = 0; i < 50 && !T.cur().result; i++) await sleep(100);
        await T.exportTab(T.cur(), 'csv'); await T.exportTab(T.cur(), 'json');
        const csv = files['/tmp/players.csv'].trimEnd().split('\n'), json = JSON.parse(files['/tmp/players.json']);
        const sql = files['/tmp/players.sql'].trimEnd().split('\n');
        const q = T.cur().name;
        const r = { total, csvLines: csv.length, header: csv[0].slice(0, 60), json: json.length, sql: sql.length, sqlFirst: sql[0].slice(0, 80), qcsv: files[`/tmp/${q}.csv`], qjson: JSON.parse(files[`/tmp/${q}.json`]) };
        r.ok = csv.length === total + 1 && json.length === total && sql.length === total && /^INSERT INTO "players"/.test(sql[0])
          && r.qcsv === 'n,s,j,x\n1,"a,b","{""k"":1}",1.23456789\n' && r.qjson[0].j.k === 1 && r.qjson[0].x === 1.23456789;
        return r;
      } finally { trellis.exportPath = real.path; trellis.writeExport = real.write; }
    });
  };
  // How long the page takes to follow a window resize: from the new size until it has painted at that size.
  const resizeTiming = async () => {
    await step('resize follows the window', async () => {
      await T.openTable({ name: 'players' });
      await sleep(300);
      const times = [];
      for (let k = 0; k < 16; k++) {
        const w = k % 2 ? 1440 : 1100 + k * 10, h = k % 2 ? 900 : 700;
        const t = performance.now();
        const seen = new Promise(r => { const f = () => { removeEventListener('resize', f); r(); }; addEventListener('resize', f); setTimeout(f, 1000); });
        await trellis.selftestResize(w, h);
        await seen; await frame(); await frame();
        times.push(Math.round(performance.now() - t));
      }
      times.sort((x, y) => x - y);
      return { median: times[8], worst: times[15], all: times };
    });
  };
  await step('window may be dragged', async () => {
    try { await window.__TAURI_INTERNALS__.invoke('plugin:window|start_dragging'); return 'allowed'; }
    catch (e) { return /not allowed|denied/i.test(String(e)) ? `FAILED ${e}` : `allowed (${e})`; }
  });
  if ((await trellis.selftestOnly()) === 'grid') {
    await resizeTiming();
    await bigGrid();
    await jsonCells();
    await stopAndCap();
    await exports();
    await trellis.selftestLog('done');
    return trellis.selftestDone();
  }
  await lights('in the workspace');
  await trellis.selftestResize(1200, 780); await lights('after resize');
  await trellis.selftestResize(1440, 900); await lights('after resize back');
  await trellis.disconnect(); await T.connectTo('example'); await lights('after reconnect (title change)');
  if ((await trellis.selftestOnly()) === 'lights') {
    // Closing the only workspace brings the welcome window back; it finishes the test.
    phase('reopen');
    await trellis.closeWindow();
    return;
  }
  await T.showOpenConnection();

  await step('open connection sheet', async () => [...document.querySelectorAll('.oc-row .cc-name')].map(x => x.innerText.replace(/\s+/g, ' ')));
  await step('new form', async () => { $('[data-oc="new"]').click(); await sleep(100); return $('.sheet-title').textContent; });
  await step('back to list', async () => { $('[data-cf="back"]').click(); await sleep(150); return !!$('.oc-list'); });

  await step('connect example', async () => { await T.connectTo('example'); await sleep(500); return { tabs: T.S.tabs.map(t => t.name), tables: T.S.schema.tables.length, engine: T.S.info.engine + ' ' + T.S.info.version }; });
  await step('sample query ran', async () => $('[data-tab]') && T.S.tabs[0].msg.replace(/<[^>]+>/g, ''));
  await step('edit and delete', async () => {
    T.startEdit(2, 3);
    const i = $('.cell-input'); i.value = 'PL';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    T.selectCell(5, 1, false);
    $('[data-act=del-row]').click();
    return $('#pendingCount').textContent;
  });
  await step('review', async () => { await T.reviewChanges(); await sleep(150); return $('.modal-sql').textContent; });
  await step('commit fails and rolls back', async () => { $('.modal .btn.commit').click(); await sleep(400); return $('.modal-err').textContent; });
  await step('commit the edit only', async () => {
    $('[data-mi="1"]').click();
    $('[data-act=del-row]').click();
    await T.reviewChanges(); await sleep(150);
    $('.modal .btn.commit').click(); await sleep(500);
    return { pending: T.cur().pending.edits.size, country: T.cur().rows[2].vals[3] };
  });
  await bigGrid();
  await jsonCells();
  await stopAndCap();
  await exports();
  await step('blob cell', async () => { const t = T.newQueryTab("SELECT x'00ff' AS b, 9007199254740993 AS big, 1.5 AS f, NULL AS n"); T.runActive(); await sleep(300); return [...document.querySelectorAll('.grid tbody td')].map(td => td.textContent); });

  const pg = { name: 'Shop — staging', engine: 'postgres', env: 'staging', host: '127.0.0.1', port: 55432, user: 'postgres', password: 'strata', database: 'shop', sslMode: 'prefer' };
  const my = { name: 'Shop — MySQL prod', engine: 'mysql', env: 'production', host: '127.0.0.1', port: 53306, user: 'root', password: 'strata', database: 'shop', sslMode: 'prefer' };
  let ids = [];
  await step('save servers (Keychain)', async () => {
    const a = await trellis.saveConnection(pg), b = await trellis.saveConnection(my);
    ids = [a.id, b.id];
    return [a.hasPassword, b.hasPassword];
  });
  await step('test form with saved password', async () => { const i = await trellis.testConnection({ id: ids[0], host: '127.0.0.1' }); return `${i.engine} ${i.version} ${i.tls}`; });
  await step('connect postgres', async () => {
    T.S.tabs.forEach(t => { if (t.pending) t.pending = { edits: new Map(), deletes: new Map(), inserts: [] }; t.saved = t.sql; });
    await T.connectTo(ids[0], true); await sleep(300);
    await T.openTable({ schema: 'public', name: 'customers' });
    const tab = T.cur();
    return { total: tab.total, editable: tab.editable, err: tab.error, vip: tab.rows[6] && tab.rows[6].vals[3], schemas: T.S.schema.schemas };
  });
  await step('postgres structure', async () => { $('[data-view=structure]').click(); await sleep(500); return $('.structure') && $('.structure').innerText.slice(0, 80); });
  await step('switch schema to cjm', async () => {
    await T.setSchema('cjm'); await sleep(200);
    T.newQueryTab('SELECT count(*) FROM cj_event_types'); T.runActive(); await sleep(400);
    return { items: [...document.querySelectorAll('#sideList .side-item')].map(x => x.innerText.trim()), result: T.cur().msg.replace(/<[^>]+>/g, '') };
  });
  await step('palette across schemas', async () => {
    T.showPalette(); const p = $('#palInput'); p.value = 'cust'; p.dispatchEvent(new Event('input'));
    const r = [...document.querySelectorAll('.pal-item')].map(x => x.innerText.replace(/\s+/g, ' ')).slice(0, 3);
    document.querySelector('#overlay').innerHTML = ''; return r;
  });
  await step('connect mysql production', async () => {
    await T.connectTo(ids[1], true); await sleep(300);
    await T.openTable({ schema: 'shop', name: 'orders' });
    return { total: T.cur().total, rim: document.documentElement.classList.contains('env-production'), tls: T.S.info.tls };
  });
  await step('production asks before a write', async () => { T.newQueryTab('UPDATE orders SET total = total WHERE id = 1'); T.runActive(); await sleep(200); const h = $('.modal h2') && $('.modal h2').textContent; $('[data-mi="0"]').click(); return h; });
  await step('history pane', async () => { T.setPane('history'); return document.querySelectorAll('#sideList .side-item').length; });
  await step('connection menu', async () => { await T.showConnMenu(); const r = [...document.querySelectorAll('.menu-conn .cc-name')].map(x => x.textContent); document.querySelector('#overlay').innerHTML = ''; return r; });
  await step('delete test connections', async () => { for (const id of ids) await trellis.deleteConnection(id); return (await trellis.connections()).length; });
  await trellis.selftestLog('done');
  await trellis.selftestDone();
})();
