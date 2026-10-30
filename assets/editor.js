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
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) {}

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
    { cat: 'Bausteine', key: 'toggle aufklappen einklappen dropdown', ic: '▸', label: 'Toggle', hint: 'Aufklappbarer Abschnitt', run: () => insBlock('<details class="toggle" open><summary><br></summary><div class="toggle-body"></div></details>') },
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
    if (v) { repair(); UM.start(); } else UM.stop();
    toggleBtn.textContent = v ? 'Fertig' : 'Bearbeiten';
    toggleBtn.classList.toggle('on', v);
    syncBar(false);            // andere Beschriftung → Leiste kann umbrechen
    if (!v) { hideSlash(); pop.style.display = 'none'; deselectImg(); if (dirty) save(); }
    else region.focus({ preventScroll: true });
  }
  toggleBtn.addEventListener('click', () => setEditing(!editing));
  onRegion('input', () => { setDirty(true); onType(); });

  /* ================= Format-Helfer ================= */
  function cmd(name, val) { focusRegion(); act(() => document.execCommand(name, false, val || null)); }
  function fmt(tag) { focusRegion(); act(() => document.execCommand('formatBlock', false, tag)); }
  function ins(html) { focusRegion(); act(() => document.execCommand('insertHTML', false, html)); }
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
    UM.commit(); UM.note();
    const root = focusRegion();
    const sel = window.getSelection();
    if (!sel.rangeCount || !inRegion(sel.anchorNode)) return ins(html);

    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    let block = blockAtCursor(node, root);
    // Im Toggle-Titel: neuen Block hinter den ganzen Toggle setzen, nie hinein.
    const inSum = node.closest && node.closest('summary');
    if (inSum && inSum.parentElement && inSum.parentElement.tagName === 'DETAILS' && inRegion(inSum)) block = inSum.parentElement;
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
    UM.commit();
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
    if (e.defaultPrevented) return;        // im Toggle-Titel/-Inhalt schon erledigt (s. u.)
    const li = currentListItem();
    if (!li) return;                       // außerhalb von Listen normal lassen
    e.preventDefault();
    act(() => { if (e.shiftKey) outdentItem(li); else indentItem(li); });
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
    UM.commit(); UM.note();
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
    UM.commit(); UM.note();
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

  /* ================= Toggles – Verhalten 1:1 wie in Notion =================
     Am echten Notion gemessen (Okt. 2026). Gespeichert wird weiterhin ganz
     normales <details><summary>…</summary>Inhalt</details> — nur die
     Bedienung im Browser ist neu.

     Maus
       · Dreieck            → auf/zu (animiert). Beim Bearbeiten NUR das Dreieck;
                              ein Klick auf den Titel setzt den Cursor.
       · Leerer Toggle      → Klick in die graue Zeile legt die erste Zeile an.
     Im Titel
       · Enter              → offen: neue Zeile als ERSTER Inhalt des Toggles
                              zu:   neuer (zugeklappter) Toggle darunter
                              Text hinter dem Cursor wandert mit.
       · Enter am Anfang    → leerer Toggle darüber, Cursor bleibt
       · Enter, Titel leer  → Toggle wird normaler Text
       · Umschalt+Enter     → Zeilenumbruch im Titel
       · Rücktaste am Anfang→ Toggle wird normaler Text (Inhalt bleibt darunter)
       · Entf am Ende       → offen: erste Inhaltszeile wird angehängt
                              zu:   nächster Absatz wird angehängt
       · Strg/⌘+Enter       → auf/zu
       · Tab / Umschalt+Tab → ganzen Toggle ein-/ausrücken
     Im Inhalt
       · Rücktaste am Anfang der ERSTEN Zeile  → Zeile wandert in den Titel
       · Rücktaste am Anfang der LETZTEN Zeile → Zeile rückt aus dem Toggle aus
       · Rücktaste direkt nach einem Toggle    → zu: in den Titel, offen: an
                                                 dessen letzte Zeile
       · Tab direkt unter einem Toggle         → Zeile wandert hinein (klappt auf)
       · Umschalt+Tab                          → Zeile rückt aus
     Überall
       · „> “ am Zeilenanfang        → Zeile wird Toggle
       · Strg+Umschalt+7 / ⌘⌥7       → Zeile wird Toggle
       · Strg+Alt+T / ⌘⌥T            → alle Toggles zu (bzw. alle auf, wenn alle zu)
       · Strg/⌘+Z, Strg/⌘+Umschalt+Z, Strg+Y → Rückgängig / Wiederholen
         (eigener Verlauf: der Browser kennt die Umbauten oben nicht)       */

  const ANIM_MS = 220;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ZW = /[​﻿]/g;
  const isDetails = n => !!n && n.nodeType === 1 && n.tagName === 'DETAILS';
  const sumOf = d => d.querySelector(':scope > summary');
  const nodeEl = n => (n && n.nodeType === 3) ? n.parentNode : n;

  /* ---------- Auf- und Zuklappen ---------- */
  const wantOpen = d => (d._lrWant != null ? d._lrWant : d.open);
  function animateToggle(d, open) {
    if (d._lrTimer) { clearTimeout(d._lrTimer); d._lrTimer = null; }
    d._lrWant = open;
    if (reduceMotion || !d.isConnected) { d.open = open; d._lrWant = null; return; }
    const sum = sumOf(d);
    const startH = d.getBoundingClientRect().height;
    if (open) d.open = true;                       // Inhalt muss messbar sein
    const endH = open ? d.scrollHeight : (sum ? sum.getBoundingClientRect().height : 0);
    d.classList.add('lr-animating');
    d.style.height = startH + 'px';
    void d.offsetHeight;                           // Reflow erzwingen
    d.style.height = endH + 'px';
    d._lrTimer = setTimeout(() => {
      d.style.height = '';
      d.classList.remove('lr-animating');
      if (!open) d.open = false;
      d._lrTimer = null; d._lrWant = null;
    }, ANIM_MS);
  }
  function setOpen(d, open, animate) {
    if (wantOpen(d) === open) return;
    if (animate === false) {
      if (d._lrTimer) { clearTimeout(d._lrTimer); d._lrTimer = null; }
      d.classList.remove('lr-animating'); d.style.height = '';
      d.open = open; d._lrWant = null;
    } else animateToggle(d, open);
  }

  /* Sitzt der Klick auf dem Dreieck (linker Rand der Zeile)? */
  function onMarker(ev, sum) {
    const r = sum.getBoundingClientRect();
    return ev.clientX <= r.left + 30;
  }
  document.addEventListener('click', ev => {
    const sum = ev.target.closest && ev.target.closest('summary');
    if (!sum) return;
    const d = sum.parentElement;
    if (!isDetails(d)) return;
    if (ev.target.closest('a')) return;            // Links im Titel gewinnen
    ev.preventDefault();
    if (editing) {
      // Tastatur-„Klicks“ (detail 0) schalten beim Bearbeiten nie um —
      // dafür gibt es Strg/⌘+Enter. Mit der Maus nur über das Dreieck.
      if (ev.detail === 0 || !onMarker(ev, sum)) return;
    }
    animateToggle(d, !wantOpen(d));
  }, true);

  /* Leerer Toggle: Klick in die Platzhalterzeile legt die erste Zeile an. */
  document.addEventListener('mousedown', ev => {
    if (!editing) return;
    const t = ev.target;
    if (!t || !t.parentElement || !isDetails(t.parentElement) || t.tagName === 'SUMMARY') return;
    const d = t.parentElement;
    if (bodyOf(d) !== t || !inRegion(t) || !isEmptyEl(t)) return;
    ev.preventDefault();
    act(() => { t.textContent = ''; const p = el('<p><br></p>'); t.appendChild(p); placeCaret(p, false); });
  }, true);

  /* ---------- Bausteine eines Toggles ----------------------------------------
     Titel = <summary>. Der Inhalt steckt meist in einem Rahmen (.toggle-body,
     .tgb, .solution-body …); fehlt der, liegen die Inhaltsblöcke direkt im
     <details> — dann ist das <details> selbst der Rahmen.                    */
  const BODY_CLS = /(^|[\s_-])(body|tgb|tb|content|inner|answer|antwort|loesung|lösung|sol-b)([\s_-]|$)|body(\s|$)/i;
  function bodyOf(d) {
    const rest = [...d.children].filter(c => c.tagName !== 'SUMMARY');
    if (rest.length === 1 && /^(DIV|SECTION)$/.test(rest[0].tagName) &&
        (BODY_CLS.test(rest[0].className || '') || !rest[0].className)) return rest[0];
    const hit = rest.find(c => /^(DIV|SECTION)$/.test(c.tagName) && BODY_CLS.test(c.className || ''));
    return hit || d;
  }
  /* Inhaltsblöcke eines Toggles in Reihenfolge. Ein Rahmen, der nur Text ohne
     eigene Absätze enthält, zählt selbst als (einzige) Zeile. */
  function kidsOf(d) {
    const body = bodyOf(d);
    if (body === d) return [...d.children].filter(c => c.tagName !== 'SUMMARY' && !c.hasAttribute('data-lr-ui'));
    if (body.children.length === 0 && !isEmptyEl(body)) return [body];
    if (body.firstElementChild && !hasBlockKids(body) && body.textContent.replace(ZW, '').trim()) return [body];
    return [...body.children];
  }
  function insertFirstKid(d, node) {
    const body = bodyOf(d);
    if (body === d) { const s = sumOf(d); d.insertBefore(node, s ? s.nextSibling : d.firstChild); }
    else body.insertBefore(node, body.firstChild);
  }
  function appendKid(d, node) { bodyOf(d).appendChild(node); }
  /* Gehört dieser Block direkt in einen Toggle? Dann {d, kids, i}. */
  function kidInfo(block) {
    if (!block || block.tagName === 'SUMMARY') return null;
    const p = block.parentElement;
    let d = null;
    if (isDetails(p)) d = p;
    else if (p && isDetails(p.parentElement) && bodyOf(p.parentElement) === p) d = p.parentElement;
    if (!d || !inRegion(d)) return null;
    const kids = kidsOf(d);
    const i = kids.indexOf(block);
    return i < 0 ? null : { d, kids, i };
  }

  const BLOCK_SEL = 'p,div,ul,ol,table,details,figure,blockquote,pre,h1,h2,h3,h4,h5,h6,hr,section';
  const hasBlockKids = n => !!n.querySelector(BLOCK_SEL);
  function isEmptyEl(n) {
    if (!n) return true;
    if (n.querySelector && n.querySelector('img,table,hr,iframe,video,svg,audio,canvas')) return false;
    return !n.textContent.replace(ZW, '').replace(/\s/g, '');
  }
  /* Einfacher Textblock, der mit einem anderen verschmolzen werden darf. */
  const mergeable = n => !!n && n.nodeType === 1 &&
    /^(P|H[1-6]|DIV|SUMMARY|LI|TD|TH)$/.test(n.tagName) && !hasBlockKids(n) && !n.matches('[data-lr-ui]');

  /* Der Block, in dem der Cursor steht (Titel zählt als eigener Block). */
  function blockAt(n) {
    n = nodeEl(n);
    while (n && n.nodeType === 1 && !regions.includes(n)) {
      if (n.tagName === 'SUMMARY' || n.tagName === 'LI') return n;
      const disp = getComputedStyle(n).display;
      if (BLOCKISH[disp] || disp === 'list-item') return n;
      n = n.parentNode;
    }
    return null;
  }
  function caret() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!inRegion(r.startContainer)) return null;
    return { sel, r, collapsed: sel.isCollapsed };
  }
  function textBefore(host, r) {
    const pre = document.createRange();
    pre.selectNodeContents(host);
    try { pre.setEnd(r.startContainer, r.startOffset); } catch (e) { return 'x'; }
    const frag = pre.cloneContents();
    if (frag.querySelector && frag.querySelector('img')) return 'x';
    return pre.toString().replace(ZW, '');
  }
  function textAfter(host, r) {
    const post = document.createRange();
    post.selectNodeContents(host);
    try { post.setStart(r.endContainer, r.endOffset); } catch (e) { return 'x'; }
    const frag = post.cloneContents();
    if (frag.querySelector && frag.querySelector('img')) return 'x';
    return post.toString().replace(ZW, '');
  }
  const atStart = (host, c) => c.collapsed && host.contains(c.r.startContainer) && textBefore(host, c.r) === '';
  const atEnd = (host, c) => c.collapsed && host.contains(c.r.endContainer) && textAfter(host, c.r).replace(/\n$/, '') === '';

  /* Cursor an den Anfang bzw. das Ende eines Elements setzen. */
  function placeCaret(host, atEndPos) {
    if (!host) return;
    const sel = window.getSelection(), r = document.createRange();
    const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
      acceptNode: t => t.data.replace(ZW, '').length || t.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    let first = null, last = null, t;
    while ((t = w.nextNode())) { if (!first) first = t; last = t; }
    if (atEndPos && last) { r.setStart(last, last.data.length); }
    else if (!atEndPos && first) { r.setStart(first, 0); }
    else {
      const br = host.querySelector('br');
      if (br) r.setStartBefore(br); else r.setStart(host, atEndPos ? host.childNodes.length : 0);
    }
    r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    const box = host.getBoundingClientRect ? host : host.parentElement;
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
  }
  function saveSel() {
    const s = window.getSelection();
    if (!s.rangeCount) return null;
    const r = s.getRangeAt(0);
    return { sc: r.startContainer, so: r.startOffset, ec: r.endContainer, eo: r.endOffset };
  }
  function restoreSel(x) {
    if (!x || !x.sc.isConnected || !x.ec.isConnected) return false;
    const len = n => n.nodeType === 3 ? n.data.length : n.childNodes.length;
    try {
      const r = document.createRange();
      r.setStart(x.sc, Math.min(x.so, len(x.sc)));
      r.setEnd(x.ec, Math.min(x.eo, len(x.ec)));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      const b = nodeEl(x.sc); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
      return true;
    } catch (e) { return false; }
  }

  /* Leerer Titel/Absatz braucht einen <br>, sonst hat der Cursor keine Zeile.
     Beim Speichern fliegt der Platzhalter wieder heraus (cleanDoc). */
  function pad(n) {
    if (!n) return;
    if (isEmptyEl(n)) {
      [...n.childNodes].forEach(c => { if (c.nodeType === 3 || c.nodeName === 'BR') c.remove(); });
      n.appendChild(document.createElement('br'));
    }
  }
  /* Abschließenden Platzhalter-<br> entfernen, bevor etwas angehängt wird. */
  function trimTail(n) {
    while (n.lastChild && (n.lastChild.nodeName === 'BR' ||
      (n.lastChild.nodeType === 3 && !n.lastChild.data.replace(ZW, '')))) n.lastChild.remove();
  }
  /* Inhalt von src ans Ende von target hängen; Cursor an die Nahtstelle. */
  function mergeInto(target, src) {
    trimTail(target);
    const r = document.createRange();
    r.selectNodeContents(target); r.collapse(false);
    const mark0 = document.createTextNode('');
    target.appendChild(mark0);
    trimTail(src);
    while (src.firstChild) target.appendChild(src.firstChild);
    pad(target);
    const sel = window.getSelection(), rr = document.createRange();
    rr.setStart(mark0, 0); rr.collapse(true);
    sel.removeAllRanges(); sel.addRange(rr);
    return mark0;
  }
  /* Rahmen (Body) bleibt bestehen, alles andere wird entfernt. */
  function removeBlock(block, d) {
    if (d && bodyOf(d) === block) { block.textContent = ''; return; }
    block.remove();
  }
  /* Letzter sichtbarer Textblock in einem Toggle (für Rücktaste danach). */
  function lastVisibleText(d) {
    if (!wantOpen(d)) return sumOf(d);
    const kids = kidsOf(d);
    let n = kids[kids.length - 1];
    if (!n) return sumOf(d);
    for (let guard = 0; n && guard < 50; guard++) {
      if (isDetails(n)) return lastVisibleText(n);
      if (mergeable(n)) return n;
      if (/^(UL|OL)$/.test(n.tagName)) { n = n.lastElementChild; continue; }
      const kidsN = [...n.children].filter(c => !c.hasAttribute('data-lr-ui'));
      if (!kidsN.length) return null;
      n = kidsN[kidsN.length - 1];
      if (n.tagName === 'LI' && n.querySelector(':scope > ul, :scope > ol')) n = n.querySelector(':scope > ul, :scope > ol');
    }
    return null;
  }

  /* ---------- Neue Toggles ---------- */
  function makeToggle(like, titleNodes, open) {
    const nd = document.createElement('details');
    nd.className = (like && like.className) || 'toggle';
    if (open) nd.open = true;
    const ns = document.createElement('summary');
    (titleNodes || []).forEach(n => ns.appendChild(n));
    pad(ns);
    nd.appendChild(ns);
    const lb = like ? bodyOf(like) : null;
    if (!like || lb !== like) {
      const nb = document.createElement(lb ? lb.tagName.toLowerCase() : 'div');
      nb.className = lb ? lb.className : 'toggle-body';
      nd.appendChild(nb);
    }
    return nd;
  }
  /* Block (Absatz, Überschrift …) in einen Toggle verwandeln. */
  function blockToToggle(block, open) {
    const nodes = [...block.childNodes];
    const nd = makeToggle(null, nodes, open);
    block.replaceWith(nd);
    return nd;
  }
  /* Toggle zurück in normalen Text verwandeln; der Inhalt bleibt darunter. */
  function toggleToText(d) {
    const s = sumOf(d);
    const p = document.createElement('p');
    if (s) while (s.firstChild) p.appendChild(s.firstChild);
    pad(p);
    const parent = d.parentNode;
    parent.insertBefore(p, d);
    const body = bodyOf(d);
    const kids = body === d ? [...d.children].filter(c => c.tagName !== 'SUMMARY') : null;
    let after = p;
    if (kids) kids.forEach(k => { parent.insertBefore(k, after.nextSibling); after = k; });
    else if (hasBlockKids(body) || isEmptyEl(body)) { [...body.childNodes].forEach(k => { parent.insertBefore(k, after.nextSibling); after = k; }); }
    else { const q = document.createElement('p'); while (body.firstChild) q.appendChild(body.firstChild); parent.insertBefore(q, after.nextSibling); }
    d.remove();
    placeCaret(p, false);
    return p;
  }

  /* ---------- Ein- und Ausrücken ---------- */
  function indentInto(prevD, block) {
    const keep = saveSel();
    setOpen(prevD, true, false);
    const body = bodyOf(prevD);
    if (body !== prevD && kidsOf(prevD)[0] === body) {      // Rahmen mit reinem Text → erst in Absatz fassen
      const p = document.createElement('p'); while (body.firstChild) p.appendChild(body.firstChild); body.appendChild(p);
    }
    if (body !== prevD && isEmptyEl(body) && !body.children.length) body.textContent = '';
    appendKid(prevD, block);
    restoreSel(keep) || placeCaret(block.tagName === 'DETAILS' ? sumOf(block) : block, false);
  }
  function outdent(block) {
    const info = kidInfo(block);
    if (!info) return false;
    const { d, kids, i } = info;
    if (bodyOf(d) === block) return false;               // Rahmen selbst bleibt
    const keep = saveSel();
    const follow = kids.slice(i + 1);
    d.parentNode.insertBefore(block, d.nextSibling);
    if (isDetails(block)) {
      // Wie in Notion: nachfolgende Zeilen werden Inhalt des ausgerückten Toggles.
      follow.forEach(f => appendKid(block, f));
      if (follow.length) setOpen(block, true, false);
    } else {
      // Ein Absatz kann keine Unterzeilen tragen — sie rücken mit aus.
      let after = block;
      follow.forEach(f => { d.parentNode.insertBefore(f, after.nextSibling); after = f; });
    }
    if (!kidsOf(d).length && bodyOf(d) !== d) bodyOf(d).textContent = '';
    restoreSel(keep);
    return true;
  }

  /* ================= Tastenlogik ================= */
  /* kind: 'enter' | 'shiftenter' | 'backspace' | 'delete' | 'tab' | 'shifttab'.
     Rückgabe true = erledigt (Browser-Standard unterdrücken). */
  function handleKey(kind) {
    const c = caret();
    if (!c) return false;
    const block = blockAt(c.r.startContainer);
    if (!block) return false;
    const endBlock = blockAt(c.r.endContainer);

    // Auswahl über Blockgrenzen am Titel → Browser würde <summary> zerreißen.
    if (!c.collapsed && endBlock !== block && (block.tagName === 'SUMMARY' || (endBlock && endBlock.tagName === 'SUMMARY'))) {
      if (kind === 'tab' || kind === 'shifttab') return true;
      act(() => {
        c.r.deleteContents();
        repair();
        const r2 = window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null;
        if (r2) r2.collapse(true);
      });
      if (kind === 'backspace' || kind === 'delete') return true;
      return handleKey(kind);
    }

    /* ---------- Cursor im Titel ---------- */
    if (block.tagName === 'SUMMARY' && isDetails(block.parentElement)) {
      const sum = block, d = sum.parentElement;
      if (kind === 'enter') {
        if (isEmptyEl(sum)) { act(() => toggleToText(d)); return true; }
        if (c.collapsed && atStart(sum, c)) {
          act(() => { const nd = makeToggle(d, [], false); d.parentNode.insertBefore(nd, d); placeCaret(sum, false); });
          return true;
        }
        act(() => {
          const r = c.r;
          if (!c.collapsed) r.deleteContents();
          const cut = document.createRange();
          cut.setStart(r.endContainer, r.endOffset);
          cut.setEnd(sum, sum.childNodes.length);
          const tail = cut.extractContents();
          [...tail.querySelectorAll('br')].forEach(b => { if (!b.nextSibling) b.remove(); });
          pad(sum);
          if (wantOpen(d)) {
            const p = document.createElement('p');
            p.appendChild(tail); pad(p);
            const body = bodyOf(d);
            if (body !== d && kidsOf(d)[0] === body && !isEmptyEl(body)) {
              const q = document.createElement('p'); while (body.firstChild) q.appendChild(body.firstChild); body.appendChild(q);
            }
            if (body !== d && isEmptyEl(body) && !body.children.length) body.textContent = '';
            insertFirstKid(d, p);
            placeCaret(p, false);
          } else {
            const nd = makeToggle(d, [tail], false);
            d.parentNode.insertBefore(nd, d.nextSibling);
            placeCaret(sumOf(nd), false);
          }
        });
        return true;
      }
      if (kind === 'shiftenter') {
        act(() => {
          const r = c.r;
          if (!c.collapsed) r.deleteContents();
          trimEmptyText(sum);
          const br = document.createElement('br');
          r.insertNode(br);
          // Leerzeichen direkt nach dem Umbruch würde der Browser schlucken.
          const nx = br.nextSibling;
          if (nx && nx.nodeType === 3 && /^ /.test(nx.data)) nx.data = '\u00a0' + nx.data.slice(1);
          // Am Zeilenende braucht der Umbruch einen zweiten <br>, sonst springt der Cursor nicht.
          if (!br.nextSibling || (br.nextSibling.nodeType === 3 && !br.nextSibling.data.replace(ZW, '') && !br.nextSibling.nextSibling))
            sum.appendChild(document.createElement('br'));
          const rr = document.createRange(); rr.setStartAfter(br); rr.collapse(true);
          c.sel.removeAllRanges(); c.sel.addRange(rr);
        });
        return true;
      }
      if (kind === 'backspace') {
        if (c.collapsed && atStart(sum, c)) { act(() => toggleToText(d)); return true; }
        if (c.collapsed && isEmptyEl(sum)) { act(() => toggleToText(d)); return true; }
        return false;                                   // normales Löschen im Titel
      }
      if (kind === 'delete') {
        if (!(c.collapsed && atEnd(sum, c))) return false;
        if (wantOpen(d)) {
          const first = kidsOf(d)[0];
          if (first && mergeable(first)) act(() => { const was = bodyOf(d) === first; mergeInto(sum, first); if (!was) first.remove(); });
          else if (first && isEmptyEl(first)) act(() => removeBlock(first, d));
        } else {
          const nx = d.nextElementSibling;
          if (nx && mergeable(nx) && !isDetails(nx)) act(() => { mergeInto(sum, nx); nx.remove(); });
        }
        return true;                                    // nie dem Browser überlassen
      }
      if (kind === 'tab') {
        const prev = d.previousElementSibling;
        if (isDetails(prev) && inRegion(prev)) act(() => indentInto(prev, d));
        return true;
      }
      if (kind === 'shifttab') { act(() => outdent(d)); return true; }
      return false;
    }

    /* ---------- Cursor in einer Zeile ---------- */
    const info = kidInfo(block);
    if ((kind === 'enter' || kind === 'shiftenter') && info && bodyOf(info.d) === block) {
      // Inhalt liegt ohne Absatz im Rahmen: erst in <p> fassen, dann normal umbrechen.
      const keep = saveSel();
      const p = document.createElement('p');
      while (block.firstChild) p.appendChild(block.firstChild);
      block.appendChild(p);
      restoreSel(keep);
      return false;
    }
    if (kind === 'backspace' && c.collapsed && atStart(block, c)) {
      if (info) {
        const { d, kids, i } = info;
        const sum = sumOf(d);
        if (i === 0) {
          if (!sum) return false;
          if (isEmptyEl(block) && !block.querySelector('img')) {
            act(() => { removeBlock(block, d); placeCaret(sum, true); });
            return true;
          }
          if (mergeable(block)) {
            act(() => { const isBody = bodyOf(d) === block; mergeInto(sum, block); if (!isBody) block.remove(); });
            return true;
          }
          return false;
        }
        if (i === kids.length - 1 && bodyOf(d) !== block) {
          act(() => outdent(block));
          return true;
        }
      }
      // Direkt nach einem Toggle: in dessen sichtbares Ende hineinziehen.
      const prev = block.previousElementSibling;
      if (isDetails(prev) && inRegion(prev)) {
        const target = lastVisibleText(prev);
        if (!target) return true;
        if (isEmptyEl(block)) { act(() => { block.remove(); placeCaret(target, true); }); return true; }
        if (mergeable(block)) { act(() => { mergeInto(target, block); block.remove(); }); return true; }
        return true;
      }
      return false;
    }
    if (kind === 'tab' || kind === 'shifttab') {
      if (block.tagName === 'LI' || block.closest('li')) return false;       // Listen rücken selbst ein
      if (block.closest('td,th')) return false;
      if (kind === 'tab') {
        const prev = block.previousElementSibling;
        if (isDetails(prev) && inRegion(prev) && (!info || bodyOf(info.d) !== block)) act(() => indentInto(prev, block));
        return true;
      }
      if (info && bodyOf(info.d) !== block) act(() => outdent(block));
      return true;
    }
    return false;
  }
  function trimEmptyText(n) {
    [...n.childNodes].forEach(c => { if (c.nodeType === 3 && !c.data.length) c.remove(); });
    if (n.childNodes.length === 1 && n.firstChild.nodeName === 'BR') n.firstChild.remove();
  }

  /* Zeile in Toggle verwandeln (Strg+Umschalt+7, „> “). */
  function convertBlock(open, stripPrefix) {
    const c = caret();
    if (!c) return false;
    const block = blockAt(c.r.startContainer);
    if (!block || block.tagName === 'SUMMARY' || !/^(P|H[1-6]|DIV)$/.test(block.tagName)) return false;
    if (hasBlockKids(block) || block.closest('li,td,th')) return false;
    if (regions.includes(block)) return false;
    const info = kidInfo(block);
    if (info && bodyOf(info.d) === block) return false;
    if (block.matches('[class*="cx-h"]')) return false;
    act(() => {
      if (stripPrefix) {
        const r = document.createRange();
        r.selectNodeContents(block);
        r.setEnd(c.r.startContainer, c.r.startOffset);
        r.deleteContents();
      }
      const nd = blockToToggle(block, open);
      placeCaret(sumOf(nd), !stripPrefix);
    });
    return true;
  }

  /* Alle Toggles zu – oder alle auf, wenn schon alle zu sind. */
  function toggleAll() {
    const all = regions.flatMap(r => [...r.querySelectorAll('details')]);
    if (!all.length) return;
    const anyOpen = all.some(d => wantOpen(d));
    const anim = all.length <= 20;
    all.forEach(d => setOpen(d, !anyOpen, anim));
  }

  /* Struktur reparieren, falls der Browser (Einfügen, Diktat …) doch einmal
     an einem Toggle vorbeigearbeitet hat: genau ein <summary>, ganz vorn,
     ohne Absätze darin. */
  function repair() {
    regions.forEach(rg => rg.querySelectorAll('details').forEach(d => {
      let sums = [...d.children].filter(c => c.tagName === 'SUMMARY');
      if (!sums.length) { const s = document.createElement('summary'); pad(s); d.insertBefore(s, d.firstChild); sums = [s]; }
      if (d.firstElementChild !== sums[0]) d.insertBefore(sums[0], d.firstChild);
      sums.slice(1).reverse().forEach(x => {
        const p = document.createElement('p');
        while (x.firstChild) p.appendChild(x.firstChild);
        x.remove(); pad(p);
        insertFirstKid(d, p);
      });
      const s = sums[0];
      s.querySelectorAll(':scope > p, :scope > div, :scope > h1, :scope > h2, :scope > h3, :scope > h4').forEach(b => {
        const frag = document.createDocumentFragment();
        if (b.previousSibling) frag.appendChild(document.createElement('br'));
        while (b.firstChild) frag.appendChild(b.firstChild);
        b.replaceWith(frag);
      });
      if (isEmptyEl(s) && !s.querySelector('br')) pad(s);
    }));
  }

  /* ---------- Eingaben abfangen ---------- */
  document.addEventListener('keydown', e => {
    // Strg+Alt+T / ⌘⌥T: alle Toggles — auch im Lesemodus.
    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.code === 'KeyT') {
      e.preventDefault(); toggleAll(); return;
    }
    if (!editing || e.isComposing || e.defaultPrevented) return;
    if (!inRegion(e.target) && !inRegion(document.activeElement)) return;
    const mod = e.ctrlKey || e.metaKey;

    // Rückgängig / Wiederholen (Strg+Z bzw. ⌘Z; Wiederholen: +Umschalt oder Strg+Y)
    if (mod && !e.altKey) {
      const k = (e.key || '').toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey && e.ctrlKey)) { e.preventDefault(); redo(); return; }
    }
    if (!caret()) return;
    UM.note();
    if (slashMenu.style.display === 'block') return;

    // Strg/⌘+Enter: Toggle auf/zu
    if (mod && e.key === 'Enter') {
      const b = blockAt(caret().r.startContainer);
      if (b && b.tagName === 'SUMMARY' && isDetails(b.parentElement)) { e.preventDefault(); setOpen(b.parentElement, !wantOpen(b.parentElement)); }
      return;
    }
    // Strg+Umschalt+7 (Windows) / ⌘⌥7 (Mac): Zeile → Toggle
    if (e.code === 'Digit7' && ((e.ctrlKey && e.shiftKey && !e.altKey) || (e.metaKey && e.altKey))) {
      e.preventDefault(); convertBlock(false, false); return;
    }
    if (mod || e.altKey) return;

    let kind = null;
    if (e.key === 'Enter') kind = e.shiftKey ? 'shiftenter' : 'enter';
    else if (e.key === 'Backspace' && !e.shiftKey) kind = 'backspace';
    else if (e.key === 'Delete' && !e.shiftKey) kind = 'delete';
    else if (e.key === 'Tab') kind = e.shiftKey ? 'shifttab' : 'tab';
    if (!kind) return;
    if ((kind === 'tab' || kind === 'shifttab') && currentListItem()) return;   // Listen-Einzug weiter unten
    if (handleKey(kind)) e.preventDefault();
  }, true);

  /* Bildschirmtastatur (iPad/Handy) meldet Tasten oft nur als beforeinput. */
  document.addEventListener('beforeinput', e => {
    if (!editing || !inRegion(e.target)) return;
    const t = e.inputType;
    if (t === 'historyUndo') { e.preventDefault(); undo(); return; }
    if (t === 'historyRedo') { e.preventDefault(); redo(); return; }
    UM.boundary(t);
    if (slashMenu.style.display === 'block') return;

    // Markdown-Kürzel „> “ am Zeilenanfang → Toggle
    if (t === 'insertText' && e.data === ' ') {
      const c = caret();
      if (c && c.collapsed) {
        const b = blockAt(c.r.startContainer);
        if (b && b.tagName !== 'SUMMARY' && textBefore(b, c.r) === '>') {
          if (convertBlock(true, true)) { e.preventDefault(); return; }
        }
      }
    }
    const map = { insertParagraph: 'enter', insertLineBreak: 'shiftenter',
      deleteContentBackward: 'backspace', deleteContentForward: 'delete' };
    if (map[t] && handleKey(map[t])) e.preventDefault();
  }, true);

  onRegion('input', () => { if (editing) repair(); });
  /* Einfügen in einen Titel: erste Zeile in den Titel, weitere Zeilen werden
     eigene Zeilen (offen: Inhalt des Toggles, zu: Absätze darunter). */
  onRegion('paste', e => {
    if (!editing) return;
    const c = caret();
    const b = c && blockAt(c.r.startContainer);
    const eb = c && blockAt(c.r.endContainer);
    if (!b || (b.tagName !== 'SUMMARY' && !(eb && eb.tagName === 'SUMMARY'))) { setTimeout(repair, 0); return; }
    const txt = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').replace(/\r/g, '');
    e.preventDefault();
    const lines = txt.split('\n');
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    act(() => {
      if (!c.collapsed) { c.r.deleteContents(); repair(); }
      const r = window.getSelection().getRangeAt(0);
      const sum = blockAt(r.startContainer);
      const d = sum && sum.parentElement;
      const t = document.createTextNode(lines[0] || '');
      trimEmptyText(sum);
      r.insertNode(t);
      const rr = document.createRange(); rr.setStart(t, t.data.length); rr.collapse(true);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(rr);
      const rest = lines.slice(1).map(l => { const q = document.createElement('p'); q.textContent = l; pad(q); return q; });
      if (!rest.length || !isDetails(d)) return;
      if (wantOpen(d)) {
        const body = bodyOf(d);
        if (body !== d && kidsOf(d)[0] === body && !isEmptyEl(body)) {
          const q = document.createElement('p'); while (body.firstChild) q.appendChild(body.firstChild); body.appendChild(q);
        }
        if (body !== d && isEmptyEl(body) && !body.children.length) body.textContent = '';
        rest.reverse().forEach(q => insertFirstKid(d, q));
        rest.reverse();
      } else {
        let after = d;
        rest.forEach(q => { d.parentNode.insertBefore(q, after.nextSibling); after = q; });
      }
      placeCaret(rest[rest.length - 1], true);
    });
  });

  /* ================= Rückgängig / Wiederholen =================
     Eigener Verlauf über einen MutationObserver: jede Änderung im Report
     (Tippen, Formatieren, Toggle-Umbau, Bilder) wird mitgeschrieben und lässt
     sich exakt umkehren — mit denselben DOM-Knoten, damit nichts von den
     Report-eigenen Funktionen (Bild-Zoom …) verloren geht.                  */
  const IGNORE_ATTR = { open: 1, contenteditable: 1, draggable: 1, src: 1, spellcheck: 1, 'data-lr-sticky': 1 };
  const stripLr = v => (v || '').split(/\s+/).filter(x => x && !/^lr-(sel|animating)$/.test(x)).join(' ');
  function keepRec(m) {
    if (m.type === 'attributes') {
      const a = m.attributeName;
      if (IGNORE_ATTR[a]) return false;
      if (m.target.tagName === 'DETAILS' && (a === 'style' || a === 'class')) return false;
      if (a === 'class' && stripLr(m.oldValue) === stripLr(m.target.getAttribute('class'))) return false;
      if (a === 'style' && m.target.tagName === 'IMG' && !editing) return false;
      return true;
    }
    if (m.type === 'childList') {
      const ui = n => n.nodeType === 1 && n.hasAttribute('data-lr-ui');
      const all = [...m.addedNodes, ...m.removedNodes];
      return all.length && !all.every(ui);
    }
    return true;
  }
  const UM = {
    undo: [], redo: [], cur: null, obs: null, timer: null, applying: false, pending: null, lastCls: null,
    start() {
      if (this.obs) return;
      this.obs = new MutationObserver(recs => this.feed(recs));
      regions.forEach(r => this.obs.observe(r, { childList: true, subtree: true, characterData: true,
        characterDataOldValue: true, attributes: true, attributeOldValue: true }));
    },
    stop() { if (!this.obs) return; this.commit(); this.obs.disconnect(); this.obs = null; },
    feed(recs) {
      if (this.applying) return;
      const f = recs.filter(keepRec);
      if (!f.length) return;
      if (!this.cur) this.cur = { recs: [], selBefore: this.pending || saveSel() };
      this.pending = null;
      this.cur.recs.push(...f);
      this.redo.length = 0;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.commit(), 1000);
    },
    commit() {
      if (this.obs) this.feed(this.obs.takeRecords());
      clearTimeout(this.timer);
      if (this.cur && this.cur.recs.length) {
        this.cur.selAfter = saveSel();
        this.undo.push(this.cur);
        if (this.undo.length > 400) this.undo.shift();
      }
      this.cur = null; this.lastCls = null;
    },
    /* Cursor merken, bevor die nächste Änderung beginnt. */
    note() { if (!this.cur) this.pending = saveSel(); },
    /* Neue Rückgängig-Stufe, wenn sich die Art der Eingabe ändert. */
    boundary(inputType) {
      const cls = /^insertText|^insertCompositionText|^insertReplacementText/.test(inputType) ? 'ins'
        : /^delete/.test(inputType) ? 'del' : 'other';
      if (this.cur && (cls === 'other' || (this.lastCls && cls !== this.lastCls))) this.commit();
      this.note();
      this.lastCls = cls === 'other' ? null : cls;
    },
    apply(recs) {
      this.applying = true;
      for (let i = recs.length - 1; i >= 0; i--) {
        const m = recs[i];
        try {
          if (m.type === 'characterData') m.target.data = m.oldValue;
          else if (m.type === 'attributes') {
            if (m.oldValue == null) m.target.removeAttribute(m.attributeName);
            else m.target.setAttribute(m.attributeName, m.oldValue);
          } else {
            [...m.addedNodes].reverse().forEach(n => { if (n.parentNode === m.target) m.target.removeChild(n); });
            const ref = (m.nextSibling && m.nextSibling.parentNode === m.target) ? m.nextSibling
              : (m.previousSibling && m.previousSibling.parentNode === m.target) ? m.previousSibling.nextSibling : null;
            [...m.removedNodes].forEach(n => m.target.insertBefore(n, ref));
          }
        } catch (e) { /* Knoten inzwischen anderweitig verschoben – überspringen */ }
      }
      const out = this.obs ? this.obs.takeRecords().filter(keepRec) : [];
      this.applying = false;
      return out;
    }
  };
  function undo() {
    UM.commit();
    const tx = UM.undo.pop();
    if (!tx) { toast('Nichts mehr rückgängig zu machen.'); return; }
    const inv = UM.apply(tx.recs);
    UM.redo.push({ recs: inv, selBefore: tx.selBefore, selAfter: tx.selAfter });
    restoreSel(tx.selBefore);
    hideSlash(); deselectImg();
    setDirty(true);
  }
  function redo() {
    UM.commit();
    const tx = UM.redo.pop();
    if (!tx) return;
    const inv = UM.apply(tx.recs);
    UM.undo.push({ recs: inv, selBefore: tx.selBefore, selAfter: tx.selAfter });
    restoreSel(tx.selAfter);
    hideSlash(); deselectImg();
    setDirty(true);
  }
  /* Ein Umbau = genau eine Rückgängig-Stufe. */
  function act(fn) {
    UM.commit();
    UM.pending = saveSel();
    fn();
    UM.commit();
    setDirty(true);
  }
  onRegion('mousedown', () => { if (editing) UM.commit(); });

  if (location.hash === '#edit' || new URLSearchParams(location.search).get('edit') === '1') setEditing(true);
})();
