/* Hub-Logik: Lernreports laden, anzeigen, hinzufügen, löschen — dazu Fachbereichs-Ordner
   mit eigener Farbe, Suche und freies Sortieren per Ziehen. */

const ROOT_ID = '__root__';
const THEMES = ['teal', 'indigo', 'plum', 'amber', 'rose', 'forest', 'ocean', 'clay'];

const board = document.getElementById('board');
const empty = document.getElementById('empty');
const noHits = document.getElementById('noHits');
const toastEl = document.getElementById('toast');

/* state.order: { ordnerId: [dateiname, ...] }  ·  ROOT_ID = „Ohne Ordner“ */
let state = { folders: [], order: { [ROOT_ID]: [] } };
let metaByFile = new Map();
let query = '';

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function folderById(id) { return state.folders.find(f => f.id === id); }
function folderName(id) { return id === ROOT_ID ? 'Ohne Ordner' : (folderById(id)?.name || 'Ordner'); }
function newFolderId() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function themeOf(id) { return id === ROOT_ID ? null : (folderById(id)?.color || 'teal'); }

/* ---------- Daten aus dem privaten GitHub-Repo ---------- */
const DATA_FILE = 'hub-data.json';
let shaByFile = new Map();
let lastLoad = 0;

/* Metadaten (Titel, Untertitel, Kapitel) werden aus der Datei gelesen und pro
   Gerät nach Versionskennung zwischengespeichert — so wird jeder Report nur
   einmal pro Änderung heruntergeladen. */
const ENTITIES = { '&nbsp;': ' ', '&shy;': '', '&ndash;': '–', '&mdash;': '—', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '’', '&amp;': '&' };
function pickText(html, re) {
  const m = html.match(re);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|shy|ndash|mdash|lt|gt|quot|#39|amp);/g, x => ENTITIES[x])
    .replace(/\s+/g, ' ').trim();
}
function parseMeta(file, html) {
  let title = pickText(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!title) title = pickText(html, /<title[^>]*>([\s\S]*?)<\/title>/i).split('·')[0].trim();
  return {
    file, url: 'view.html?f=' + encodeURIComponent(file), title,
    eyebrow: pickText(html, /<div class="eyebrow"[^>]*>([\s\S]*?)<\/div>/i),
    lead: pickText(html, /<p class="lead"[^>]*>([\s\S]*?)<\/p>/i),
    chapters: (html.match(/class="ch-nr"/g) || []).length
  };
}
function metaCacheGet() { try { return JSON.parse(localStorage.getItem('lh_meta')) || {}; } catch (e) { return {}; } }
function metaCacheSet(c) { try { localStorage.setItem('lh_meta', JSON.stringify(c)); } catch (e) {} }

function defaultData() { return { version: 1, folders: [], order: {} }; }
function normalizeData(data, files) {
  data = data && typeof data === 'object' ? data : defaultData();
  const folders = [], seen = new Set();
  for (const f of (Array.isArray(data.folders) ? data.folders : [])) {
    if (!f || typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(f.id)) continue;
    if (f.id === ROOT_ID || seen.has(f.id)) continue;
    seen.add(f.id);
    folders.push({ id: f.id, name: String(f.name == null ? '' : f.name).replace(/\s+/g, ' ').trim().slice(0, 80) || 'Ordner',
      collapsed: !!f.collapsed, color: THEMES.includes(f.color) ? f.color : null });
  }
  folders.forEach((f, i) => { if (!f.color) f.color = THEMES[i % THEMES.length]; });
  const src = (data.order && typeof data.order === 'object') ? data.order : {};
  const order = {}, used = new Set();
  for (const key of [ROOT_ID, ...folders.map(f => f.id)]) {
    const out = [];
    for (const name of (Array.isArray(src[key]) ? src[key] : [])) {
      if (typeof name !== 'string' || used.has(name) || !files.includes(name)) continue;
      used.add(name); out.push(name);
    }
    order[key] = out;
  }
  for (const name of files) if (!used.has(name)) order[ROOT_ID].push(name);
  return { version: 1, folders, order };
}

