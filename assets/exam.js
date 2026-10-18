/* Lernreport-Hub — Prüfungsmodus für Altfragen-Kataloge.
   Liest einen Katalog (article.card > .stem + ol.opts + details.sol) aus dem
   privaten Repo, lässt Themen auswählen und fragt interaktiv ab.
   Der Katalog selbst wird nie verändert. Jede Fassung einer Frage
   (Hauptfassung + jede „Variante aus Frage …“) ist ein eigenes Prüfungsitem
   mit ihrem eigenen Lösungsschlüssel. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const app = $('#app');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nums = t => (String(t || '').match(/\d+/g) || []);
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const q = new URLSearchParams(location.search);
  const file = q.get('f');
  const back = 'view.html?f=' + encodeURIComponent(file || '');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const K_STATS = 'lh_exam_stats:' + file, K_SESS = 'lh_exam_sess:' + file, K_PREF = 'lh_exam_pref:' + file;

  function fail(msg) {
    app.innerHTML = `<div class="ex-center"><p><b>${esc(msg)}</b></p><p><a href="./">← Zurück zum Hub</a></p></div>`;
  }

  /* ================= Katalog einlesen ================= */
  function clean(node) {           // Inhalte aus dem eigenen Katalog — trotzdem Skripte/Handler raus
    $$('script,style,input,label.done', node).forEach(n => n.remove());
    $$('*', node).forEach(n => [...n.attributes].forEach(a => { if (/^on/i.test(a.name)) n.removeAttribute(a.name); }));
    return node;
  }
  function readOpts(ol) {
    if (!ol) return null;
    return $$(':scope > li', ol).map((li, i) => {
      const L = $('.L', li);
      const letter = L ? L.textContent.replace(/[^A-Za-z]/g, '').toUpperCase() : String.fromCharCode(65 + i);
      const body = li.cloneNode(true); const l2 = $('.L', body); if (l2) l2.remove();
      return { letter, html: clean(body).innerHTML.trim() };
    });
  }
  function parse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = ($('h1', doc) || {}).textContent || doc.title || 'Altfragen';
    const groups = new Map();
    $$('.grphead[data-grp]', doc).forEach(g => groups.set(g.dataset.grp, g.textContent.trim()));
    const sections = [];
    const items = [];
    const problems = [];
    $$('section[id]', doc).forEach(sec => {
      const cards = $$('article.card', sec);
      if (!cards.length) return;
      const h2 = ($('.sechead h2', sec) || $('h2', sec) || {}).textContent || sec.id;
      const [key, ...rest] = h2.split(' · ');
      const S = { id: sec.id, key: key.trim(), title: (rest.join(' · ') || h2).trim(), grp: sec.dataset.grp || 'x', items: [] };
      sections.push(S);
      cards.forEach(card => {
        const cid = card.id || ('q' + items.length);
        const n = +card.dataset.n || 1;
        const freq = ($('.freq', card) || {}).textContent || '';
        const mainStem = $(':scope > .stem', card);
        const extras = $$(':scope > .figbox, :scope > .notebox, :scope > .extbox', card).map(e => clean(e.cloneNode(true)).outerHTML).join('');
        const solin = $('details.sol .solin', card);
        const ag = solin ? $$('.ansgrp', solin).map(g => ({ g, n: nums(($('.alab', g) || {}).textContent) })) : [];
        // Begründung, Hinweise, Fundstelle — alles aus der Lösung außer den Schlüsselzeilen
        let explain = '';
        if (solin) {
          const c = solin.cloneNode(true);
          $$('h4, .ansgrp, label.done', c).forEach(x => x.remove());
          explain = clean(c).innerHTML.trim();
        }
        const versions = [{ stem: mainStem, opts: $(':scope > ol.opts', card), label: '', isVar: false, vnums: null }];
        $$(':scope > details.var', card).forEach(v => {
          const sm = ($('summary', v) || {}).textContent || '';
          versions.push({ stem: $('.stem', v) || mainStem, opts: $('ol.opts', v), label: sm.replace(/\s*anzeigen\s*$/i, '').trim(),
            isVar: true, vnums: nums(sm), note: ($('.vnote', v) || {}).textContent || '' });
        });
        const varNums = new Set(versions.filter(v => v.isVar).flatMap(v => v.vnums));
        versions.forEach((v, vi) => {
          const match = v.isVar ? ag.filter(a => a.n.some(x => v.vnums.includes(x))) : ag.filter(a => !a.n.some(x => varNums.has(x)));
          const grp = match.length === 1 ? match[0].g : (ag[vi] || ag[0] || {}).g;
          if (match.length !== 1) problems.push(cid + (v.isVar ? ' / ' + v.label : '') + ': Lösung nicht eindeutig zugeordnet');
          const opts = readOpts(v.opts);
          const ansEls = grp ? $$('.ans', grp) : [];
          const correct = ansEls.map(a => (($('.L', a) || {}).textContent || '').replace(/[^A-Za-z]/g, '').toUpperCase()).filter(Boolean);
          const free = grp ? ($('.ans-free', grp) || {}).textContent || '' : '';
          const keyHtml = grp ? clean(grp.cloneNode(true)).innerHTML : '';
          let type = 'mc';
          if (!opts || !opts.length) type = 'free';
          else if (!correct.length && /keine/i.test(free)) type = 'none';
          else if (!correct.length) type = 'free';
          if (opts && type === 'mc') correct.forEach(L => { if (!opts.some(o => o.letter === L)) problems.push(cid + ': Lösung ' + L + ' fehlt in den Optionen'); });
          const item = {
            id: cid + '~' + vi, cid, sec: S.id, secKey: S.key, n, freq: freq.trim(), isVar: v.isVar, varLabel: v.label,
            asked: grp ? (($('.alab', grp) || {}).textContent || '').trim() : '',
            stem: v.stem ? clean(v.stem.cloneNode(true)).innerHTML.replace(/[ \t]*\n[ \t]*(?=[a-zäöüß(,])/g, ' ') : '', extras,
            opts: type === 'free' ? (opts || []) : opts, correct: type === 'mc' ? correct : [], type, free: free.trim(), keyHtml, explain
          };
          items.push(item); S.items.push(item);
        });
      });
    });
    const originals = new Set(items.flatMap(i => nums(i.asked)));
    return { title: title.trim(), groups, sections, items, problems, originals: originals.size, cards: new Set(items.map(i => i.cid)).size };
  }

  /* ================= Zustand ================= */
  let CAT = null;
  let pref = Object.assign({ secs: null, versions: 'all', count: 20, order: 'mix', hot: false, wrong: false, free: true }, store.get(K_PREF, {}));
  let stats = store.get(K_STATS, {});
  let sess = null;   // { ids, idx, res: {id: {sel:[], ok:bool|null, part}} , checked:{} }

  const byId = id => CAT.items.find(i => i.id === id);
  function pool() {
    const secs = new Set(pref.secs || CAT.sections.map(s => s.id));
    return CAT.items.filter(i => secs.has(i.sec)
      && (pref.versions === 'all' || !i.isVar)
      && (!pref.hot || i.n >= 2)
      && (pref.free || i.type !== 'free')
      && (!pref.wrong || (stats[i.id] && stats[i.id].last === 0)));
  }
  const savePref = () => store.set(K_PREF, pref);
  const saveSess = () => sess ? store.set(K_SESS, sess) : store.del(K_SESS);

  /* ================= Startseite: Auswahl ================= */
  function renderSetup() {
    window.scrollTo(0, 0);
    const all = new Set(pref.secs || CAT.sections.map(s => s.id));
    const p = pool();
    const wrongCount = CAT.items.filter(i => stats[i.id] && stats[i.id].last === 0).length;
    const count = pref.count === 'all' ? p.length : Math.min(pref.count, p.length);
    const resume = store.get(K_SESS, null);
    const grpOrder = [...new Set(CAT.sections.map(s => s.grp))];
    const vcount = s => s.items.filter(i => pref.versions === 'all' || !i.isVar).length;
    const seg = (name, val, label) => `<button class="seg${String(pref[name]) === String(val) ? ' on' : ''}" data-pref="${name}" data-val="${val}">${label}</button>`;
    app.innerHTML = `
      <header class="ex-top"><a class="ex-back" href="${esc(back)}">← Katalog</a><span class="ex-brand">Prüfungsmodus</span><span></span></header>
      <main class="ex-wrap">
        <div class="ex-hero">
          <div class="ex-eyebrow">Altfragen · interaktiv</div>
          <h1>${esc(CAT.title.replace(/\s*–\s*thematischer Katalog/i, ''))}</h1>
          <p class="ex-lead">${CAT.cards} Fragen in ${CAT.items.length} Fassungen · deckt alle ${CAT.originals} Altfragen ab</p>
        </div>
        ${resume && resume.ids && resume.idx < resume.ids.length ? `
        <div class="ex-resume"><div><b>Laufende Prüfung</b><span>Frage ${resume.idx + 1} von ${resume.ids.length}</span></div>
          <div class="ex-resume-b"><button class="btn ghost" id="dropSess">Verwerfen</button><button class="btn primary" id="resumeSess">Fortsetzen</button></div></div>` : ''}
        <section class="ex-card">
          <div class="ex-card-h"><h2>Themen</h2>
            <div class="ex-mini"><button class="linkbtn" id="selAll">Alle</button><span>·</span><button class="linkbtn" id="selNone">Keine</button></div></div>
          ${grpOrder.map(g => {
            const secs = CAT.sections.filter(s => s.grp === g);
            const allOn = secs.every(s => all.has(s.id));
            return `<div class="ex-grp"><div class="ex-grp-h"><span>${esc(CAT.groups.get(g) || 'Weitere')}</span>
              <button class="linkbtn" data-grpsel="${esc(g)}">${allOn ? 'abwählen' : 'alle'}</button></div>
              <div class="ex-tiles">${secs.map(s => `
                <button class="tile${all.has(s.id) ? ' on' : ''}" data-sec="${esc(s.id)}" aria-pressed="${all.has(s.id)}">
                  <span class="tile-k">${esc(s.key)}</span><span class="tile-t">${esc(s.title)}</span>
                  <span class="tile-c">${vcount(s)} ${pref.versions === 'all' ? 'Fassungen' : 'Fragen'}</span><span class="tile-ck" aria-hidden="true"></span></button>`).join('')}
              </div></div>`;
          }).join('')}
        </section>
        <section class="ex-card">
          <div class="ex-card-h"><h2>Einstellungen</h2></div>
          <div class="ex-opt"><div class="ex-opt-l">Fassungen<small>Varianten = gleiche Frage aus anderen Jahrgängen, eigene Lösung</small></div>
            <div class="segs">${seg('versions', 'all', 'Alle Fassungen')}${seg('versions', 'main', 'Nur Hauptfassung')}</div></div>
          <div class="ex-opt"><div class="ex-opt-l">Anzahl</div>
            <div class="segs">${seg('count', 10, '10')}${seg('count', 20, '20')}${seg('count', 40, '40')}${seg('count', 'all', 'Alle')}</div></div>
          <div class="ex-opt"><div class="ex-opt-l">Reihenfolge</div>
            <div class="segs">${seg('order', 'mix', 'Gemischt')}${seg('order', 'cat', 'Wie im Katalog')}</div></div>
          <label class="ex-sw"><input type="checkbox" data-chk="hot" ${pref.hot ? 'checked' : ''}><span class="sw"></span><span>Nur mehrfach gefragte</span></label>
          <label class="ex-sw"><input type="checkbox" data-chk="free" ${pref.free ? 'checked' : ''}><span class="sw"></span><span>Freitext- &amp; Abbildungsfragen einbeziehen</span></label>
          <label class="ex-sw${wrongCount ? '' : ' dis'}"><input type="checkbox" data-chk="wrong" ${pref.wrong ? 'checked' : ''} ${wrongCount ? '' : 'disabled'}><span class="sw"></span>
            <span>Nur zuletzt falsch beantwortete <em>(${wrongCount})</em></span></label>
        </section>
        <div class="ex-start">
          <button class="btn primary big" id="start" ${count ? '' : 'disabled'}>${count ? `Prüfung starten · ${count} ${count === 1 ? 'Frage' : 'Fragen'}` : 'Keine Fragen ausgewählt'}</button>
          ${count && count < p.length ? `<p class="ex-note">Zufällig aus ${p.length} passenden Fassungen gezogen.</p>` : ''}
        </div>
      </main>`;

    app.onclick = e => {
      const t = e.target.closest('button'); if (!t) return;
      const cur = new Set(pref.secs || CAT.sections.map(s => s.id));
      if (t.dataset.sec) { cur.has(t.dataset.sec) ? cur.delete(t.dataset.sec) : cur.add(t.dataset.sec); pref.secs = [...cur]; }
      else if (t.dataset.grpsel) {
        const ids = CAT.sections.filter(s => s.grp === t.dataset.grpsel).map(s => s.id);
        const on = ids.every(i => cur.has(i)); ids.forEach(i => on ? cur.delete(i) : cur.add(i)); pref.secs = [...cur];
      }
      else if (t.id === 'selAll') pref.secs = null;
      else if (t.id === 'selNone') pref.secs = [];
      else if (t.dataset.pref) { const v = t.dataset.val; pref[t.dataset.pref] = /^\d+$/.test(v) ? +v : v; }
      else if (t.id === 'start') return start(pool());
      else if (t.id === 'resumeSess') { sess = resume; return renderQ(); }
      else if (t.id === 'dropSess') { store.del(K_SESS); }
      else return;
      savePref(); const y = scrollY; renderSetup(); scrollTo(0, y);
    };
    app.onchange = e => {
      const c = e.target.closest('[data-chk]'); if (!c) return;
      pref[c.dataset.chk] = c.checked; savePref(); const y = scrollY; renderSetup(); scrollTo(0, y);
    };
  }

  function start(list, keepOrder) {
    let ids = (keepOrder || pref.order === 'cat') ? list.map(i => i.id) : shuffle(list).map(i => i.id);
    if (!keepOrder && pref.count !== 'all') ids = ids.slice(0, pref.count);
    if (!keepOrder && pref.order === 'cat') {     // Auswahl zufällig, Anzeige in Katalogreihenfolge
      const pick = new Set(pref.count === 'all' ? ids : shuffle(list).slice(0, pref.count).map(i => i.id));
      ids = list.filter(i => pick.has(i.id)).map(i => i.id);
    }
    sess = { ids, idx: 0, res: {}, started: Date.now() };
    saveSess(); renderQ();
  }

  /* ================= Frage ================= */
  function renderQ() {
    window.scrollTo(0, 0);
    if (sess.idx >= sess.ids.length) return renderEnd();
    const it = byId(sess.ids[sess.idx]);
    if (!it) { sess.idx++; saveSess(); return renderQ(); }
    const r = sess.res[it.id] || (sess.res[it.id] = { sel: [], done: false, ok: null });
    const answered = Object.values(sess.res).filter(x => x.done);
    const right = answered.filter(x => x.ok === true).length;
    const pct = Math.round(sess.idx / sess.ids.length * 100);
    const secT = (CAT.sections.find(s => s.id === it.sec) || {}).title || '';
    const hint = it.type === 'free' ? 'Freitext – erst selbst beantworten, dann Lösung ansehen'
      : 'Eine oder mehrere Antworten können richtig sein';

    app.innerHTML = `
      <header class="ex-top"><button class="ex-back" id="quit">✕ Beenden</button>
        <span class="ex-count">Frage <b>${sess.idx + 1}</b> / ${sess.ids.length}</span>
        <span class="ex-score" title="Richtig beantwortet">✓ ${right}${answered.length ? ' / ' + answered.length : ''}</span>
        <div class="ex-prog"><i style="width:${pct}%"></i></div></header>
      <main class="ex-wrap ex-q">
        <div class="ex-meta"><span class="chip key">${esc(it.secKey)}</span><span class="chip">${esc(secT)}</span>
          ${it.n >= 2 ? `<span class="chip hot">${esc(it.freq || it.n + '× gefragt')}</span>` : ''}
          ${it.isVar ? `<span class="chip var">${esc(it.varLabel)}</span>` : ''}</div>
        <article class="ex-qcard${it.type === 'free' ? ' free' : ''}">
          <div class="ex-stem">${it.stem}</div>
          ${it.extras ? `<div class="ex-extras">${it.extras}</div>` : ''}
          <p class="ex-hint">${hint}</p>
          ${it.opts && it.opts.length ? `<div class="ex-opts" role="group">${it.opts.map(o => `
            <button class="opt" data-l="${esc(o.letter)}" aria-pressed="false"><span class="opt-l">${esc(o.letter)}</span><span class="opt-t">${o.html}</span><span class="opt-mark" aria-hidden="true"></span></button>`).join('')}</div>` : ''}
          <div class="ex-verdict" id="verdict" hidden></div>
          <div class="ex-sol" id="sol" hidden></div>
        </article>
        <div class="ex-actions" id="actions"></div>
        <p class="ex-keys">Tastatur: ${it.opts && it.opts.length && it.type !== 'free' ? 'A–' + it.opts[it.opts.length - 1].letter + ' wählen · ' : ''}Enter = prüfen / weiter</p>
      </main>`;
    paint(it, r);

    app.onclick = e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.id === 'quit') { if (!answered.length || confirm('Prüfung beenden und Auswertung zeigen?')) return renderEnd(true); return; }
      if (t.classList.contains('opt')) {
        if (r.done || it.type === 'free') return;
        const L = t.dataset.l; r.sel = r.sel.includes(L) ? r.sel.filter(x => x !== L) : [...r.sel, L].sort();
        saveSess(); return paint(it, r);
      }
      if (t.id === 'check') return check(it, r);
      if (t.id === 'know' || t.id === 'dunno') { r.ok = t.id === 'know'; record(it, r.ok); saveSess(); return paint(it, r); }
      if (t.id === 'next') { sess.idx++; saveSess(); return renderQ(); }
      if (t.id === 'prev') { sess.idx = Math.max(0, sess.idx - 1); saveSess(); return renderQ(); }
    };
  }

  function check(it, r) {
    r.done = true;
    if (it.type === 'free') { r.ok = null; saveSess(); return paint(it, r); }
    const want = it.type === 'none' ? [] : it.correct;
    const hit = r.sel.filter(l => want.includes(l)).length;
    const wrongSel = r.sel.filter(l => !want.includes(l)).length;
    r.ok = wrongSel === 0 && hit === want.length;
    r.part = !r.ok && hit > 0;
    record(it, r.ok); saveSess(); paint(it, r);
  }
  function record(it, ok) {
    const s = stats[it.id] || { r: 0, w: 0 };
    ok ? s.r++ : s.w++; s.last = ok ? 1 : 0; s.t = Date.now();
    stats[it.id] = s; store.set(K_STATS, stats);
  }

  function paint(it, r) {
    const want = it.type === 'none' ? [] : it.correct;
    $$('.opt', app).forEach(b => {
      const L = b.dataset.l, sel = r.sel.includes(L), cor = want.includes(L);
      b.classList.toggle('sel', sel); b.setAttribute('aria-pressed', sel);
      b.classList.remove('ok', 'bad', 'miss', 'dim');
      if (r.done && it.type !== 'free') {
        b.disabled = true;
        if (cor && sel) b.classList.add('ok');
        else if (cor) b.classList.add('miss');
        else if (sel) b.classList.add('bad');
        else b.classList.add('dim');
        const m = $('.opt-mark', b);
        m.textContent = cor && sel ? '✓ richtig' : cor ? 'verpasst' : sel ? '✗ falsch' : '';
      }
    });
    const v = $('#verdict'), sol = $('#sol'), act = $('#actions');
    if (r.done) {
      sol.hidden = false;
      const keyLine = it.type === 'mc' ? `<div class="ex-key"><span class="k">Richtig</span><b>${want.join(', ')}</b>${it.asked ? `<span class="src">${esc(it.asked)}</span>` : ''}</div>`
        : it.type === 'none' ? `<div class="ex-key"><span class="k">Richtig</span><b>Keine der Antworten</b>${it.asked ? `<span class="src">${esc(it.asked)}</span>` : ''}</div>`
        : `<div class="ex-key"><span class="k">Lösung</span><b>${esc(it.free || 'siehe Begründung')}</b>${it.asked ? `<span class="src">${esc(it.asked)}</span>` : ''}</div>`;
      sol.innerHTML = keyLine + `<div class="ex-explain">${it.explain}</div>`;
      if (it.type === 'free') {
        v.hidden = r.ok === null;
        if (r.ok !== null) { v.className = 'ex-verdict ' + (r.ok ? 'good' : 'bad'); v.textContent = r.ok ? '✓ Gewusst' : '✗ Nicht gewusst'; }
        act.innerHTML = r.ok === null
          ? `<span class="ex-self">Wie lief's?</span><button class="btn bad" id="dunno">Nicht gewusst</button><button class="btn good" id="know">Gewusst</button>`
          : nav(true);
      } else {
        v.hidden = false;
        const missed = want.filter(l => !r.sel.includes(l)).length, extra = r.sel.filter(l => !want.includes(l)).length;
        v.className = 'ex-verdict ' + (r.ok ? 'good' : r.part ? 'part' : 'bad');
        v.innerHTML = r.ok ? '✓ Richtig' : (r.part ? '✗ Teilweise richtig' : '✗ Falsch') +
          `<small>${[missed ? missed + ' verpasst' : '', extra ? extra + ' falsch gewählt' : '', r.part ? 'zählt als falsch' : '', !r.sel.length && want.length ? 'nichts gewählt' : ''].filter(Boolean).join(' · ')}</small>`;
        act.innerHTML = nav(true);
      }
    } else {
      v.hidden = true; sol.hidden = true;
      act.innerHTML = (sess.idx > 0 ? '<button class="btn ghost" id="prev">← Zurück</button>' : '<span></span>') +
        `<button class="btn primary" id="check">${it.type === 'free' ? 'Lösung anzeigen' : (it.type === 'none' || r.sel.length ? 'Lösung anzeigen' : 'Lösung anzeigen (nichts gewählt)')}</button>`;
    }
  }
  const nav = () => (sess.idx > 0 ? '<button class="btn ghost" id="prev">← Zurück</button>' : '<span></span>') +
    `<button class="btn primary" id="next">${sess.idx + 1 >= sess.ids.length ? 'Auswertung →' : 'Nächste Frage →'}</button>`;

  /* ================= Auswertung ================= */
  function renderEnd(early) {
    window.scrollTo(0, 0);
    const done = sess.ids.map(id => [byId(id), sess.res[id]]).filter(([i, r]) => i && r && r.done && r.ok !== null);
    const right = done.filter(([, r]) => r.ok).length;
    const pct = done.length ? Math.round(right / done.length * 100) : 0;
    const wrong = done.filter(([, r]) => !r.ok).map(([i]) => i);
    const bySec = CAT.sections.map(s => {
      const d = done.filter(([i]) => i.sec === s.id);
      return { s, n: d.length, r: d.filter(([, r]) => r.ok).length };
    }).filter(x => x.n);
    const tone = pct >= 80 ? 'good' : pct >= 60 ? 'part' : 'bad';
    store.del(K_SESS);
    app.innerHTML = `
      <header class="ex-top"><a class="ex-back" href="${esc(back)}">← Katalog</a><span class="ex-brand">Auswertung</span><span></span></header>
      <main class="ex-wrap">
        <section class="ex-result ${tone}">
          <div class="ring" style="--p:${pct}"><span>${pct}<small>%</small></span></div>
          <div><h1>${pct >= 80 ? 'Stark.' : pct >= 60 ? 'Solide – da geht noch was.' : 'Dranbleiben.'}</h1>
            <p>${right} von ${done.length} richtig${early ? ` · vorzeitig beendet (${done.length} von ${sess.ids.length} beantwortet)` : ''}</p></div>
        </section>
        ${bySec.length ? `<section class="ex-card"><div class="ex-card-h"><h2>Nach Thema</h2></div>
          ${bySec.map(x => { const p = Math.round(x.r / x.n * 100); return `<div class="bar-row"><span class="bar-k">${esc(x.s.key)}</span><span class="bar-t">${esc(x.s.title)}</span>
            <span class="bar"><i class="${p >= 80 ? 'good' : p >= 60 ? 'part' : 'bad'}" style="width:${p}%"></i></span><span class="bar-n">${x.r}/${x.n}</span></div>`; }).join('')}</section>` : ''}
        ${wrong.length ? `<section class="ex-card"><div class="ex-card-h"><h2>Falsch beantwortet · ${wrong.length}</h2></div>
          ${wrong.map(i => { const r = sess.res[i.id]; return `<details class="rev"><summary><span class="chip key">${esc(i.secKey)}</span><span class="rev-s">${esc(txt(i.stem))}</span></summary>
            <div class="rev-b">${i.type === 'free' ? '' : `<p><span class="k">Deine Wahl</span> ${r.sel.length ? r.sel.join(', ') : '—'} &nbsp; <span class="k">Richtig</span> <b>${i.type === 'none' ? 'keine' : i.correct.join(', ')}</b></p>`}
            ${i.opts && i.opts.length ? `<ol class="rev-opts">${i.opts.map(o => `<li class="${(i.type === 'mc' && i.correct.includes(o.letter)) ? 'c' : r.sel.includes(o.letter) ? 'w' : ''}"><b>${o.letter})</b> ${o.html}</li>`).join('')}</ol>` : ''}
            <div class="ex-explain">${i.explain}</div></div></details>`; }).join('')}</section>` : ''}
        <div class="ex-start row">
          ${wrong.length ? `<button class="btn primary big" id="redo">Falsche wiederholen (${wrong.length})</button>` : ''}
          <button class="btn ${wrong.length ? 'ghost' : 'primary'} big" id="again">Neue Prüfung</button>
        </div>
      </main>`;
    app.onclick = e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.id === 'redo') start(shuffle(wrong), true);
      if (t.id === 'again') { sess = null; renderSetup(); }
    };
  }
  function txt(html) { const d = document.createElement('div'); d.innerHTML = html; return d.textContent.replace(/\s+/g, ' ').trim().slice(0, 140); }

  /* ================= Tastatur ================= */
  document.addEventListener('keydown', e => {
    if (!sess || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (!$('.ex-q')) return;
    if (e.key === 'Enter') { const b = $('#check') || $('#next'); if (b) { e.preventDefault(); b.click(); } return; }
    if (/^[a-h]$/i.test(e.key)) { const b = $(`.opt[data-l="${e.key.toUpperCase()}"]`); if (b && !b.disabled) { e.preventDefault(); b.click(); } }
  });

  /* ================= Start ================= */
  (async function boot() {
    if (!file || !/^[^/\\]+\.html?$/i.test(file)) return fail('Kein Katalog angegeben.');
    if (!LH.token()) { location.replace('./?next=' + encodeURIComponent(location.pathname + location.search)); return; }
    let html;
    try { html = await LH.readText('lectures/' + file); }
    catch (e) {
      if (e.status === 401) { LH.logout(); location.replace('./?next=' + encodeURIComponent(location.pathname + location.search)); return; }
      return fail(e.status === 404 ? 'Diesen Katalog gibt es nicht (mehr).' : (e.message || 'Laden fehlgeschlagen.'));
    }
    CAT = parse(LH.prepareImages(html));
    if (!CAT.items.length) return fail('In dieser Datei wurden keine Altfragen im Katalog-Format gefunden.');
    if (CAT.problems.length) console.warn('Prüfungsmodus:', CAT.problems);
    document.title = 'Prüfung · ' + CAT.title;
    window.LH_EXAM = CAT;   // für Kontrolle in der Konsole
    renderSetup();
    LH.hydrateImages(document);
    new MutationObserver(() => LH.hydrateImages(document)).observe(app, { childList: true });
  })();
})();
