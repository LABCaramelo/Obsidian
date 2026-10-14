import { Events, basename, stem, extname } from './util.js';

const TYPES = new Set(['file', 'folder', 'search', 'group']);
const id = () => crypto.randomUUID();
const validPath = (path) => typeof path === 'string' && !!path && !/^[\\/]|^[a-z]:/i.test(path) && !path.split(/[\\/]/).some((p) => p === '..' || p === '.' || !p);

/** Per-vault favorites. Files remain referenced when missing so restoring a file restores its bookmark. */
export class Bookmarks extends Events {
  constructor(storage) {
    super();
    this.storage = storage;
    this.items = [];
    this.revision = 0;
    this.savedRevision = 0;
    this.pending = Promise.resolve();
    this.timer = null;
  }

  async load() {
    const stored = await this.storage.readConfig('bookmarks.json');
    const seen = new Set();
    const normalize = (items, depth = 0) => {
      if (!Array.isArray(items) || depth > 20) return [];
      return items.flatMap((raw) => {
        if (!raw || !TYPES.has(raw.type)) return [];
        if ((raw.type === 'file' || raw.type === 'folder') && !validPath(raw.path)) return [];
        if (raw.type === 'search' && (typeof raw.query !== 'string' || !raw.query.trim())) return [];
        const item = { id: typeof raw.id === 'string' && raw.id && !seen.has(raw.id) ? raw.id : id(), type: raw.type };
        seen.add(item.id);
        if (typeof raw.title === 'string' && raw.title.trim()) item.title = raw.title.trim();
        if (raw.type === 'group') {
          item.title ||= 'Novo grupo';
          item.collapsed = !!raw.collapsed;
          item.items = normalize(raw.items, depth + 1);
        } else if (raw.type === 'search') {
          item.query = raw.query;
          item.matchCase = !!raw.matchCase;
        } else {
          item.path = raw.path;
          if (raw.type === 'file' && typeof raw.subpath === 'string' && raw.subpath.startsWith('#')) item.subpath = raw.subpath;
        }
        return [item];
      });
    };
    this.items = normalize(stored?.items);
    this.revision = this.savedRevision = 0;
    this.emit('change');
  }

  *walk(items = this.items) {
    for (const item of items) {
      yield item;
      if (item.type === 'group') yield* this.walk(item.items);
    }
  }

  find(itemId) {
    return [...this.walk()].find((item) => item.id === itemId) || null;
  }

  locate(itemId, items = this.items) {
    const index = items.findIndex((item) => item.id === itemId);
    if (index !== -1) return { items, index };
    for (const item of items) {
      if (item.type === 'group') {
        const found = this.locate(itemId, item.items);
        if (found) return found;
      }
    }
    return null;
  }

  findTarget(target) {
    return [...this.walk()].find((item) => item.type === target.type && (item.type === 'search'
      ? item.query === target.query && !!item.matchCase === !!target.matchCase
      : item.path === target.path && (item.subpath || '') === (target.subpath || ''))) || null;
  }

  add(target, groupId = null) {
    if (!TYPES.has(target.type)) throw new Error('Tipo de favorito inválido.');
    if (['file', 'folder'].includes(target.type) && !validPath(target.path)) throw new Error('Caminho de favorito inválido.');
    if (target.type === 'search' && (typeof target.query !== 'string' || !target.query.trim())) throw new Error('Digite uma busca para salvá-la.');
    const group = groupId ? this.find(groupId) : null;
    if (groupId && group?.type !== 'group') throw new Error('Grupo de favoritos não encontrado.');
    const existing = target.type === 'group' ? null : this.findTarget(target);
    if (existing) return existing;
    const item = { id: id(), type: target.type };
    if (target.title?.trim()) item.title = target.title.trim();
    if (item.type === 'group') Object.assign(item, { title: item.title || 'Novo grupo', items: [], collapsed: false });
    else if (item.type === 'search') Object.assign(item, { query: target.query, matchCase: !!target.matchCase });
    else {
      item.path = target.path;
      if (item.type === 'file' && target.subpath?.startsWith('#')) item.subpath = target.subpath;
    }
    (group ? group.items : this.items).push(item);
    if (group) group.collapsed = false;
    this.changed();
    return item;
  }

  remove(itemId) {
    const found = this.locate(itemId);
    if (!found) return false;
    found.items.splice(found.index, 1);
    this.changed();
    return true;
  }

  rename(itemId, title) {
    const item = this.find(itemId);
    if (!item || !title?.trim()) return false;
    item.title = title.trim();
    this.changed();
    return true;
  }

  toggleGroup(itemId) {
    const item = this.find(itemId);
    if (item?.type !== 'group') return;
    item.collapsed = !item.collapsed;
    this.changed();
  }

  /** Move into a group or immediately before another sibling; cycles are rejected. */
  move(itemId, groupId = null, beforeId = null) {
    const found = this.locate(itemId);
    const item = found?.items[found.index];
    const group = groupId ? this.find(groupId) : null;
    if (!item || itemId === groupId || (groupId && group?.type !== 'group')) return false;
    if (item.type === 'group' && [...this.walk(item.items)].some((child) => child.id === groupId)) return false;
    const target = group ? group.items : this.items;
    if (beforeId && !target.some((child) => child.id === beforeId)) return false;
    if (itemId === beforeId) return false;
    found.items.splice(found.index, 1);
    const index = beforeId ? target.findIndex((child) => child.id === beforeId) : target.length;
    target.splice(index, 0, item);
    if (group) group.collapsed = false;
    this.changed();
    return true;
  }

  remapPath(oldPath, newPath) {
    let changed = false;
    for (const item of this.walk()) {
      if (item.type !== 'file' && item.type !== 'folder') continue;
      if (item.path === oldPath || item.path.startsWith(`${oldPath}/`)) {
        item.path = newPath + item.path.slice(oldPath.length);
        changed = true;
      }
    }
    if (changed) this.changed();
    return changed;
  }

  changed() {
    this.revision++;
    this.emit('change');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch((err) => this.emit('save-error', err)), 300);
  }

  flush() {
    clearTimeout(this.timer);
    const revision = this.revision;
    const data = { version: 1, items: structuredClone(this.items) };
    const task = this.pending.catch(() => {}).then(async () => {
      if (revision <= this.savedRevision) return;
      await this.storage.writeConfig('bookmarks.json', data);
      this.savedRevision = revision;
    });
    this.pending = task;
    return task;
  }
}

export function bookmarkTitle(item) {
  if (item.title) return item.title;
  if (item.type === 'search') return item.query;
  const name = item.type === 'file' && ['md', 'canvas'].includes(extname(item.path || '')) ? stem(item.path) : basename(item.path || '');
  return name + (item.subpath || '');
}
