'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Persists the list of known vaults in the user-data folder.
 * Shape mirrors the registry observed in the original app:
 *   { "vaults": { "<16-hex id>": { "path": "...", "ts": 1700000000000, "open": true } } }
 */
class VaultRegistry {
  constructor(file) {
    this.file = file;
    this.data = { vaults: {} };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed.vaults === 'object') this.data = parsed;
    } catch {
      // First run or corrupted file: start empty.
    }
    // Forget vaults whose folder disappeared.
    for (const [id, v] of Object.entries(this.data.vaults)) {
      if (!v || typeof v.path !== 'string' || !fs.existsSync(v.path)) delete this.data.vaults[id];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.entries(this.data.vaults)
      .map(([id, v]) => ({ id, path: v.path, name: path.basename(v.path), ts: v.ts || 0, open: !!v.open }))
      .sort((a, b) => b.ts - a.ts);
  }

  get(id) {
    const v = this.data.vaults[id];
    return v ? { id, ...v, name: path.basename(v.path) } : null;
  }

  findByPath(p) {
    const target = path.resolve(p).toLowerCase();
    return this.list().find((v) => path.resolve(v.path).toLowerCase() === target) || null;
  }

  /** Registers a folder (if needed) and returns its id. */
  add(folder) {
    const existing = this.findByPath(folder);
    if (existing) return existing.id;
    let id;
    do id = crypto.randomBytes(8).toString('hex');
    while (this.data.vaults[id]);
    this.data.vaults[id] = { path: path.resolve(folder), ts: Date.now() };
    this.save();
    return id;
  }

  update(id, patch) {
    if (!this.data.vaults[id]) return;
    Object.assign(this.data.vaults[id], patch);
    this.save();
  }

  remove(id) {
    delete this.data.vaults[id];
    this.save();
  }
}

module.exports = { VaultRegistry };