async function load() {
  setSync('Lade …');
  let tree, json;
  try {
    [tree, json] = await Promise.all([LH.tree(), LH.readJSON(DATA_FILE)]);
  } catch (e) {
    if (e.status === 401) { LH.logout(); return showLogin('Dein Zugangsschlüssel ist ungültig oder abgelaufen. Bitte neu anmelden.'); }
    setSync('Offline', true);
    toast(e.message || 'Laden fehlgeschlagen');
    return;
  }
  shaByFile = new Map();
  for (const [p, sha] of tree) { const m = p.match(/^lectures\/([^/]+\.html?)$/i); if (m) shaByFile.set(m[1], sha); }
  const files = [...shaByFile.keys()].sort();

  // Metadaten: aus dem Gerätespeicher, fehlende/veraltete nachladen (max. 4 parallel)
  const cache = metaCacheGet(), fresh = {};
  const todo = files.filter(f => !(cache[f] && cache[f].sha === shaByFile.get(f)));
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const f = todo.shift();
      try { const html = await LH.readText('lectures/' + f, shaByFile.get(f)); cache[f] = { sha: shaByFile.get(f), ...parseMeta(f, html) }; }
      catch (e) { cache[f] = { sha: null, ...parseMeta(f, '') }; }
      setSync('Lade Reports … ' + (++done));
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const f of files) fresh[f] = cache[f];
  metaCacheSet(fresh);

  const data = normalizeData(json.data, files);
  metaByFile = new Map(files.map(f => [f, { ...fresh[f], url: 'view.html?f=' + encodeURIComponent(f) }]));
  state.folders = data.folders.map(f => ({ ...f }));
  state.order = data.order;
  lastLoad = Date.now();
  setSync('Synchronisiert');
  render();
}

/* Beim Zurückkehren (anderes Gerät hat evtl. etwas geändert) still neu laden. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && LH.token() && Date.now() - lastLoad > 15000
      && !drag && !document.querySelector('dialog[open]')) load();
});

const syncEl = document.getElementById('sync');
function setSync(t, bad) { if (syncEl) { syncEl.textContent = t; syncEl.classList.toggle('bad', !!bad); } }

/* ---------- Rendern ---------- */
function render() {
  const total = metaByFile.size;
  board.innerHTML = '';
  board.appendChild(sectionEl({ id: ROOT_ID, name: 'Ohne Ordner', collapsed: false }, true));
  for (const f of state.folders) board.appendChild(sectionEl(f, false));

  empty.hidden = total > 0;
  board.hidden = total === 0 && state.folders.length === 0;
  updateStats();
  refreshFolderSelects();
  applyFilter();
}

function updateStats() {
  let chapters = 0;
  for (const m of metaByFile.values()) chapters += m.chapters || 0;
  document.getElementById('statReports').textContent = metaByFile.size;
  document.getElementById('statFolders').textContent = state.folders.length;
  document.getElementById('statChapters').textContent = chapters;
}

function sectionEl(f, isRoot) {
  const files = state.order[f.id] || [];
  const sec = document.createElement('section');
  sec.className = 'folder' + (isRoot ? ' root' : ' t-' + (f.color || 'teal')) + (f.collapsed ? ' collapsed' : '')
    + (isRoot && files.length === 0 && state.folders.length ? ' tidy' : '');
  sec.dataset.folder = f.id;

  const head = document.createElement('div');
  head.className = 'folder-head';
  head.innerHTML = `
    ${isRoot ? '' : `<button class="fold-toggle" title="Auf-/Zuklappen" aria-expanded="${!f.collapsed}">▾</button>`}
    <span class="folder-dot" aria-hidden="true"></span>
    <h2 class="folder-name">${esc(f.name)}</h2>
    <span class="folder-count">${files.length}</span>
    <span class="folder-rule" aria-hidden="true"></span>
    <span class="folder-actions">${isRoot ? '' : `
      <button class="icon-btn" data-act="rename" title="Umbenennen & Farbe ändern">✎</button>
      <button class="icon-btn danger" data-act="delfolder" title="Ordner löschen">✕</button>`}</span>`;
  // Ohne Ordner-Struktur braucht die „Ohne Ordner“-Überschrift niemand.
  head.hidden = isRoot && state.folders.length === 0;
  sec.appendChild(head);

  const body = document.createElement('div');
  body.className = 'folder-body';
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.dataset.drop = f.id;
  grid.dataset.hint = isRoot
    ? 'Alles einsortiert — hierher ziehen, um einen Report aus einem Ordner zu nehmen.'
    : 'Leerer Ordner — zieh einen Lernreport hierher.';
  for (const file of files) {
    const m = metaByFile.get(file);
    if (m) grid.appendChild(cardEl(m));
  }
  body.appendChild(grid);
  sec.appendChild(body);
  return sec;
}

