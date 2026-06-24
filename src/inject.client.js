/* frigate-layout-sync - injected client.
 * Adds a Save/Load control to the Frigate UI plus a layout editor for the
 * built-in "All Cameras" view (which Frigate itself does not let you arrange).
 *
 * Two kinds of layout are handled:
 *  - Camera GROUP layouts + stream settings, which Frigate stores in IndexedDB
 *    (idb-keyval: db "keyval-store", store "keyval"). We snapshot/restore those.
 *  - The "All Cameras" view, which Frigate renders as a fixed CSS grid. We give
 *    it a custom arrangement by overriding the grid (columns, order, per-camera
 *    width) via inline styles keyed on each tile's data-camera attribute, and we
 *    keep it applied across React re-renders with a MutationObserver.
 *
 * Everything is stored server-side, keyed by a max viewport width, so each
 * device loads the layout that fits its screen.
 */
(function () {
  'use strict';
  if (window.__layoutSyncLoaded) return;
  window.__layoutSyncLoaded = true;

  var BASE = '/__layoutsync';
  var IDB_DB = 'keyval-store';
  var IDB_STORE = 'keyval';
  var ALLCAMS_KEY = '__layoutsync_allcams'; // localStorage cache of the active All-Cameras layout
  var AUTOLOAD_KEY = '__layoutsync_autoload'; // '0' = user disabled auto-load; anything else = ON (default)
  var APPLIED_FLAG = '__layoutsync_applied';  // sessionStorage: auto-load already ran this tab session

  // Auto-load is ON by default; the checkbox writes '0' here to disable it.
  function autoLoadEnabled() { try { return localStorage.getItem(AUTOLOAD_KEY) !== '0'; } catch (e) { return true; } }
  function setAutoLoad(on) { try { on ? localStorage.removeItem(AUTOLOAD_KEY) : localStorage.setItem(AUTOLOAD_KEY, '0'); } catch (e) { /* private mode */ } }

  // ------------------------------------------------------------- IndexedDB
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_DB);
      req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (e) { /* exists */ } };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGetAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = {}, tx = db.transaction(IDB_STORE, 'readonly');
        var cur = tx.objectStore(IDB_STORE).openCursor();
        cur.onsuccess = function (e) { var c = e.target.result; if (c) { out[c.key] = c.value; c.continue(); } else resolve(out); };
        cur.onerror = function () { reject(cur.error); };
      });
    });
  }
  function idbSetMany(obj) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite'), st = tx.objectStore(IDB_STORE);
        Object.keys(obj).forEach(function (k) { st.put(obj[k], k); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function isPresentationKey(k) {
    return /-draggable-layout(:|$)/.test(k) || /^streaming-settings(:|$)/.test(k) ||
      /^live-layout(:|$)/.test(k) || /^autoLiveView(:|$)/.test(k) || /^displayCameraNames(:|$)/.test(k);
  }
  function filterPresentation(all) { var o = {}; Object.keys(all).forEach(function (k) { if (isPresentationKey(k)) o[k] = all[k]; }); return o; }

  // ------------------------------------------------------------- API
  function apiList() { return fetch(BASE + '/api/layouts', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }); }
  function apiSave(p) { return fetch(BASE + '/api/layouts', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }).then(function (r) { if (!r.ok) throw new Error('save failed (' + r.status + ')'); return r.json(); }); }
  function apiDelete(id) { return fetch(BASE + '/api/layouts/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' }); }
  function pickProfile(profiles, w) {
    var b = profiles.filter(function (p) { return p.maxWidth != null && p.maxWidth >= w; }).sort(function (a, b2) { return a.maxWidth - b2.maxWidth; });
    if (b.length) return b[0];
    var d = profiles.filter(function (p) { return p.maxWidth == null; });
    return d.length ? d[0] : null;
  }

  // ----------------------------------------------------- auto-load on open
  // Is the saved layout already present in the browser? Containment, not equality:
  // applying writes ONLY the profile's keys (idbSetMany never deletes the browser's
  // other keys), so we reload only if some profile key is missing or differs.
  function dataApplied(browser, data) {
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) { if (JSON.stringify(browser[keys[i]]) !== JSON.stringify(data[keys[i]])) return false; }
    return true;
  }
  function markApplied() { try { sessionStorage.setItem(APPLIED_FLAG, '1'); } catch (e) { /* noop */ } }

  // No saved layout for this screen yet: seed the server from whatever the browser
  // currently has, so installing the extension NEVER changes or loses the user's
  // existing in-browser layout — it just starts syncing it. Silent, no reload.
  function bootstrapFromBrowser() {
    markApplied();
    return idbGetAll().then(function (all) {
      var data = filterPresentation(all), allCameras = getCache();
      if (!Object.keys(data).length && !allCameras) return; // nothing to preserve yet
      return apiSave({ label: 'Default (from this device)', maxWidth: null, data: data, allCameras: allCameras })
        .then(function () { refreshState(); }).catch(function () { /* offline; try again next open */ });
    }).catch(function () { /* noop */ });
  }

  // Apply the saved layout matching this screen, once per tab session. Idempotent:
  // if the browser already matches the server we do nothing (so no reload loop and
  // no flicker on every open). Only a genuine difference triggers one reload.
  function autoApplyOnOpen() {
    if (!autoLoadEnabled()) return;
    try { if (sessionStorage.getItem(APPLIED_FLAG)) return; } catch (e) { /* noop */ }
    apiList().then(function (profiles) {
      var p = pickProfile(profiles, window.innerWidth);
      if (!p) return bootstrapFromBrowser();             // empty / no match -> seed, never lose
      if (p.allCameras) setCache(p.allCameras);          // engine applies it (non-destructive, no reload)
      var data = (p.data && typeof p.data === 'object') ? p.data : {};
      if (!Object.keys(data).length) { markApplied(); return; }
      idbGetAll().then(function (all) {
        if (dataApplied(filterPresentation(all), data)) { markApplied(); return; } // already present
        markApplied();                                   // set BEFORE reload so it runs at most once
        idbSetMany(data).then(function () { location.reload(); }).catch(function () { /* noop */ });
      }).catch(function () { /* noop */ });
    });
  }

  // ============================ All-Cameras layout ============================
  // Locate Frigate's All-Cameras CSS grid (LiveDashboardView: "mt-2 ... grid").
  function findGrid() {
    var els = document.querySelectorAll('div[class*="grid"]');
    for (var i = 0; i < els.length; i++) {
      var cls = (els[i].className || '').toString();
      if (/(^|\s)grid(\s|$)/.test(cls) && /mt-2/.test(cls) && getComputedStyle(els[i]).display === 'grid') return els[i];
    }
    return null;
  }
  function camOfNode(node) { while (node && node.getAttribute) { if (node.getAttribute('data-camera')) return node.getAttribute('data-camera'); node = node.parentElement; } return null; }
  function tileCam(t) { var dc = t.querySelector && t.querySelector('[data-camera]'); return dc ? dc.getAttribute('data-camera') : null; }
  function gridTiles(grid) { return [].slice.call(grid.children).map(function (t) { return { el: t, cam: tileCam(t) }; }).filter(function (x) { return x.cam; }); }

  function getCache() { try { return JSON.parse(localStorage.getItem(ALLCAMS_KEY) || 'null'); } catch (e) { return null; } }
  function setCache(layout) { try { layout ? localStorage.setItem(ALLCAMS_KEY, JSON.stringify(layout)) : localStorage.removeItem(ALLCAMS_KEY); } catch (e) { /* private mode */ } }

  function applyAllCams(layout) {
    var grid = findGrid(); if (!grid) return false;
    if (!layout) { clearAllCams(grid); return true; }
    grid.style.gridTemplateColumns = 'repeat(' + layout.columns + ', minmax(0,1fr))';
    gridTiles(grid).forEach(function (t) {
      var idx = layout.order.indexOf(t.cam);
      t.el.style.order = String(idx < 0 ? 999 : idx);
      var span = Math.max(1, Math.min((layout.span && layout.span[t.cam]) || 1, layout.columns));
      t.el.style.gridColumn = 'span ' + span + ' / span ' + span;
    });
    return true;
  }
  function clearAllCams(grid) {
    grid = grid || findGrid(); if (!grid) return;
    grid.style.gridTemplateColumns = '';
    [].slice.call(grid.children).forEach(function (t) { t.style.order = ''; t.style.gridColumn = ''; });
  }
  function layoutFromDOM() {
    var grid = findGrid(); if (!grid) return null;
    var tiles = gridTiles(grid);
    if (!tiles.length) return null;
    var cols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length || 2;
    var span = {};
    tiles.forEach(function (t) { var m = (t.el.className || '').toString().match(/col-span-(\d)/); span[t.cam] = m ? +m[1] : 1; });
    return { columns: cols, order: tiles.map(function (t) { return t.cam; }), span: span };
  }

  // Keep our button aligned with Frigate's own bottom-right control cluster, so it
  // tracks it even when a scrollbar on a group view shifts those controls left (a
  // viewport-fixed button would otherwise stay pinned to the edge, over the scrollbar).
  function frigateAnchor() {
    var els = document.querySelectorAll('[class*="cursor-pointer"][class*="rounded-lg"]');
    var best = null;
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width < 16 || r.width > 48 || r.height < 16 || r.height > 48) continue; // ~32px controls
      if (window.innerHeight - r.bottom > 90) continue; // bottom strip only
      if (window.innerWidth - r.right > 160) continue;  // right strip only
      if (!best || r.right > best.right) best = r;       // rightmost = the fullscreen button
    }
    return best;
  }
  var lastFabPos = '';
  function positionFab() {
    if (!wrap) return;
    var right = 12, bottom = 76, a = frigateAnchor();
    if (a) { right = Math.max(0, Math.round(window.innerWidth - a.right)); bottom = Math.round(window.innerHeight - a.top + 8); }
    var key = right + ',' + bottom;
    if (key === lastFabPos) return;
    lastFabPos = key;
    wrap.style.right = right + 'px';
    wrap.style.bottom = bottom + 'px';
  }

  // Re-sync the open panel when the camera view changes (e.g. All Cameras -> a
  // group), so things like the All-Cameras-only "Edit" action don't go stale. The
  // signature flips on URL changes and on whether the All-Cameras grid is present.
  var lastViewSig = null;
  function viewSig() { return location.href + '|' + (findGrid() ? 'A' : 'G'); }
  function checkViewChange() {
    var sig = viewSig();
    if (sig === lastViewSig) return;
    lastViewSig = sig;
    if (panel && panel.classList.contains('open')) refreshState();
  }

  // Keep the layout applied across Frigate re-renders, and fetch the server
  // layout once the All-Cameras grid actually appears (it is not in the DOM at
  // script-load time).
  var applyTimer = null, serverApplied = false;
  function scheduleApply() {
    if (applyTimer) return;
    applyTimer = setTimeout(function () {
      applyTimer = null;
      positionFab();
      checkViewChange();
      if (!findGrid()) { serverApplied = false; return; } // not on the All-Cameras view
      var c = getCache();
      if (c) applyAllCams(c);
      if (!serverApplied) { serverApplied = true; refreshFromServer(); }
      if (editMode) decorateTiles();
    }, 120);
  }
  var observer = new MutationObserver(scheduleApply);

  function refreshFromServer() {
    if (!findGrid()) return; // only on the All-Cameras view
    if (!autoLoadEnabled()) return; // honor the auto-load toggle (manual Load still works)
    apiList().then(function (profiles) {
      if (!findGrid()) return;
      var p = pickProfile(profiles, window.innerWidth);
      var lay = p && p.allCameras ? p.allCameras : null;
      if (lay) { setCache(lay); applyAllCams(lay); }
    });
  }
  function startEngine() {
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleApply(); // fetches + applies once the grid is present
    positionFab();
    var rt = null;
    window.addEventListener('resize', function () { positionFab(); if (editMode) return; clearTimeout(rt); rt = setTimeout(refreshFromServer, 400); });
    setInterval(function () { positionFab(); checkViewChange(); }, 1000); // backstop for scrollbar/view changes without a DOM mutation
  }

  // ---- editor (pointer-based so it works with mouse AND touch) ----
  var editMode = false, dragCam = null, startX = 0, startY = 0, moved = false;
  function working() { return getCache() || layoutFromDOM() || { columns: 2, order: [], span: {} }; }
  function commit(layout) { setCache(layout); applyAllCams(layout); updateEditBar(); }
  function decorateTiles() {
    var grid = findGrid(); if (!grid) return;
    gridTiles(grid).forEach(function (t) {
      t.el.style.outline = editMode ? '2px dashed #38bdf8' : '';
      t.el.style.outlineOffset = editMode ? '-2px' : '';
      t.el.style.cursor = editMode ? 'grab' : '';
    });
  }
  function reorder(cam, target) {
    var lay = working(), order = lay.order.slice();
    var from = order.indexOf(cam); if (from >= 0) order.splice(from, 1);
    var to = order.indexOf(target); order.splice(to < 0 ? order.length : to, 0, cam);
    lay.order = order; commit(lay);
  }
  function cycleSpan(cam) {
    var lay = working(); lay.span = lay.span || {};
    var cur = lay.span[cam] || 1; lay.span[cam] = cur >= lay.columns ? 1 : cur + 1; commit(lay);
  }
  function onPointerDown(e) { if (!editMode) return; var cam = camOfNode(e.target); if (!cam) return; dragCam = cam; startX = e.clientX; startY = e.clientY; moved = false; }
  function onPointerMove(e) { if (!editMode || !dragCam) return; if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 8) moved = true; }
  function onPointerUp(e) {
    if (!editMode || !dragCam) return;
    if (moved) { var tgt = camOfNode(document.elementFromPoint(e.clientX, e.clientY)); if (tgt && tgt !== dragCam) reorder(dragCam, tgt); }
    else cycleSpan(dragCam);
    dragCam = null; moved = false;
  }
  function onClickCapture(e) { if (editMode && camOfNode(e.target)) { e.preventDefault(); e.stopPropagation(); } } // block tile navigation while editing
  function enterEdit() {
    if (!findGrid()) { toast('Open the All Cameras view first', true); return; }
    editMode = true; commit(working()); decorateTiles();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('click', onClickCapture, true);
    panel.classList.remove('open');
    showEditBar();
  }
  function exitEdit() {
    editMode = false; decorateTiles();
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('click', onClickCapture, true);
    hideEditBar();
  }
  function setColumns(delta) {
    var lay = working();
    lay.columns = Math.max(1, Math.min(6, (lay.columns || 2) + delta));
    if (lay.span) Object.keys(lay.span).forEach(function (k) { lay.span[k] = Math.min(lay.span[k], lay.columns); });
    commit(lay);
  }
  function resetAllCams() { setCache(null); var g = findGrid(); if (g) clearAllCams(g); exitEdit(); refreshState(); toast('All-Cameras layout reset'); }

  // ------------------------------------------------------------- UI shell
  var host = document.createElement('div');
  host.id = '__layoutsync_host';
  (document.body || document.documentElement).appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = [
    '<style>',
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    // 32px / 8px radius to match Frigate's own bottom-right control buttons; sit
    // one slot above the fullscreen button (right:12, just above the control row).
    '.wrap{position:fixed;right:12px;bottom:76px;z-index:2147483000}',
    '.fab{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:8px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45);opacity:.8}.fab:hover{opacity:1;background:#374151}',
    '.panel{position:absolute;right:0;bottom:40px;width:268px;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:12px;padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);display:none}.panel.open{display:block}',
    '.title{font-size:13px;font-weight:600;margin:0 0 9px;display:flex;justify-content:space-between;align-items:center}.title small{font-weight:400;color:#9ca3af}',
    '.chk{display:flex;align-items:flex-start;gap:7px;font-size:12px;color:#cbd5e1;line-height:1.35;cursor:pointer;padding:7px 8px;border:1px solid #1f2937;border-radius:8px;margin:0 0 2px}.chk input{margin-top:1px;accent-color:#0ea5e9;cursor:pointer}.chk span{color:#9ca3af;font-size:11px;display:block}',
    'button.act{width:100%;text-align:left;background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:8px;padding:9px 11px;font-size:13px;cursor:pointer;margin-top:7px}button.act:hover{background:#374151}button.act:disabled{opacity:.4;cursor:not-allowed}',
    'button.act b{display:block;font-size:13px}button.act span{display:block;font-size:11px;color:#9ca3af;margin-top:1px}',
    '.modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:2147483001}.modal.open{display:flex}',
    '.card{background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:14px;padding:18px;width:340px;max-width:92vw}',
    '.card h3{margin:0 0 8px;font-size:15px}.card p{margin:0 0 10px;font-size:12.5px;color:#cbd5e1;line-height:1.45}',
    '.wbadge{display:inline-block;background:#0b1220;border:1px solid #1f2a44;border-radius:8px;padding:3px 9px;font-variant-numeric:tabular-nums;font-weight:700;color:#7dd3fc}',
    '.row{display:flex;align-items:center;gap:8px;margin:10px 0;font-size:13px}.row input[type=text]{flex:1;background:#0b1220;border:1px solid #374151;color:#e5e7eb;border-radius:7px;padding:7px 9px;font-size:13px}',
    '.btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}',
    '.btn{border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;border:1px solid #374151;background:#1f2937;color:#e5e7eb}.btn.primary{background:#0ea5e9;border-color:#0ea5e9;color:#04222e;font-weight:600}.btn:hover{filter:brightness(1.1)}',
    '.list{margin:6px 0 0;max-height:230px;overflow:auto}',
    '.item{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #1f2937;border-radius:8px;margin-top:7px;font-size:12.5px}.item .meta{flex:1;min-width:0}.item .meta b{display:block}.item .meta span{color:#9ca3af;font-size:11px}',
    '.del{background:#3f1d1d;border:1px solid #7f1d1d;color:#fca5a5;border-radius:7px;padding:5px 9px;cursor:pointer;font-size:12px}.del:hover{background:#7f1d1d;color:#fff}',
    '.empty{color:#9ca3af;font-size:12.5px;padding:10px 2px}',
    '.editbar{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:none;align-items:center;gap:14px;background:#0ea5e9;color:#04222e;border-radius:11px;padding:8px 14px;font-size:13px;font-weight:600;z-index:2147483002;box-shadow:0 8px 24px rgba(0,0,0,.45)}.editbar.open{display:flex}',
    '.editbar .hint{font-weight:400;color:#053040;font-size:12px}',
    '.editbar .step{display:inline-flex;align-items:center;gap:6px}',
    '.editbar .sbtn{width:24px;height:24px;border-radius:6px;border:none;background:#04222e;color:#7dd3fc;font-size:15px;font-weight:700;cursor:pointer;line-height:1}',
    '.ebtn{border:none;border-radius:7px;padding:6px 11px;font-size:12.5px;font-weight:600;cursor:pointer;background:#04222e;color:#e0f2fe}.ebtn.primary{background:#04222e;color:#7dd3fc}.ebtn:hover{filter:brightness(1.2)}',
    '.toast{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);background:#0ea5e9;color:#04222e;font-weight:600;font-size:13px;padding:9px 16px;border-radius:9px;z-index:2147483003;box-shadow:0 6px 20px rgba(0,0,0,.5);opacity:0;transition:opacity .2s;pointer-events:none}.toast.show{opacity:1}.toast.err{background:#ef4444;color:#fff}',
    '</style>',
    '<div class="wrap" id="wrap">',
    '  <div class="panel" id="panel">',
    '    <p class="title">Layout Sync <small id="hint"></small></p>',
    '    <label class="chk" title="When on, the layout saved for this screen is applied automatically when you open Frigate."><input type="checkbox" id="autoLoadChk"><div><b style="font-weight:600;color:#e5e7eb">Auto-load saved layout</b><span>apply your saved layout on open</span></div></label>',
    '    <button class="act" id="editAllcamsBtn"><b>Edit All-Cameras layout</b><span id="editSub">arrange the built-in grid</span></button>',
    '    <button class="act" id="saveBtn"><b>Save current layout</b><span>store this arrangement on the server</span></button>',
    '    <button class="act" id="loadBtn"><b>Load layout for this screen</b><span id="loadSub">pull the matching layout</span></button>',
    '    <button class="act" id="manageBtn"><b>Manage saved layouts</b><span id="manageSub">view / delete</span></button>',
    '  </div>',
    '  <button class="fab" id="fab" title="Layout Sync" aria-label="Layout Sync"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect></svg></button>',
    '</div>',
    '<div class="editbar" id="editbar">',
    '  <span>All-Cameras layout</span>',
    '  <span class="step">Columns <button class="sbtn" id="colMinus">−</button><b id="colNum">2</b><button class="sbtn" id="colPlus">+</button></span>',
    '  <span class="hint">drag to reorder &middot; click a camera to change its width</span>',
    '  <button class="ebtn" id="editReset">Reset</button>',
    '  <button class="ebtn" id="editSaveBtn">Save…</button>',
    '  <button class="ebtn primary" id="editDone">Done</button>',
    '</div>',
    '<div class="modal" id="saveModal"><div class="card">',
    '  <h3>Save layout</h3>',
    '  <p>Saves the current camera-group arrangement, the All-Cameras layout, and stream settings for screens <b>up to</b> a width you choose. <b>Resize this window</b> to the maximum width this layout should apply to, then Save. Tick &ldquo;no limit&rdquo; to make it the default for any size.</p>',
    '  <p>This layout will apply up to: <span class="wbadge" id="curW">0</span> px</p>',
    '  <div class="row"><label><input type="checkbox" id="noLimit"> No limit (default for all widths)</label></div>',
    '  <div class="row"><input type="text" id="label" placeholder="Label (optional), e.g. Desktop / Phone"></div>',
    '  <div class="btns"><button class="btn" id="saveCancel">Cancel</button><button class="btn primary" id="saveOk">Save</button></div>',
    '</div></div>',
    '<div class="modal" id="manageModal"><div class="card">',
    '  <h3>Saved layouts</h3><div class="list" id="list"></div>',
    '  <div class="btns"><button class="btn" id="manageClose">Close</button></div>',
    '</div></div>',
    '<div class="toast" id="toast"></div>',
  ].join('');

  var $ = function (id) { return root.getElementById(id); };
  var panel = $('panel');
  var wrap = $('wrap');
  function toast(msg, err) { var t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : ''); setTimeout(function () { t.className = 'toast'; }, 2600); }

  function showEditBar() { $('editbar').classList.add('open'); updateEditBar(); }
  function hideEditBar() { $('editbar').classList.remove('open'); }
  function updateEditBar() { $('colNum').textContent = String(working().columns || 2); }

  $('autoLoadChk').checked = autoLoadEnabled();
  $('autoLoadChk').addEventListener('change', function () { setAutoLoad(this.checked); toast(this.checked ? 'Auto-load on' : 'Auto-load off'); });

  $('fab').addEventListener('click', function () { var open = panel.classList.toggle('open'); if (open) { $('autoLoadChk').checked = autoLoadEnabled(); refreshState(); } });
  function refreshState() {
    $('hint').textContent = window.innerWidth + 'px';
    // Only meaningful on the All-Cameras view — hide it entirely elsewhere.
    $('editAllcamsBtn').style.display = findGrid() ? '' : 'none';
    return apiList().then(function (profiles) {
      var has = profiles.length > 0;
      $('loadBtn').disabled = !has; $('manageBtn').disabled = !has;
      if (has) { var m = pickProfile(profiles, window.innerWidth); $('loadSub').textContent = m ? ('matches: ' + m.label) : 'no layout matches this width'; $('manageSub').textContent = profiles.length + ' saved'; }
      else { $('loadSub').textContent = 'no layouts saved yet'; $('manageSub').textContent = 'none yet'; }
      return profiles;
    });
  }

  $('editAllcamsBtn').addEventListener('click', enterEdit);
  $('colMinus').addEventListener('click', function () { setColumns(-1); });
  $('colPlus').addEventListener('click', function () { setColumns(1); });
  $('editReset').addEventListener('click', resetAllCams);
  $('editDone').addEventListener('click', exitEdit);
  $('editSaveBtn').addEventListener('click', function () { openSave(); });

  // ---- save flow
  var widthTimer = null;
  function openSave() { $('curW').textContent = window.innerWidth; $('noLimit').checked = false; $('label').value = ''; $('saveModal').classList.add('open'); widthTimer = setInterval(function () { if (!$('noLimit').checked) $('curW').textContent = window.innerWidth; }, 250); }
  function closeSave() { $('saveModal').classList.remove('open'); if (widthTimer) clearInterval(widthTimer); }
  $('saveBtn').addEventListener('click', openSave);
  $('saveCancel').addEventListener('click', closeSave);
  $('noLimit').addEventListener('change', function () { $('curW').textContent = $('noLimit').checked ? '∞ (no limit)' : window.innerWidth; });
  $('saveOk').addEventListener('click', function () {
    var noLimit = $('noLimit').checked, maxWidth = noLimit ? null : window.innerWidth, label = $('label').value.trim();
    idbGetAll().then(function (all) {
      var data = filterPresentation(all), allCameras = getCache();
      if (!Object.keys(data).length && !allCameras) { toast('Nothing to save yet - arrange a group or the All-Cameras view first', true); return; }
      return apiSave({ label: label, maxWidth: maxWidth, data: data, allCameras: allCameras }).then(function () { closeSave(); toast('Saved' + (noLimit ? ' (default)' : ' for ≤ ' + maxWidth + 'px')); refreshState(); });
    }).catch(function (e) { toast('Save error: ' + e.message, true); });
  });

  // ---- load flow
  $('loadBtn').addEventListener('click', function () {
    apiList().then(function (profiles) {
      var p = pickProfile(profiles, window.innerWidth);
      if (!p) { toast('No layout matches this screen width', true); return; }
      if (p.allCameras) setCache(p.allCameras);
      var data = p.data || {};
      var done = function () { toast('Applied "' + p.label + '"'); if (Object.keys(data).length) { toast('Applied "' + p.label + '" - reloading'); setTimeout(function () { location.reload(); }, 700); } else { applyAllCams(getCache()); } };
      if (Object.keys(data).length) idbSetMany(data).then(done).catch(function (e) { toast('Load error: ' + e.message, true); });
      else done();
    });
  });

  // ---- manage flow
  $('manageBtn').addEventListener('click', function () { $('manageModal').classList.add('open'); renderList(); });
  $('manageClose').addEventListener('click', function () { $('manageModal').classList.remove('open'); });
  function renderList() {
    apiList().then(function (profiles) {
      var list = $('list');
      if (!profiles.length) { list.innerHTML = '<div class="empty">No saved layouts yet.</div>'; return; }
      list.innerHTML = '';
      profiles.forEach(function (p) {
        var row = document.createElement('div'); row.className = 'item';
        var bound = p.maxWidth == null ? 'Default (any width)' : ('≤ ' + p.maxWidth + 'px');
        var when = ''; try { when = new Date(p.createdAt).toLocaleString(); } catch (e) { when = p.createdAt || ''; }
        var bits = (p.data ? Object.keys(p.data).length + ' keys' : '0 keys') + (p.allCameras ? ' + all-cams' : '');
        var meta = document.createElement('div'); meta.className = 'meta';
        var b = document.createElement('b'); b.textContent = p.label || bound;
        var s = document.createElement('span'); s.textContent = bound + '  ·  ' + bits + '  ·  ' + when;
        meta.appendChild(b); meta.appendChild(s);
        var del = document.createElement('button'); del.className = 'del'; del.textContent = 'Delete';
        del.addEventListener('click', function () { apiDelete(p.id).then(function () { renderList(); refreshState(); toast('Deleted'); }); });
        row.appendChild(meta); row.appendChild(del); list.appendChild(row);
      });
    });
  }

  refreshState();
  startEngine();
  autoApplyOnOpen(); // apply the saved layout for this screen on open (or seed it on first run)
})();
