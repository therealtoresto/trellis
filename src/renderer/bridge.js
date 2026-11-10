// The window's door to the Rust side: every call returns the value or throws the database's own message.
(() => {
  const T = window.__TAURI__;
  if (!T || window.trellis) return;
  const { invoke } = T.core;
  const call = (cmd, args) => invoke(cmd, args).catch(e => { throw new Error(typeof e === 'string' ? e : e && e.message ? e.message : String(e)); });
  const win = T.window.getCurrentWindow();
  const webview = T.webviewWindow.getCurrentWebviewWindow();

  window.trellis = {
    connections: () => call('conns_list'),
    saveConnection: form => call('conns_save', { form }),
    deleteConnection: id => call('conns_delete', { id }),
    testConnection: form => call('conns_test', { form }),
    connect: id => call('db_connect', { id }),
    disconnect: () => call('db_disconnect'),
    objects: () => call('db_objects'),
    setSchema: schema => call('db_set_schema', { schema }),
    allColumns: () => call('db_all_columns'),
    structure: target => call('db_structure', { target }),
    page: (target, opts) => call('db_page', { target, opts }),
    query: sql => call('db_query', { sql }),
    preview: changes => call('db_preview', { changes }),
    apply: changes => call('db_apply', { changes }),
    resetDemo: () => call('demo_reset'),
    openFile: () => call('dialog_open_sqlite'),
    newFile: () => call('dialog_new_sqlite'),
    openSql: () => call('file_open_sql'),
    readSql: path => call('file_read_sql', { path }),
    saveSql: ({ file, text, name, saveAs }) => call('file_save_sql', { file: file || null, text, name: name || null, saveAs: !!saveAs }),
    reveal: path => call('file_reveal', { path }),
    newWindow: connectId => call('window_new', { connectId: connectId || null }),
    copy: text => call('clipboard_write', { text }),
    info: () => call('app_info'),
    onMenu: fn => webview.listen('menu', e => fn(e.payload)),
    // `check` says whether to hold the close; held closes come back through `ask`.
    onCloseRequested: (check, ask) => win.onCloseRequested(e => { if (check()) { e.preventDefault(); ask(); } }),
    closeWindow: () => win.destroy(),
    connectOnOpen: () => window.__TRELLIS_CONNECT__ || null,
    selftestLog: text => call('selftest_log', { text }),
    selftestDone: () => call('selftest_done'),
  };
})();
