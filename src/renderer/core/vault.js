import { Events, basename, dirname, extname, isMarkdown, joinPath, stem } from './util.js';

const api = window.basalto.vault;

/**
 * In-memory model of the vault: every file/folder entry plus the text of each Markdown file.
 * Emits: create(file), modify(file, {external}), delete(file), rename(file, oldPath).
 */
export class Vault extends Events {
  constructor() {
    super();
    this.info = null;
    this.entries = new Map(); // path -> { path, type, size, mtime, ctime }
    this.contents = new Map(); // markdown path -> text
    this.writing = new Map(); // path -> text being written (to recognize our own watcher echoes)
  }

  async load() {
    this.info = await api.info();
    const list = await api.list();
    for (const entry of list) this.entries.set(entry.path, entry);
    const md = list.filter((e) => e.type === 'file' && isMarkdown(e.path)).map((e) => e.path);
    // Read in batches to keep each IPC message reasonably small.
    for (let i = 0; i < md.length; i += 200) {
      const batch = await api.readMany(md.slice(i, i + 200));
      for (const [p, text] of Object.entries(batch)) if (text != null) this.contents.set(p, text);
    }
    api.onEvent((event) => this.onWatcherEvent(event));
  }

  get name() {
    return this.info?.name || '';
  }

  fileUrl(path) {
    if (globalThis.location?.protocol?.startsWith('http')) {
      return `/vaultfile/${path.split('/').map(encodeURIComponent).join('/')}`;
    }
    return `vaultfile://${this.info?.id || ''}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  getFile(path) {
    const e = this.entries.get(path);
    return e && e.type === 'file' ? e : null;
  }

  getFolder(path) {
    if (path === '') return { path: '', type: 'folder' };
    const e = this.entries.get(path);
    return e && e.type === 'folder' ? e : null;
  }

  exists(path) {
    return path === '' || this.entries.has(path);
  }

  getFiles() {
    return [...this.entries.values()].filter((e) => e.type === 'file');
  }

  getMarkdownFiles() {
    return this.getFiles().filter((e) => isMarkdown(e.path));
  }

  getFolders() {
    return [...this.entries.values()].filter((e) => e.type === 'folder');
  }

  getChildren(folderPath) {
    return [...this.entries.values()].filter((e) => dirname(e.path) === folderPath);
  }

  /** Text of a Markdown or canvas file from the cache (falls back to disk). */
  async read(path) {
    if (this.contents.has(path)) return this.contents.get(path);
    const text = await api.read(path);
    if (isTextFile(path)) this.contents.set(path, text);
    return text;
  }

  cachedRead(path) {
    return this.contents.get(path) ?? '';
  }

  async write(path, text) {
    const existed = this.entries.has(path);
    this.contents.set(path, text);
    this.writing.set(path, text);
    try {
      const stat = await api.write(path, text);
      this.ensureParents(path);
      if (stat) this.entries.set(path, stat);
      const file = this.entries.get(path);
      this.emit(existed ? 'modify' : 'create', file, { external: false });
      return file;
    } finally {
      setTimeout(() => {
        if (this.writing.get(path) === text) this.writing.delete(path);
      }, 1500);
    }
  }

  async writeBinary(path, bytes) {
    const stat = await api.writeBinary(path, bytes);
    this.ensureParents(path);
    this.entries.set(path, stat);
    this.emit('create', stat);
    return stat;
  }

  async create(path, text = '') {
    if (this.exists(path)) throw new Error(`Já existe: ${path}`);
    return this.write(path, text);
  }

  async createFolder(path) {
    if (this.exists(path)) return this.entries.get(path);
    const stat = await api.mkdir(path);
    this.ensureParents(path);
    this.entries.set(path, stat || { path, type: 'folder' });
    this.emit('create', this.entries.get(path));
    return this.entries.get(path);
  }

  ensureParents(path) {
    let dir = dirname(path);
    while (dir && !this.entries.has(dir)) {
      this.entries.set(dir, { path: dir, type: 'folder' });
      this.emit('create', this.entries.get(dir));
      dir = dirname(dir);
    }
  }

  /** Returns a free path such as "Pasta/Sem título 2.md". */
  getAvailablePath(folder, name, ext) {
    let candidate = joinPath(folder, `${name}.${ext}`);
    let i = 1;
    while (this.exists(candidate) || this.existsCaseInsensitive(candidate)) {
      candidate = joinPath(folder, `${name} ${i}.${ext}`);
      i++;
    }
    return candidate;
  }

  existsCaseInsensitive(path) {
    const lower = path.toLowerCase();
    for (const p of this.entries.keys()) if (p.toLowerCase() === lower) return true;
    return false;
  }

  async rename(oldPath, newPath) {
    if (oldPath === newPath) return;
    const entry = this.entries.get(oldPath);
    if (!entry) throw new Error(`Não encontrado: ${oldPath}`);
    await api.rename(oldPath, newPath);
    this.ensureParents(newPath);

    const moved = [];
    if (entry.type === 'folder') {
      const prefix = `${oldPath}/`;
      for (const [p, e] of [...this.entries]) {
        if (p.startsWith(prefix)) moved.push([p, `${newPath}/${p.slice(prefix.length)}`, e]);
      }
    }
    moved.unshift([oldPath, newPath, entry]);

    for (const [from, to, e] of moved) {
      this.entries.delete(from);
      const updated = { ...e, path: to };
      this.entries.set(to, updated);
      if (this.contents.has(from)) {
        this.contents.set(to, this.contents.get(from));
        this.contents.delete(from);
      }
    }
    for (const [from, to] of moved) this.emit('rename', this.entries.get(to), from);
  }

  async trash(path) {
    const entry = this.entries.get(path);
    if (!entry) return;
    await api.trash(path);
    this.removeEntry(path);
  }

  removeEntry(path) {
    const entry = this.entries.get(path);
    if (!entry) return;
    const removed = [entry];
    if (entry.type === 'folder') {
      const prefix = `${path}/`;
      for (const [p, e] of this.entries) if (p.startsWith(prefix)) removed.push(e);
    }
    for (const e of removed) {
      this.entries.delete(e.path);
      this.contents.delete(e.path);
    }
    for (const e of removed) this.emit('delete', e);
  }

  async onWatcherEvent(event) {
    const { path } = event;
    if (event.kind === 'deleted') {
      // Our own rename already moved the entry; nothing left to delete then.
      if (this.entries.has(path)) this.removeEntry(path);
      return;
    }
    const stat = event.stat;
    const isNew = !this.entries.has(path);
    if (stat.type === 'folder') {
      if (isNew) {
        this.ensureParents(path);
        this.entries.set(path, stat);
        this.emit('create', stat);
        // A folder moved in from outside: pick up its contents.
        const all = await api.list();
        for (const e of all) {
          if (e.path.startsWith(`${path}/`) && !this.entries.has(e.path)) {
            this.entries.set(e.path, e);
            if (isMarkdown(e.path)) this.contents.set(e.path, await api.read(e.path));
            this.emit('create', e);
          }
        }
      }
      return;
    }
    this.ensureParents(path);
    this.entries.set(path, stat);
    // Canvases are only cached once opened; until then there is nothing to keep in sync.
    if (!isMarkdown(path) && !(isTextFile(path) && this.contents.has(path))) {
      if (isNew) this.emit('create', stat);
      return;
    }
    let text;
    try {
      text = await api.read(path);
    } catch {
      return;
    }
    if (this.writing.has(path) && this.writing.get(path) === text) return; // our own write echoing back
    const previous = this.contents.get(path);
    this.contents.set(path, text);
    if (isNew) this.emit('create', stat);
    else if (previous !== text) this.emit('modify', stat, { external: true });
  }
}

/** Files whose text the vault keeps in memory: notes and canvases. */
export function isTextFile(path) {
  return isMarkdown(path) || extname(path) === 'canvas';
}

export { basename, dirname, extname, stem };
