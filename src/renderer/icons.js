// Line icons on a 16px grid, drawn in the current text color. The rings are Dendro's mark.
window.ICONS = {
  table: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6.5h12M6.5 6.5V13"/>',
  view: '<path d="M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  play: '<path d="M5 3.2v9.6L12.8 8z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5"/>',
  download: '<path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/>',
  folder: '<path d="M2 4.5c0-.8.7-1.5 1.5-1.5h2.8l1.5 1.5h4.7c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5z"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  left: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  right: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  filter: '<path d="M2.5 3.5h11L9.5 8.5v4l-3 1v-5z"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7 13 3M11 5l1.5 1.5"/>',
  inspector: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M10 3v10"/>',
  history: '<path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.5 2.8v2.6h2.6M8 5.3V8l1.8 1.4"/>',
  code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2c0-.6-.4-1-1-1h-6c-.6 0-1 .4-1 1v6c0 .6.4 1 1 1h2"/>',
  db: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  columns: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10M10 3v10"/>',
  rowplus: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M8 5.8v4.4M5.8 8h4.4"/>',
  plug: '<path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3"/>',
  link: '<path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"/>',
  arrowr: '<path d="M3 8h9.5M9 4.5 12.5 8 9 11.5"/>',
  window: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M2 6h12"/>',
  schema: '<rect x="6" y="1.8" width="4" height="3.4" rx="1"/><rect x="1.8" y="10.8" width="4" height="3.4" rx="1"/><rect x="10.2" y="10.8" width="4" height="3.4" rx="1"/><path d="M8 5.2v2.8M3.8 10.8V8h8.4v2.8"/>',
  updown: '<path d="m5 6 3-3 3 3M5 10l3 3 3-3"/>',
  file: '<path d="M4 1.8h5.2L12 4.6v9.6H4z"/><path d="M9 1.8v3h3M6 8.5h4M6 11h4"/>',
  pencil: '<path d="M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L6 12.1l-3.1.8.8-3.1z"/>',
  trellis: '<rect x="2" y="2" width="12" height="12" rx="3"/><path d="M2 8 8 2M2 14 14 2M8 14 14 8M8 2l6 6M2 2l12 12M2 8l6 6"/>',
  rings: '<path d="M8 1.2c3.9 0 6.8 2.9 6.8 6.7 0 3.9-3 6.9-6.9 6.9C4 14.8 1.2 11.8 1.2 8 1.2 4.1 4.2 1.2 8 1.2z"/><path d="M8.2 3.4c2.5 0 4.4 1.9 4.4 4.5 0 2.5-2 4.5-4.6 4.5-2.5 0-4.3-2-4.3-4.4 0-2.6 1.9-4.6 4.5-4.6z"/><path d="M8.3 5.6c1.3 0 2.3 1 2.3 2.3 0 1.3-1 2.3-2.4 2.3-1.3 0-2.2-1-2.2-2.2 0-1.4 1-2.4 2.3-2.4z"/>',
};

window.ic = (n, cls = '') => `<svg class="icon ${cls}" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${window.ICONS[n] || ''}</svg>`;

// Connection avatars, on a 24px grid. The first three stand for the engines when a connection keeps "Auto";
// the rest are a set to pick from per connection. They are drawn for Trellis, not the projects' trademarked logos.
window.ENGINE_ICONS = {
  // An elephant head from the front: wide ears, brow, eyes and a trunk curling to the right.
  postgres: '<path d="M7.3 7.6C5.1 6.3 2.7 7.4 2.7 10.3c0 2.7 2 4.6 4.8 4.5"/><path d="M16.7 7.6c2.2-1.3 4.6-.2 4.6 2.7 0 2.7-2 4.6-4.8 4.5"/><path d="M7.3 7.6C8.4 5.9 10.1 5 12 5s3.6.9 4.7 2.6"/><path d="M7.5 14.8c.7 1.1 1.7 1.8 2.9 2.1v1.4c0 1.7 1.1 2.7 2.7 2.7.7 0 1.3-.3 1.6-.8"/><path d="M16.5 14.8c-.7 1.1-1.7 1.8-2.9 2.1v1.6"/><circle cx="9.7" cy="11.2" r=".75" fill="currentColor" stroke="none"/><circle cx="14.3" cy="11.2" r=".75" fill="currentColor" stroke="none"/>',
  // A dolphin leaping right: arched back, fin, beak and tail.
  mysql: '<path d="M3.2 17.5c1.8-6.6 7.4-10.4 14.3-9.6 1.2.1 2.3.6 3.1 1.4"/><path d="M20.6 9.3l-2.3.4"/><path d="M5.5 18.2c2.6-3.5 6.4-5.5 11.2-5.6"/><path d="M10.4 9.4l1-3.1 2.2 2.2"/><path d="M3.2 17.5l-.9 2.6M3.2 17.5l2.6.4"/>',
  // A feather: spine, vane and quill.
  sqlite: '<path d="M19.8 4.2c-6.7.4-11.3 4.9-12.4 12.4"/><path d="M19.8 4.2c-.2 7.4-4.8 12-12.4 12.4"/><path d="M7.4 16.6L4.3 19.7"/><path d="M10.6 13.4h3.6M12.9 10.2h3.4"/>',
};