function cardEl(m) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.file = m.file;
  card.dataset.search = ((m.title || '') + ' ' + (m.eyebrow || '') + ' ' + (m.lead || '') + ' ' + m.file).toLowerCase();
  card.innerHTML = `
    <div class="drag-handle" title="Ziehen zum Sortieren">⠿</div>
    <div class="eyebrow"><span title="${esc(m.eyebrow)}">${esc(m.eyebrow) || 'Lern-Report'}</span></div>
    <h3>${esc(m.title) || esc(m.file)}</h3>
    <p class="lead">${esc(m.lead)}</p>
    <p class="meta">${m.chapters ? `<span class="chip">${m.chapters} Kapitel</span>` : ''}<span class="fname">${esc(m.file)}</span></p>
    <div class="row">
      <a class="btn primary" href="${esc(m.url)}" draggable="false">Öffnen</a>
      <a class="btn quiet" href="${esc(m.url)}&amp;edit=1" draggable="false">Bearbeiten</a>
      <span class="card-tools">
        <button class="icon-btn" data-act="move" title="In Ordner verschieben">📁</button>
        <button class="icon-btn danger" data-act="del" title="Aus dem Hub löschen">✕</button>
      </span>
    </div>`;
  return card;
}

function updateCounts() {
  board.querySelectorAll('section.folder').forEach(sec => {
    const n = sec.querySelectorAll(':scope .grid > .card').length;
    const c = sec.querySelector('.folder-count');
    if (c) c.textContent = n;
  });
}

/* ---------- Suche ---------- */
const searchInput = document.getElementById('search');
const searchClear = document.getElementById('searchClear');
searchInput.addEventListener('input', () => { query = searchInput.value.trim().toLowerCase(); applyFilter(); });
searchClear.addEventListener('click', () => { searchInput.value = ''; query = ''; applyFilter(); searchInput.focus(); });

/* „/“ springt in die Suche, Esc räumt sie wieder auf — wie in den Werkzeugen,
   die man sonst benutzt. In Eingabefeldern und Dialogen gilt das nicht. */
