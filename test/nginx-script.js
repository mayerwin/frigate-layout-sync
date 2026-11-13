'use strict';
// Behavioural test of the frigate-ext apply script, no Docker or Frigate needed:
// render applyScript() against a temp dir with a fake `nginx` that logs calls.
// Guards the reload-only-on-change rule: every `nginx -s reload` grows Frigate's
// nginx master RSS, and an unconditional 30s reload ran Frigate out of memory.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const nx = require('../src/nginx.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fls-nginx-'));
const root = tmp.split(path.sep).join('/');
fs.mkdirSync(path.join(tmp, 'bin'));
fs.writeFileSync(path.join(tmp, 'bin', 'nginx'), `#!/bin/sh\necho "nginx $*" >> "${root}/calls"\n`, { mode: 0o755 });
const conf = path.join(tmp, 'nginx.conf');
fs.writeFileSync(conf, 'server {\n    location / {\n            root /opt/frigate/web;\n    }\n}\n');

const script = nx.applyScript()
  .split('/usr/local/nginx/conf/frigate-ext').join(`${root}/frigate-ext`)
  .split('/usr/local/nginx/conf/nginx.conf').join(`${root}/nginx.conf`)
  .split('/tmp/').join(`${root}/`);
const env = { ...process.env, PATH: `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH}` };
const run = () => execFileSync('sh', ['-c', script], { env }).toString().trim().split('\n').pop();
const reloads = () => {
  const f = path.join(tmp, 'calls');
  return fs.existsSync(f) ? (fs.readFileSync(f, 'utf8').match(/-s reload/g) || []).length : 0;
};

assert.strictEqual(run(), 'FLS_RELOADED');
assert.strictEqual(reloads(), 1);
for (let i = 0; i < 5; i++) assert.strictEqual(run(), 'FLS_UNCHANGED');
assert.strictEqual(reloads(), 1, 'no reload while nothing changed');
assert.strictEqual(
  fs.readFileSync(path.join(tmp, 'frigate-ext', 'generated', 'subfilter.conf'), 'utf8'),
  `sub_filter '</body>' '${nx.INJECT_TAG}</body>';\n`);

fs.writeFileSync(path.join(tmp, 'frigate-ext', 'inject', 'zz-other.html'), '<script src=/x.js></script>');
assert.strictEqual(run(), 'FLS_RELOADED', 'another extension tag -> combined sub_filter changed');
fs.writeFileSync(conf, fs.readFileSync(conf, 'utf8').split('\n').filter((l) => !l.includes('frigate-ext')).join('\n'));
assert.strictEqual(run(), 'FLS_RELOADED', 'includes wiped -> re-added');
assert.strictEqual(run(), 'FLS_UNCHANGED');
assert.strictEqual(reloads(), 3);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('nginx-script: ok');
