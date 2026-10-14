import { Panel } from './sidebar.js';
import { el, debounce, stem, escapeRegExp, isMarkdown } from '../core/util.js';
import { parseLinktext } from '../core/parse.js';
import { icon } from '../ui/icons.js';

// Panels that describe the active note: tags (vault-wide), backlinks, outgoing links and outline.

export class TagsPanel extends Panel {
  constructor(app) {
    super(app);
    this.containerEl.classList.add('tags-panel');
    this.sortByCount = false;
    const sortBtn = el('button', { class: 'clickable-icon', title: 'Ordenar por contagem/nome' }, icon('sort'));
    sortBtn.addEventListener('click', () => {
      this.sortByCount = !this.sortByCount;
      this.render();
    });
    this.listEl = el('div', { class: 'tag-container' });
    this.containerEl.append(el('div', { class: 'nav-header' }, sortBtn), this.listEl);
    this.renderSoon = debounce(() => this.render(), 300);
    app.metadata.on('changed', this.renderSoon);
    app.metadata.on('deleted', this.renderSoon);
  }
  get id() {
    return 'tags';
  }
  get title() {
    return 'Tags';
  }
  get icon() {
    return 'hash';
  }
  onShow() {
    this.render();
  }

  render() {
    if (this.containerEl.classList.contains('is-hidden')) return;
    const counts = this.app.metadata.getAllTags();
    // Build a tree from nested tags like #projeto/ativo
    const root = { children: new Map(), count: 0 };
    for (const [tag, count] of counts) {
      let node = root;
      let full = '';
      for (const part of tag.slice(1).split('/')) {
        full = full ? `${full}/${part}` : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, full: `#${full}`, children: new Map(), count: 0 });
        node = node.children.get(part);
        node.count += count;
      }
    }
    this.listEl.textContent = '';
    if (!counts.size) {
      this.listEl.appendChild(el('div', { class: 'pane-empty', text: 'Nenhuma tag encontrada.' }));
      return;
    }
    const renderLevel = (node, parent) => {
      const kids = [...node.children.values()].sort((a, b) => (this.sortByCount ? b.count - a.count : a.name.localeCompare(b.name)));
      for (const kid of kids) {
        const row = el('div', { class: 'tag-pane-tag tree-item-self' }, el('span', { class: 'tree-item-inner', text: `#${kid.name}` }), el('span', { class: 'tree-item-flair', text: String(kid.count) }));
        row.addEventListener('click', () => this.app.openSearch(`tag:${kid.full}`));
        const childrenEl = el('div', { class: 'tree-item-children' });
        parent.append(el('div', { class: 'tree-item' }, row, childrenEl));
        renderLevel(kid, childrenEl);
      }
    };
    renderLevel(root, this.listEl);
  }
}

class ActiveFilePanel extends Panel {
  constructor(app) {
    super(app);
    this.renderSoon = debounce(() => this.render(), 250);
    app.workspace.on('active-leaf-change', this.renderSoon);
    app.workspace.on('file-open', this.renderSoon);
    app.metadata.on('resolved', this.renderSoon);
    app.metadata.on('changed', this.renderSoon);
  }
  get file() {
    return this.app.workspace.getActiveFile();
  }
  onShow() {
    this.render();
  }
  render() {}
}

function lineOf(text, line) {
  return (text.split('\n')[line] || '').trim();
}

export class BacklinksPanel extends ActiveFilePanel {
  constructor(app) {
    super(app);
    this.containerEl.classList.add('backlink-panel');
    this.showUnlinked = false;
  }
  get id() {
    return 'backlinks';
  }
  get title() {
    return 'Backlinks';
  }
  get icon() {
    return 'link';
  }