document.addEventListener('keydown', ev => {
  const t = ev.target;
  const typing = t && (t.matches?.('input, select, textarea') || t.isContentEditable);
  if (ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey
      && !document.querySelector('dialog[open]')) {
    ev.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (ev.key === 'Escape' && t === searchInput) {
    searchInput.value = ''; query = ''; applyFilter(); searchInput.blur();
  }
});

/* Die Kopfleiste bekommt erst beim Scrollen eine Kante. */
const onScroll = () => document.querySelector('.topbar').classList.toggle('scrolled', window.scrollY > 4);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

function applyFilter() {
  searchClear.hidden = !query;
  let hits = 0;
  board.querySelectorAll('section.folder').forEach(sec => {
    let visible = 0, total = 0;
    sec.querySelectorAll('.card').forEach(card => {
      const match = !query || card.dataset.search.includes(query);
      card.classList.toggle('filtered', !match);
      total++;
      if (match) visible++;
    });
    // Während der Suche zeigt die Zahl, wie viele der Reports gemeint sind.
    const count = sec.querySelector('.folder-count');
    if (count) count.textContent = query ? visible + ' / ' + total : total;
    // Bei aktiver Suche leere Ordner ausblenden und Treffer immer aufklappen.
    sec.classList.toggle('filtered', !!query && visible === 0);
    if (query) sec.classList.remove('collapsed');
    else sec.classList.toggle('collapsed', !!folderById(sec.dataset.folder)?.collapsed);
    hits += visible;
  });
  const nothing = !!query && hits === 0 && metaByFile.size > 0;
  noHits.hidden = !nothing;
  if (nothing) document.getElementById('noHitsQ').textContent = 'Kein Lernreport passt zu „' + searchInput.value.trim() + '“.';
  if (metaByFile.size > 0) empty.hidden = true;
}

/* ---------- Speichern der Struktur ---------- */
/* Mehrere Änderungen kurz hintereinander (Ziehen, Umbenennen) → ein Speicherstand. */
let layoutTimer = null, layoutBusy = null;
function saveLayout() {
  clearTimeout(layoutTimer);
  setSync('Nicht gespeichert');
  layoutTimer = setTimeout(flushLayout, 900);
}
async function flushLayout() {
  if (layoutBusy) await layoutBusy.catch(() => {});
  const snap = { folders: state.folders.map(f => ({ ...f })), order: JSON.parse(JSON.stringify(state.order)) };
  setSync('Speichere …');
  layoutBusy = LH.updateJSON(DATA_FILE, () => normalizeData(snap, [...shaByFile.keys()].sort()), 'Hub: Ordner/Reihenfolge');
  try { await layoutBusy; setSync('Synchronisiert'); return true; }
  catch (e) { setSync('Fehler', true); toast('Reihenfolge konnte nicht gespeichert werden: ' + (e.message || '')); return false; }
}

/* Zustand aus dem DOM übernehmen (nach dem Ziehen). */
function syncFromDOM() {
  const order = {};
  board.querySelectorAll('.grid[data-drop]').forEach(g => {
    order[g.dataset.drop] = [...g.querySelectorAll(':scope > .card')].map(c => c.dataset.file);
  });
  if (!order[ROOT_ID]) order[ROOT_ID] = [];
  state.order = order;
  state.folders = [...board.querySelectorAll('section.folder:not(.root)')]
    .map(s => folderById(s.dataset.folder)).filter(Boolean);
  updateCounts();
  updateStats();
}
function snapshot() {
  return JSON.stringify({ f: state.folders.map(f => f.id), o: state.order });
}

/* „Ohne Ordner“ zeigt sich nur so viel, wie gerade nötig ist. */
function refreshRootChrome() {
  const sec = board.querySelector('section.folder.root');
  if (!sec) return;
  const count = sec.querySelectorAll('.grid > .card').length;
  const head = sec.querySelector('.folder-head');
  if (head) head.hidden = state.folders.length === 0;
  sec.classList.toggle('tidy', count === 0 && state.folders.length > 0);
}

/* ---------- Ordner-Aktionen ---------- */
const folderDlg = document.getElementById('folderDlg');
const folderNameInput = document.getElementById('folderName');
const folderColors = document.getElementById('folderColors');
let folderDlgTarget = null;   // null = neu anlegen, sonst Ordner-ID
let pickedColor = 'teal';

THEMES.forEach(t => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'swatch t-' + t; b.dataset.color = t; b.title = t;
  b.addEventListener('click', () => pickColor(t));
  folderColors.appendChild(b);
});
function pickColor(t) {
  pickedColor = t;
  folderColors.querySelectorAll('.swatch').forEach(s =>
    s.setAttribute('aria-pressed', String(s.dataset.color === t)));
}

function openFolderDialog(id) {
  folderDlgTarget = id || null;
  const f = id ? folderById(id) : null;
  document.getElementById('folderDlgTitle').textContent = id ? 'Ordner bearbeiten' : 'Neuer Ordner';
  folderNameInput.value = f ? f.name : '';
  // Neue Ordner bekommen die nächste noch freie Farbe vorgeschlagen.
  pickColor(f ? f.color : (THEMES.find(t => !state.folders.some(x => x.color === t)) || THEMES[state.folders.length % THEMES.length]));
  folderDlg.showModal();
  setTimeout(() => folderNameInput.focus(), 30);
}
folderDlg.addEventListener('close', () => {
  if (folderDlg.returnValue !== 'ok') return;
  const name = folderNameInput.value.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) return;
  if (folderDlgTarget) {
    const f = folderById(folderDlgTarget);
    if (f) { f.name = name; f.color = pickedColor; }
    toast('Ordner aktualisiert.');
  } else {
    const id = newFolderId();
    state.folders.push({ id, name, collapsed: false, color: pickedColor });
    state.order[id] = [];
    toast('Fachbereich „' + name + '“ angelegt.');
  }
  render();
  saveLayout();
});
document.getElementById('addFolderBtn').addEventListener('click', () => openFolderDialog(null));

function deleteFolder(id) {
  const f = folderById(id);
  if (!f) return;
  const inside = (state.order[id] || []).length;
  const msg = inside
    ? `Ordner „${f.name}“ löschen?\n\nDie ${inside} Lernreport(s) darin bleiben erhalten und wandern zurück zu „Ohne Ordner“.`
    : `Ordner „${f.name}“ löschen?`;
  if (!confirm(msg)) return;
  state.order[ROOT_ID] = [...state.order[ROOT_ID], ...(state.order[id] || [])];
  delete state.order[id];
  state.folders = state.folders.filter(x => x.id !== id);
  render();
  saveLayout();
  toast('Ordner gelöscht — die Lernreports sind erhalten geblieben.');
}

