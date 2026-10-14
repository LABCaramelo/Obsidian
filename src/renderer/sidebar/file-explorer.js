import { Panel } from './sidebar.js';
import { el, debounce, basename, dirname, stem, joinPath, isMarkdown, IMAGE_EXT, extname } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { Menu } from '../ui/menu.js';

const DRAG_TYPE = 'application/x-basalto-path';

export class FileExplorer extends Panel {
  constructor(app) {
    super(app);
    this.expanded = new Set();
    this.sortOrder = 'alphabetical'; // alphabetical | alphabeticalReverse | byModifiedTime | byCreatedTime
    this.containerEl.classList.add('file-explorer');

    const button = (name, label, onClick) => {
      const b = el('button', { class: 'clickable-icon', 'aria-label': label, title: label }, icon(name));
      b.addEventListener('click', onClick);
      return b;
    };
    this.headerEl = el(
      'div',
      { class: 'nav-header' },
      button('file-plus', 'Nova nota', () => this.app.createNewNote(this.targetFolder())),
      button('folder-plus', 'Nova pasta', () => this.app.createNewFolder(this.targetFolder())),
      button('sort', 'Alterar ordenação', (e) => this.showSortMenu(e)),
      button('chevrons-down-up', 'Recolher tudo', () => {
        this.expanded.clear();
        this.render();
        this.app.workspace.requestSave();
      }),
    );
    this.treeEl = el('div', { class: 'nav-files-container' });
    this.containerEl.append(this.headerEl, this.treeEl);

    // Dropping on the empty area moves to the vault root.
    this.treeEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
    });
    this.treeEl.addEventListener('drop', (e) => {
      if (e.target === this.treeEl) this.onDrop(e, '');
    });
    this.treeEl.addEventListener('contextmenu', (e) => {
      if (e.target !== this.treeEl) return;
      const menu = new Menu();
      menu.addItem({ title: 'Nova nota', icon: 'file-plus', onClick: () => this.app.createNewNote('') });
      menu.addItem({ title: 'Nova pasta', icon: 'folder-plus', onClick: () => this.app.createNewFolder('') });
      menu.addItem({ title: 'Novo canvas', icon: 'canvas', onClick: () => this.app.createNewCanvas('') });
      menu.showAtMouseEvent(e);
    });

    this.renderSoon = debounce(() => this.render(), 50);
    for (const evt of ['create', 'delete', 'rename']) app.vault.on(evt, () => this.renderSoon());
    app.vault.on('modify', () => {
      if (this.sortOrder !== 'alphabetical' && this.sortOrder !== 'alphabeticalReverse') this.renderSoon();
    });
    app.workspace.on('active-leaf-change', () => this.revealActive());
    app.workspace.on('file-open', () => this.revealActive());
  }

  get id() {
    return 'file-explorer';
  }
  get title() {
    return 'Arquivos';
  }
  get icon() {
    return 'folder';
  }

  targetFolder() {
    const active = this.app.workspace.getActiveFile();
    return this.app.settings.get('newFileLocation') === 'current' && active ? dirname(active) : '';
  }

  sortEntries(entries) {
    const cmp = {
      alphabetical: (a, b) => basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true, sensitivity: 'base' }),
      alphabeticalReverse: (a, b) => basename(b.path).localeCompare(basename(a.path), undefined, { numeric: true, sensitivity: 'base' }),
      byModifiedTime: (a, b) => (b.mtime || 0) - (a.mtime || 0),
      byCreatedTime: (a, b) => (b.ctime || 0) - (a.ctime || 0),
    }[this.sortOrder];
    const folders = entries.filter((e) => e.type === 'folder').sort((a, b) => basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true }));
    const files = entries.filter((e) => e.type === 'file').sort(cmp);
    return [...folders, ...files];
  }

  render() {
    const scroll = this.treeEl.scrollTop;
    this.treeEl.textContent = '';
    this.treeEl.appendChild(this.renderChildren(''));
    this.treeEl.scrollTop = scroll;
    this.highlightActive();
  }

  renderChildren(folder) {
    const frag = document.createDocumentFragment();
    for (const entry of this.sortEntries(this.app.vault.getChildren(folder))) {
      frag.appendChild(entry.type === 'folder' ? this.renderFolder(entry) : this.renderFile(entry));
    }
    return frag;
  }

  renderFolder(entry) {
    const open = this.expanded.has(entry.path);
    const self = el(
      'div',
      { class: 'nav-folder-title tree-item-self', draggable: 'true', 'data-path': entry.path },
      el('span', { class: 'tree-item-icon collapse-icon' }, icon(open ? 'chevron-down' : 'chevron-right', 14)),
      el('span', { class: 'tree-item-inner', text: basename(entry.path) }),
    );
    const children = el('div', { class: 'nav-folder-children' });
    if (open) children.appendChild(this.renderChildren(entry.path));
    const wrapper = el('div', { class: `nav-folder${open ? '' : ' is-collapsed'}` }, self, children);

    self.addEventListener('click', () => {
      if (this.expanded.has(entry.path)) this.expanded.delete(entry.path);
      else this.expanded.add(entry.path);
      this.render();
      this.app.workspace.requestSave();
    });
    self.addEventListener('contextmenu', (e) => this.showFolderMenu(e, entry.path));
    this.bindDrag(self, entry.path);
    self.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      self.classList.add('is-drop-target');
    });
    self.addEventListener('dragleave', () => self.classList.remove('is-drop-target'));
    self.addEventListener('drop', (e) => {
      self.classList.remove('is-drop-target');
      this.onDrop(e, entry.path);
    });
    return wrapper;
  }

  renderFile(entry) {
    const ext = extname(entry.path);
    const name = isMarkdown(entry.path) || ext === 'canvas' ? stem(entry.path) : basename(entry.path);
    const self = el(
      'div',
      { class: 'nav-file-title tree-item-self', draggable: 'true', 'data-path': entry.path },
      el('span', { class: 'tree-item-inner', text: name }),
      !isMarkdown(entry.path) && ext ? el('span', { class: 'nav-file-tag', text: ext }) : null,
    );
    self.addEventListener('click', (e) => this.app.openFile(entry.path, { newLeaf: e.ctrlKey || e.metaKey }));
    self.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.app.openFile(entry.path, { newLeaf: true });
    });
    self.addEventListener('contextmenu', (e) => this.showFileMenu(e, entry.path));
    this.bindDrag(self, entry.path);
    return el('div', { class: 'nav-file' }, self);
  }

  bindDrag(node, path) {
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DRAG_TYPE, path);
      // Dropping a note into the editor inserts a link to it.
      const linktext = this.app.metadata.fileToLinktext(path, this.app.workspace.getActiveFile() || '');
      const isImage = IMAGE_EXT.has(extname(path));
      e.dataTransfer.setData('text/plain', `${isImage ? '!' : ''}[[${linktext}]]`);
      e.dataTransfer.effectAllowed = 'copyMove';
    });
  }

  async onDrop(e, folder) {
    const path = e.dataTransfer.getData(DRAG_TYPE);
    if (!path) return;
    e.preventDefault();
    if (dirname(path) === folder || folder === path || folder.startsWith(`${path}/`)) return;
    await this.app.renameFile(path, joinPath(folder, basename(path)));
    if (folder) this.expanded.add(folder);
  }

  showFileMenu(e, path) {
    const menu = new Menu();
    menu.addItem({ title: 'Abrir em nova aba', icon: 'file-symlink', onClick: () => this.app.openFile(path, { newLeaf: true }) });
    menu.addItem({ title: 'Abrir à direita', icon: 'columns', onClick: () => this.app.openFile(path, { split: true }) });
    menu.addSeparator();
    menu.addItem({ title: 'Renomear…', icon: 'edit', onClick: () => this.app.promptRename(path) });
    menu.addItem({ title: 'Duplicar', icon: 'copy', onClick: () => this.app.duplicateFile(path) });
    menu.addItem({ title: 'Copiar caminho', icon: 'link', onClick: () => navigator.clipboard.writeText(path) });
    this.app.addBookmarkMenuItem(menu, path);
    menu.addSeparator();
    menu.addItem({ title: 'Abrir no aplicativo padrão', icon: 'external-link', onClick: () => window.basalto.shell.openPath(path) });
    menu.addItem({ title: 'Mostrar no explorador do sistema', icon: 'folder-open', onClick: () => window.basalto.shell.reveal(path) });
    menu.addSeparator();
    menu.addItem({ title: 'Excluir', icon: 'trash', danger: true, onClick: () => this.app.deleteFile(path) });
    menu.showAtMouseEvent(e);
  }

  showFolderMenu(e, path) {
    const menu = new Menu();
    menu.addItem({ title: 'Nova nota', icon: 'file-plus', onClick: () => this.app.createNewNote(path) });
    menu.addItem({ title: 'Nova pasta', icon: 'folder-plus', onClick: () => this.app.createNewFolder(path) });
    menu.addItem({ title: 'Novo canvas', icon: 'canvas', onClick: () => this.app.createNewCanvas(path) });
    menu.addSeparator();
    menu.addItem({ title: 'Renomear…', icon: 'edit', onClick: () => this.app.promptRename(path) });
    menu.addItem({ title: 'Buscar na pasta', icon: 'search', onClick: () => this.app.openSearch(`path:"${path}"`) });
    this.app.addBookmarkMenuItem(menu, path);
    menu.addItem({ title: 'Mostrar no explorador do sistema', icon: 'folder-open', onClick: () => window.basalto.shell.reveal(path) });
    menu.addSeparator();
    menu.addItem({ title: 'Excluir', icon: 'trash', danger: true, onClick: () => this.app.deleteFile(path) });
    menu.showAtMouseEvent(e);
  }

  showSortMenu(e) {
    const menu = new Menu();
    const opt = (title, order) =>
      menu.addItem({
        title: `${this.sortOrder === order ? '✓ ' : ''}${title}`,
        onClick: () => {
          this.sortOrder = order;
          this.render();
          this.app.workspace.requestSave();
        },
      });
    opt('Nome (A a Z)', 'alphabetical');
    opt('Nome (Z a A)', 'alphabeticalReverse');
    opt('Data de modificação (mais recente)', 'byModifiedTime');
    opt('Data de criação (mais recente)', 'byCreatedTime');
    menu.showAtMouseEvent(e);
  }

  revealActive() {
    const active = this.app.workspace.getActiveFile();
    if (!active) return this.highlightActive();
    let dir = dirname(active);
    let changed = false;
    while (dir) {
      if (!this.expanded.has(dir)) {
        this.expanded.add(dir);
        changed = true;
      }
      dir = dirname(dir);
    }
    if (changed) this.render();
    else this.highlightActive();
  }

  highlightActive() {
    const active = this.app.workspace.getActiveFile();
    for (const node of this.treeEl.querySelectorAll('.tree-item-self.is-active')) node.classList.remove('is-active');
    if (!active) return;
    const node = this.treeEl.querySelector(`.nav-file-title[data-path="${CSS.escape(active)}"]`);
    if (node) {
      node.classList.add('is-active');
      node.scrollIntoView({ block: 'nearest' });
    }
  }

  serialize() {
    return { expanded: [...this.expanded], sortOrder: this.sortOrder };
  }

  restore(data) {
    if (data?.expanded) this.expanded = new Set(data.expanded);
    if (data?.sortOrder) this.sortOrder = data.sortOrder;
    this.render();
  }

  onShow() {
    this.highlightActive();
  }
}