  render() {
    if (this.containerEl.classList.contains('is-hidden')) return;
    this.containerEl.textContent = '';
    const file = this.file;
    if (!file) {
      this.containerEl.appendChild(el('div', { class: 'pane-empty', text: 'Nenhuma nota ativa.' }));
      return;
    }
    const { metadata, vault } = this.app;
    const backlinks = metadata.getBacklinks(file);
    this.containerEl.appendChild(el('div', { class: 'tree-item-self is-header' }, el('span', { class: 'tree-item-inner', text: 'Menções vinculadas' }), el('span', { class: 'tree-item-flair', text: String(backlinks.length) })));
    if (!backlinks.length) this.containerEl.appendChild(el('div', { class: 'pane-empty', text: 'Nenhum backlink encontrado.' }));
    for (const { source, refs } of backlinks) {
      const text = vault.cachedRead(source);
      const group = el('div', { class: 'search-result' });
      const title = el('div', { class: 'search-result-file-title tree-item-self' }, el('span', { class: 'tree-item-inner', text: stem(source) }), el('span', { class: 'tree-item-flair', text: String(refs.length) }));
      title.addEventListener('click', (e) => this.app.openFile(source, { newLeaf: e.ctrlKey || e.metaKey }));
      group.appendChild(title);
      for (const ref of refs.slice(0, 20)) {
        const row = el('div', { class: 'search-result-file-match', text: lineOf(text, ref.position.start.line) });
        row.addEventListener('click', (e) => this.app.openFile(source, { line: ref.position.start.line, newLeaf: e.ctrlKey || e.metaKey }));
        group.appendChild(row);
      }
      this.containerEl.appendChild(group);
    }

    // Unlinked mentions: the note's name appears as plain text elsewhere.
    const toggle = el('div', { class: 'tree-item-self is-header is-clickable' }, el('span', { class: 'tree-item-icon' }, icon(this.showUnlinked ? 'chevron-down' : 'chevron-right', 14)), el('span', { class: 'tree-item-inner', text: 'Menções não vinculadas' }));
    toggle.addEventListener('click', () => {
      this.showUnlinked = !this.showUnlinked;
      this.render();
    });
    this.containerEl.appendChild(toggle);
    if (!this.showUnlinked) return;
    const name = stem(file);
    const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[|])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}\\]|])`, 'iu');
    const linked = new Set(backlinks.map((b) => b.source));
    let found = 0;
    for (const f of vault.getMarkdownFiles()) {
      if (f.path === file || linked.has(f.path)) continue;
      const lines = vault.cachedRead(f.path).split('\n');
      const hits = lines.map((l, i) => [l, i]).filter(([l]) => re.test(l));
      if (!hits.length) continue;
      found++;
      const group = el('div', { class: 'search-result' }, el('div', { class: 'search-result-file-title tree-item-self' }, el('span', { class: 'tree-item-inner', text: stem(f.path) })));
      for (const [l, i] of hits.slice(0, 5)) {
        const linkBtn = el('button', { class: 'mod-small', text: 'Vincular' });
        linkBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const all = vault.cachedRead(f.path).split('\n');
          all[i] = all[i].replace(re, (m, pre) => `${pre}[[${metadata.fileToLinktext(file, f.path)}${m.slice(pre.length) === name ? '' : `|${m.slice(pre.length)}`}]]`);
          await vault.write(f.path, all.join('\n'));
        });
        const row = el('div', { class: 'search-result-file-match' }, el('span', { text: l.trim() }), linkBtn);
        row.addEventListener('click', () => this.app.openFile(f.path, { line: i }));
        group.appendChild(row);
      }
      this.containerEl.appendChild(group);
    }
    if (!found) this.containerEl.appendChild(el('div', { class: 'pane-empty', text: 'Nenhuma menção não vinculada.' }));
  }
}

export class OutgoingLinksPanel extends ActiveFilePanel {
  get id() {
    return 'outgoing-links';
  }
  get title() {
    return 'Links de saída';
  }
  get icon() {
    return 'link-2';
  }
  render() {
    if (this.containerEl.classList.contains('is-hidden')) return;
    this.containerEl.textContent = '';
    const file = this.file;
    const cache = file ? this.app.metadata.getCache(file) : null;
    if (!cache) {
      this.containerEl.appendChild(el('div', { class: 'pane-empty', text: 'Nenhuma nota ativa.' }));
      return;
    }
    const resolved = new Map();
    const unresolved = new Map();
    for (const ref of [...cache.links, ...cache.embeds]) {
      const { path } = parseLinktext(ref.link);
      if (!path) continue;
      const dest = this.app.metadata.getFirstLinkpathDest(path, file);
      if (dest) resolved.set(dest.path, (resolved.get(dest.path) || 0) + 1);
      else unresolved.set(path, (unresolved.get(path) || 0) + 1);
    }
    const section = (title, map, onClick, cls) => {
      this.containerEl.appendChild(el('div', { class: 'tree-item-self is-header' }, el('span', { class: 'tree-item-inner', text: title }), el('span', { class: 'tree-item-flair', text: String(map.size) })));
      for (const [key, count] of map) {
        const row = el('div', { class: `tree-item-self ${cls}` }, el('span', { class: 'tree-item-inner', text: isMarkdown(key) ? stem(key) : key }), el('span', { class: 'tree-item-flair', text: String(count) }));
        row.addEventListener('click', (e) => onClick(key, e));
        this.containerEl.appendChild(row);
      }
    };
    section('Links', resolved, (p, e) => this.app.openFile(p, { newLeaf: e.ctrlKey || e.metaKey }), 'outgoing-link-item');
    section('Links não resolvidos', unresolved, (p, e) => this.app.openLinkText(p, file, e.ctrlKey || e.metaKey), 'outgoing-link-item is-unresolved');
  }
}

export class OutlinePanel extends ActiveFilePanel {
  constructor(app) {
    super(app);
    app.on('editor-change', this.renderSoon);
  }
  get id() {
    return 'outline';
  }
  get title() {
    return 'Sumário';
  }
  get icon() {
    return 'list-tree';
  }
  render() {
    if (this.containerEl.classList.contains('is-hidden')) return;
    this.containerEl.textContent = '';
    const file = this.file;
    const view = this.app.workspace.activeLeaf?.view;
    const cache = file ? this.app.metadata.getCache(file) : null;
    if (!cache || !cache.headings.length) {
      this.containerEl.appendChild(el('div', { class: 'pane-empty', text: file ? 'Nenhum título nesta nota.' : 'Nenhuma nota ativa.' }));
      return;
    }
    const minLevel = Math.min(...cache.headings.map((h) => h.level));
    for (const h of cache.headings) {
      const row = el('div', { class: 'tree-item-self outline-item', style: `padding-left: ${8 + (h.level - minLevel) * 14}px`, text: h.heading });
      row.addEventListener('click', () => {
        view?.scrollToLine?.(h.position.start.line);
        view?.focus?.();
      });
      this.containerEl.appendChild(row);
    }
  }
}
