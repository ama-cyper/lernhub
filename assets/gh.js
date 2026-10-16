/* Lernreport-Hub — Verbindung zu GitHub.
   Die App selbst ist nur eine leere Hülle. Alle Lernreports liegen im PRIVATEN
   Repo und werden nur mit dem persönlichen Zugangsschlüssel (Token) geladen,
   der ausschließlich in diesem Browser gespeichert wird. */
(function () {
  'use strict';
  if (window.LH) return;

  const CFG = { owner: 'ama-cyper', repo: 'lernhub-daten', branch: 'main' };
  const KEY = 'lh_token';
  const store = {
    get(k) { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v, persist) {
      try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {}
      try { (persist ? localStorage : sessionStorage).setItem(k, v); } catch (e) {}
    },
    del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) {} }
  };
  // Nur für lokale Tests umstellbar; im Normalbetrieb immer api.github.com.
  let API = 'https://api.github.com';
  try { if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && localStorage.getItem('lh_api')) API = localStorage.getItem('lh_api'); } catch (e) {}

  const me = document.currentScript && document.currentScript.src;
  const APP = me ? new URL('../', me).href : new URL('./', location.href).href;
  const R = `/repos/${CFG.owner}/${CFG.repo}`;

  /* ---------- Base64 (UTF-8-sicher, auch für große Dateien) ---------- */
  function b64FromBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const b64FromText = t => b64FromBytes(new TextEncoder().encode(t));
  function bytesFromB64(b) {
    const bin = atob(String(b).replace(/\s/g, ''));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  const textFromB64 = b => new TextDecoder().decode(bytesFromB64(b));
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');

  /* ---------- Anfragen ---------- */
  class GHError extends Error {
    constructor(status, msg) { super(msg); this.status = status; this.conflict = status === 409; }
  }
  async function api(path, opts = {}) {
    const token = opts.token || store.get(KEY);
    if (!token) throw new GHError(401, 'Nicht angemeldet');
    let res;
    try {
      res = await fetch(API + path, {
        method: opts.method || 'GET',
        cache: opts.cache || 'no-store',
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: opts.accept || 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new GHError(0, 'Keine Verbindung — bist du online?');
    }
    if (res.status === 401) { throw new GHError(401, 'Zugangsschlüssel ungültig oder abgelaufen'); }
    if (!res.ok) {
      let m = res.statusText;
      try { m = (await res.json()).message || m; } catch (e) {}
      // GitHub meldet „Datei wurde inzwischen geändert“ als 409 (manchmal 422 mit sha-Hinweis)
      if (res.status === 422 && /sha/i.test(m)) throw new GHError(409, m);
      throw new GHError(res.status, m);
    }
    if (opts.raw === 'text') return res.text();
    if (opts.raw === 'blob') return res.blob();
    return res.status === 204 ? null : res.json();
  }

  /* Alle Dateien des Repos mit ihren Versionskennungen (sha). */
  async function tree() {
    const ref = await api(`${R}/git/ref/heads/${CFG.branch}`);
    const t = await api(`${R}/git/trees/${ref.object.sha}?recursive=1`);
    const map = new Map();
    for (const e of t.tree) if (e.type === 'blob') map.set(e.path, e.sha);
    return map;
  }

  async function readText(path, sha) {
    if (sha) return api(`${R}/git/blobs/${sha}`, { accept: 'application/vnd.github.raw', raw: 'text', cache: 'force-cache' });
    return api(`${R}/contents/${encPath(path)}?ref=${CFG.branch}`, { accept: 'application/vnd.github.raw', raw: 'text' });
  }

  async function readJSON(path) {
    try {
      const j = await api(`${R}/contents/${encPath(path)}?ref=${CFG.branch}`);
      return { data: JSON.parse(textFromB64(j.content)), sha: j.sha };
    } catch (e) {
      if (e.status === 404) return { data: null, sha: null };
      throw e;
    }
  }

  async function putText(path, text, sha, message) {
    const j = await api(`${R}/contents/${encPath(path)}`, {
      method: 'PUT',
      body: { message, content: b64FromText(text), branch: CFG.branch, ...(sha ? { sha } : {}) }
    });
    return j.content.sha;
  }

  /* Bilder heißen nach ihrem Inhalt — existiert die Datei schon, ist sie identisch. */
  async function putImage(path, b64) {
    try {
      await api(`${R}/contents/${encPath(path)}`, {
        method: 'PUT', body: { message: 'Bild: ' + path.split('/').pop(), content: b64, branch: CFG.branch }
      });
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }

  async function del(path, sha, message) {
    await api(`${R}/contents/${encPath(path)}`, { method: 'DELETE', body: { message, sha, branch: CFG.branch } });
  }

  /* JSON-Datei ändern: lesen → ändern → schreiben; bei Konflikt neu lesen und nochmal. */
  async function updateJSON(path, mutate, message) {
    for (let i = 0; i < 4; i++) {
      const { data, sha } = await readJSON(path);
      const next = mutate(data);
      try {
        await putText(path, JSON.stringify(next, null, 2), sha, message);
        return next;
      } catch (e) { if (!e.conflict) throw e; }
    }
    throw new GHError(409, 'Konnte nicht gespeichert werden (zu viele gleichzeitige Änderungen)');
  }

  /* Mehrere Dateien in EINEM Speicherstand (Commit) ablegen. */
  async function commitFiles(files, message) {
    const ref = await api(`${R}/git/ref/heads/${CFG.branch}`);
    const head = await api(`${R}/git/commits/${ref.object.sha}`);
    const entries = [];
    for (const f of files) {
      const blob = await api(`${R}/git/blobs`, { method: 'POST',
        body: f.b64 != null ? { content: f.b64, encoding: 'base64' } : { content: f.text, encoding: 'utf-8' } });
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const t = await api(`${R}/git/trees`, { method: 'POST', body: { base_tree: head.tree.sha, tree: entries } });
    const c = await api(`${R}/git/commits`, { method: 'POST', body: { message, tree: t.sha, parents: [ref.object.sha] } });
    await api(`${R}/git/refs/heads/${CFG.branch}`, { method: 'PATCH', body: { sha: c.sha } });
  }

  /* ---------- Bilder: lazy aus dem privaten Repo laden ---------- */
  const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const imgCache = new Map();
  async function imageURL(path) {
    if (imgCache.has(path)) return imgCache.get(path);
    const p = (async () => {
      let blob = null, cache = null;
      try { cache = await caches.open('lh-img-v1'); const hit = await cache.match(APP + '__img/' + path); if (hit) blob = await hit.blob(); } catch (e) {}
      if (!blob) {
        blob = await api(`${R}/contents/${encPath(path)}?ref=${CFG.branch}`, { accept: 'application/vnd.github.raw', raw: 'blob', cache: 'default' });
        // Bildnamen sind Inhalts-Prüfsummen — einmal geladen, nie wieder ändernd.
        if (cache && /\/img\/[0-9a-f]{16}\./.test(path)) { try { await cache.put(APP + '__img/' + path, new Response(blob)); } catch (e) {} }
      }
      return URL.createObjectURL(blob);
    })();
    imgCache.set(path, p);
    p.catch(() => imgCache.delete(path));
    return p;
  }
  function loadImg(img) {
    const rel = img.getAttribute('data-gh-src');
    if (!rel || img._lhLoading) return Promise.resolve();
    img._lhLoading = true;
    return imageURL('lectures/' + rel).then(u => { img.src = u; }).catch(() => { img._lhLoading = false; img.alt = img.alt || 'Bild konnte nicht geladen werden'; });
  }
  let io = null;
  function hydrateImages(root) {
    const imgs = (root || document).querySelectorAll('img[data-gh-src]');
    if (!('IntersectionObserver' in window)) { imgs.forEach(loadImg); return; }
    if (!io) io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); loadImg(e.target); } }), { rootMargin: '1200px 0px' });
    imgs.forEach(i => io.observe(i));
  }
  const loadAllImages = () => Promise.all([...document.querySelectorAll('img[data-gh-src]')].map(loadImg));

  /* Relative Bildpfade im Report-HTML auf das private Repo umbiegen. */
  function prepareImages(html) {
    return html.replace(/(<img\b[^>]*?\s)src=(["'])(?!https?:|data:|blob:|\/\/|\/)([^"']+)\2/gi,
      (m, pre, q, src) => `${pre}src=${q}${PIXEL}${q} data-gh-src=${q}${src}${q}`);
  }

  /* Eingebettete Bilder (data:) aus einem Report herauslösen → eigene Dateien. */
  async function extractImages(html) {
    const files = [];
    const re = /(<img\b[^>]*?\ssrc=)(["'])data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\2/gi;
    const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
    const parts = [];
    let last = 0, m;
    while ((m = re.exec(html))) {
      const b64 = m[4].replace(/\s/g, '');
      const name = await hashName(bytesFromB64(b64), EXT[m[3].toLowerCase()] || 'bin');
      if (!files.some(f => f.path === 'lectures/' + name)) files.push({ path: 'lectures/' + name, b64 });
      parts.push(html.slice(last, m.index), `${m[1]}${m[2]}${name}${m[2]}`);
      last = m.index + m[0].length;
    }
    parts.push(html.slice(last));
    return { html: parts.join(''), files };
  }
  async function hashName(bytes, ext) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    return 'img/' + [...d].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16) + '.' + ext;
  }

  /* ---------- Anmeldung ---------- */
  async function verify(token) {
    const r = await api(R, { token });
    if (!r.private) throw new GHError(403, 'Das Daten-Repo ist ÖFFENTLICH. Aus Sicherheitsgründen abgebrochen — stelle es in den GitHub-Einstellungen auf „Private“.');
    if (!r.permissions || !r.permissions.push) throw new GHError(403, 'Der Schlüssel darf das Repo nur lesen. Bitte „Contents: Read and write“ vergeben.');
    return r;
  }
  function login(token, persist) { store.set(KEY, token, persist); }
  function logout() {
    store.del(KEY);
    try { caches.delete('lh-img-v1'); } catch (e) {}
    try { Object.keys(localStorage).filter(k => k.startsWith('lh_draft:') || k === 'lh_meta').forEach(k => localStorage.removeItem(k)); } catch (e) {}
  }

  /* ---------- Entwürfe (Sicherheitsnetz, falls das Speichern scheitert) ---------- */
  const draftKey = f => 'lh_draft:' + f;
  const drafts = {
    get(f) { try { return JSON.parse(localStorage.getItem(draftKey(f))); } catch (e) { return null; } },
    set(f, d) { try { localStorage.setItem(draftKey(f), JSON.stringify(d)); return true; } catch (e) { return false; } },
    del(f) { try { localStorage.removeItem(draftKey(f)); } catch (e) {} }
  };

  window.LH = {
    CFG, APP, PIXEL, GHError,
    token: () => store.get(KEY), login, logout, verify,
    tree, readText, readJSON, putText, putImage, del, updateJSON, commitFiles,
    imageURL, hydrateImages, loadAllImages, prepareImages, extractImages, hashName,
    b64FromBytes, b64FromText, drafts,
    repoURL: `https://github.com/${CFG.owner}/${CFG.repo}`
  };
})();
