'use strict';
// frigate-layout-sync — companion service (NO reverse proxy).
//
// Frigate's own nginx is the single front door. It injects our <script> into the
// dashboard HTML (via an nginx `sub_filter`) and routes `/__layoutsync/*` to this
// tiny service. Everything else — assets, the REST API, the live-view websockets,
// video — is served by Frigate directly and never touches this process.
//
// This process does two things:
//   1. Serves the injected client (`/__layoutsync/inject.js`) and a small layout
//      API (`/__layoutsync/api/*`), storing layout profiles server-side as YAML
//      so they sync across every device that opens Frigate.
//   2. Keeps the nginx injection in place: on start, and whenever the Frigate
//      container (re)starts, it ensures the `sub_filter` + `location` exist and
//      reloads nginx — so a Frigate upgrade self-heals with no manual step.
//      (See src/nginx.js. This is best-effort; if the Docker socket is not
//      available the service still serves the API and prints manual setup hints.)
const fs = require('fs');
const http = require('http');
const path = require('path');
const storage = require('./storage');
const nginx = require('./nginx');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BASE = '/__layoutsync';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// The injected client.
const CLIENT_JS = fs.readFileSync(path.join(__dirname, 'inject.client.js'), 'utf8');

// ----------------------------------------------------------- helpers
function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 20e6) req.destroy(); }); req.on('end', () => resolve(b));
  });
}

// ----------------------------------------------------------- request handler
const requestHandler = async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0];
    if (url === BASE + '/inject.js' && req.method === 'GET') {
      // the client rarely changes and is cheap, so allow a short cache
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-cache' });
      return res.end(CLIENT_JS);
    }
    if (url === BASE + '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, service: 'frigate-layout-sync', nginx: nginx.status() });
    }
    if (url === BASE + '/api/layouts') {
      if (req.method === 'GET') return json(res, 200, await storage.list());
      if (req.method === 'POST') {
        let p; try { p = JSON.parse((await readBody(req)) || '{}'); } catch (_) { return json(res, 400, { error: 'invalid JSON' }); }
        try { return json(res, 200, await storage.save(p)); } catch (e) { return json(res, 400, { error: e.message }); }
      }
    }
    if (url.startsWith(BASE + '/api/layouts/') && req.method === 'DELETE') {
      const id = decodeURIComponent(url.slice((BASE + '/api/layouts/').length));
      try { return json(res, 200, await storage.remove(id)); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    // Anything else should have been served by Frigate's nginx, not routed here.
    return json(res, 404, { error: 'not found', hint: 'frigate-layout-sync only serves ' + BASE + '/*' });
  } catch (e) {
    try { json(res, 500, { error: e.message }); } catch (_) { /* noop */ }
  }
};

const server = http.createServer(requestHandler);
// A client aborting a connection must never crash the process.
server.on('connection', (s) => { try { s.on('error', () => {}); } catch (_) { /* noop */ } });
server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch (_) { /* noop */ } });
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, HOST, () => {
  console.log(`[frigate-layout-sync] companion listening on http://${HOST}:${PORT}${BASE}`);
  // Best-effort: make Frigate's nginx inject our script + route ${BASE}/* here,
  // and keep doing so across Frigate restarts/upgrades.
  nginx.start({ dataDir: DATA_DIR }).catch((e) => console.error('[frigate-layout-sync] nginx integrator error:', e.message));
});
