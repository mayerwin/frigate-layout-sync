'use strict';
// Self-healing nginx integrator — implements the shared "frigate-ext" injection
// protocol (v2) so MULTIPLE independent extensions can inject into Frigate's one
// nginx.conf without conflicts. See PROTOCOL.md; the SHARED constants below MUST be
// identical in every extension.
//
// Why v2: nginx's `sub_filter` consumes each source token once, so two extensions
// both doing `sub_filter '</body>' ...` collide (only the first-included one fires).
// v2 fixes that: there is exactly ONE `</body>` sub_filter, generated from every
// extension's script tag, so any number of extensions inject together.
//
// Layout in Frigate's container (all under /usr/local/nginx/conf/frigate-ext):
//   inject/<ext-id>.html     each extension's ONE <script> tag (input)
//   locations/<ext-id>.conf  each extension's `location /<prefix>/ {...}` (input)
//   generated/subfilter.conf the single combined `sub_filter '</body>' '<all tags></body>';`
//                            (output) — regenerated from inject/*.html on every apply
// nginx.conf gets two idempotent `include` lines (combined sub_filter inside
// `location /`; locations inside `server`). Every nginx.conf edit / regen / reload
// runs under a shared `flock` so concurrent extensions serialize, and nginx is only
// reloaded when that pass actually changed a file (see applyScript()).
const { execFile, spawn } = require('child_process');

// ============================== SHARED PROTOCOL ==============================
const LOCK = '/tmp/frigate-inject.lock';
const EXT_ROOT = '/usr/local/nginx/conf/frigate-ext';
const INJECT_DIR = EXT_ROOT + '/inject';       // <ext-id>.html -> one <script> tag
const LOCATION_DIR = EXT_ROOT + '/locations';  // <ext-id>.conf -> a location block
const GEN_DIR = EXT_ROOT + '/generated';       // holds the single combined sub_filter
const MANAGED = '# frigate-ext (managed)';
// ============================ THIS EXTENSION =================================
const EXT_ID = 'frigate-layout-sync';
const BASE = '/__layoutsync';
const ROUTE = BASE + '/';
// JS-string-safe tag: Frigate's `location /` sets `sub_filter_types text/css
// application/javascript`, so the shared `sub_filter '</body>'` also runs on JS
// bundles. A bundle carrying the literal "</body>" in a string (Frigate's Monaco
// ConfigEditor does) gets this tag spliced INTO that string, so it must contain
// NO character that can terminate a JS string or the nginx string: no quote of
// any kind, no backslash, no newline. Hence the UNQUOTED src (valid HTML5). A
// double-quoted src here blanked Frigate's Config page (SyntaxError). See
// PROTOCOL.md and frigate-better-face-recognition #5.
const INJECT_TAG = `<script src=${BASE}/inject.js defer></script>`;

const CONTAINER = process.env.FRIGATE_CONTAINER || 'frigate';
const CONF = process.env.FRIGATE_NGINX_CONF || '/usr/local/nginx/conf/nginx.conf';
const UPSTREAM = process.env.LAYOUTSYNC_UPSTREAM || 'frigate-layout-sync:3000';
const RESOLVER = process.env.NGINX_RESOLVER || '127.0.0.11';
const AUTO = process.env.NGINX_AUTOCONFIG !== 'false';

let state = { mode: AUTO ? 'starting' : 'disabled', applied: false, lastError: null, container: CONTAINER };
let busy = false;
function status() { return state; }

// --------------------------------------------------------- file contents
function locationConf() {
  // Variable proxy_pass + resolver => nginx resolves the upstream lazily, so the
  // companion being down can never break Frigate's web UI (that path just 502s).
  return [
    `location ${ROUTE} {`,
    `    resolver ${RESOLVER} ipv6=off valid=10s;`,
    `    set $fls_upstream "http://${UPSTREAM}";`,
    `    proxy_pass $fls_upstream$request_uri;`,
    `    proxy_http_version 1.1;`,
    `    proxy_set_header Host $host;`,
    `    proxy_set_header X-Forwarded-For $remote_addr;`,
    `    proxy_read_timeout 30s;`,
    `}`,
    ``,
  ].join('\n');
}

// --------------------------------------------------------- the locked critical section
// Single-quote a value for sh (the content we pass contains `$` and `"`).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// put FILE CONTENT: write only if the bytes differ, and mark the pass as changed.
// Writing is atomic (tmp + mv) so nginx never sees a half file.
const PUT_FN =
  `put() { printf '%s' "$2" > "$1.t" && if cmp -s "$1.t" "$1"; then rm -f "$1.t"; else mv "$1.t" "$1"; C=1; fi; }`;

