/*
 * End-to-end integration test for frigate-layout-sync.
 *
 * Drives a real browser (Playwright) through the running proxy against a real
 * Frigate, exercising: login through the proxy, the injected button, live-view
 * survival, and the full save / load / responsive-pick / delete flow against
 * Frigate's IndexedDB.
 *
 * SAFETY: this test only writes THROWAWAY IndexedDB keys (a fake camera group
 * that Frigate ignores) and cleans them up afterwards - it never touches your
 * real dragged layouts. It DOES reset frigate-layout-sync's own saved profiles
 * (its layouts.yaml), so point it at a non-critical instance if you care about
 * those.
 *
 * Requirements:
 *   npm install            # installs devDependency "playwright"
 *   npx playwright install chromium
 *   FRIGATE_PASSWORD=...   # Frigate login password (FRIGATE_USER defaults to admin)
 *   FRIGATE_PROXY=http://localhost:3000   # where this service is listening
 *   node test/e2e.js
 */
'use strict';
const { chromium } = require('playwright');

const PROXY = process.env.FRIGATE_PROXY || 'http://localhost:3000';
const USER = process.env.FRIGATE_USER || 'admin';
const PASS = process.env.FRIGATE_PASSWORD;
const TKEY = '__fls_e2e__-draggable-layout:' + USER; // synthetic; Frigate ignores unknown groups
const UKEY = '__fls_e2e_unrelated__';

if (!PASS) { console.error('Set FRIGATE_PASSWORD (and FRIGATE_USER if not "admin").'); process.exit(2); }

const R = [];
const check = (name, cond, extra) => { R.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ('  [' + extra + ']') : '')); };
const listApi = (p) => p.evaluate((b) => fetch(b + '/__layoutsync/api/layouts').then((r) => r.json()), PROXY);
const reopen = async (p) => { if (!(await p.$('#panel.open'))) { await (await p.$('#fab')).click(); await p.waitForTimeout(250); } };
const pick = (profiles, w) => { const bd = profiles.filter((x) => x.maxWidth != null && x.maxWidth >= w).sort((a, b) => a.maxWidth - b.maxWidth); return bd.length ? bd[0] : (profiles.find((x) => x.maxWidth == null) || null); };