function setCollapsed(id, collapsed) {
  const f = folderById(id);
  if (!f) return;
  f.collapsed = collapsed;
  const sec = board.querySelector(`section.folder[data-folder="${id}"]`);
  if (sec) {
    sec.classList.toggle('collapsed', collapsed);
    const t = sec.querySelector('.fold-toggle');
    if (t) t.setAttribute('aria-expanded', String(!collapsed));
  }
  saveLayout();
}

/* ---------- Verschieben per Dialog (Alternative zum Ziehen) ---------- */
const moveDlg = document.getElementById('moveDlg');
const moveSel = document.getElementById('moveSel');
let moveTarget = null;

function openMoveDialog(file) {
  const m = metaByFile.get(file);
  if (!m) return;
  moveTarget = file;
  document.getElementById('moveWhat').textContent = m.title || file;
  const current = Object.keys(state.order).find(k => (state.order[k] || []).includes(file)) || ROOT_ID;
  moveSel.innerHTML = '';
  for (const opt of [{ id: ROOT_ID, name: 'Ohne Ordner' }, ...state.folders]) {
    const o = document.createElement('option');
    o.value = opt.id; o.textContent = opt.name;
    if (opt.id === current) o.selected = true;
    moveSel.appendChild(o);
  }
  moveDlg.showModal();
}
moveDlg.addEventListener('close', () => {
  if (moveDlg.returnValue !== 'ok' || !moveTarget) return;
  const to = moveSel.value;
  if (!state.order[to]) state.order[to] = [];
  for (const k of Object.keys(state.order)) state.order[k] = state.order[k].filter(f => f !== moveTarget);
  state.order[to].push(moveTarget);
  const f = folderById(to);
  if (f) f.collapsed = false;
  render();
  saveLayout();
  toast('Verschoben nach „' + folderName(to) + '“.');
});