// Regenerate the single combined sub_filter from all inject/*.html. The OUTPUT
// bytes must be identical in every extension so concurrent runs converge; it is
// compared before replacing so an unchanged set of tags is not a change.
const REGEN =
  `T=$(cat '${INJECT_DIR}/'*.html 2>/dev/null | tr -d '\\r\\n'); F='${GEN_DIR}/subfilter.conf'; ` +
  `if [ -n "$T" ]; then printf "sub_filter '</body>' '%s</body>';\\n" "$T" > "$F.t" && ` +
  `if cmp -s "$F.t" "$F"; then rm -f "$F.t"; else mv "$F.t" "$F"; C=1; fi; ` +
  `elif [ -e "$F" ]; then rm -f "$F"; C=1; fi`;

// One flock'd shell pass: write our two inputs, migrate legacy bits, ensure the two
// include lines, regenerate the combined sub_filter. Every step records whether it
// changed anything on disk, and nginx is validated + reloaded ONLY if something did.
// Reloading unconditionally is not harmless: each `nginx -s reload` grows Frigate's
// nginx master RSS (~240 KB/reload measured on nginx 1.27.4 in Frigate 0.18), so a
// 30s timer that always reloaded (the old design) ran it out of memory within days.
// On a failed `nginx -t`, roll back only THIS extension's inputs and recover.
function applyScript() {
  return [
    `C=0`,
    PUT_FN,
    `mkdir -p '${INJECT_DIR}' '${LOCATION_DIR}' '${GEN_DIR}'`,
    `put '${INJECT_DIR}/${EXT_ID}.html' ${shq(INJECT_TAG)}`,
    `put '${LOCATION_DIR}/${EXT_ID}.conf' ${shq(locationConf())}`,
    // migrate away older versions of THIS extension (direct block + per-ext sub_filter)
    `if grep -q '>>> ${EXT_ID} (managed)' '${CONF}' 2>/dev/null || grep -q '${EXT_ID} sub_filter' '${CONF}' 2>/dev/null; then`,
    `  sed -i '/${EXT_ID} sub_filter/d' '${CONF}'`,
    `  awk '/>>> ${EXT_ID}/{s=1} /<<< ${EXT_ID}/{s=0;next} !s' '${CONF}' > '${CONF}.fls.t' && mv '${CONF}.fls.t' '${CONF}'; C=1`,
    `fi`,
    // superseded by the combined sub_filter
    `if [ -e '${EXT_ROOT}/subfilters/${EXT_ID}.conf' ]; then rm -f '${EXT_ROOT}/subfilters/${EXT_ID}.conf'; C=1; fi`,
    // idempotent include lines (checked individually so upgrades add the new one)
    `if ! grep -qF 'frigate-ext/locations/*.conf' '${CONF}'; then`,
    `  awk '{ if (!L && index($0, "location / {")) { print "        include ${LOCATION_DIR}/*.conf; ${MANAGED}"; L=1 } print }' '${CONF}' > '${CONF}.fls.t' && mv '${CONF}.fls.t' '${CONF}'; C=1`,
    `fi`,
    `if ! grep -qF 'frigate-ext/generated/*.conf' '${CONF}'; then`,
    `  awk '{ print; if (!S && index($0, "root /opt/frigate/web")) { print "            include ${GEN_DIR}/*.conf; ${MANAGED}"; S=1 } }' '${CONF}' > '${CONF}.fls.t' && mv '${CONF}.fls.t' '${CONF}'; C=1`,
    `fi`,
    REGEN,
    `if [ "$C" = 0 ]; then echo FLS_UNCHANGED; exit 0; fi`,
    `if nginx -t 2>/tmp/fls-nginxt; then`,
    `  nginx -s reload 2>/dev/null; echo FLS_RELOADED`,
    `else`,
    `  rm -f '${INJECT_DIR}/${EXT_ID}.html' '${LOCATION_DIR}/${EXT_ID}.conf'`,
    `  ${REGEN}`,
    `  nginx -t >/dev/null 2>&1 && nginx -s reload 2>/dev/null`,
    `  echo FLS_FAIL; cat /tmp/fls-nginxt >&2; exit 1`,
    `fi`,
  ].join('\n');
}

// --------------------------------------------------------- docker plumbing
function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.message = (err.message + '\n' + (stderr || '')).trim(); return reject(err); }
      resolve(stdout);
    });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
const lockedSh = (script) => docker(['exec', CONTAINER, 'flock', '-w', '30', LOCK, 'sh', '-c', script]);

