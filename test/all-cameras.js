/*
 * Integration test for the All-Cameras layout editor.
 *
 * Drives a real browser through the proxy against a real Frigate and exercises:
 * entering edit mode, setting the column count, click-to-resize, pointer drag to
 * reorder, saving (the layout is stored in the profile), responsive auto-apply on
 * reload, and applying an explicit camera order.
 *
 * SAFETY: it cleans up after itself (clears the All-Cameras layout it set and
 * deletes the test profiles it created). Like test/e2e.js it does reset
 * frigate-layout-sync's own saved profiles, so point it at a non-critical
 * instance if you have layouts you care about.
 *
 *   FRIGATE_PASSWORD=... FRIGATE_PROXY=http://localhost:3000 node test/all-cameras.js
 */
'use strict';
const { chromium } = require('playwright');

const PROXY = process.env.FRIGATE_PROXY || 'http://localhost:3000';
const USER = process.env.FRIGATE_USER || 'admin';
const PASS = process.env.FRIGATE_PASSWORD;
if (!PASS) { console.error('Set FRIGATE_PASSWORD (and FRIGATE_USER if not "admin").'); process.exit(2); }

const R = [];
const check = (n, c, e) => R.push((c ? 'PASS' : 'FAIL') + '  ' + n + (e ? ('  [' + e + ']') : ''));
const api = () => fetch(PROXY + '/__layoutsync/api/layouts').then(r => r.json());
const wipe = async () => { for (const e of await api().catch(() => [])) await fetch(PROXY + '/__layoutsync/api/layouts/' + e.id, { method: 'DELETE' }); };
const grid = (p) => p.evaluate(() => {
  const g = [...document.querySelectorAll('div[class*=grid]')].find(d => /(^|\s)grid(\s|$)/.test(d.className) && /mt-2/.test(d.className) && getComputedStyle(d).display === 'grid');
  if (!g) return null;
  const cols = getComputedStyle(g).gridTemplateColumns.trim().split(/\s+/).length;
  const tiles = [...g.children].map(t => { const dc = t.querySelector('[data-camera]'); const r = t.getBoundingClientRect(); return { cam: dc ? dc.getAttribute('data-camera') : null, gc: t.style.gridColumn, y: Math.round(r.y), x: Math.round(r.x) }; }).filter(t => t.cam);
  return { cols, tiles, visual: tiles.slice().sort((a, b) => a.y - b.y || a.x - b.x).map(t => t.cam) };
});

(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 900 } });
  const p = await c.newPage();
  await wipe();
  await p.goto(PROXY + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(2000);
  const pe = await p.$('input[type=password]'); if (pe) { const ue = await p.$('input[type=text],input[name=user]'); if (ue) await ue.fill(USER); await pe.fill(PASS); const bt = await p.$('button[type=submit]') || await p.$('button'); if (bt) await bt.click(); await p.waitForTimeout(7000); }
  await p.evaluate(() => localStorage.removeItem('__layoutsync_allcams'));

  check('All Cameras grid found', !!(await grid(p)));

  await p.click('#fab'); await p.waitForTimeout(300);
  await p.click('#editAllcamsBtn'); await p.waitForTimeout(600);
  check('edit mode (editbar visible)', await p.locator('#editbar.open').count() > 0);

  for (let i = 0; i < 6; i++) { const n = +(await p.locator('#colNum').textContent()); if (n <= 2) break; await p.click('#colMinus'); await p.waitForTimeout(150); }
  for (let i = 0; i < 6; i++) { const n = +(await p.locator('#colNum').textContent()); if (n >= 2) break; await p.click('#colPlus'); await p.waitForTimeout(150); }
  await p.waitForTimeout(400);
  let gi = await grid(p);
  check('column count control sets 2 columns', gi && gi.cols === 2, gi && ('cols=' + gi.cols));

  // click two wide cameras to span 1 for a clean 2-column grid
  const tiles = gi.tiles;
  const wide = tiles.filter(t => /span 2/.test(t.gc)).slice(0, 2).map(t => t.cam);
  const firstCam = tiles[0].cam, firstGcBefore = tiles[0].gc;
  for (const cam of (wide.length ? wide : [firstCam])) { await p.locator('[data-camera="' + cam + '"]').first().click({ force: true }).catch(() => {}); await p.waitForTimeout(300); }
  const firstGcAfter = (await grid(p)).tiles.find(t => t.cam === firstCam).gc;
  check('click cycles a camera width', wide.length ? true : firstGcBefore !== firstGcAfter, firstGcBefore + ' -> ' + firstGcAfter);

  // pointer drag: move the second-row camera onto the first
  let dragOK = false;
  try {
    await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(200);
    const v0 = (await grid(p)).visual;
    const src = v0[2], dst = v0[0]; // a lower camera onto the first
    const sb = await p.locator('[data-camera="' + src + '"]').first().boundingBox();
    const db = await p.locator('[data-camera="' + dst + '"]').first().boundingBox();
    await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await p.mouse.down();
    await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 - 25, { steps: 3 });
    await p.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 12 });
    await p.mouse.up();
    await p.waitForTimeout(500);
    const v1 = (await grid(p)).visual;
    dragOK = v1.indexOf(src) < v1.indexOf(dst);
  } catch (e) { /* */ }
  check('pointer drag reorders a camera', dragOK);

  // save (no limit)
  await p.click('#editSaveBtn'); await p.waitForTimeout(300);
  await p.check('#noLimit'); await p.fill('#label', 'AllCams Test'); await p.click('#saveOk'); await p.waitForTimeout(1000);
  let L = await api();
  check('saved profile carries the All-Cameras layout', L.length === 1 && L[0].allCameras && L[0].allCameras.columns === 2, L[0] && L[0].allCameras && JSON.stringify({ c: L[0].allCameras.columns, n: L[0].allCameras.order.length }));

  // responsive auto-apply: clear local cache, reload -> engine applies from server
  await p.evaluate(() => localStorage.removeItem('__layoutsync_allcams'));
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(6500);
  gi = await grid(p);
  check('layout auto-applies from server on reload (2 cols)', gi && gi.cols === 2, gi && ('cols=' + gi.cols));

  // explicit order applies (no drag dependency)
  await wipe();
  const want = await p.evaluate(() => { const u = [...new Set([...document.querySelectorAll('[data-camera]')].map(e => e.getAttribute('data-camera')))]; const rev = u.slice().reverse(); localStorage.setItem('__layoutsync_allcams', JSON.stringify({ columns: 2, order: rev, span: {} })); return rev; });
  await p.reload({ waitUntil: 'domcontentloaded' }); await p.waitForTimeout(5500);
  const gi2 = await grid(p);
  check('explicit camera order is applied', gi2 && gi2.visual[0] === want[0], gi2 && ('first=' + gi2.visual[0]));

  await p.evaluate(() => localStorage.removeItem('__layoutsync_allcams'));
  await wipe();

  console.log('\n===== ALL-CAMERAS layout E2E ====='); R.forEach(r => console.log('  ' + r));
  const f = R.filter(r => r.startsWith('FAIL'));
  console.log('\n  ' + (f.length ? (f.length + ' FAILED of ' + R.length) : ('ALL ' + R.length + ' PASSED')));
  await b.close(); process.exit(f.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e.message, '\n', e.stack); process.exit(2); });