window.CONN_ICONS = {
  db: '<ellipse cx="12" cy="5.5" rx="7" ry="2.7"/><path d="M5 5.5v13c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7v-13M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h5M11 16.5h5"/>',
  cloud: '<path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.6A6.2 6.2 0 0 0 5.9 9.6 4.5 4.5 0 0 0 7 18.5z"/>',
  bolt: '<path d="M13.2 3 5 13.4h6.3L10.4 21l8.4-10.6h-6.4z"/>',
  flame: '<path d="M12 3.2c.6 3.5 5.8 5.3 5.8 10.7a5.8 5.8 0 0 1-11.6 0c0-2.6 1.4-4.4 2.7-5.6.1 2.1 1 3.4 2.4 3.6-.7-3.3.2-6.1.7-8.7z"/>',
  leaf: '<path d="M5 19.5C4.6 10.8 9.9 5 20 4.3c.2 10-5.6 15.5-15 15.2z"/><path d="M5 19.5 13.5 11"/>',
  rocket: '<path d="M14.6 15.6 8.4 9.4C10.7 5.2 14.6 3.6 20.4 3.6c0 5.8-1.6 9.7-5.8 12z"/><path d="M8.4 9.4 5 9.1l2.6-3.4h4.1M14.6 15.6l.3 3.4 3.4-2.6v-4.1"/><path d="M7.4 16.6c-1.4.4-2.4 1.6-2.8 3.8 2.2-.4 3.4-1.4 3.8-2.8"/>',
  shield: '<path d="M12 3.2 19 6v5.4c0 4.5-2.9 7.8-7 9.4-4.1-1.6-7-4.9-7-9.4V6z"/><path d="m9 12 2.2 2.2L15.3 10"/>',
  flask: '<path d="M9.5 3.5h5M10.4 3.5v6L5.2 18.3A1.8 1.8 0 0 0 6.8 21h10.4a1.8 1.8 0 0 0 1.6-2.7l-5.2-8.8v-6"/><path d="M7.6 14.5h8.8"/>',
  gamepad: '<path d="M7 8.5h10a4.5 4.5 0 0 1 4.5 4.5v1.6a2.9 2.9 0 0 1-5.2 1.8L15 14.8H9l-1.3 1.6A2.9 2.9 0 0 1 2.5 14.6V13A4.5 4.5 0 0 1 7 8.5z"/><path d="M7.5 10.8v3.4M5.8 12.5h3.4"/><circle cx="15.6" cy="11.6" r=".6" fill="currentColor" stroke="none"/><circle cx="17.6" cy="13.4" r=".6" fill="currentColor" stroke="none"/>',
  cart: '<path d="M3 4h2.2l2.4 11.2h10.2l2.2-7.7H6.3"/><circle cx="9" cy="19.2" r="1.3"/><circle cx="16.6" cy="19.2" r="1.3"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 16v-4.5M12 16V8M16 16v-6.5"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2M12 3.4c2.3 2.4 3.4 5.3 3.4 8.6s-1.1 6.2-3.4 8.6c-2.3-2.4-3.4-5.3-3.4-8.6S9.7 5.8 12 3.4z"/>',
  cube: '<path d="M12 3.2 19.8 7.6v8.8L12 20.8l-7.8-4.4V7.6z"/><path d="M4.2 7.6 12 12l7.8-4.4M12 12v8.8"/>',
  star: '<path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  heart: '<path d="M12 19.8s-7.3-4.3-8.8-8.6C2.1 8 4 4.8 7.2 4.8c2 0 3.4 1.1 4.8 2.9 1.4-1.8 2.8-2.9 4.8-2.9 3.2 0 5.1 3.2 4 6.4-1.5 4.3-8.8 8.6-8.8 8.6z"/>',
  briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V5.2h6v2.3M3.5 12.5h17"/>',
  code: '<path d="m8 7.5-4.5 4.5L8 16.5M16 7.5l4.5 4.5-4.5 4.5M13.5 4.5l-3 15"/>',
  bug: '<rect x="7.8" y="7.6" width="8.4" height="12" rx="4.2"/><path d="M12 11v8.6M4.5 11.5h3.3M16.2 11.5h3.3M4.5 16.5h3.3M16.2 16.5h3.3M9.3 7.9 7.6 5.6M14.7 7.9l1.7-2.3"/>',
  key: '<circle cx="8.5" cy="15.5" r="4.3"/><path d="m11.6 12.4 8.2-8.2M17 7l2.4 2.4M14.6 9.4l2 2"/>',
};

// One avatar for a connection: its own icon, or its engine's when it keeps "Auto".
window.connIcon = (engine, icon) => `<svg class="conn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(icon && window.CONN_ICONS[icon]) || window.ENGINE_ICONS[engine] || window.CONN_ICONS.db}</svg>`;