// --------------------------------------------------------- apply (idempotent + safe)
async function ensure() {
  if (!AUTO || busy) return;
  busy = true;
  try {
    const out = String(await lockedSh(applyScript()));
    if (out.includes('FLS_RELOADED')) {
      console.log(state.applied
        ? `[frigate-layout-sync] nginx injection drifted; re-applied and reloaded ${CONTAINER} nginx`
        : `[frigate-layout-sync] injected into ${CONTAINER} nginx (route ${ROUTE} -> ${UPSTREAM})`);
    }
    state = { ...state, mode: 'managed', applied: true, lastError: null };
  } catch (e) {
    state = { ...state, applied: false, lastError: e.message };
    console.error('[frigate-layout-sync] nginx ensure failed:', e.message);
  } finally {
    busy = false;
  }
}

async function ensureWithRetry(tries = 24, delayMs = 5000) {
  for (let i = 0; i < tries && !state.applied; i++) {
    await ensure();
    if (!state.applied) await new Promise((r) => setTimeout(r, delayMs));
  }
}

function manualHint() {
  console.warn('[frigate-layout-sync] auto nginx config is OFF or Docker is unreachable.');
  console.warn('[frigate-layout-sync] Wire Frigate\'s nginx yourself (see PROTOCOL.md / README):');
  console.warn(`  drop this tag in ${INJECT_DIR}/${EXT_ID}.html:  ${INJECT_TAG}`);
  console.warn(`  drop a location in ${LOCATION_DIR}/${EXT_ID}.conf:  location ${ROUTE} { proxy_pass http://${UPSTREAM}; }`);
}

// --------------------------------------------------------- lifecycle
async function start() {
  if (!AUTO) { state.mode = 'disabled'; manualHint(); return; }
  try {
    await docker(['version', '--format', '{{.Server.Version}}']);
  } catch (e) {
    state = { ...state, mode: 'manual', lastError: 'docker unreachable: ' + e.message };
    manualHint();
    return;
  }
  // Event-driven, no polling. Frigate's nginx.conf comes only from its image: an
  // nginx restart inside the container (s6) regenerates base_path.conf and
  // listen.conf, not nginx.conf, and a container restart keeps the writable layer.
  // So our edits are lost only when the container is RECREATED (an upgrade), which
  // always emits a `start` event. Match by NAME from the event actor, NOT
  // `--filter container=<name>` (binds to the old id, misses the recreated one).
  // Start watching BEFORE the first apply so a Frigate start meanwhile isn't missed;
  // after a dropped stream, reconnect with --since to replay what was missed.
  let since = null;
  const watch = () => {
    const args = ['events', '--filter', 'type=container', '--filter', 'event=start', '--format', '{{.Actor.Attributes.name}}'];
    if (since) args.push('--since', String(since));
    const ev = spawn('docker', args);
    let reconnecting = false;
    const reconnect = () => {
      if (reconnecting) return;
      reconnecting = true;
      since = Math.floor(Date.now() / 1000) - 1;
      setTimeout(watch, 5000);
    };
    ev.stdout.on('data', (buf) => {
      if (String(buf).split('\n').map((s) => s.trim()).includes(CONTAINER)) {
        state.applied = false;
        setTimeout(() => ensureWithRetry(), 1500);
      }
    });
    ev.stderr.on('data', () => {});
    ev.on('close', reconnect);
    ev.on('error', reconnect);
  };
  watch();
  await ensureWithRetry();

  // Hourly safety net for the unforeseen (a manual edit, a future Frigate that
  // rebuilds nginx.conf on nginx restart). Costs one `docker exec` and, since
  // ensure() reloads only on change, no nginx reload.
  setInterval(() => ensure(), 60 * 60 * 1000).unref();
}

// Remove ONLY this extension's files + regenerate the combined sub_filter + reload.
async function remove() {
  await lockedSh([
    `rm -f '${INJECT_DIR}/${EXT_ID}.html' '${LOCATION_DIR}/${EXT_ID}.conf'`,
    `C=0`,
    REGEN,
    `nginx -t >/dev/null 2>&1 && nginx -s reload 2>/dev/null`,
    `echo removed`,
  ].join('\n'));
  console.log(`[frigate-layout-sync] removed ${EXT_ID} injection from ${CONTAINER} nginx`);
}

module.exports = { start, ensure, remove, status, applyScript, locationConf, INJECT_TAG, EXT_ID, ROUTE, UPSTREAM };

// `node src/nginx.js apply|remove`
if (require.main === module) {
  const cmd = process.argv[2] || 'apply';
  (cmd === 'remove' ? remove() : ensure())
    .then(() => process.exit(state.applied || cmd === 'remove' ? 0 : 1))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