(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
  await c.addInitScript(() => {
    const DB = 'keyval-store', ST = 'keyval';
    const open = () => new Promise((res, rej) => { const r = indexedDB.open(DB); r.onupgradeneeded = () => { try { r.result.createObjectStore(ST); } catch (e) {} }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    window.__t = {
      getAll: async () => { const db = await open(); return new Promise((res, rej) => { const o = {}; const tx = db.transaction(ST, 'readonly'); const cu = tx.objectStore(ST).openCursor(); cu.onsuccess = (e) => { const c = e.target.result; if (c) { o[c.key] = c.value; c.continue(); } else res(o); }; cu.onerror = () => rej(cu.error); }); },
      set: async (k, v) => { const db = await open(); return new Promise((res, rej) => { const tx = db.transaction(ST, 'readwrite'); tx.objectStore(ST).put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
      del: async (k) => { const db = await open(); return new Promise((res, rej) => { const tx = db.transaction(ST, 'readwrite'); tx.objectStore(ST).delete(k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
    };
  });
  const p = await c.newPage();

  // reset the tool's own server profiles so this test is deterministic
  for (const e of await fetch(PROXY + '/__layoutsync/api/layouts').then((r) => r.json()).catch(() => [])) {
    await fetch(PROXY + '/__layoutsync/api/layouts/' + e.id, { method: 'DELETE' });
  }

  // ---- login through the proxy ----
  await p.goto(PROXY + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(2000);
  const pe = await p.$('input[type=password]');
  if (pe) { const ue = await p.$('input[type=text],input[name=user]'); if (ue) await ue.fill(USER); await pe.fill(PASS); const bt = await p.$('button[type=submit]') || await p.$('button'); if (bt) await bt.click(); await p.waitForTimeout(6000); }
  check('login works through proxy', !(await p.$('input[type=password]')));
  check('Layouts button injected', !!(await p.$('#fab')));

  const live = await p.evaluate(() => new Promise((res) => { const t = setTimeout(() => res(false), 14000); const iv = setInterval(() => { const v = [...document.querySelectorAll('video')].find((v) => v.readyState >= 2 && v.videoWidth > 0); if (v) { clearInterval(iv); clearTimeout(t); res(true); } }, 250); }));
  check('live view works through the proxy (tile decoded)', live);

  // ---- seed throwaway layout + save (default / no-limit) ----
  const seed = [{ i: 'a', x: 0, y: 0, w: 6, h: 4 }, { i: 'b', x: 6, y: 0, w: 6, h: 4 }];
  await p.evaluate(async ({ TKEY, UKEY, seed }) => { await window.__t.set(TKEY, seed); await window.__t.set(UKEY, 'nope'); }, { TKEY, UKEY, seed });
  await reopen(p);
  await p.click('#saveBtn'); await p.waitForTimeout(300);
  await p.check('#noLimit'); await p.fill('#label', 'e2e Default'); await p.click('#saveOk'); await p.waitForTimeout(1000);
  let L = await listApi(p);
  check('save created one profile', L.length === 1, L.map((x) => x.label + '/' + x.maxWidth).join(','));
  check('profile is default (maxWidth null)', L[0] && L[0].maxWidth === null);
  check('captured the throwaway layout key', !!(L[0] && L[0].data && L[0].data[TKEY]));
  check('EXCLUDED the unrelated key', !(L[0] && L[0].data && L[0].data[UKEY]));

  // ---- delete the key, then Load restores it (the only profile, so deterministic) ----
  await p.evaluate((k) => window.__t.del(k), TKEY);
  check('throwaway key removed', !(await p.evaluate((k) => window.__t.getAll().then((o) => k in o), TKEY)));
  await reopen(p);
  await p.click('#loadBtn');
  await p.waitForTimeout(3500);
  await p.waitForLoadState('domcontentloaded').catch(() => {});
  const restored = await p.evaluate((k) => window.__t.getAll().then((o) => o[k]), TKEY);
  check('Load restored the layout into IndexedDB', JSON.stringify(restored) === JSON.stringify(seed));

  // ---- responsive: a second profile at a narrow width ----
  await p.setViewportSize({ width: 700, height: 900 });
  await p.evaluate((k) => window.__t.set(k, [{ i: 'a', x: 0, y: 0, w: 12, h: 4 }]), TKEY);
  await reopen(p);
  await p.click('#saveBtn'); await p.waitForTimeout(300);
  await p.fill('#label', 'e2e Mobile'); await p.click('#saveOk'); await p.waitForTimeout(1000);
  L = await listApi(p);
  check('two profiles now', L.length === 2, L.map((x) => x.label + '/' + x.maxWidth).join(','));
  const mob = L.find((x) => x.maxWidth != null);
  check('mobile profile maxWidth ~700', !!(mob && mob.maxWidth >= 600 && mob.maxWidth <= 820), mob && String(mob.maxWidth));
  check('responsive pick @700 -> Mobile', pick(L, 700) && pick(L, 700).label === 'e2e Mobile');
  check('responsive pick @1600 -> Default', pick(L, 1600) && pick(L, 1600).label === 'e2e Default');

  // ---- delete via Manage ----
  await reopen(p);
  await p.click('#manageBtn'); await p.waitForTimeout(500);
  const dels = await p.$$('.del');
  check('manage lists both profiles', dels.length === 2, String(dels.length));
  if (dels.length) { await dels[0].click(); await p.waitForTimeout(700); }
  check('delete removed one', (await listApi(p)).length === 1);

  // ---- cleanup (leave Frigate + server as we found them) ----
  await p.evaluate(async ({ TKEY, UKEY }) => { await window.__t.del(TKEY); await window.__t.del(UKEY); }, { TKEY, UKEY });
  for (const e of await listApi(p)) await fetch(PROXY + '/__layoutsync/api/layouts/' + e.id, { method: 'DELETE' });

  console.log('\n===== frigate-layout-sync E2E =====');
  R.forEach((r) => console.log('  ' + r));
  const fails = R.filter((r) => r.startsWith('FAIL'));
  console.log('\n  ' + (fails.length ? (fails.length + ' FAILED of ' + R.length) : ('ALL ' + R.length + ' PASSED')));
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e.message, '\n', e.stack); process.exit(2); });
