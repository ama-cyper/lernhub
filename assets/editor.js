/* Notion-artiger Editor für die Lern-Reports.
   Bearbeitet .wrap direkt im Browser, speichert über den lokalen Server in die HTML-Datei.
   Funktionen: Slash-Befehle, Auswahl-Popover (Format + Textmarker), Bild-Skalierung/-Ausrichtung,
   PDF-Export (1:1 über den Druckdialog). */
(function () {
  'use strict';

  /* ---------- Bearbeitbare Bereiche ----------------------------------------
     Nicht jeder Report ist gleich gebaut: die Dermatologie-Vorlagen packen
     alles in „.wrap“, neuere (V8, Altklausur-Lernseite) benutzen <main> und
     stellen den Titel in einen eigenen Kopfbereich davor. Deshalb ist der
     Bearbeitungsbereich eine Liste — Hauptteil plus der Titelblock, falls er
     außerhalb liegt. Navigation und Werkzeugleisten bleiben außen vor.       */
  const regions = [];
  function addRegion(node) {
    if (!node || node === document.body || node === document.documentElement) return;
    if (regions.some(r => r === node || r.contains(node))) return;
    // Ein neuer, größerer Bereich schluckt bereits erfasste kleinere.
    for (let i = regions.length - 1; i >= 0; i--) if (node.contains(regions[i])) regions.splice(i, 1);
    regions.push(node);
  }

  addRegion(document.querySelector('.wrap')
    || document.querySelector('main')
    || document.querySelector('#content, .content, .container, .page'));

  /* Bei manchen Vorlagen steht der Titel in einem eigenen Kopfbereich vor dem
     Hauptteil. Diesen mitnehmen — sonst ließe sich der Titel des Lernreports
     überhaupt nicht bearbeiten. Navigationsbereiche bleiben unberührt. */
  const title = document.querySelector('h1');
  if (title && !regions.some(r => r.contains(title))) {
    let host = title.closest('header, section, article') || title.closest('div');
    if (!host || host === document.body || host.querySelector('nav, .rail, .topbar, .top-actions'))
      host = title;                    // im Zweifel nur die Überschrift selbst
    addRegion(host);
  }

  if (!regions.length) addRegion(document.querySelector('body > div') || document.body);
  if (!regions.length) return;
  const region = regions[0];                      // Hauptbereich

  const inRegion = n => !!n && regions.some(r => r === n || r.contains(n));
  /* Der Bereich, in dem der Cursor gerade steht. */
  function currentRegion() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const hit = regions.find(r => r.contains(sel.anchorNode) || r === sel.anchorNode);
      if (hit) return hit;
    }
    return region;
  }
  /* Den Bereich fokussieren, OHNE den Cursor zu verlieren.
     focus() auf ein contenteditable setzt die Einfügemarke sonst an den Anfang —
     genau daran sind eingefügte Blöcke bisher an der falschen Stelle gelandet. */
  function focusRegion() {
    const r = currentRegion();
    if (r.contains(document.activeElement) || document.activeElement === r) return r;
    const sel = window.getSelection();
    const saved = (sel && sel.rangeCount && inRegion(sel.anchorNode)) ? sel.getRangeAt(0).cloneRange() : null;
    r.focus({ preventScroll: true });
    if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
    return r;
  }
  /* Ereignis im bearbeitbaren Bereich? (statt je Bereich zu lauschen) */
  const onRegion = (type, fn, opts) =>
    document.addEventListener(type, e => { if (inRegion(e.target)) fn(e); }, opts);

  let editing = false, dirty = false;
  let selImg = null;               // aktuell markiertes Bild
  let slashCtx = null;             // {node, start} für /-Befehl
  let slashIdx = 0;                // markierter Eintrag im Slash-Menü
  let autosaveTimer = null;        // Timer für automatisches Speichern
  const AUTOSAVE_DELAY = 4000;     // ms nach der letzten Änderung (jede Speicherung ist ein Commit)
  const DOC = window.LH_DOC || {};  // {file, sha, fromDraft} — gesetzt von view.html
  let rev = 0, saving = false, draftTimer = null;

  const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
  /* Eigene Bedienelemente markieren: werden beim Speichern entfernt und sind
     nie mitbearbeitbar (wichtig, falls der Bereich mal <body> ist). */
  const mark = n => { n.setAttribute('data-lr-ui', '1'); n.setAttribute('contenteditable', 'false'); return n; };

  try { document.execCommand('styleWithCSS', false, true); } catch (e) {}

  /* ---------- Aktionsleiste ---------- */
  document.body.classList.add('lr-has-bar');
  const bar = mark(el(
    '<div id="lr-bar">' +
      '<span class="lr-brand">✏️ Lernreport-Editor</span>' +
      '<span class="lr-status" id="lr-status">Gespeichert</span>' +
      (document.querySelector('article.card details.sol') && window.LH_DOC && LH_DOC.file
        ? '<a id="lr-exam" href="' + LH.APP + 'exam.html?f=' + encodeURIComponent(LH_DOC.file) + '" title="Altfragen interaktiv abfragen">🎯 Prüfung</a>' : '') +
      '<button id="lr-pdf" title="Als PDF speichern/drucken">PDF</button>' +
      '<a href="' + LH.APP + '">← Hub</a>' +
      '<button id="lr-toggle">Bearbeiten</button>' +
      '<button class="save" id="lr-save" disabled>Speichern</button>' +
    '</div>'));
  document.body.appendChild(bar);

  /* ---------- Platz für die Editor-Leiste ----------------------------------
     Die Editor-Leiste liegt fest oben im Fenster. Viele Reports bringen aber
     eigene Steuerleisten mit („Abstand: groß“, „Lösungen: sichtbar“, Suche,
     Kapitel-Navigation …). Die kleben per position:sticky an top:0 — also
     beim Scrollen genau UNTER unserer Leiste: unsichtbar und nicht mehr
     anklickbar. Deshalb: tatsächliche Höhe der Leiste messen und alles, was
     sich an den oberen Fensterrand heftet, um genau diesen Betrag nach unten
     schieben. Weil jeder Report seine Leiste anders nennt (.toolbar, .topbar,
     .search, .controls-wrap …), wird nicht nach Klassennamen gesucht, sondern
     danach, was sich tatsächlich oben festhält.

     Die Regeln stehen in einem eigenen <style data-lr-ui>, die Markierung ist
     ein Attribut, das cleanDoc entfernt — die gespeicherte Datei bleibt also
     unberührt.                                                              */
  const STICK = 'data-lr-sticky';
  const barCSS = mark(el('<style></style>'));
  document.head.appendChild(barCSS);
  let lastBarH = -1;

  function syncBar(force) {
    const h = Math.ceil(bar.getBoundingClientRect().height);
    if (!h || (h === lastBarH && !force)) return;
    lastBarH = h;

    // Erst zurücksetzen, damit die ursprünglichen Werte gemessen werden.
    document.querySelectorAll('[' + STICK + ']').forEach(n => n.removeAttribute(STICK));
    barCSS.textContent = '';
    document.body.style.setProperty('--lr-bar-height', h + 'px');

    /* Solche Leisten sitzen immer weit oben im Dokument — ein paar Ebenen
       unter <body> genügen und halten den Aufwand auch bei sehr großen
       Reports klein. */
    const offsets = new Set();
    (function walk(node, depth) {
      for (const child of node.children) {
        if (child.hasAttribute('data-lr-ui')) continue;
        if (/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(child.tagName)) continue;
        const cs = getComputedStyle(child);
        if (cs.position === 'sticky' || cs.position === 'fixed') {
          const top = parseFloat(cs.top);         // „auto“ ergibt NaN
          if (top === top && top < h) {
            const t = Math.max(0, Math.round(top));
            child.setAttribute(STICK, String(t));
            offsets.add(t);
            continue;                             // in der Leiste selbst klebt nichts mehr
          }
        }
        if (depth < 4) walk(child, depth + 1);
      }
    })(document.body, 0);

    /* Nur am Bildschirm: im Druck gibt es keine Editor-Leiste, unter der
       etwas Platz bräuchte (siehe @media print in editor.css). */
    let css = '';
    offsets.forEach(t => {
      css += 'body.lr-has-bar [' + STICK + '="' + t + '"]{top:' + (t + h) + 'px !important;}';
    });
    barCSS.textContent = css ? '@media screen{' + css + '}' : '';
  }

  syncBar(true);
  requestAnimationFrame(() => syncBar(true));
  // Schriften laden nach — danach kann die Leiste eine andere Höhe haben.
  window.addEventListener('load', () => syncBar(true));
  if ('ResizeObserver' in window) new ResizeObserver(() => syncBar(false)).observe(bar);
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    // Andere Fensterbreite kann andere Leisten kleben lassen (Media Queries).
    resizeTimer = setTimeout(() => syncBar(true), 150);
  });

  const statusEl = bar.querySelector('#lr-status');
  const saveBtn = bar.querySelector('#lr-save');
  const toggleBtn = bar.querySelector('#lr-toggle');

  const fileInput = mark(el('<input type="file" accept="image/*,.gif" hidden>'));
  document.body.appendChild(fileInput);

  /* ---------- Slash-Menü ---------- */
  const COMMANDS = [
    { cat: 'Text', key: 'text absatz p normal', ic: '¶', label: 'Text', hint: 'Normaler Absatz', run: () => fmt('P') },
    { cat: 'Text', key: 'überschrift gross h2 titel', ic: 'H', label: 'Überschrift groß', hint: 'Große Zwischenüberschrift', run: () => fmt('H2') },
    { cat: 'Text', key: 'überschrift klein h3', ic: 'h', label: 'Überschrift klein', hint: 'Kleine Zwischenüberschrift', run: () => fmt('H3') },
    { cat: 'Text', key: 'liste aufzählung bullet punkte', ic: '•', label: 'Aufzählung', hint: 'Liste mit Punkten', run: () => cmd('insertUnorderedList') },
    { cat: 'Text', key: 'nummeriert liste ordered zahlen', ic: '1.', label: 'Nummerierte Liste', hint: 'Liste mit Zahlen', run: () => cmd('insertOrderedList') },
    { cat: 'Text', key: 'zitat quote blockquote', ic: '❝', label: 'Zitat', hint: 'Eingerückter Zitatblock', run: () => insBlock('<blockquote class="lr-quote"><p>Zitat …</p></blockquote>') },
    { cat: 'Bausteine', key: 'toggle aufklappen einklappen dropdown', ic: '▸', label: 'Toggle', hint: 'Aufklappbarer Abschnitt', run: () => insBlock('<details class="toggle" open><summary>Überschrift</summary><div class="toggle-body"><p>Inhalt …</p></div></details>') },
    { cat: 'Bausteine', key: 'tabelle table', ic: '▦', label: 'Tabelle', hint: '2 Spalten, 2 Zeilen', run: () => insBlock('<div class="tw"><table><thead><tr><th>Spalte 1</th><th>Spalte 2</th></tr></thead><tbody><tr><td>…</td><td>…</td></tr><tr><td>…</td><td>…</td></tr></tbody></table></div>') },
    { cat: 'Bausteine', key: 'bild gif foto image upload', ic: '🖼', label: 'Bild / GIF', hint: 'Von der Festplatte einfügen', run: () => fileInput.click() },
    { cat: 'Bausteine', key: 'trennlinie linie divider hr', ic: '—', label: 'Trennlinie', hint: 'Horizontale Linie', run: () => insBlock('<hr class="lr-hr">') },
    { cat: 'Bausteine', key: 'folie chip verweis skript', ic: '📎', label: 'Folien-Chip', hint: 'Verweis auf eine Folie', run: () => ins('<span class="folie" title="Verweis auf die Vorlesungsfolie">📎 Folie&nbsp;X</span>&nbsp;') },
    { cat: 'Hinweis-Box', key: 'merksatz merken box grün', ic: '🧠', label: 'Merksatz', hint: 'Grüne Hinweisbox', run: () => box('merk', '🧠', 'Merksatz') },
    { cat: 'Hinweis-Box', key: 'klinik tipp box blau', ic: '🩺', label: 'Klinik-Tipp', hint: 'Blaue Hinweisbox', run: () => box('klin', '🩺', 'Klinik-Tipp') },
    { cat: 'Hinweis-Box', key: 'blickschulung box lila sehen', ic: '🔍', label: 'Blickschulung', hint: 'Lila Hinweisbox', run: () => box('blick', '🔍', 'Blickschulung') },
    { cat: 'Hinweis-Box', key: 'klausurfalle falle box rot warnung', ic: '⚠️', label: 'Klausurfalle', hint: 'Rote Warnbox', run: () => box('falle', '⚠️', 'Klausurfalle') },
    { cat: 'Hinweis-Box', key: 'fun fact etymologie box gold', ic: '💡', label: 'Fun Fact', hint: 'Goldene Box', run: () => box('fun', '💡', 'Etymologie & Fun Fact') },
    { cat: 'Hinweis-Box', key: 'ergänzung ergaenzung box quelle', ic: '📚', label: 'Ergänzung', hint: 'Ergänzend zum Skript', run: () => box('erg', '📚', 'Ergänzend zum Skript') },
    { cat: 'Hinweis-Box', key: 'prüfungsfokus pruefung box', ic: '🎯', label: 'Prüfungsfokus', hint: 'Orange Box', run: () => box('pruef', '🎯', 'Prüfungsfokus') },
    { cat: 'Hinweis-Box', key: 'selbsttest test box fragen', ic: '✅', label: 'Selbsttest', hint: 'Test-Box', run: () => box('test', '✅', 'Selbsttest') }
  ];
  const slashMenu = mark(el('<div id="lr-slash"></div>'));
  document.body.appendChild(slashMenu);

  /* ---------- Kleines Eingabefeld (Ersatz für window.prompt) ----------
     window.prompt raubt dem bearbeitbaren Bereich die Textmarkierung — danach
     fügte „OK“ den Kommentar ins Nichts ein und nichts wurde gespeichert.
     Dieses eigene Feld merkt sich die Auswahl und stellt sie beim OK wieder her. */
  const askBox = mark(el(
    '<div id="lr-ask">' +
      '<div class="lr-ask-h"></div>' +
      '<textarea class="lr-ask-in" rows="2" placeholder="Kommentar eingeben …"></textarea>' +
      '<div class="lr-ask-row">' +
        '<button type="button" class="lr-ask-cancel">Abbrechen</button>' +
        '<button type="button" class="lr-ask-ok">OK</button>' +
      '</div>' +
    '</div>'));
  document.body.appendChild(askBox);
  const askInput = askBox.querySelector('.lr-ask-in');
  const askHead = askBox.querySelector('.lr-ask-h');
  let askOnOk = null;

  function openAsk(opts) {
    askOnOk = opts.onOk || null;
    askHead.textContent = opts.title || '';
    askInput.value = opts.value || '';
    askInput.placeholder = opts.placeholder || 'Text eingeben …';
    askBox.style.display = 'block';
    positionAsk(opts.atRect);
    requestAnimationFrame(() => { askInput.focus(); askInput.select(); });
  }
  function positionAsk(rect) {
    const r = rect && (rect.width || rect.height || rect.left)
      ? rect : { left: innerWidth / 2 - 160, top: 120, bottom: 120, width: 0 };
    const bw = askBox.offsetWidth || 320, bh = askBox.offsetHeight || 120;
    let left = Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, innerWidth - bw - 8));
    let top = r.bottom + 10;
    if (top + bh > innerHeight - 8) top = Math.max(60, r.top - bh - 10);
    askBox.style.left = left + 'px';
    askBox.style.top = top + 'px';
  }
  function closeAsk() { askBox.style.display = 'none'; askOnOk = null; }

  /* Kurze Rückmeldung (z. B. „bitte zuerst markieren“). */
  const toastEl = mark(el('<div id="lr-toast"></div>'));
  document.body.appendChild(toastEl);
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }
  askBox.querySelector('.lr-ask-cancel').addEventListener('click', closeAsk);
  askBox.querySelector('.lr-ask-ok').addEventListener('click', () => {
    const val = askInput.value, cb = askOnOk;
    closeAsk();
    if (cb) cb(val);
  });
  askInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askBox.querySelector('.lr-ask-ok').click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeAsk(); }
  });

  /* Auswahl (Range) wiederherstellen und Cursor in den passenden Bereich setzen. */
  function editableOf(node) {
    const h = node && node.nodeType === 3 ? node.parentElement : node;
    return regions.find(r => r.contains(h)) || region;
  }
  function restoreRange(range) {
    editableOf(range.startContainer).focus({ preventScroll: true });
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(range);
  }

  /* ---------- Auswahl-Popover (Inline-Format + Textmarker) ---------- */
  const HL = { Gelb: '#fff3a3', Grün: '#c6f0d4', Blau: '#cfe3ff', Rosa: '#ffd6e7', Orange: '#ffe0b3' };
  const TC = { Grün: '#0e7c66', Blau: '#2563eb', Lila: '#7c3aed', Rot: '#c0392b', Gold: '#b8860b' };
  const ico = d => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    bold: ico('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z"/>'),
    italic: ico('<path d="M14 5h-4M14 19h-4M14.5 5 9.5 19"/>'),
    underline: ico('<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M5 20h14"/>'),
    strike: ico('<path d="M5 12h14"/><path d="M16 6.5A4 3 0 0 0 12 5c-2.5 0-4 1.3-4 3 0 1.2.8 2.2 2.5 2.8"/><path d="M8 17.5A4.5 3 0 0 0 12 19c2.6 0 4.2-1.3 4.2-3 0-.6-.2-1.2-.5-1.6"/>'),
    link: ico('<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>'),
    term: ico('<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8.5 9.5h7M8.5 12.5h4"/>'),
    chev: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
  };
  const pop = mark(el('<div id="lr-pop" role="toolbar" aria-label="Textformat"></div>'));
  pop.innerHTML =
    '<div class="lr-pop-row">' +
      `<button data-c="bold" title="Fett (Strg+B)" aria-label="Fett">${I.bold}</button>` +
      `<button data-c="italic" title="Kursiv (Strg+I)" aria-label="Kursiv">${I.italic}</button>` +
      `<button data-c="underline" title="Unterstrichen (Strg+U)" aria-label="Unterstrichen">${I.underline}</button>` +
      `<button data-c="strikeThrough" title="Durchgestrichen" aria-label="Durchgestrichen">${I.strike}</button>` +
      '<span class="lr-sep"></span>' +
      `<button data-act="color" class="lr-colorbtn" title="Farbe &amp; Textmarker" aria-label="Farbe und Textmarker"><span class="lr-a">A</span>${I.chev}</button>` +
      '<span class="lr-sep"></span>' +
      `<button data-act="link" title="Link einfügen" aria-label="Link">${I.link}</button>` +
      `<button data-act="term" class="lr-wide" title="Fachbegriff erklären (Tooltip)" aria-label="Erklärung">${I.term}<span>Erklärung</span></button>` +
    '</div>' +
    '<div class="lr-colors">' +
      '<div class="lr-col-h">Textmarker</div><div class="lr-col-g">' +
        '<button data-hl="transparent" class="lr-chip lr-none" title="Kein Marker"><span>A</span></button>' +
        Object.entries(HL).map(([n, c]) => `<button class="lr-chip" data-hl="${c}" title="${n}" style="background:${c}"><span>A</span></button>`).join('') +
      '</div>' +
      '<div class="lr-col-h">Schriftfarbe</div><div class="lr-col-g">' +
        '<button data-fc="inherit" class="lr-chip lr-plain" title="Standard"><span>A</span></button>' +
        Object.entries(TC).map(([n, c]) => `<button class="lr-chip lr-plain" data-fc="${c}" title="${n}"><span style="color:${c}">A</span></button>`).join('') +
      '</div>' +
    '</div>';
  document.body.appendChild(pop);
  const colorBtn = pop.querySelector('.lr-colorbtn');
  function setColorsOpen(open) { pop.classList.toggle('lr-colors-open', open); colorBtn.classList.toggle('on', open); }

  /* ---------- Bild-Werkzeugleiste + Anfasser ---------- */
  const imgbar = mark(el('<div id="lr-imgbar">' +
    '<button data-al="a-left" title="Links, Text fließt rechts">⬅</button>' +
    '<button data-al="a-center" title="Zentriert">▢</button>' +
    '<button data-al="a-right" title="Rechts, Text fließt links">➡</button>' +
    '<button data-al="a-full" title="Volle Breite">↔</button>' +
    '<span class="lr-sep"></span>' +
    '<button data-sz="220" title="Klein">S</button>' +
    '<button data-sz="360" title="Mittel">M</button>' +
    '<button data-sz="560" title="Groß">L</button>' +
    '<span class="lr-sep"></span>' +
    '<button data-act="del" title="Bild löschen">🗑</button>' +
    '</div>'));
  document.body.appendChild(imgbar);
  const resizeH = mark(el('<div id="lr-resize" title="Ziehen zum Skalieren"></div>'));
  document.body.appendChild(resizeH);

  /* ================= Zustand ================= */
  function setDirty(v) {
    dirty = v; saveBtn.disabled = !v;
    statusEl.textContent = v ? 'Nicht gespeichert' : 'Gespeichert';
    if (v) {
      rev++;
      scheduleAutosave();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => { if (dirty) writeDraft(); }, 1500);
    }
  }
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { if (dirty) save(); }, AUTOSAVE_DELAY);
  }
  function setEditing(v) {
    editing = v;
    hideHoverOverlays();
    document.body.classList.toggle('lr-editing', v);
    regions.forEach(r => r.setAttribute('contenteditable', v ? 'true' : 'false'));
    toggleBtn.textContent = v ? 'Fertig' : 'Bearbeiten';
    toggleBtn.classList.toggle('on', v);
    syncBar(false);            // andere Beschriftung → Leiste kann umbrechen
    if (!v) { hideSlash(); pop.style.display = 'none'; deselectImg(); if (dirty) save(); }
    else region.focus({ preventScroll: true });
  }
  toggleBtn.addEventListener('click', () => setEditing(!editing));
  onRegion('input', () => { setDirty(true); onType(); });

  /* ================= Format-Helfer ================= */
  function cmd(name, val) { focusRegion(); document.execCommand(name, false, val || null); setDirty(true); }
  function fmt(tag) { focusRegion(); document.execCommand('formatBlock', false, tag); setDirty(true); }
  function ins(html) { focusRegion(); document.execCommand('insertHTML', false, html); setDirty(true); }
  function box(cls, ic, label) {
    insBlock('<div class="cx ' + cls + '"><div class="cx-h">' + ic + ' <span>' + label +
      '</span></div><div class="cx-b"><p>Text …</p></div></div>');
  }
  /* Neuen Block genau dort einfügen, wo der Cursor steht — wie in Notion.
     Früher wurde am nächsten „bekannten“ Container (.chapter, .cx-b …)
     angesetzt; kannte eine Vorlage diese Klassen nicht, landete der Block
     hinter dem ganzen Kapitel — also ganz unten. Jetzt zählt nur noch der
     nächste Block um den Cursor herum. */
  const BLOCKISH = { block: 1, flex: 1, grid: 1, 'list-item': 1, 'table-cell': 1, 'flow-root': 1 };
  function blockAtCursor(node, root) {
    let n = node;
    while (n && n !== root && n.nodeType === 1) {
      if (BLOCKISH[getComputedStyle(n).display]) return n;
      n = n.parentNode;
    }
    return null;
  }

  function insBlock(html) {
    const root = focusRegion();
    const sel = window.getSelection();
    if (!sel.rangeCount || !inRegion(sel.anchorNode)) return ins(html);

    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    const block = blockAtCursor(node, root);
    if (!block || !block.parentNode) return ins(html);

    const frag = document.createElement('template');
    frag.innerHTML = html.trim();
    const first = frag.content.firstChild;

    if (/^(TD|TH|LI)$/.test(block.tagName)) {
      // In Zelle/Listenpunkt gehört der Block hinein, nicht daneben.
      block.appendChild(frag.content);
    } else if (!block.textContent.trim() && !block.querySelector('img,table,hr,iframe')) {
      // Leere Zeile (z. B. nur der /-Befehl stand darin) wird ersetzt,
      // damit keine leeren Absätze zurückbleiben.
      block.replaceWith(frag.content);
    } else {
      block.parentNode.insertBefore(frag.content, block.nextSibling);
    }

    // Cursor in den ersten sinnvollen Textbereich setzen
    const spot = first && (first.querySelector ? (first.querySelector('p,summary,td,th,li') || first) : first);
    if (spot) { const r = document.createRange(); r.selectNodeContents(spot); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest' });
    setDirty(true);
  }

  /* ================= Slash-Menü ================= */
  function onType() {
    if (!editing) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return hideSlash();
    const node = sel.focusNode;
    if (!node || node.nodeType !== 3 || !inRegion(node)) return hideSlash();
    const before = node.textContent.slice(0, sel.focusOffset);
    const m = before.match(/(?:^|\s)\/([^/\n]{0,25})$/);
    if (!m) return hideSlash();
    slashCtx = { node, start: sel.focusOffset - m[1].length - 1 };
    renderSlash(m[1].trim().toLowerCase());
  }
  function renderSlash(q) {
    const items = COMMANDS.filter(c => !q || c.label.toLowerCase().includes(q) || c.key.includes(q));
    if (!items.length) { slashMenu.innerHTML = '<div class="lr-none">Kein Befehl gefunden</div>'; }
    else {
      let html = '', cat = '';
      items.forEach((c, i) => {
        if (c.cat !== cat) { cat = c.cat; html += '<div class="lr-cat">' + cat + '</div>'; }
        html += '<div class="lr-item" data-i="' + COMMANDS.indexOf(c) + '"><div class="ic">' + c.ic +
          '</div><div class="tx"><b>' + c.label + '</b><small>' + c.hint + '</small></div></div>';
      });
      slashMenu.innerHTML = html;
    }
    slashMenu._items = items;
    slashIdx = 0;
    highlightSlash();
    slashMenu.querySelectorAll('.lr-item').forEach(it => {
      it.addEventListener('mousedown', e => { e.preventDefault(); runCommand(COMMANDS[+it.dataset.i]); });
    });
    // Position am Cursor
    const r = window.getSelection().getRangeAt(0).cloneRange();
    let rect = r.getBoundingClientRect();
    if (!rect.height) { const sp = document.createElement('span'); sp.textContent = '​'; r.insertNode(sp); rect = sp.getBoundingClientRect(); sp.remove(); }
    let top = rect.bottom + 6, left = rect.left;
    if (top + 340 > innerHeight) top = Math.max(60, rect.top - 346);
    if (left + 300 > innerWidth) left = innerWidth - 300;
    slashMenu.style.top = top + 'px';
    slashMenu.style.left = left + 'px';
    slashMenu.style.display = 'block';
  }
  function highlightSlash() {
    const items = slashMenu.querySelectorAll('.lr-item');
    items.forEach(it => it.classList.remove('sel'));
    const visible = slashMenu._items || [];
    if (!visible.length) return;
    slashIdx = (slashIdx + visible.length) % visible.length;
    const target = slashMenu.querySelector('.lr-item[data-i="' + COMMANDS.indexOf(visible[slashIdx]) + '"]');
    if (target) { target.classList.add('sel'); target.scrollIntoView({ block: 'nearest' }); }
  }
  function hideSlash() { slashMenu.style.display = 'none'; slashCtx = null; }
  function runCommand(c) {
    // "/query" entfernen
    if (slashCtx) {
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(slashCtx.node, slashCtx.start);
      r.setEnd(sel.focusNode, sel.focusOffset);
      r.deleteContents();
      sel.removeAllRanges(); sel.addRange(r);
    }
    hideSlash();
    c.run();
  }
  onRegion('keydown', e => {
    if (slashMenu.style.display !== 'block') return;
    const items = slashMenu._items || [];
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx++; highlightSlash(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx--; highlightSlash(); }
    else if (e.key === 'Enter') { if (items.length) { e.preventDefault(); runCommand(items[slashIdx]); } }
    else if (e.key === 'Escape') { e.preventDefault(); hideSlash(); }
  });

  /* ---------- Tab in Listen: Unterpunkt ein-/ausrücken (wie in Notion) ---------- */
  function currentListItem() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.anchorNode;
    if (n && n.nodeType === 3) n = n.parentNode;
    const li = n && n.closest ? n.closest('li') : null;
    return (li && inRegion(li)) ? li : null;
  }
  onRegion('keydown', e => {
    if (e.key !== 'Tab' || slashMenu.style.display === 'block') return;
    if (caretSummary()) return;            // im Toggle-Titel gilt Tab anders (s. u.)
    const li = currentListItem();
    if (!li) return;                       // außerhalb von Listen normal lassen
    e.preventDefault();
    if (e.shiftKey) outdentItem(li); else indentItem(li);
    setDirty(true);
  });

  /* Einrücken: den Punkt in eine Unterliste des VORHERIGEN Punktes schieben —
     so entsteht eine gültige, echte Verschachtelung (wie in Notion). Der erste
     Punkt einer Ebene lässt sich nicht weiter einrücken. */
  function indentItem(li) {
    const prev = li.previousElementSibling;
    if (!prev || prev.tagName !== 'LI') return;
    const type = (li.parentNode.tagName || 'UL').toLowerCase();
    let sub = prev.querySelector(':scope > ul, :scope > ol');
    if (!sub) { sub = document.createElement(type); prev.appendChild(sub); }
    sub.appendChild(li);
    placeCaretInItem(li);
  }
  /* Ausrücken: eine Ebene höher, direkt hinter den bisherigen Elternpunkt. */
  function outdentItem(li) {
    const parentList = li.parentNode;
    const hostLi = parentList.parentNode;
    if (!hostLi || hostLi.tagName !== 'LI') return;   // schon oberste Ebene
    const outerList = hostLi.parentNode;
    // spätere Geschwister bleiben als Unterpunkte an li hängen (Notion-Verhalten)
    let sib = li.nextElementSibling;
    if (sib) {
      let keep = li.querySelector(':scope > ul, :scope > ol');
      if (!keep) { keep = document.createElement(parentList.tagName.toLowerCase()); li.appendChild(keep); }
      while (sib) { const nx = sib.nextElementSibling; keep.appendChild(sib); sib = nx; }
    }
    outerList.insertBefore(li, hostLi.nextSibling);
    if (!parentList.children.length) parentList.remove();
    placeCaretInItem(li);
  }
  /* Cursor ans Ende des eigenen Textes des Punktes setzen (vor etwaige Unterliste). */
  function placeCaretInItem(li) {
    const walk = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement.closest('ul,ol') === li.querySelector(':scope>ul,:scope>ol')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    let last = null, n; while ((n = walk.nextNode())) last = n;
    const sel = window.getSelection(); const r = document.createRange();
    if (last) { r.setStart(last, last.textContent.length); r.collapse(true); }
    else { r.selectNodeContents(li); r.collapse(true); }
    sel.removeAllRanges(); sel.addRange(r);
  }

  /* ================= Auswahl-Popover ================= */
  function updatePopover() {
    if (!editing) return;
    const sel = window.getSelection();
    if (slashMenu.style.display === 'block') { pop.style.display = 'none'; return; }
    const hide = () => { pop.style.display = 'none'; setColorsOpen(false); };
    if (!sel.rangeCount || sel.isCollapsed || !inRegion(sel.anchorNode)) { hide(); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) { hide(); return; }
    pop.style.display = 'block';
    // Aktive Formate hervorheben
    pop.querySelectorAll('button[data-c]').forEach(b => {
      let on = false; try { on = document.queryCommandState(b.dataset.c); } catch (_) {}
      b.classList.toggle('on', on);
    });
    const row = pop.firstElementChild;
    const pw = row.offsetWidth, ph = row.offsetHeight;
    const topBar = (document.getElementById('lr-bar') || {}).offsetHeight || 0;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, innerWidth - pw - 8));
    let top = rect.top - ph - 10, above = true;
    if (top < topBar + 8) { top = rect.bottom + 10; above = false; }
    pop.classList.toggle('lr-above', above);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  document.addEventListener('selectionchange', () => { updatePopover(); onType(); });
  pop.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  pop.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'color') { setColorsOpen(!pop.classList.contains('lr-colors-open')); return; }
    focusRegion();
    if (b.dataset.c) document.execCommand(b.dataset.c, false, null);
    else if (b.dataset.hl) { document.execCommand('styleWithCSS', false, true); document.execCommand('hiliteColor', false, b.dataset.hl); setColorsOpen(false); }
    else if (b.dataset.fc) { document.execCommand('styleWithCSS', false, true); document.execCommand('foreColor', false, b.dataset.fc); setColorsOpen(false); }
    else if (b.dataset.act === 'link') { makeLink(); return; }
    else if (b.dataset.act === 'term') { makeTerm(); return; }
    setDirty(true);
    setTimeout(updatePopover, 0);
  });

  /* Link setzen — ebenfalls über das eigene Feld, damit die Auswahl erhalten bleibt. */
  function makeLink() {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { toast('Bitte zuerst den Text markieren, der verlinkt werden soll.'); return; }
    pop.style.display = 'none';
    const range = sel.getRangeAt(0).cloneRange();
    openAsk({
      title: 'Link-Adresse (URL):',
      value: 'https://',
      placeholder: 'https://…',
      atRect: range.getBoundingClientRect(),
      onOk: val => {
        const url = val.trim();
        if (!url || url === 'https://') return;
        restoreRange(range);
        document.execCommand('createLink', false, url);
        setDirty(true);
      }
    });
  }

  /* Fachbegriff mit Tooltip/Kommentar auszeichnen (oder bestehenden bearbeiten) */
  const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function makeTerm() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    pop.style.display = 'none';

    // Liegt die Auswahl in einem bestehenden Begriff? → bearbeiten statt neu anlegen
    let node = sel.anchorNode; if (node && node.nodeType === 3) node = node.parentNode;
    const existing = node && node.closest ? node.closest('.lr-term') : null;
    if (existing) {
      openAsk({
        title: 'Kommentar zu „' + existing.textContent.trim() + '“ (leer = entfernen):',
        value: existing.getAttribute('data-tip') || '',
        atRect: existing.getBoundingClientRect(),
        onOk: val => {
          hideTip();
          if (val.trim() === '') { existing.replaceWith(document.createTextNode(existing.textContent)); }
          else existing.setAttribute('data-tip', val.trim());
          setDirty(true);
        }
      });
      return;
    }

    const text = sel.toString().trim();
    if (!text) { toast('Bitte zuerst den Begriff markieren, der einen Kommentar bekommen soll.'); return; }
    // Auswahl JETZT sichern — das Eingabefeld nimmt gleich den Fokus.
    const range = sel.getRangeAt(0).cloneRange();
    openAsk({
      title: 'Kommentar zu „' + text + '“:',
      value: '',
      atRect: range.getBoundingClientRect(),
      onOk: val => {
        if (val.trim() === '') return;
        wrapAsTerm(range, val.trim());
        setDirty(true);
      }
    });
  }

  /* Markierten Text in einen Kommentar-Span packen — direkt über die Range-API,
     ohne execCommand. Das funktioniert in Absätzen, Tabellenzellen und Listen
     gleichermaßen, braucht keinen Fokus und hängt keine Inline-Styles an. */
  function wrapAsTerm(range, tip) {
    const span = document.createElement('span');
    span.className = 'lr-term';
    span.setAttribute('data-tip', tip);
    try {
      range.surroundContents(span);
    } catch (e) {
      // Auswahl überschreitet Elementgrenzen → Inhalt herauslösen und einpacken
      span.appendChild(range.extractContents());
      range.insertNode(span);
    }
    // Schmales Nullbreiten-Zeichen dahinter, damit man normal weiterschreiben kann
    const zw = document.createTextNode('​');
    span.parentNode.insertBefore(zw, span.nextSibling);
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStartAfter(zw); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
  }

  /* ================= Bild-Upload ================= */
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; fileInput.value = ''; if (!f) return;
    statusEl.textContent = 'Lade Bild …';
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const ext = ((f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || (f.type.split('/')[1] || 'png')).toLowerCase().replace('jpeg', 'jpg');
      const rel = await LH.hashName(bytes, ext);
      await LH.putImage('lectures/' + rel, LH.b64FromBytes(bytes));
      const url = URL.createObjectURL(f);
      ins('<img class="lr-img a-center" src="' + url + '" data-gh-src="' + rel + '" alt=""><p><br></p>');
      statusEl.textContent = dirty ? 'Nicht gespeichert' : 'Gespeichert';
    } catch (err) { statusEl.textContent = 'Upload-Fehler: ' + (err.message || ''); }
  });

  /* ================= Bild auswählen / ausrichten / skalieren / verschieben ================= */
  function selectImg(img) {
    deselectImg();
    selImg = img; img.classList.add('lr-sel'); img.setAttribute('draggable', 'true');
    positionImgUI();
    imgbar.style.display = 'flex'; resizeH.style.display = 'block';
  }
  function deselectImg() {
    if (selImg) { selImg.classList.remove('lr-sel'); selImg.removeAttribute('draggable'); }
    selImg = null; imgbar.style.display = 'none'; resizeH.style.display = 'none';
  }
  function positionImgUI() {
    if (!selImg) return;
    const r = selImg.getBoundingClientRect();
    let top = r.top - imgbar.offsetHeight - 8; if (top < 60) top = r.top + 8;
    imgbar.style.top = top + 'px';
    imgbar.style.left = Math.max(8, Math.min(r.left, innerWidth - imgbar.offsetWidth - 8)) + 'px';
    resizeH.style.left = (r.right - 8) + 'px';
    resizeH.style.top = (r.bottom - 8) + 'px';
  }
  onRegion('click', e => {
    if (!editing) return;
    if (e.target.tagName === 'IMG') { e.preventDefault(); selectImg(e.target); }
    else deselectImg();
  });
  imgbar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  imgbar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !selImg) return;
    if (b.dataset.al) { selImg.classList.remove('a-left', 'a-right', 'a-center', 'a-full'); selImg.classList.add(b.dataset.al);
      if (b.dataset.al === 'a-full') selImg.style.width = ''; }
    else if (b.dataset.sz) { selImg.classList.remove('a-full'); selImg.style.width = b.dataset.sz + 'px'; }
    else if (b.dataset.act === 'del') { const p = selImg.closest('figure.lr-figure') || selImg; deselectImg(); p.remove(); setDirty(true); return; }
    setDirty(true); positionImgUI();
  });
  // Skalieren per Anfasser
  resizeH.addEventListener('mousedown', e => {
    if (!selImg) return; e.preventDefault();
    const startX = e.clientX, startW = selImg.getBoundingClientRect().width;
    const maxW = (selImg.closest('[contenteditable]') || region).clientWidth - 40;
    selImg.classList.remove('a-full');
    const move = ev => { let w = Math.round(startW + (ev.clientX - startX)); w = Math.max(60, Math.min(w, maxW)); selImg.style.width = w + 'px'; positionImgUI(); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); setDirty(true); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  // Verschieben per Drag an eine Textstelle
  onRegion('dragstart', e => { if (editing && e.target.tagName === 'IMG') e.dataTransfer.setData('text/lr-img', '1'); });
  onRegion('dragover', e => { if (editing && selImg) e.preventDefault(); });
  onRegion('drop', e => {
    if (!editing || !selImg) return; e.preventDefault();
    const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY)
      : (document.caretPositionFromPoint && (() => { const c = document.caretPositionFromPoint(e.clientX, e.clientY); const r = document.createRange(); r.setStart(c.offsetNode, c.offset); return r; })());
    if (pos) { pos.insertNode(selImg); setDirty(true); positionImgUI(); }
  });
  window.addEventListener('scroll', () => { if (selImg) positionImgUI(); if (pop.style.display === 'block') updatePopover(); }, true);
  window.addEventListener('resize', () => { if (selImg) positionImgUI(); });

  document.addEventListener('keydown', e => {
    if (!editing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selImg && document.activeElement !== fileInput) {
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault(); const p = selImg.closest('figure.lr-figure') || selImg; deselectImg(); p.remove(); setDirty(true);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });

  /* ================= PDF-Export (1:1 via Druck) ================= */
  bar.querySelector('#lr-pdf').addEventListener('click', () => {
    const wasEditing = editing;
    if (wasEditing) setEditing(false);
    statusEl.textContent = 'Bilder laden …';
    LH.loadAllImages().then(() => new Promise(r => setTimeout(r, 300))).then(() => {
      statusEl.textContent = dirty ? 'Nicht gespeichert' : 'Gespeichert';
      window.print(); if (wasEditing) setEditing(true);
    });
  });

  /* ================= Speichern ================= */
  function cleanDoc() {
    // In ein unsichtbares Dokument kopieren: dort lädt der Browser keine Bilder nach.
    const clone = document.implementation.createHTMLDocument('').importNode(document.documentElement, true);
    clone.querySelectorAll('[data-lr-ui]').forEach(n => n.remove());
    const b = clone.querySelector('body');
    if (b) {
      b.classList.remove('lr-editing', 'lr-has-bar');
      b.style.removeProperty('--lr-bar-height');
    }
    // Markierung der verschobenen Sticky-Leisten gehört nicht in die Datei.
    clone.querySelectorAll('[' + STICK + ']').forEach(n => n.removeAttribute(STICK));
    clone.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
    clone.querySelectorAll('.lr-sel').forEach(n => n.classList.remove('lr-sel'));
    clone.querySelectorAll('img[draggable]').forEach(n => n.removeAttribute('draggable'));
    // Bilder aus dem privaten Repo: wieder den echten, relativen Pfad eintragen.
    clone.querySelectorAll('img[data-gh-src]').forEach(n => { n.setAttribute('src', n.getAttribute('data-gh-src')); n.removeAttribute('data-gh-src'); });
    // Laufzeit-Reste der Toggle-Animation dürfen nie in der Datei landen.
    clone.querySelectorAll('.lr-animating').forEach(n => {
      n.classList.remove('lr-animating');
      n.style.height = '';
    });
    // Platzhalter-Umbruch aus (noch) leeren Toggle-Titeln entfernen.
    clone.querySelectorAll('summary > br:last-child').forEach(n => n.remove());
    clone.querySelectorAll('[style=""]').forEach(n => n.removeAttribute('style'));
    clone.querySelectorAll('[class=""]').forEach(n => n.removeAttribute('class'));
    return '<!doctype html>\n' + clone.outerHTML;
  }
  /* Speichern = ein Commit ins private Repo. Die mitgeschickte Versionskennung
     (sha) sorgt dafür, dass GitHub ablehnt, wenn die Datei inzwischen auf einem
     anderen Gerät geändert wurde — dann gibt es eine Rückfrage statt Datenverlust. */
  async function save(force) {
    if (!dirty || saving) return;
    clearTimeout(autosaveTimer);
    saving = true;
    const myRev = rev;
    const content = cleanDoc();
    writeDraft(content);
    statusEl.textContent = 'Speichere …';
    try {
      if (force) DOC.sha = (await LH.tree()).get('lectures/' + DOC.file) || null;
      DOC.sha = await LH.putText('lectures/' + DOC.file, content, DOC.sha, 'Bearbeitet: ' + DOC.file);
      if (rev === myRev) { setDirty(false); LH.drafts.del(DOC.file); statusEl.textContent = 'Gespeichert'; }
      else scheduleAutosave();
      hideConflict();
    } catch (err) {
      if (err.conflict) { statusEl.textContent = 'Konflikt'; showConflict(); }
      else if (err.status === 0) { statusEl.textContent = 'Offline — Entwurf auf dem Gerät gesichert'; clearTimeout(autosaveTimer); autosaveTimer = setTimeout(() => save(), 15000); }
      else statusEl.textContent = 'Fehler: ' + (err.message || 'Speichern fehlgeschlagen');
    } finally { saving = false; }
  }
  function writeDraft(content) {
    LH.drafts.set(DOC.file, { baseSha: DOC.sha, html: content || cleanDoc(), t: Date.now() });
  }

  /* ---------- Hinweisleiste (Konflikt / Entwurf) ---------- */
  const note = mark(el('<div id="lr-note"><span class="lr-note-t"></span><span class="lr-note-b"></span></div>'));
  document.body.appendChild(note);
  function showNote(text, buttons) {
    note.querySelector('.lr-note-t').textContent = text;
    const b = note.querySelector('.lr-note-b'); b.innerHTML = '';
    buttons.forEach(([label, fn, primary]) => {
      const x = document.createElement('button'); x.textContent = label; if (primary) x.className = 'pri';
      x.addEventListener('click', fn); b.appendChild(x);
    });
    note.style.display = 'flex';
  }
  function hideConflict() { note.style.display = 'none'; }
  function showConflict() {
    showNote('Dieser Report wurde inzwischen auf einem anderen Gerät geändert. Deine Änderungen sind hier als Entwurf gesichert.', [
      ['Andere Version laden', () => { dirty = false; location.reload(); }],
      ['Meine Version speichern', () => { hideConflict(); save(true); }, true]
    ]);
  }
  setTimeout(() => {
    const d = LH.drafts.get(DOC.file);
    if (DOC.fromDraft) {
      setEditing(true); setDirty(true);
      return;
    }
    if (!d || !d.html) return;
    const when = new Date(d.t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    const stale = d.baseSha !== DOC.sha;
    showNote((stale
      ? 'Ungespeicherter Entwurf vom ' + when + ' gefunden — der Report wurde seitdem woanders geändert. Wiederherstellen überschreibt diese Änderungen.'
      : 'Ungespeicherter Entwurf vom ' + when + ' gefunden.'), [
      ['Verwerfen', () => { LH.drafts.del(DOC.file); hideConflict(); }],
      ['Wiederherstellen', () => { const u = new URL(location.href); u.searchParams.set('draft', '1'); location.href = u.href; }, true]
    ]);
  }, 0);
  LH.hydrateImages(document);
  if (document.readyState === 'complete') LH.prefetchImages(); else window.addEventListener('load', () => LH.prefetchImages());
  saveBtn.addEventListener('click', () => save());
  // App wechseln / Handy sperren: sofort speichern statt auf den Timer zu warten.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) { writeDraft(); save(); } });
  window.addEventListener('pagehide', () => { if (dirty) writeDraft(); });
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ================= Fachbegriff-Tooltips (Hover-Popup) ================= */
  const tipBox = mark(el('<div id="lr-tip"></div>'));
  document.body.appendChild(tipBox);
  let tipTarget = null;
  function showTip(term) {
    const txt = term.getAttribute('data-tip'); if (!txt) return;
    tipTarget = term;
    tipBox.innerHTML = '<div class="lr-tip-h">' + I.term + 'Erklärung</div>';
    tipBox.appendChild(document.createTextNode(txt));
    tipBox.style.display = 'block';
    const r = term.getBoundingClientRect();
    const tw = tipBox.offsetWidth, th = tipBox.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, innerWidth - tw - 8));
    let top = r.top - th - 10;
    if (top < 60) top = r.bottom + 10;
    tipBox.style.left = left + 'px'; tipBox.style.top = top + 'px';
    requestAnimationFrame(() => tipBox.classList.add('show'));
  }
  function hideTip() {
    tipTarget = null; tipBox.classList.remove('show');
    setTimeout(() => { if (!tipTarget) tipBox.style.display = 'none'; }, 160);
  }
  document.addEventListener('mouseover', e => {
    const t = e.target.closest && e.target.closest('.lr-term'); if (t) showTip(t);
  });
  document.addEventListener('mouseout', e => {
    const t = e.target.closest && e.target.closest('.lr-term'); if (t) hideTip();
  });

  /* ================= Bild-Lightbox + Lupe-Hinweis ================= */
  const zoomHint = mark(el('<div id="lr-zoomhint"><span class="ic">🔍</span><span>Zum Vergrößern klicken</span></div>'));
  document.body.appendChild(zoomHint);
  const lightbox = mark(el('<div id="lr-lightbox">' +
    '<button class="lr-lb-close" title="Schließen (Esc)" aria-label="Schließen">×</button>' +
    '<img alt=""><div class="lr-lb-cap"></div></div>'));
  document.body.appendChild(lightbox);
  const lbImg = lightbox.querySelector('img');
  const lbCap = lightbox.querySelector('.lr-lb-cap');

  function isContentImg(node) {
    return node && node.tagName === 'IMG' && inRegion(node);
  }
  function positionZoomHint(img) {
    const r = img.getBoundingClientRect();
    zoomHint.style.display = 'flex';
    const hw = zoomHint.offsetWidth;
    zoomHint.style.left = Math.max(8, r.right - hw - 10) + 'px';
    zoomHint.style.top = Math.max(64, r.top + 10) + 'px';
  }
  function hideZoomHint() { zoomHint.style.display = 'none'; }
  function openLightbox(src, cap) {
    lbImg.src = src; lbCap.textContent = cap || '';
    lightbox.style.display = 'flex';
    document.body.classList.add('lr-lightbox-open');
    requestAnimationFrame(() => lightbox.classList.add('show'));
  }
  function closeLightbox() {
    lightbox.classList.remove('show');
    document.body.classList.remove('lr-lightbox-open');
    setTimeout(() => { lightbox.style.display = 'none'; lbImg.src = ''; }, 210);
  }
  // Nur außerhalb des Bearbeiten-Modus: Bilder sind anklickbar zum Vergrößern
  onRegion('mouseover', e => {
    if (editing) return;
    if (isContentImg(e.target)) { e.target.style.cursor = 'zoom-in'; positionZoomHint(e.target); }
  });
  onRegion('mouseout', e => { if (isContentImg(e.target)) hideZoomHint(); });
  onRegion('click', e => {
    if (editing) return;
    if (!isContentImg(e.target)) return;
    e.preventDefault();
    const fig = e.target.closest('figure');
    const capEl = fig && fig.querySelector('figcaption');
    const cap = capEl ? capEl.textContent.trim() : (e.target.getAttribute('alt') || '');
    openLightbox(e.target.currentSrc || e.target.src, cap);
  });
  lightbox.addEventListener('click', e => {
    if (e.target === lightbox || e.target.closest('.lr-lb-close')) closeLightbox();
  });

  /* Overlays beim Scrollen / Moduswechsel / Esc aufräumen */
  function hideHoverOverlays() { hideTip(); hideZoomHint(); }
  window.addEventListener('scroll', hideHoverOverlays, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && lightbox.style.display === 'flex') { e.preventDefault(); closeLightbox(); }
  });

  /* ================= Toggles (nach Notion-Vorbild) =================
     Notion verhält sich so:
       · Das Dreieck links schaltet auf und zu und dreht sich dabei um 90°.
       · Auf die Überschrift zu klicken setzt den Cursor — es klappt NICHT zu.
         Genau daran scheitert <details>/<summary>, denn dort schaltet jeder
         Klick auf die Zeile um; im Bearbeiten-Modus kann man den Titel dann
         nicht anfassen, ohne dass der Abschnitt zuklappt.
       · Auf- und Zuklappen ist animiert, nicht ruckartig.
     Umgesetzt ohne Änderung am gespeicherten HTML: die vorhandenen
     <details>-Blöcke bleiben, wie sie sind. */
  const ANIM_MS = 220;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animateToggle(d, open) {
    if (d._lrTimer) { clearTimeout(d._lrTimer); d._lrTimer = null; }
    if (reduceMotion) { d.open = open; return; }

    const sum = d.querySelector(':scope > summary');
    const startH = d.getBoundingClientRect().height;
    if (open) d.open = true;                       // Inhalt muss messbar sein
    const endH = open ? d.scrollHeight
                      : (sum ? sum.getBoundingClientRect().height : 0);

    d.classList.add('lr-animating');
    d.style.height = startH + 'px';
    void d.offsetHeight;                           // Reflow erzwingen
    d.style.height = endH + 'px';

    d._lrTimer = setTimeout(() => {
      d.style.height = '';
      d.classList.remove('lr-animating');
      if (!open) d.open = false;
      d._lrTimer = null;
    }, ANIM_MS);
  }

  /* Sitzt der Klick auf dem Dreieck (linker Rand der Zeile)? */
  function onMarker(ev, sum) {
    if (ev.detail === 0) return true;              // Tastatur (Enter/Leertaste)
    const r = sum.getBoundingClientRect();
    return ev.clientX <= r.left + 30;
  }

  document.addEventListener('click', ev => {
    const sum = ev.target.closest && ev.target.closest('summary');
    if (!sum) return;
    const d = sum.parentElement;
    if (!d || d.tagName !== 'DETAILS') return;
    if (ev.target.closest('a')) return;            // Links im Titel gewinnen

    // Beim Bearbeiten schaltet nur das Dreieck — sonst käme man an den
    // Titeltext nicht heran, ohne den Abschnitt zuzuklappen.
    if (editing && !onMarker(ev, sum)) { ev.preventDefault(); return; }

    ev.preventDefault();
    animateToggle(d, !d.open);
  }, true);

  /* ---------- Tastatur im Toggle-Titel (wie in Notion) --------------------
     Enter            → neuer Toggle direkt darunter, Cursor in dessen Titel
     Umschalt+Enter   → Cursor in den Inhalt DIESES Toggles (z. B. Antwort
     bzw. Tab           unter die Frage schreiben); klappt ihn dabei auf
     Umschalt+Tab     → aus dem Inhalt zurück in den Titel
     Rücktaste        → leeren Toggle wieder entfernen
     Ohne diese Behandlung entscheidet der Browser, was Enter in einem
     <summary> bedeutet — und wirft den Cursor irgendwohin unter den Block. */

  const nodeEl = n => (n && n.nodeType === 3) ? n.parentNode : n;

  /* Steht der Cursor in einem Toggle-Titel? Dann dieses <summary> liefern. */
  function caretSummary() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const n = nodeEl(sel.anchorNode);
    const sum = (n && n.closest) ? n.closest('summary') : null;
    if (!sum || !inRegion(sum)) return null;
    const d = sum.parentElement;
    return (d && d.tagName === 'DETAILS') ? sum : null;
  }
  /* … und umgekehrt: im INHALT eines Toggles? Dann das <details> liefern. */
  function caretDetails() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const n = nodeEl(sel.anchorNode);
    if (!n || !n.closest || n.closest('summary')) return null;
    const d = n.closest('details');
    return (d && inRegion(d)) ? d : null;
  }

  /* Der Inhaltsrahmen eines Klapp-Blocks. Die Toggle-Bausteine benutzen
     „.toggle-body“, die berichtseigenen Blöcke ihr eigenes Gegenstück
     („.solution-body“ …). Fehlt so ein Rahmen, liegt der Inhalt direkt
     im <details> — dann ist das <details> selbst der Rahmen. */
  function bodyOf(d) {
    for (const c of d.children) {
      if (c.tagName === 'SUMMARY') continue;
      return /(^|\s)[\w-]*body(\s|$)/.test(c.className || '') ? c : d;
    }
    return d;
  }

  const isTextBlock = n => n && /^(P|H1|H2|H3|H4|H5|H6|DIV|UL|OL|LI|BLOCKQUOTE|TABLE)$/.test(n.tagName);

  /* Cursor an den Anfang bzw. das Ende eines Elements setzen. */
  function placeCaret(host, atEnd) {
    if (!host) return;
    const sel = window.getSelection(), r = document.createRange();
    let last = null;
    if (atEnd) {
      const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let n; while ((n = w.nextNode())) last = n;
    }
    if (last) { r.setStart(last, last.textContent.length); r.collapse(true); }
    else { r.selectNodeContents(host); r.collapse(true); }
    sel.removeAllRanges(); sel.addRange(r);
    if (host.scrollIntoView) host.scrollIntoView({ block: 'nearest' });
  }

  /* Ein leerer Titel braucht einen Umbruch als Platzhalter, sonst hat der
     Cursor keine Zeile, in der er stehen kann. Beim Speichern fliegt er
     wieder heraus (siehe cleanDoc). */
  function padSummary(sum) {
    while (sum.lastChild && sum.lastChild.nodeName === 'BR') sum.lastChild.remove();
    if (!sum.textContent.trim() && !sum.querySelector('img'))
      sum.appendChild(document.createElement('br'));
  }

  /* Umschalt+Enter / Tab: in den Inhalt des Toggles springen. */
  function focusToggleBody(d) {
    if (!d.open) animateToggle(d, true);
    const body = bodyOf(d);
    let last = null;
    for (const c of body.children) if (c.tagName !== 'SUMMARY') last = c;
    if (!isTextBlock(last)) {
      last = el('<p><br></p>');
      body.appendChild(last);
      setDirty(true);
    }
    placeCaret(last, true);
  }

  /* Enter: neuen Toggle auf derselben Ebene anlegen. Text hinter dem Cursor
     wandert in den neuen Titel — genauso teilt Notion eine Zeile. */
  function newToggleAfter(d, sum) {
    const sel = window.getSelection();
    let tail = null;
    if (sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (!sel.isCollapsed) r.deleteContents();
      // Nur teilen, wenn das Ende der Auswahl wirklich im Titel liegt —
      // sonst würde eine über den Block hinausreichende Auswahl den ganzen
      // Titel mitnehmen.
      if (sum.contains(r.endContainer)) {
        const cut = document.createRange();
        cut.setStart(r.endContainer, r.endOffset);
        cut.setEnd(sum, sum.childNodes.length);
        tail = cut.extractContents();
      }
    }
    padSummary(sum);

    const nd = document.createElement('details');
    if (d.className) nd.className = d.className;      // gleiche Optik wie der Nachbar
    nd.open = true;
    const ns = document.createElement('summary');
    if (tail) ns.appendChild(tail);
    padSummary(ns);
    nd.appendChild(ns);

    const body = bodyOf(d);
    if (body === d) nd.appendChild(el('<p><br></p>'));
    else {
      const nb = document.createElement(body.tagName.toLowerCase());
      if (body.className) nb.className = body.className;
      nb.appendChild(el('<p><br></p>'));
      nd.appendChild(nb);
    }

    d.parentNode.insertBefore(nd, d.nextSibling);
    placeCaret(ns, false);
    setDirty(true);
  }

  /* Rücktaste am Anfang eines vollständig leeren Toggles: Block entfernen. */
  function isEmptyToggle(d, sum) {
    if (sum.textContent.trim() || sum.querySelector('img')) return false;
    if (d.querySelector('img,table,hr,iframe')) return false;
    const body = bodyOf(d);
    const txt = (body === d)
      ? [...d.children].filter(c => c.tagName !== 'SUMMARY').map(c => c.textContent).join('')
      : body.textContent;
    return !txt.trim();
  }
  function atStartOf(host) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0), pre = document.createRange();
    pre.selectNodeContents(host);
    pre.setEnd(r.startContainer, r.startOffset);
    return !pre.toString().trim();
  }
  function removeToggle(d) {
    const prev = d.previousElementSibling;
    const host = d.parentNode;
    d.remove();
    if (prev && prev.tagName === 'DETAILS') placeCaret(prev.querySelector(':scope > summary'), true);
    else if (prev) placeCaret(prev, true);
    else placeCaret(host, false);
    setDirty(true);
  }

  onRegion('keydown', e => {
    if (!editing || e.defaultPrevented) return;
    if (slashMenu.style.display === 'block') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const sum = caretSummary();
    if (sum) {
      const d = sum.parentElement;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return newToggleAfter(d, sum); }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); return focusToggleBody(d); }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); return focusToggleBody(d); }
      if (e.key === 'Backspace' && isEmptyToggle(d, sum) && atStartOf(sum)) {
        e.preventDefault(); return removeToggle(d);
      }
      return;
    }
    // Umschalt+Tab im Inhalt: zurück in den Titel (Listen behalten ihr Ausrücken).
    if (e.key === 'Tab' && e.shiftKey && !currentListItem()) {
      const d = caretDetails();
      if (d) { e.preventDefault(); placeCaret(d.querySelector(':scope > summary'), true); }
    }
  });

  if (location.hash === '#edit' || new URLSearchParams(location.search).get('edit') === '1') setEditing(true);
})();