function refreshFolderSelects() {
  const sel = document.getElementById('addFolderSel');
  const keep = sel.value;
  sel.innerHTML = '<option value="">Ohne Ordner</option>';
  for (const f of state.folders) {
    const o = document.createElement('option');
    o.value = f.id; o.textContent = f.name;
    sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

/* ---------- Löschen ---------- */
async function del(file) {
  if (!confirm(`„${file}“ wirklich aus dem Hub löschen?\n\n(Über den Versionsverlauf auf GitHub lässt er sich bei Bedarf wiederherstellen.)`)) return;
  try {
    await LH.del('lectures/' + file, shaByFile.get(file), 'Gelöscht: ' + file);
    shaByFile.delete(file);
    for (const k of Object.keys(state.order)) state.order[k] = state.order[k].filter(f => f !== file);
    await flushLayout();
    toast('Gelöscht.'); load();
  } catch (e) { toast('Fehler: ' + (e.message || '')); }
}

/* ---------- Klicks im Board ---------- */
board.addEventListener('click', ev => {
  const btn = ev.target.closest('button');
  const sec = ev.target.closest('section.folder');
  if (btn) {
    if (btn.classList.contains('fold-toggle')) {
      return setCollapsed(sec.dataset.folder, !sec.classList.contains('collapsed'));
    }
    const card = btn.closest('.card');
    switch (btn.dataset.act) {
      case 'rename': return openFolderDialog(sec.dataset.folder);
      case 'delfolder': return deleteFolder(sec.dataset.folder);
      case 'move': return openMoveDialog(card.dataset.file);
      case 'del': return del(card.dataset.file);
    }
    return;
  }
  // Klick auf die Ordnerzeile klappt auf/zu
  if (ev.target.closest('.folder-head') && sec && !sec.classList.contains('root')) {
    setCollapsed(sec.dataset.folder, !sec.classList.contains('collapsed'));
  }
});

/* ================= Ziehen & Ablegen =================
   Verhalten wie in Notion/Trello:
   · Maus  — sobald man mit gedrückter Taste ein paar Pixel zieht, geht es los.
             Zusätzlich startet reines Gedrückthalten den Zug (ohne Bewegung).
   · Touch — erst nach kurzem Halten, damit Wischen weiterhin scrollt.
   Das gezogene Element wandert live im DOM mit; die übrigen Karten gleiten
   per FLIP-Animation an ihre neue Stelle. */
const HOLD_MS = 180;        // Gedrückthalten ohne Bewegung
const MOUSE_THRESHOLD = 5;  // px, ab hier ist es eindeutig ein Zug
const TOUCH_TOLERANCE = 10; // px, darunter gilt es noch als Tippen/Scrollen

let press = null;
let drag = null;
let suppressClick = false;

board.addEventListener('pointerdown', ev => {
  if (drag) endDrag(true);
  if (press) cancelPress();
  if (!ev.isPrimary) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  if (ev.target.closest('a, button, input, select, textarea')) return;

  const card = ev.target.closest('.card');
  const head = ev.target.closest('.folder-head');
  let mode = null, el = null;
  if (card) { mode = 'card'; el = card; }
  else if (head) {
    const sec = head.closest('section.folder');
    if (sec.classList.contains('root')) return;  // „Ohne Ordner“ bleibt oben
    mode = 'folder'; el = sec;
  } else return;

  press = { mode, el, x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, pointerType: ev.pointerType };
  if (ev.target.closest('.drag-handle')) startDrag(ev.clientX, ev.clientY);
  else press.timer = setTimeout(() => startDrag(press.x, press.y), HOLD_MS);
});

window.addEventListener('pointermove', ev => {
  if (press && !drag && ev.pointerId === press.pointerId) {
    const dist = Math.hypot(ev.clientX - press.x, ev.clientY - press.y);
    if (press.pointerType === 'touch') {
      // Finger: Bewegung heißt scrollen, nicht ziehen.
      if (dist > TOUCH_TOLERANCE) cancelPress();
    } else if (dist > MOUSE_THRESHOLD) {
      // Maus/Stift: Bewegung heißt ziehen — und zwar sofort.
      startDrag(press.x, press.y);
    }
  }
  if (!drag || ev.pointerId !== drag.pointerId) return;
  ev.preventDefault();
  drag.lastX = ev.clientX; drag.lastY = ev.clientY;
  moveGhost();
  drag.scrollDir = ev.clientY < 100 ? -1 : (ev.clientY > innerHeight - 100 ? 1 : 0);
  placeDragged();
}, { passive: false });

window.addEventListener('pointerup', ev => {
  if (drag && ev.pointerId !== drag.pointerId) return;
  endDrag();
});
window.addEventListener('pointercancel', () => endDrag(true));
window.addEventListener('blur', () => endDrag(true));
window.addEventListener('keydown', ev => { if (ev.key === 'Escape' && drag) { ev.preventDefault(); endDrag(true); } });

function cancelPress() { if (press?.timer) clearTimeout(press.timer); press = null; }

function startDrag(x, y) {
  if (!press || drag) return;
  const { mode, el, pointerId } = press;
  cancelPress();

  const r = el.getBoundingClientRect();
  drag = {
    mode, el, pointerId, before: snapshot(),
    home: { parent: el.parentNode, next: el.nextElementSibling },
    offX: x - r.left, offY: y - r.top, lastX: x, lastY: y, scrollDir: 0
  };

  if (mode === 'folder') board.classList.add('folder-dnd');   // Ordner nur als Zeilen anzeigen
  el.classList.add('drag-source');

  const ghost = (mode === 'card' ? el : el.querySelector('.folder-head')).cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.classList.remove('drag-source');
  ghost.style.width = (mode === 'card' ? r.width : el.getBoundingClientRect().width) + 'px';
  if (mode === 'card') ghost.style.height = r.height + 'px';
  document.body.appendChild(ghost);
  drag.ghost = ghost;

  document.body.classList.add('dnd');
  if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) {} }
  moveGhost();
  requestAnimationFrame(scrollLoop);
}

function moveGhost() {
  drag.ghost.style.transform =
    `translate3d(${drag.lastX - drag.offX}px, ${drag.lastY - drag.offY}px, 0) rotate(1.2deg) scale(1.02)`;
}

function scrollLoop() {
  if (!drag) return;
  if (drag.scrollDir) {
    const y0 = window.scrollY;
    window.scrollBy(0, drag.scrollDir * 14);
    if (window.scrollY !== y0) placeDragged();
  }
  requestAnimationFrame(scrollLoop);
}

/* Umordnen mit FLIP: erst Positionen merken, dann verschieben, dann die
   Differenz wegtweenen — dadurch gleiten die Karten, statt zu springen. */
