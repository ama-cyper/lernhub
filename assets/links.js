/* Lernreport-Hub — Altfragen ↔ Lernreports verdrahten + Fehlerlog.

   Woher die Verknüpfung kommt: In deinen Lernreports stehen Chips wie
   „Altfrage 99 · 153 · 178“ (Originalnummern), im Katalog steht pro Frage
   „Kam in Frage 99, 153 und 178“. Gleiche Nummer = gleiche Frage. Damit weiß
   der Hub für jede Katalogfrage, in welchem Report-Abschnitt sie erklärt ist —
   ohne dass irgendetwas erfunden oder von Hand gepflegt wird. Fehlt so ein
   Chip, verweist der Hub nur auf den Report zur Vorlesung (laut „Quellen:“).

   Fehlerlog: liegt als progress/fehlerlog.json im privaten Repo und ist damit
   auf allen Geräten gleich. Eine Frage verlässt das Log erst, wenn sie
   zweimal hintereinander richtig beantwortet wurde.                        */
(function () {
  'use strict';
  if (window.LHLinks || !window.LH) return;

  /* Ordner, in denen die Verdrahtung aktiv ist (IDs aus hub-data.json).
     Weitere Fächer: ID hier ergänzen.                                       */
  const LINK_FOLDERS = ['fmvb8065s77uq'];   // Pharmakologie 2 (neu)

  const CACHE_V = 2;
  const KEY_RE = /\b(VL\d{2}|SS\d{2}|S\d{2}(?:-\d{2})?)\b/g;
  const nums = t => (String(t || '').match(/\d+/g) || []).map(Number);
  const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
  const local = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ---------------- Index ---------------- */
  function parseCatalog(doc) {
    const cards = {};
    doc.querySelectorAll('section[id]').forEach(sec => {
      const h2 = clean((sec.querySelector('.sechead h2') || sec.querySelector('h2') || {}).textContent);
      const key = h2.split(' · ')[0] || sec.id;
      sec.querySelectorAll('article.card[id]').forEach(card => {
        const n = new Set(nums((card.querySelector('.occ') || {}).textContent));
        card.querySelectorAll('details.var > summary, .ansgrp .alab').forEach(x => nums(x.textContent).forEach(v => n.add(v)));
        cards[card.id] = { sec: key, nums: [...n], stem: clean((card.querySelector(':scope > .stem') || {}).textContent).slice(0, 160) };
      });
    });
    return cards;
  }
  function parseReport(doc, file) {
    const title = clean((doc.querySelector('h1') || {}).textContent) || file;
    const meta = clean((doc.querySelector('.meta') || {}).textContent);
    const quellen = (meta.split(/Quellen?:/i)[1] || '').split(/ergänzend/i)[0];
    const keys = [...new Set(quellen.match(KEY_RE) || [])];
    const label = ((file.match(/^(lr|vl|v|s)\s*-?(\d+)/i) || []).slice(1).join('') || '').toUpperCase();
    const spots = [];   // {a, h, n:[...]}
    let a = '', h = '';
    doc.querySelectorAll('h1[id], h2[id], h3[id], h4[id], .aq').forEach(el => {
      if (!el.classList.contains('aq')) { a = el.id; h = clean(el.textContent); return; }
      const n = nums(el.textContent);
      if (n.length) spots.push({ a, h, n });
    });
    return { f: file, title, label, keys, spots };
  }

  async function build(fid, files, shaOf) {
    const out = { fid, catalog: null, cards: {}, reports: [], byNum: {}, numToCard: {} };
    const parser = new DOMParser();
    const texts = await Promise.all(files.map(f => LH.readText('lectures/' + f, shaOf(f)).catch(() => null)));
    files.forEach((f, i) => {
      if (texts[i] == null) return;
      const doc = parser.parseFromString(texts[i], 'text/html');
      if (doc.querySelector('article.card details.sol')) {
        if (!out.catalog) { out.catalog = f; out.cards = parseCatalog(doc); }
        return;
      }
      const r = parseReport(doc, f);
      out.reports.push({ f: r.f, title: r.title, label: r.label, keys: r.keys });
      r.spots.forEach(s => s.n.forEach(n => {
        const list = out.byNum[n] || (out.byNum[n] = []);
        if (!list.some(x => x.f === f && x.a === s.a)) list.push({ f, a: s.a, h: s.h });
      }));
    });
    Object.entries(out.cards).forEach(([id, c]) => c.nums.forEach(n => { if (!(n in out.numToCard)) out.numToCard[n] = id; }));
    return out;
  }

  const memo = new Map();
  function forFile(file) {
    if (memo.has(file)) return memo.get(file);
    const p = (async () => {
      const [{ data: hub }, tree] = await Promise.all([LH.readJSON('hub-data.json'), LH.tree()]);
      if (!hub || !hub.order) return null;
      const fid = Object.keys(hub.order).find(k => (hub.order[k] || []).includes(file));
      if (!fid || !LINK_FOLDERS.includes(fid)) return null;
      const files = hub.order[fid].filter(f => tree.has('lectures/' + f));
      const stamp = CACHE_V + '|' + files.map(f => f + '@' + tree.get('lectures/' + f)).join('|');
      const ck = 'lh_links:' + fid;
      const hit = local.get(ck, null);
      if (hit && hit.stamp === stamp) return wrap(hit.idx);
      const idx = await build(fid, files, f => tree.get('lectures/' + f));
      local.set(ck, { stamp, idx });
      return wrap(idx);
    })();
    memo.set(file, p);
    p.catch(() => memo.delete(file));
    return p;
  }

  function wrap(idx) {
    const repOf = f => idx.reports.find(r => r.f === f) || { f, title: f, label: '' };
    /* Wo ist diese Katalogfrage im Report erklärt? Genaue Abschnitte zuerst
       (nach Anzahl passender Originalnummern), sonst der Report zur Vorlesung. */
    idx.forCard = function (cid) {
      const c = idx.cards[cid];
      if (!c) return { spots: [], reports: [] };
      const score = new Map();
      c.nums.forEach(n => (idx.byNum[n] || []).forEach(s => {
        const k = s.f + '#' + s.a;
        const e = score.get(k) || { ...s, hits: 0 }; e.hits++; score.set(k, e);
      }));
      const spots = [...score.values()].sort((x, y) => y.hits - x.hits).slice(0, 3)
        .map(s => ({ ...s, rep: repOf(s.f) }));
      let reports = [];
      if (!spots.length) {
        // Nur Reports, deren Hauptquelle diese Vorlesung ist — ein Report, der
        // sie bloß mit zwei Folien streift, wäre ein falscher Wegweiser.
        reports = idx.reports.filter(r => r.keys[0] === c.sec).slice(0, 2);
      }
      return { spots, reports };
    };
    idx.cardForNums = list => { for (const n of list) if (idx.numToCard[n]) return idx.numToCard[n]; return null; };
    idx.reportURL = (f, a) => LH.APP + 'view.html?f=' + encodeURIComponent(f) + (a ? '#' + encodeURIComponent(a) : '');
    idx.catalogURL = cid => idx.catalog ? LH.APP + 'view.html?f=' + encodeURIComponent(idx.catalog) + (cid ? '#' + encodeURIComponent(cid) : '') : null;
    return idx;
  }

  /* ---------------- Fehlerlog ---------------- */
  const PATH = 'progress/fehlerlog.json';
  const K_STATE = 'lh_errlog', K_PEND = 'lh_errlog_pending';
  let state = local.get(K_STATE, { version: 1, files: {} });
  let pending = local.get(K_PEND, []);
  let loaded = null, timer = null, flushing = null;
  const listeners = new Set();

  function apply(data, d) {
    data = data && data.files ? data : { version: 1, files: {} };
    const F = data.files[d.f] || (data.files[d.f] = {});
    const e = F[d.c] || (F[d.c] = { w: 0, r: 0, s: 0, t: 0 });
    if (d.ok) { e.r++; e.s++; } else { e.w++; e.s = 0; e.lw = d.t; }
    e.t = d.t;
    return data;
  }
  const emit = () => listeners.forEach(fn => { try { fn(); } catch (e) {} });
  function load() {
    if (loaded) return loaded;
    loaded = LH.readJSON(PATH).then(({ data }) => {
      let s = data && data.files ? data : { version: 1, files: {} };
      pending.forEach(d => { s = apply(s, d); });
      state = s; local.set(K_STATE, state); emit();
      if (pending.length) flush();
      return state;
    }).catch(() => state);
    return loaded;
  }
  function record(file, cid, ok) {
    const d = { f: file, c: cid, ok: !!ok, t: Date.now() };
    state = apply(state, d); pending.push(d);
    local.set(K_STATE, state); local.set(K_PEND, pending);
    emit();
    clearTimeout(timer); timer = setTimeout(flush, 2500);
  }
  function flush() {
    clearTimeout(timer);
    if (!pending.length) return Promise.resolve();
    if (flushing) return flushing.then(flush);
    const batch = pending.slice();
    flushing = LH.updateJSON(PATH, data => batch.reduce(apply, data), 'Fehlerlog: ' + batch.length + ' Antwort(en)')
      .then(fresh => {
        pending = pending.slice(batch.length); local.set(K_PEND, pending);
        let s = fresh; pending.forEach(d => { s = apply(s, d); }); state = s; local.set(K_STATE, state); emit();
      })
      .catch(() => {})   // offline: bleibt auf dem Gerät und geht beim nächsten Mal mit
      .finally(() => { flushing = null; });
    return flushing;
  }
  const entry = (file, cid) => ((state.files[file] || {})[cid]) || null;
  const inLog = e => !!e && e.w > 0 && e.s < 2;
  function list(file) {
    return Object.entries(state.files[file] || {}).filter(([, e]) => inLog(e))
      .sort((a, b) => (b[1].lw || 0) - (a[1].lw || 0)).map(([cid, e]) => ({ cid, ...e }));
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', () => { flush(); });

  window.LHLinks = {
    LINK_FOLDERS, forFile,
    errlog: { load, record, flush, entry, inLog: (f, c) => inLog(entry(f, c)), list, on: fn => listeners.add(fn) }
  };
})();
