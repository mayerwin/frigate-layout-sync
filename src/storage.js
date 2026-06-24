'use strict';
// Layout profiles are persisted as a single human-readable YAML file so you can
// inspect, hand-edit, back up or commit it. Each profile is the snapshot of the
// Frigate presentation state (IndexedDB entries) plus the max viewport width it
// applies to (null = the default, applies at any width).
const fs = require('fs/promises');
const path = require('path');
const yaml = require('js-yaml');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'layouts.yaml');

async function readAll() {
  try {
    const doc = yaml.load(await fs.readFile(FILE, 'utf8')) || {};
    return Array.isArray(doc.profiles) ? doc.profiles : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeAll(profiles) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const body =
    '# frigate-layout-sync layout profiles\n' +
    '# maxWidth: the largest viewport width (px) this layout applies to; null = default.\n' +
    '# data: the Frigate IndexedDB presentation entries captured for this layout.\n' +
    yaml.dump({ profiles }, { lineWidth: -1, noRefs: true, sortKeys: false });
  await fs.writeFile(FILE, body);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normWidth(w) {
  if (w === null || w === undefined || w === '' || w === 'null') return null;
  const n = Math.round(Number(w));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function list() {
  return await readAll();
}

// Upsert by maxWidth: one layout per breakpoint. Saving again for the same
// width (or for "default") replaces the previous one.
async function save(input) {
  const maxWidth = normWidth(input.maxWidth);
  const data = input.data && typeof input.data === 'object' ? input.data : {};
  const allCameras = input.allCameras && typeof input.allCameras === 'object' ? input.allCameras : null;
  if (!Object.keys(data).length && !allCameras) throw new Error('nothing to save');
  const profiles = (await readAll()).filter(
    (p) => p.maxWidth !== maxWidth && p.id !== input.id
  );
  const profile = {
    id: input.id || genId(),
    label: String(input.label || '').slice(0, 60) || (maxWidth ? '≤ ' + maxWidth + 'px' : 'Default (any width)'),
    maxWidth,
    createdAt: new Date().toISOString(),
    data,
    allCameras,
  };
  profiles.push(profile);
  profiles.sort((a, b) => (a.maxWidth == null ? Infinity : a.maxWidth) - (b.maxWidth == null ? Infinity : b.maxWidth));
  await writeAll(profiles);
  return profile;
}

async function remove(id) {
  const profiles = await readAll();
  const next = profiles.filter((p) => p.id !== id);
  await writeAll(next);
  return { ok: true, removed: profiles.length - next.length };
}

module.exports = { list, save, remove, FILE };
