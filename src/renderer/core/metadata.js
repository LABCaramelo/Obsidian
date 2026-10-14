import { Events, basename, dirname, extname, isMarkdown, joinPath, stem } from './util.js';
import { parseNote, parseLinktext } from './parse.js';

/**
 * Keeps parsed metadata of every note and the resolved link graph up to date.
 * Emits: changed(path, cache), deleted(path), resolved().
 */
export class MetadataCache extends Events {
  constructor(vault) {
    super();
    this.vault = vault;
    this.caches = new Map(); // path -> parsed note
    this.resolvedLinks = {}; // source -> { dest: count }
    this.unresolvedLinks = {}; // source -> { linktext: count }
    this.byName = new Map(); // lower-case name (with ext for non-md, stem for md) -> [paths]
  }

  init() {
    this.rebuildNameIndex();
    for (const file of this.vault.getMarkdownFiles()) this.caches.set(file.path, parseNote(this.vault.cachedRead(file.path)));
    this.resolveAll();

    this.vault.on('create', (file) => {
      if (file.type !== 'file') return;
      this.rebuildNameIndex();
      if (isMarkdown(file.path)) this.reparse(file.path, false);
      this.resolveAll(); // a new file may resolve previously dangling links
    });
    this.vault.on('modify', (file) => {
      if (isMarkdown(file.path)) this.reparse(file.path, true);
    });
    this.vault.on('delete', (file) => {
      this.caches.delete(file.path);
      this.rebuildNameIndex();
      this.resolveAll();
      this.emit('deleted', file.path);
    });
    this.vault.on('rename', (file, oldPath) => {
      const cache = this.caches.get(oldPath);
      this.caches.delete(oldPath);
      if (file.type === 'file' && isMarkdown(file.path)) this.caches.set(file.path, cache || parseNote(this.vault.cachedRead(file.path)));
      this.rebuildNameIndex();
      this.resolveAll();
    });
  }

  reparse(path, resolveSingle) {
    const cache = parseNote(this.vault.cachedRead(path));
    this.caches.set(path, cache);
    if (resolveSingle) {
      this.resolveFile(path);
      this.emit('resolved');
    }
    this.emit('changed', path, cache);
  }

  getCache(path) {
    return this.caches.get(path) || null;
  }

  rebuildNameIndex() {
    this.byName.clear();
    const add = (key, p) => {
      const k = key.toLowerCase();
      if (!this.byName.has(k)) this.byName.set(k, []);
      this.byName.get(k).push(p);
    };
    for (const file of this.vault.getFiles()) {
      add(basename(file.path), file.path);
      if (isMarkdown(file.path)) add(stem(file.path), file.path);
    }
  }

  /**
   * Resolves a link path the same way for links and embeds:
   * exact vault path → path relative to the source note → shortest path with that name.
   */
  getFirstLinkpathDest(linkpath, sourcePath = '') {
    if (!linkpath) return sourcePath ? this.vault.getFile(sourcePath) : null;
    const clean = linkpath.replace(/^\.?\//, '');
    const variants = extname(clean) ? [clean, `${clean}.md`] : [`${clean}.md`, clean];
    for (const v of variants) {
      const f = this.vault.getFile(v);
      if (f) return f;
    }
    const sourceDir = dirname(sourcePath);
    if (sourceDir) {
      for (const v of variants) {
        const f = this.vault.getFile(normalize(joinPath(sourceDir, v)));
        if (f) return f;
      }
    }
    const lower = clean.toLowerCase();
    const name = basename(lower);
    const candidates = this.byName.get(name) || [];
    const matching = candidates.filter((p) => {
      const pl = p.toLowerCase();
      return pl.endsWith(`/${lower}`) || pl.endsWith(`/${lower}.md`) || pl === lower || pl === `${lower}.md` || !lower.includes('/');
    });
    if (!matching.length) return null;
    matching.sort((a, b) => {
      // Prefer the file in the same folder as the source, then the shortest path.
      const sameA = dirname(a) === sourceDir ? 0 : 1;
      const sameB = dirname(b) === sourceDir ? 0 : 1;
      return sameA - sameB || a.length - b.length || a.localeCompare(b);
    });
    return this.vault.getFile(matching[0]);
  }

  /** Shortest unambiguous link text for `path`. */
  fileToLinktext(path, sourcePath = '', omitMdExtension = true) {
    const name = basename(path);
    const key = (isMarkdown(path) ? stem(path) : name).toLowerCase();
    const unique = (this.byName.get(key) || []).filter((p) => (isMarkdown(path) ? isMarkdown(p) : true)).length <= 1;
    let text = unique ? name : path;
    if (omitMdExtension && isMarkdown(path)) text = text.replace(/\.md$/i, '');
    return text;
  }

  resolveAll() {
    this.resolvedLinks = {};
    this.unresolvedLinks = {};
    for (const path of this.caches.keys()) this.resolveFile(path);
    this.emit('resolved');
  }

  resolveFile(path) {
    const cache = this.caches.get(path);
    const resolved = {};
    const unresolved = {};
    if (cache) {
      for (const ref of [...cache.links, ...cache.embeds]) {
        const { path: linkpath } = parseLinktext(ref.link);
        if (!linkpath) continue;
        const dest = this.getFirstLinkpathDest(linkpath, path);
        if (dest) resolved[dest.path] = (resolved[dest.path] || 0) + 1;
        else unresolved[linkpath] = (unresolved[linkpath] || 0) + 1;
      }
    }
    this.resolvedLinks[path] = resolved;
    this.unresolvedLinks[path] = unresolved;
  }

  /** Notes linking to `path`, with the link references inside each of them. */
  getBacklinks(path) {
    const result = [];
    for (const [source, dests] of Object.entries(this.resolvedLinks)) {
      if (!dests[path]) continue;
      const cache = this.caches.get(source);
      const refs = [...(cache?.links || []), ...(cache?.embeds || [])].filter(
        (ref) => this.getFirstLinkpathDest(parseLinktext(ref.link).path, source)?.path === path,
      );
      result.push({ source, refs });
    }
    return result.sort((a, b) => a.source.localeCompare(b.source));
  }

  getAllTags() {
    const counts = new Map();
    for (const cache of this.caches.values()) {
      for (const t of [...cache.tags.map((x) => x.tag), ...cache.frontmatterTags]) {
        const key = t;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return counts;
  }

  getFileTags(path) {
    const cache = this.caches.get(path);
    if (!cache) return [];
    return [...new Set([...cache.frontmatterTags, ...cache.tags.map((t) => t.tag)])];
  }

  /** Every note name and alias, for quick switcher / link suggestions. */
  getLinkSuggestions() {
    const out = [];
    for (const file of this.vault.getFiles()) {
      out.push({ file: file.path, alias: null });
      const aliases = this.caches.get(file.path)?.aliases || [];
      for (const alias of aliases) out.push({ file: file.path, alias });
    }
    return out;
  }
}

function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}