function reorder(apply) {
  const cards = [...board.querySelectorAll('.grid > .card:not(.filtered)')];
  const before = new Map();
  for (const c of cards) if (c !== drag.el) before.set(c, c.getBoundingClientRect());
  apply();
  for (const [c, b] of before) {
    const a = c.getBoundingClientRect();
    const dx = b.left - a.left, dy = b.top - a.top;
    if (!dx && !dy) continue;
    c.style.transition = 'none';
    c.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      c.style.transition = 'transform .19s cubic-bezier(.2,.7,.3,1)';
      c.style.transform = '';
    });
  }
}
function clearFlip() {
  board.querySelectorAll('.grid > .card').forEach(c => { c.style.transition = ''; c.style.transform = ''; });
}

/* Das echte Element wandert im DOM mit — es ist gleichzeitig die Vorschau. */
function placeDragged() {
  const el = drag.el;
  const x = drag.lastX, y = drag.lastY;
  const under = document.elementFromPoint(x, y);
  if (!under || !document.body.contains(under)) return;

  if (drag.mode === 'folder') {
    const sec = under.closest('section.folder');
    if (!sec || sec === el || sec.classList.contains('root')) return;
    const r = sec.getBoundingClientRect();
    board.insertBefore(el, (y > r.top + r.height / 2) ? sec.nextSibling : sec);
    return;
  }

  // Karte über einer Ordnerzeile → ans Ende dieses Ordners
  const head = under.closest('.folder-head');
  if (head) {
    const sec = head.closest('section.folder');
    const grid = sec.querySelector('.grid[data-drop]');
    if (grid && grid.lastElementChild !== el) reorder(() => grid.appendChild(el));
    return markTarget(sec);
  }

  const overCard = under.closest('.card');
  if (overCard && overCard !== el && overCard.parentElement?.matches('.grid[data-drop]')) {
    const r = overCard.getBoundingClientRect();
    const after = x > r.left + r.width / 2;
    const ref = after ? overCard.nextSibling : overCard;
    if (ref !== el) reorder(() => overCard.parentElement.insertBefore(el, ref));
    return markTarget(overCard.closest('section.folder'));
  }

  const grid = under.closest('.grid[data-drop]') ||
               under.closest('section.folder')?.querySelector('.grid[data-drop]');
  if (grid && !grid.contains(el)) reorder(() => grid.appendChild(el));
  if (grid) markTarget(grid.closest('section.folder'));
}

function markTarget(sec) {
  board.querySelectorAll('.folder.drop-target').forEach(s => { if (s !== sec) s.classList.remove('drop-target'); });
  if (sec) sec.classList.add('drop-target');
}

function endDrag(abort) {
  cancelPress();
  if (!drag) return;
  const d = drag;
  drag = null;

  if (abort) d.home.parent.insertBefore(d.el, d.home.next);
  d.ghost.remove();
  d.el.classList.remove('drag-source');
  document.body.classList.remove('dnd');
  board.classList.remove('folder-dnd');
  board.querySelectorAll('.folder.drop-target').forEach(s => s.classList.remove('drop-target'));
  clearFlip();

  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 300);

  // In einen zugeklappten Ordner gezogen? Dann aufklappen, damit man es sieht.
  if (d.mode === 'card' && !abort) {
    const sec = d.el.closest('section.folder');
    if (sec?.classList.contains('collapsed')) {
      const f = folderById(sec.dataset.folder);
      if (f) { f.collapsed = false; sec.classList.remove('collapsed'); }
      sec.querySelector('.fold-toggle')?.setAttribute('aria-expanded', 'true');
    }
  }

  syncFromDOM();
  refreshRootChrome();
  if (snapshot() !== d.before) {
    saveLayout();
    toast(d.mode === 'folder' ? 'Ordner-Reihenfolge gespeichert.' : 'Reihenfolge gespeichert.');
  }
}

/* Nach dem Ziehen keinen versehentlichen Klick auslösen. */
document.addEventListener('click', ev => {
  if (!suppressClick) return;
  ev.preventDefault(); ev.stopPropagation();
}, true);
/* Natives Bild-/Link-Ziehen im Board stört das eigene Sortieren. */
document.addEventListener('dragstart', ev => { if (ev.target.closest('#board')) ev.preventDefault(); });
document.addEventListener('selectstart', ev => { if (drag) ev.preventDefault(); });
document.addEventListener('contextmenu', ev => { if (drag) ev.preventDefault(); });

