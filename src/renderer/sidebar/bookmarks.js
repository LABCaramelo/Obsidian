import { Panel } from './sidebar.js';
import { el, extname } from '../core/util.js';
import { bookmarkTitle } from '../core/bookmarks.js';
import { icon } from '../ui/icons.js';
import { Menu } from '../ui/menu.js';
import { promptText, confirmAction } from '../ui/modal.js';
import { notice } from '../ui/notice.js';

const DRAG_TYPE = 'application/x-basalto-bookmark';
const FILE_DRAG = 'application/x-basalto-path';

export class BookmarksPanel extends Panel {
  constructor(app) {
    super(app);
    this.store = app.bookmarks;
    this.containerEl.classList.add('bookmarks-panel');
    const button = (name, title, fn) => {
      const btn = el('button', { class: 'clickable-icon', title, 'aria-label': title }, icon(name, 16));
      btn.addEventListener('click', fn);
      return btn;
    };
    this.treeEl = el('div', { class: 'bookmarks-tree', 'aria-label': 'Favoritos' });
    this.containerEl.append(el('div', { class: 'nav-header' },
      button('bookmark-plus', 'Favoritar arquivo atual', () => app.commands.run('bookmarks:add-active')),
      button('folder-plus', 'Novo grupo de favoritos', () => this.addGroup()),
      button('search', 'Salvar busca atual', () => app.commands.run('bookmarks:add-search')),
    ), this.treeEl);
    this.store.on('change', () => this.render());
    app.workspace.on('active-leaf-change', () => this.highlight());
    app.workspace.on('file-open', () => this.highlight());
    for (const event of ['create', 'delete', 'rename']) app.vault.on(event, () => this.render());
    this.bindDrop(this.treeEl, null);
    this.treeEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.bookmark-row')) return;
      new Menu().addItem({ title: 'Novo grupo', icon: 'folder-plus', onClick: () => this.addGroup() }).showAtMouseEvent(e);
    });
    this.render();
  }

  get id() { return 'bookmarks'; }
  get title() { return 'Favoritos'; }
  get icon() { return 'bookmark'; }

  render() {
    const focusedId = this.treeEl.querySelector('.bookmark-row:focus')?.dataset.id;
    this.treeEl.textContent = '';
    if (!this.store.items.length) this.treeEl.append(el('div', { class: 'pane-empty', text: 'Guarde notas, pastas e buscas aqui. Arraste arquivos do explorador ou use o menu de contexto.' }));
    for (const item of this.store.items) this.treeEl.append(this.renderItem(item, null));
    this.highlight();
    if (focusedId) [...this.treeEl.querySelectorAll('.bookmark-row')].find((row) => row.dataset.id === focusedId)?.focus();
  }

  renderItem(item, parentId) {
    const group = item.type === 'group';
    const exists = group || item.type === 'search' || this.app.vault.exists(item.path);
    const name = group ? (item.collapsed ? 'chevron-right' : 'chevron-down') : item.type === 'search' ? 'search' : item.type === 'folder' ? 'folder' : extname(item.path) === 'canvas' ? 'canvas' : 'file-text';
    const row = el('div', { class: `tree-item-self bookmark-row${exists ? '' : ' is-missing'}`, tabindex: '0', draggable: 'true', 'data-id': item.id, 'data-path': item.path || '', title: item.path ? `${item.path}${item.subpath || ''}${exists ? '' : ' (arquivo ausente)'}` : bookmarkTitle(item) },
      el('span', { class: 'tree-item-icon' }, icon(name, 14)), el('span', { class: 'tree-item-inner', text: bookmarkTitle(item) }));
    if (group) row.setAttribute('aria-expanded', String(!item.collapsed));
    const open = (e) => group ? this.store.toggleGroup(item.id) : this.openItem(item, e.ctrlKey || e.metaKey || e.button === 1);
    row.addEventListener('click', open);
    row.addEventListener('auxclick', (e) => { if (e.button === 1 && !group) { e.preventDefault(); open(e); } });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
      if (e.key === 'F2') { e.preventDefault(); this.rename(item); }
      if (e.key === 'Delete') { e.preventDefault(); this.remove(item); }
    });
    row.addEventListener('contextmenu', (e) => { e.stopPropagation(); this.showMenu(e, item, parentId); });
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.setData(DRAG_TYPE, item.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    this.bindDrop(row, group ? item.id : parentId, group ? null : item.id);
    const wrapper = el('div', { class: 'bookmark-item' }, row);
    if (group && !item.collapsed) {
      const children = el('div', { class: 'tree-item-children bookmark-children' });
      for (const child of item.items) children.append(this.renderItem(child, item.id));
      if (!item.items.length) children.append(el('div', { class: 'pane-empty', text: 'Arraste favoritos para este grupo.' }));
      this.bindDrop(children, item.id);
      wrapper.append(children);
    }
    return wrapper;
  }

  highlight() {
    const active = this.app.workspace.getActiveFile();
    for (const row of this.treeEl.querySelectorAll('.bookmark-row')) row.classList.toggle('is-active', !!active && row.dataset.path === active);
  }

  async openItem(item, newLeaf = false) {
    try {
      if (item.type === 'search') {
        this.app.searchPanel.matchCase = !!item.matchCase;
        this.app.searchPanel.caseBtn.classList.toggle('is-active', !!item.matchCase);
        this.app.openSearch(item.query);
      } else if (!this.app.vault.exists(item.path)) notice(`Arquivo ou pasta não encontrado: ${item.path}`);
      else if (item.type === 'folder') {
        this.app.leftSidebar.show('file-explorer');
        let path = '';
        for (const part of item.path.split('/')) { path = path ? `${path}/${part}` : part; this.app.explorer.expanded.add(path); }
        this.app.explorer.render();
        this.app.workspace.requestSave();
      } else await this.app.openFile(item.path, { newLeaf, subpath: item.subpath });
    } catch (err) { notice(err.message || String(err)); }
  }

  async addGroup(parentId = null) {
    const title = await promptText({ title: 'Novo grupo de favoritos', value: 'Novo grupo' });
    if (title?.trim()) this.store.add({ type: 'group', title }, parentId);
  }

  async rename(item) {
    const title = await promptText({ title: 'Nome do favorito', value: bookmarkTitle(item) });
    if (title?.trim()) this.store.rename(item.id, title);
  }

  async remove(item) {
    if (item.type === 'group' && item.items.length && !await confirmAction({ title: 'Remover grupo de favoritos', message: `Remover “${bookmarkTitle(item)}” e seus favoritos? Os arquivos permanecem no cofre.`, confirmText: 'Remover' })) return;
    this.store.remove(item.id);
  }

  showMenu(e, item, parentId) {
    const menu = new Menu();
    if (item.type !== 'group') {
      menu.addItem({ title: 'Abrir', icon: 'external-link', onClick: () => this.openItem(item) });
      if (item.type === 'file') menu.addItem({ title: 'Abrir em nova aba', icon: 'file-symlink', onClick: () => this.openItem(item, true) });
    } else menu.addItem({ title: 'Novo grupo', icon: 'folder-plus', onClick: () => this.addGroup(item.id) });
    menu.addItem({ title: 'Renomear favorito…', icon: 'edit', onClick: () => this.rename(item) });
    const siblings = parentId ? this.store.find(parentId).items : this.store.items;
    const index = siblings.indexOf(item);
    if (index > 0) menu.addItem({ title: 'Mover para cima', onClick: () => this.store.move(item.id, parentId, siblings[index - 1].id) });
    if (index < siblings.length - 1) menu.addItem({ title: 'Mover para baixo', onClick: () => this.store.move(item.id, parentId, siblings[index + 2]?.id || null) });
    if (parentId) menu.addItem({ title: 'Mover para a raiz', onClick: () => this.store.move(item.id) });
    menu.addSeparator();
    menu.addItem({ title: 'Remover dos favoritos', icon: 'bookmark-minus', onClick: () => this.remove(item) });
    menu.showAtMouseEvent(e);
  }

  bindDrop(element, groupId, beforeId = null) {
    const accepts = (e) => [...e.dataTransfer.types].some((type) => type === DRAG_TYPE || type === FILE_DRAG);
    element.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TYPE) ? 'move' : 'copy';
      element.classList.add('is-drop-target');
    });
    element.addEventListener('dragleave', (e) => { if (!element.contains(e.relatedTarget)) element.classList.remove('is-drop-target'); });
    element.addEventListener('drop', (e) => {
      if (!accepts(e)) return;
      e.preventDefault(); e.stopPropagation();
      element.classList.remove('is-drop-target');
      const itemId = e.dataTransfer.getData(DRAG_TYPE);
      if (itemId) this.store.move(itemId, groupId, beforeId);
      else {
        const path = e.dataTransfer.getData(FILE_DRAG);
        if (!this.app.vault.exists(path) || !path) return;
        const item = this.store.add({ type: this.app.vault.getFolder(path) ? 'folder' : 'file', path }, groupId);
        if (beforeId) this.store.move(item.id, groupId, beforeId);
      }
    });
  }
}
