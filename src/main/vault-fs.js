'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
let shell = null;
try {
  shell = require('electron').shell;
} catch {}
const { resolveInVault, toRel, isIgnored, normalizeRel } = require('./paths');
const { SerialQueue, atomicWrite } = require('./persistence');

const CONFIG_DIR = '.basalto';

/** File-system access for a single vault, always scoped to its root folder. */
class VaultFs {
  constructor(root) {
    this.root = path.resolve(root);
    this.watcher = null;
    this.listeners = new Set();
    this.pending = new Map();
    this.mutations = new SerialQueue();
  }

  abs(rel) {
    return resolveInVault(this.root, rel);
  }

  async list() {
    const out = [];
    const walk = async (dirAbs) => {
      let entries;
      try {
        entries = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dirAbs, entry.name);
        const rel = toRel(this.root, abs);
        if (isIgnored(rel)) continue;
        if (entry.isDirectory()) {
          out.push({ path: rel, type: 'folder' });
          await walk(abs);
        } else if (entry.isFile()) {
          try {
            const st = await fsp.stat(abs);
            out.push({ path: rel, type: 'file', size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs });
          } catch {
            // Vanished between readdir and stat.
          }
        }
      }
    };
    await walk(this.root);
    return out;
  }

  async stat(rel) {
    try {
      const st = await fsp.stat(this.abs(rel));
      return {
        path: normalizeRel(rel),
        type: st.isDirectory() ? 'folder' : 'file',
        size: st.size,
        mtime: st.mtimeMs,
        ctime: st.birthtimeMs || st.ctimeMs,
      };
    } catch {
      return null;
    }
  }

  read(rel) {
    return fsp.readFile(this.abs(rel), 'utf8');
  }

  async readMany(rels) {
    const result = {};
    await Promise.all(
      rels.map(async (rel) => {
        try {
          result[rel] = await this.read(rel);
        } catch {
          result[rel] = null;
        }
      }),
    );
    return result;
  }

  async write(rel, text) {
    const abs = this.abs(rel);
    return this.mutations.run(async () => {
      await atomicWrite(abs, text);
      return this.stat(rel);
    });
  }

  async writeBinary(rel, bytes) {
    const abs = this.abs(rel);
    return this.mutations.run(async () => {
      await atomicWrite(abs, Buffer.from(bytes));
      return this.stat(rel);
    });
  }

  async mkdir(rel) {
    const abs = this.abs(rel);
    return this.mutations.run(async () => {
      await fsp.mkdir(abs, { recursive: true });
      return this.stat(rel);
    });
  }

  async rename(from, to) {
    const src = this.abs(from);
    const dst = this.abs(to);
    return this.mutations.run(async () => {
      if (src.toLowerCase() !== dst.toLowerCase() && fs.existsSync(dst)) {
        throw new Error(`Já existe um item com esse nome: ${to}`);
      }
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.rename(src, dst);
      return this.stat(to);
    });
  }

  async trash(rel) {
    const abs = this.abs(rel);
    return this.mutations.run(async () => {
      try {
        await shell.trashItem(abs);
      } catch {
        // No system trash available (e.g. network drive): fall back to the vault-local .trash folder.
        const dst = path.join(this.root, '.trash', `${Date.now()}-${path.basename(abs)}`);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.rename(abs, dst);
      }
    });
  }

  exists(rel) {
    return fs.existsSync(this.abs(rel));
  }

  // --- configuration files under .basalto/ ---

  async readConfig(name) {
    try {
      return JSON.parse(await fsp.readFile(this.configPath(name), 'utf8'));
    } catch {
      return null;
    }
  }

  async writeConfig(name, data) {
    const file = this.configPath(name);
    const text = JSON.stringify(data, null, 2);
    return this.mutations.run(() => atomicWrite(file, text));
  }

  configPath(name) {
    if (!/^[a-z0-9-]+\.json$/i.test(name)) throw new Error(`Nome de configuração inválido: ${name}`);
    return path.join(this.root, CONFIG_DIR, name);
  }

  // --- watching ---

  onEvent(listener) {
    this.listeners.add(listener);
    if (!this.watcher) this.startWatching();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopWatching();
    };
  }

  startWatching() {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_type, filename) => {
        if (!filename) return;
        const rel = filename.split(path.sep).join('/');
        if (isIgnored(rel)) return;
        // Coalesce bursts of events for the same path.
        clearTimeout(this.pending.get(rel));
        this.pending.set(
          rel,
          setTimeout(() => {
            this.pending.delete(rel);
            this.emitFor(rel);
          }, 120),
        );
      });
      this.watcher.on('error', () => this.stopWatching());
    } catch {
      this.watcher = null;
    }
  }

  async emitFor(rel) {
    const st = await this.stat(rel);
    const event = st ? { kind: 'changed', path: rel, stat: st } : { kind: 'deleted', path: rel };
    for (const listener of this.listeners) listener(event);
  }

  stopWatching() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}

module.exports = { VaultFs, CONFIG_DIR };
