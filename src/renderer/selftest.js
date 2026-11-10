// Loaded only when Trellis starts with TRELLIS_SELFTEST=<dir>: drives this window through the main flows
// and writes one line per step to <dir>/log.txt, then quits. Postgres and MySQL come from the test containers.
(async () => {
  const $ = s => document.querySelector(s);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const T = window.__trellis;
  const step = async (name, fn) => {
    try { await trellis.selftestLog(`${name}: ${JSON.stringify(await fn())}`); }
    catch (e) { await trellis.selftestLog(`${name}: FAILED ${e && e.message ? e.message : e}`); }
  };
  window.addEventListener('error', e => trellis.selftestLog(`console: ${e.message}`));
  window.addEventListener('unhandledrejection', e => trellis.selftestLog(`console: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
  await sleep(600);

  // The window buttons must sit on the toolbar's middle line, after every event that makes AppKit move them.
  const lights = async label => {
    await sleep(350);
    const d = await trellis.debugLights();
    const bar = $('.toolbar').getBoundingClientRect();
    const mid = bar.top + bar.height / 2;
    const off = d.centers.map(([, y]) => Math.round((y - mid) * 10) / 10);
    const ok = d.centers.length === 3 && off.every(o => Math.abs(o) <= 1) && d.centers[2][0] + 7 < bar.left + 94;
    await trellis.selftestLog(`lights ${label}: ${ok ? 'OK' : 'OFF'} toolbar middle ${mid}, buttons ${JSON.stringify(d.centers.map(([x, y]) => [Math.round(x), Math.round(y * 10) / 10]))}, off by ${JSON.stringify(off)}`);
  };
  await lights('at launch');
  await trellis.selftestResize(1200, 780); await lights('after resize');
  await trellis.selftestResize(1440, 900); await lights('after resize back');
  await T.connectTo('example'); await lights('after connect (title change)');
  await trellis.disconnect(); await lights('after disconnect');
  if ((await trellis.selftestOnly()) === 'lights') { await trellis.selftestLog('done'); await trellis.selftestDone(); return; }

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