/* ---------- Hinzufügen ---------- */
const addDlg = document.getElementById('addDlg');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
document.getElementById('addBtn').addEventListener('click', () => { refreshFolderSelects(); addDlg.showModal(); });
document.getElementById('cancelAdd').addEventListener('click', () => addDlg.close());
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) importFile(fileInput.files[0]); });
['dragover', 'dragenter'].forEach(e => dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.add('hot'); }));
['dragleave', 'drop'].forEach(e => dropzone.addEventListener(e, ev => { ev.preventDefault(); dropzone.classList.remove('hot'); }));
dropzone.addEventListener('drop', ev => { const f = ev.dataTransfer.files[0]; if (f) importFile(f); });

function slugify(name) {
  return name.toLowerCase().replace(/\.html?$/, '')
    .replace(/[äàáâ]/g, 'a').replace(/[öòóô]/g, 'o').replace(/[üùúû]/g, 'u').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vorlesung';
}
/* Neuer Report: eingebettete Bilder werden als eigene Dateien abgelegt, alles
   zusammen landet in EINEM Speicherstand im privaten Repo. */
async function importFile(file) {
  let html = await file.text();
  const folder = document.getElementById('addFolderSel').value;
  fileInput.value = '';
  if (!/<body/i.test(html)) { toast('Das sieht nicht nach einer HTML-Datei aus.'); return; }
  html = html.replace(/<link rel="stylesheet" href="\/assets\/editor\.css">\s*<script src="\/assets\/editor\.js" defer(?:="")?><\/script>/g, '');
  dropzone.classList.add('busy');
  dropzone.dataset.msg = 'Wird hochgeladen …';
  try {
    const ex = await LH.extractImages(html);
    const slug = slugify(file.name);
    let fname = slug + '.html', i = 2;
    const tree = await LH.tree();
    while (tree.has('lectures/' + fname)) fname = slug + '-' + (i++) + '.html';
    await LH.commitFiles([...ex.files.filter(f => !tree.has(f.path)), { path: 'lectures/' + fname, text: ex.html }], 'Neu: ' + fname);
    shaByFile.set(fname, 'neu');
    if (!state.order[ROOT_ID]) state.order[ROOT_ID] = [];
    (folder && state.order[folder] ? state.order[folder] : state.order[ROOT_ID]).push(fname);
    await flushLayout();
    addDlg.close();
    toast('Hinzugefügt: ' + fname);
    load();
  } catch (e) {
    toast('Fehler: ' + (e.message || 'Import fehlgeschlagen'));
  } finally { dropzone.classList.remove('busy'); }
}

/* ---------- Anmeldung ---------- */
const loginEl = document.getElementById('login');
function showLogin(msg) {
  document.body.classList.add('locked');
  loginEl.hidden = false;
  document.getElementById('loginErr').textContent = msg || '';
  setTimeout(() => document.getElementById('tokenIn').focus(), 30);
}
document.getElementById('loginForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const tok = document.getElementById('tokenIn').value.trim();
  const persist = document.getElementById('remember').checked;
  const err = document.getElementById('loginErr');
  const btn = document.getElementById('loginBtn');
  if (!tok) return;
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Prüfe …';
  try {
    await LH.verify(tok);
    LH.login(tok, persist);
    document.getElementById('tokenIn').value = '';
    const next = new URLSearchParams(location.search).get('next');
    if (next && /^\/[^/]/.test(next)) { location.replace(next); return; }
    loginEl.hidden = true; document.body.classList.remove('locked');
    load();
  } catch (e) {
    err.textContent = e.status === 404 || e.status === 401
      ? 'Mit diesem Schlüssel ist das Repo „' + LH.CFG.repo + '“ nicht erreichbar. Ist es beim Erstellen unter „Repository access“ ausgewählt?'
      : (e.message || 'Anmeldung fehlgeschlagen');
  } finally { btn.disabled = false; btn.textContent = 'Anmelden'; }
});
document.getElementById('logoutBtn').addEventListener('click', () => {
  if (!confirm('Auf diesem Gerät abmelden?\n\nDer Zugangsschlüssel und zwischengespeicherte Bilder werden von diesem Gerät entfernt.')) return;
  LH.logout(); location.replace('./');
});

if (LH.token()) load(); else showLogin();
