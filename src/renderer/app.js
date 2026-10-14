import './styles/app.css';
import './styles/canvas.css';
import './styles/bookmarks.css';
import './styles/hotkeys.css';
import 'katex/dist/katex.min.css';

import { Vault } from './core/vault.js';
import { MetadataCache } from './core/metadata.js';
import { createMarkdown } from './core/markdown.js';
import { ConfigFile, DEFAULT_SETTINGS, DEFAULT_GRAPH_SETTINGS } from './core/settings.js';
import { Commands } from './core/commands.js';
import { Bookmarks } from './core/bookmarks.js';
import { parseLinktext } from './core/parse.js';
import {
  Events, el, debounce, basename, dirname, stem, extname, joinPath, isMarkdown, sanitizeFileName,
  formatDate, countWords, IMAGE_EXT, AUDIO_EXT, VIDEO_EXT,
} from './core/util.js';
import { Workspace } from './workspace/workspace.js';
import { MarkdownView } from './views/markdown-view.js';
import { GraphView } from './views/graph-view.js';
import { EmptyView } from './views/empty-view.js';
import { FileView } from './views/file-view.js';
import { CanvasView } from './views/canvas-view.js';
import { parseCanvas, serializeCanvas, remapFilePaths } from './core/canvas.js';
import { renderInto, renderNoteEmbed } from './views/reading.js';
import { Sidebar } from './sidebar/sidebar.js';
import { FileExplorer } from './sidebar/file-explorer.js';
import { SearchPanel } from './sidebar/search.js';
import { BookmarksPanel } from './sidebar/bookmarks.js';
import { TagsPanel, BacklinksPanel, OutgoingLinksPanel, OutlinePanel } from './sidebar/info-panels.js';
import { QuickSwitcher, CommandPalette, FilePicker, SettingsModal } from './ui/modals.js';
import { promptText, confirmAction } from './ui/modal.js';
import { notice } from './ui/notice.js';
import { icon } from './ui/icons.js';

class App extends Events {
  async start() {
    this.appInfo = await window.basalto.app.info();
    document.body.classList.add(`platform-${this.appInfo.platform}`);

    this.vault = new Vault();
    await this.vault.load();
    this.settings = new ConfigFile('app.json', DEFAULT_SETTINGS);
    this.graphSettings = new ConfigFile('graph.json', DEFAULT_GRAPH_SETTINGS);
    this.hotkeys = new ConfigFile('hotkeys.json', {});
    this.bookmarks = new Bookmarks(window.basalto.vault);
    this.bookmarks.on('save-error', (err) => notice(`Não foi possível salvar os favoritos: ${err.message || err}`));
    await Promise.all([this.settings.load(), this.graphSettings.load(), this.hotkeys.load(), this.bookmarks.load()]);
    const layout = (await window.basalto.vault.readConfig('workspace.json')) || {};
    this.recentFiles = layout.lastOpenFiles || [];

    this.metadata = new MetadataCache(this.vault);
    this.metadata.init();
    this.markdown = createMarkdown();
    this.markdown.md.set({ breaks: !this.settings.get('strictLineBreaks') });
    this.commands = new Commands();
    this.commands.setConfig(this.hotkeys);

    this.buildLayout();
    this.applyAppearance();
    this.registerViews();
    this.registerCommands();
    this.wireVaultEvents();
    this.wireSettings();

    await this.workspace.restore(layout.main);
    this.leftSidebar.restore(layout.left || { active: 'file-explorer' });
    this.rightSidebar.restore(layout.right || { active: 'backlinks' });
    this.explorer.restore(layout.explorer);
    this.updateWindowTitle();
    this.updateStatusBar();

    window.basalto.window.onMenuCommand((id) => { if (!this.commands.isCapturing) this.commands.run(id); });
    window.addEventListener('blur', () => this.flushSaves().catch(console.error));
    window.basalto.window.onBeforeClose(async () => {
      document.body.inert = true;
      try { await this.flushSaves(); }
      catch (err) { document.body.inert = false; throw err; }
    });
    document.body.classList.remove('is-loading');
  }

  // --- layout -------------------------------------------------------------------------

  buildLayout() {
    document.body.textContent = '';
    const ribbonButton = (name, label, onClick) => {
      const b = el('button', { class: 'clickable-icon ribbon-button', 'aria-label': label, title: label }, icon(name, 18));
      b.addEventListener('click', onClick);
      return b;
    };
    const ribbon = el(
      'div',
      { class: 'ribbon' },
      el(
        'div',
        { class: 'ribbon-top' },
        ribbonButton('panel-left', 'Alternar barra lateral esquerda', () => this.leftSidebar.toggle()),
        ribbonButton('file-plus', 'Nova nota', () => this.commands.run('file:new-note')),
        ribbonButton('search', 'Troca rápida', () => this.commands.run('switcher:open')),
        ribbonButton('graph', 'Visualização em grafo', () => this.commands.run('graph:open')),
        ribbonButton('canvas', 'Criar novo canvas', () => this.commands.run('canvas:new')),
        ribbonButton('calendar', 'Nota diária de hoje', () => this.commands.run('daily-notes:open')),
        ribbonButton('dice', 'Nota aleatória', () => this.commands.run('file:open-random')),
        ribbonButton('terminal', 'Paleta de comandos', () => this.commands.run('command-palette:open')),
      ),
      el(
        'div',
        { class: 'ribbon-bottom' },
        ribbonButton('vault', 'Abrir outro cofre', () => window.basalto.vaults.starter()),
        ribbonButton('settings', 'Configurações', () => this.commands.run('app:open-settings')),
      ),
    );

    this.workspace = new Workspace(this, el('div', { class: 'main-split' }));
    this.leftSidebar = new Sidebar(this, 'left');
    this.rightSidebar = new Sidebar(this, 'right');

    this.explorer = new FileExplorer(this);
    this.searchPanel = new SearchPanel(this);
    this.leftSidebar.addPanel(this.explorer);
    this.leftSidebar.addPanel(this.searchPanel);
    this.bookmarksPanel = new BookmarksPanel(this);
    this.leftSidebar.addPanel(this.bookmarksPanel);
    this.leftSidebar.addPanel(new TagsPanel(this));
    this.rightSidebar.addPanel(new BacklinksPanel(this));
    this.rightSidebar.addPanel(new OutgoingLinksPanel(this));
    this.rightSidebar.addPanel(new OutlinePanel(this));

    const vaultName = el('div', { class: 'vault-name', title: this.vault.info.path, text: this.vault.name });
    vaultName.addEventListener('click', () => window.basalto.vaults.starter());
    this.leftSidebar.el.appendChild(vaultName);

    this.statusLeftEl = el('div', { class: 'status-bar-item status-backlinks' });
    this.statusWordsEl = el('div', { class: 'status-bar-item status-words' });
    this.statusModeEl = el('div', { class: 'status-bar-item status-mode clickable' });
    this.statusModeEl.addEventListener('click', () => this.commands.run('editor:toggle-mode'));
    const rightToggle = el('div', { class: 'status-bar-item clickable', title: 'Alternar barra lateral direita' }, icon('panel-right', 14));
    rightToggle.addEventListener('click', () => this.rightSidebar.toggle());
    const statusBar = el('div', { class: 'status-bar' }, this.statusLeftEl, this.statusWordsEl, this.statusModeEl, rightToggle);

    const root = el(
      'div',
      { class: 'app-container' },
      el(
        'div',
        { class: 'horizontal-main-container' },
        ribbon,
        this.leftSidebar.el,
        this.leftSidebar.handleEl,
        el('div', { class: 'workspace-main' }, this.workspace.containerEl),
        this.rightSidebar.handleEl,
        this.rightSidebar.el,
      ),
      statusBar,
    );
    document.body.appendChild(root);
  }

  registerViews() {
    this.workspace.registerView('markdown', (leaf) => new MarkdownView(leaf));
    this.workspace.registerView('graph', (leaf) => new GraphView(leaf));
    this.workspace.registerView('file', (leaf) => new FileView(leaf));
    this.workspace.registerView('canvas', (leaf) => new CanvasView(leaf));
    this.workspace.registerView('empty', (leaf) => new EmptyView(leaf));
    this.workspace.on('active-leaf-change', () => {
      this.updateWindowTitle();
      this.updateStatusBar();
    });
    this.workspace.on('file-open', (file) => {
      if (file) this.pushRecent(file);
      this.updateWindowTitle();
      this.updateStatusBar();
    });
    this.on('editor-change', debounce(() => this.updateStatusBar(), 200));
    this.on('editor-cursor', debounce(() => this.updateStatusBar(), 100));
    this.on('view-mode-change', () => this.updateStatusBar());
    this.metadata.on('resolved', debounce(() => this.updateStatusBar(), 300));
  }

  // --- appearance & settings ----------------------------------------------------------------

  applyAppearance() {
    const s = this.settings.data;
    const body = document.body;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const dark = s.theme === 'system' ? media.matches : s.theme !== 'light';
    body.classList.toggle('theme-dark', dark);
    body.classList.toggle('theme-light', !dark);
    body.classList.toggle('readable-line-length', !!s.readableLineLength);
    body.style.setProperty('--interactive-accent', s.accentColor);
    body.style.setProperty('--font-text-size', `${s.fontSize}px`);
    if (!this._mediaBound) {
      this._mediaBound = true;
      media.addEventListener('change', () => this.settings.get('theme') === 'system' && this.applyAppearance());
    }
    this.emit('theme-change');
  }

  wireSettings() {
    this.settings.on('change', (patch) => {
      this.applyAppearance();
      if ('strictLineBreaks' in patch) this.markdown.md.set({ breaks: !this.settings.get('strictLineBreaks') });
      const views = this.markdownViews();
      if (['livePreview', 'showLineNumbers', 'vimMode', 'spellcheck', 'foldHeadings'].some((k) => k in patch)) {
        for (const v of views) v.editor?.reconfigure(this.settings.data);
      }
      for (const v of views) v.renderPreviewSoon();
    });
  }

  // --- vault events → views --------------------------------------------------------------------

  markdownViews() {
    return this.workspace.getLeavesOfType('markdown').map((l) => l.view);
  }

  canvasViews() {
    return this.workspace.getLeavesOfType('canvas').map((l) => l.view);
  }

  wireVaultEvents() {
    this.vault.on('modify', (file) => {
      const text = this.vault.cachedRead(file.path);
      for (const view of this.markdownViews()) {
        if (view.file === file.path && view.text !== text) view.onFileModified(text);
      }
    });
    this.vault.on('rename', (file, oldPath) => {
      this.bookmarks.remapPath(oldPath, file.path);
      for (const leaf of this.workspace.getLeaves()) {
        if (leaf.view?.file === oldPath) leaf.view.onFileRenamed(file.path);
      }
      this.recentFiles = this.recentFiles.map((p) => (p === oldPath ? file.path : p));
      this.updateWindowTitle();
    });
    this.vault.on('delete', (file) => {
      for (const leaf of this.workspace.getLeaves()) {
        if (leaf.view?.file === file.path) {
          leaf.view.dirty = false;
          leaf.setViewState({ type: 'empty', state: {} }, { history: false });
        }
      }
      this.recentFiles = this.recentFiles.filter((p) => p !== file.path);
    });
    // Link targets appearing/disappearing changes how links render.
    const refresh = debounce(() => this.markdownViews().forEach((v) => v.refresh()), 300);
    this.vault.on('create', refresh);
    this.vault.on('delete', refresh);
    this.vault.on('rename', refresh);
  }

  async flushSaves() {
    await Promise.all([...this.markdownViews(), ...this.canvasViews()].map((view) => view.saveNow()));
    await Promise.all([this.saveWorkspace(), this.settings.save(), this.graphSettings.save(), this.hotkeys.save(), this.bookmarks.flush()]);
  }

  saveWorkspace() {
    if (!this.workspace?.ready) return;
    return window.basalto.vault.writeConfig('workspace.json', {
      main: this.workspace.serialize(),
      left: this.leftSidebar.serialize(),
      right: this.rightSidebar.serialize(),
      explorer: this.explorer.serialize(),
      lastOpenFiles: this.recentFiles.slice(0, 20),
    });
  }

  pushRecent(path) {
    this.recentFiles = [path, ...this.recentFiles.filter((p) => p !== path)].slice(0, 20);
  }

  addBookmarkMenuItem(menu, path) {
    if (!path) return;
    const type = this.vault.getFolder(path) ? 'folder' : 'file';
    const existing = this.bookmarks.findTarget({ type, path });
    menu.addItem({
      title: existing ? 'Remover dos favoritos' : 'Adicionar aos favoritos',
      icon: existing ? 'bookmark-minus' : 'bookmark-plus',
      onClick: () => {
        if (existing) this.bookmarks.remove(existing.id);
        else { this.bookmarks.add({ type, path }); this.leftSidebar.show('bookmarks'); }
      },
    });
  }

  addActiveBookmark() {
    const path = this.workspace.getActiveFile();
    if (!path) return;
    this.bookmarks.add({ type: 'file', path });
    this.leftSidebar.show('bookmarks');
  }

  async bookmarkSearch() {
    const query = this.searchPanel.inputEl.value.trim();
    if (!query) { notice('Faça uma busca antes de salvá-la nos favoritos.'); return; }
    const title = await promptText({ title: 'Salvar busca nos favoritos', value: query });
    if (!title?.trim()) return;
    this.bookmarks.add({ type: 'search', query, title, matchCase: this.searchPanel.matchCase });
    this.leftSidebar.show('bookmarks');
  }

  updateWindowTitle() {
    const file = this.workspace.getActiveFile();
    const title = file ? `${isMarkdown(file) ? stem(file) : basename(file)} - ${this.vault.name} - Basalto` : `${this.vault.name} - Basalto`;
    document.title = title;
    window.basalto.window.setTitle(title);
  }

  updateStatusBar() {
    const view = this.workspace.activeLeaf?.view;
    if (view?.type === 'markdown' && view.file) {
      const sel = view.editor?.view?.state?.selection?.main;
      if (sel && !sel.empty) {
        const selectedText = view.editor.view.state.sliceDoc(sel.from, sel.to);
        const { words, chars } = countWords(selectedText);
        this.statusWordsEl.textContent = `${words.toLocaleString('pt-BR')} ${words === 1 ? 'palavra selecionada' : 'palavras selecionadas'}  ${chars.toLocaleString('pt-BR')} ${chars === 1 ? 'caractere' : 'caracteres'}`;
      } else {
        const { words, chars } = countWords(view.text || '');
        this.statusWordsEl.textContent = `${words.toLocaleString('pt-BR')} palavras  ${chars.toLocaleString('pt-BR')} caracteres`;
      }
      const backlinks = this.metadata.getBacklinks(view.file).length;
      this.statusLeftEl.textContent = `${backlinks} backlink${backlinks === 1 ? '' : 's'}`;
      this.statusModeEl.textContent = view.mode === 'preview' ? 'Leitura' : this.settings.get('livePreview') ? 'Live preview' : 'Código-fonte';
    } else if (view?.type === 'canvas' && view.file) {
      const nodes = view.data?.nodes?.length || 0;
      const edges = view.data?.edges?.length || 0;
      const selCount = view.selection?.size || 0;
      const selNote = selCount > 0 ? ` (${selCount} selecionado${selCount === 1 ? '' : 's'})` : '';
      this.statusWordsEl.textContent = `${nodes} cartão${nodes === 1 ? '' : 'ões'}  ${edges} conexão${edges === 1 ? '' : 'ões'}${selNote}`;
      this.statusLeftEl.textContent = `Zoom ${Math.round((view.viewport?.zoom || 1) * 100)}%`;
      this.statusModeEl.textContent = 'Canvas';
    } else {
      this.statusWordsEl.textContent = '';
      this.statusLeftEl.textContent = '';
      this.statusModeEl.textContent = '';
    }
  }

  // --- opening things ----------------------------------------------------------------------------

  async openFile(path, { newLeaf = false, split = false, mode, line, subpath } = {}) {
    const type = isMarkdown(path) ? 'markdown' : extname(path) === 'canvas' ? 'canvas' : 'file';
    const active = this.workspace.activeLeaf;
    let leaf;
    if (split) leaf = await this.workspace.splitLeaf(active);
    else if (!newLeaf && active?.view?.file === path) leaf = active;
    else leaf = await this.workspace.getLeaf(newLeaf);
    const state = { file: path };
    if (mode) state.mode = mode;
    if (line != null) state.line = line;
    if (subpath) state.subpath = subpath;
    await leaf.setViewState({ type, state });
    this.workspace.setActiveLeaf(leaf);
    return leaf;
  }

  /** Follows a link as written in a note: [[Nota#Título]], caminho/relativo.md, URL… */
  async openLinkText(href, sourcePath = '', newLeaf = false) {
    if (!href) return;
    if (/^(https?|mailto):/i.test(href)) return window.basalto.shell.openExternal(href);
    const { path, subpath } = parseLinktext(href);
    if (!path) {
      const view = this.workspace.activeLeaf?.view;
      if (view?.type === 'markdown') view.scrollToSubpath(subpath);
      return;
    }
    const dest = this.metadata.getFirstLinkpathDest(path, sourcePath);
    if (dest) return this.openFile(dest.path, { newLeaf, subpath });
    // Clicking an unresolved link creates the note.
    const name = extname(path) ? path : `${path}.md`;
    const folder = path.includes('/') ? '' : this.newNoteFolder(sourcePath);
    const target = joinPath(folder, name);
    const file = await this.vault.create(target, '');
    return this.openFile(file.path, { newLeaf, mode: 'source' });
  }

  openSearch(query) {
    this.leftSidebar.show('search');
    this.searchPanel.setQuery(query);
  }

  async openGraph() {
    const existing = this.workspace.getLeavesOfType('graph')[0];
    if (existing) return this.workspace.setActiveLeaf(existing);
    const leaf = await this.workspace.getLeaf(this.workspace.activeLeaf?.view?.type !== 'empty');
    await leaf.setViewState({ type: 'graph', state: {} });
    this.workspace.setActiveLeaf(leaf);
  }

  linkSuggestions(_query, sourcePath) {
    return this.metadata.getLinkSuggestions().map(({ file, alias }) => ({
      linktext: this.metadata.fileToLinktext(file, sourcePath),
      alias,
      folder: dirname(file),
    }));
  }

  // --- creating, renaming, deleting --------------------------------------------------------------

  newNoteFolder(sourcePath) {
    const s = this.settings.data;
    if (s.newFileLocation === 'current') return dirname(sourcePath || this.workspace.getActiveFile() || '');
    if (s.newFileLocation === 'folder') return s.newFileFolder || '';
    return '';
  }

  async createNewNote(folder) {
    const target = folder ?? this.newNoteFolder();
    if (target && !this.vault.exists(target)) await this.vault.createFolder(target);
    const path = this.vault.getAvailablePath(target, 'Sem título', 'md');
    const file = await this.vault.create(path, '');
    const reuse = this.workspace.activeLeaf?.view?.type === 'empty';
    const leaf = await this.openFile(file.path, { newLeaf: !reuse, mode: 'source' });
    // Let the user type the real name right away.
    const titleEl = leaf.view.inlineTitleEl;
    titleEl?.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return file;
  }

  async createNewFolder(parent = '') {
    let name = 'Sem título';
    let i = 1;
    while (this.vault.exists(joinPath(parent, name))) name = `Sem título ${i++}`;
    const path = joinPath(parent, name);
    await this.vault.createFolder(path);
    this.explorer.expanded.add(parent);
    await this.promptRename(path);
  }

  async promptRename(path) {
    if (!path) return;
    const entry = this.vault.entries.get(path);
    if (!entry) return;
    const isNote = entry.type === 'file' && isMarkdown(path);
    const current = isNote ? stem(path) : basename(path);
    const value = await promptText({ title: entry.type === 'folder' ? 'Renomear pasta' : 'Renomear arquivo', value: current, selectStem: !isNote });
    if (!value || value === current) return;
    const clean = sanitizeFileName(value);
    if (!clean) return notice('Nome inválido.');
    const target = joinPath(dirname(path), isNote ? `${clean}.md` : clean);
    try {
      await this.renameFile(path, target);
    } catch (err) {
      notice(err.message || String(err));
    }
  }

  /** Renames/moves a file or folder and rewrites links that pointed to it. */
  async renameFile(oldPath, newPath) {
    if (oldPath === newPath) return;
    const entry = this.vault.entries.get(oldPath);
    if (!entry) throw new Error(`Não encontrado: ${oldPath}`);
    if (this.vault.exists(newPath) && oldPath.toLowerCase() !== newPath.toLowerCase()) throw new Error(`Já existe um item chamado "${basename(newPath)}"`);

    // Save open editors first so no pending edit overwrites the link updates.
    await Promise.all([...this.markdownViews(), ...this.canvasViews()].map((v) => v.saveNow()));

    const isFolder = entry.type === 'folder';
    const moved = isFolder ? this.vault.getFiles().filter((f) => f.path.startsWith(`${oldPath}/`)).map((f) => f.path) : [oldPath];
    const mapPath = (p) => (isFolder ? newPath + p.slice(oldPath.length) : newPath);

    const pending = new Map(); // source -> [{ ref, target }]
    if (this.settings.get('autoUpdateLinks')) {
      for (const target of moved) {
        for (const { source, refs } of this.metadata.getBacklinks(target)) {
          if (!pending.has(source)) pending.set(source, []);
          for (const ref of refs) pending.get(source).push({ ref, target });
        }
      }
      // Relative markdown links inside moved notes may break when their folder changes.
      for (const source of moved.filter(isMarkdown)) {
        const cache = this.metadata.getCache(source);
        for (const ref of [...(cache?.links || []), ...(cache?.embeds || [])]) {
          const dest = this.metadata.getFirstLinkpathDest(parseLinktext(ref.link).path, source);
          if (!dest || moved.includes(dest.path)) continue;
          if (!pending.has(source)) pending.set(source, []);
          pending.get(source).push({ ref, target: dest.path, external: true });
        }
      }
    }

    await this.vault.rename(oldPath, newPath);

    let updatedFiles = 0;
    let updatedLinks = 0;
    if (this.settings.get('autoUpdateLinks')) {
      const movedSet = new Set(moved);
      updatedFiles += await this.updateCanvasReferences((p) => (movedSet.has(p) || (isFolder && p.startsWith(`${oldPath}/`)) ? mapPath(p) : p));
    }
    for (const [source, items] of pending) {
      const current = moved.includes(source) ? mapPath(source) : source;
      let text = this.vault.cachedRead(current);
      let changed = false;
      items.sort((a, b) => b.ref.position.start.offset - a.ref.position.start.offset);
      const seen = new Set();
      for (const { ref, target, external } of items) {
        const start = ref.position.start.offset;
        if (seen.has(start)) continue;
        seen.add(start);
        const end = ref.position.end.offset;
        if (text.slice(start, end) !== ref.original) continue;
        const newTarget = external ? target : mapPath(target);
        const { path: linkpath, subpath } = parseLinktext(ref.link);
        if (this.metadata.getFirstLinkpathDest(linkpath, current)?.path === newTarget) continue;
        text = text.slice(0, start) + this.buildLink(ref, newTarget, current, subpath) + text.slice(end);
        changed = true;
        updatedLinks++;
      }
      if (changed) {
        await this.vault.write(current, text);
        updatedFiles++;
      }
    }
    if (updatedLinks) notice(`${updatedLinks} link(s) atualizado(s) em ${updatedFiles} arquivo(s).`);
  }

  /**
   * Points file cards of closed canvases at the new paths (open canvases follow the vault's
   * rename events themselves). Returns how many canvas files were rewritten.
   */
  async updateCanvasReferences(mapPath) {
    const open = new Set(this.canvasViews().map((v) => v.file));
    let count = 0;
    for (const file of this.vault.getFiles()) {
      if (extname(file.path) !== 'canvas' || open.has(file.path)) continue;
      try {
        const data = parseCanvas(await this.vault.read(file.path));
        if (remapFilePaths(data, mapPath)) {
          await this.vault.write(file.path, serializeCanvas(data));
          count++;
        }
      } catch (err) {
        console.warn('Canvas ignorado ao atualizar links', file.path, err);
      }
    }
    return count;
  }

  buildLink(ref, targetPath, sourcePath, subpath) {
    const embed = ref.original.startsWith('!') ? '!' : '';
    if (ref.markdown) {
      const url = targetPath.split('/').map(encodeURIComponent).join('/');
      return `${embed}[${ref.displayText}](${url}${subpath ? encodeURI(subpath) : ''})`;
    }
    const inner = ref.original.replace(/^!?\[\[/, '').replace(/\]\]$/, '');
    const pipe = inner.search(/(?<!\\)\|/);
    const alias = pipe === -1 ? '' : inner.slice(pipe);
    return `${embed}[[${this.metadata.fileToLinktext(targetPath, sourcePath)}${subpath}${alias}]]`;
  }

  async deleteFile(path) {
    if (!path) return;
    const entry = this.vault.entries.get(path);
    if (!entry) return;
    if (this.settings.get('confirmDelete')) {
      const ok = await confirmAction({
        title: entry.type === 'folder' ? 'Excluir pasta' : 'Excluir arquivo',
        message: `Tem certeza de que deseja excluir "${basename(path)}"? O item irá para a lixeira do sistema.`,
        confirmText: 'Excluir',
        danger: true,
      });
      if (!ok) return;
    }
    await this.vault.trash(path);
  }

  async duplicateFile(path) {
    if (!isMarkdown(path)) return notice('Só é possível duplicar notas Markdown.');
    const target = this.vault.getAvailablePath(dirname(path), stem(path), 'md');
    const file = await this.vault.create(target, this.vault.cachedRead(path));
    this.openFile(file.path);
  }

  /** Saves pasted/dropped files into the attachment folder and returns their vault paths. */
  async saveAttachmentFiles(files, sourcePath) {
    const setting = this.settings.get('attachmentFolder') || '';
    const folder = setting.startsWith('./') ? joinPath(dirname(sourcePath), setting.slice(2)) : setting;
    const paths = [];
    for (const file of files) {
      const ext = (file.name.split('.').pop() || file.type.split('/')[1] || 'bin').toLowerCase().replace('jpeg', 'jpg');
      const generic = !file.name || /^image\.\w+$/i.test(file.name);
      const name = generic ? `Pasted image ${formatDate(new Date(), 'YYYYMMDDHHmmss')}` : sanitizeFileName(file.name.replace(/\.[^.]+$/, ''));
      const path = this.vault.getAvailablePath(folder, name, ext);
      const bytes = new Uint8Array(await file.arrayBuffer());
      await this.vault.writeBinary(path, bytes);
      paths.push(path);
    }
    this.metadata.rebuildNameIndex();
    return paths;
  }

  /** Saves pasted/dropped files as attachments and returns the Markdown to insert. */
  async saveAttachments(files, sourcePath) {
    const paths = await this.saveAttachmentFiles(files, sourcePath);
    return paths
      .map((path) => {
        const ext = extname(path);
        const embed = IMAGE_EXT.has(ext) || AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext) || ext === 'pdf';
        return `${embed ? '!' : ''}[[${this.metadata.fileToLinktext(path, sourcePath)}]]`;
      })
      .join('\n');
  }

  async createNewCanvas(folder) {
    const target = folder ?? this.newNoteFolder();
    if (target && !this.vault.exists(target)) await this.vault.createFolder(target);
    const path = this.vault.getAvailablePath(target, 'Sem título', 'canvas');
    const file = await this.vault.create(path, serializeCanvas({ nodes: [], edges: [] }));
    const reuse = this.workspace.activeLeaf?.view?.type === 'empty';
    await this.openFile(file.path, { newLeaf: !reuse });
    return file;
  }

  // --- daily notes & templates ----------------------------------------------------------------------

  async openDailyNote() {
    const s = this.settings.data;
    const name = formatDate(new Date(), s.dailyNoteFormat || 'YYYY-MM-DD');
    const path = joinPath(s.dailyNotesFolder, `${name}.md`);
    if (!this.vault.getFile(path)) {
      let content = '';
      if (s.dailyNoteTemplate) {
        const tpl = this.metadata.getFirstLinkpathDest(s.dailyNoteTemplate.replace(/\.md$/i, ''), '');
        if (tpl) content = this.applyTemplateVars(this.vault.cachedRead(tpl.path), stem(path));
      }
      await this.vault.create(path, content);
    }
    return this.openFile(path);
  }

  applyTemplateVars(text, title) {
    const now = new Date();
    return text
      .replace(/{{\s*title\s*}}/gi, title)
      .replace(/{{\s*date(?::([^}]+))?\s*}}/gi, (_m, fmt) => formatDate(now, (fmt || 'YYYY-MM-DD').trim()))
      .replace(/{{\s*time(?::([^}]+))?\s*}}/gi, (_m, fmt) => formatDate(now, (fmt || 'HH:mm').trim()));
  }

  insertTemplate() {
    const view = this.workspace.activeLeaf?.view;
    if (view?.type !== 'markdown') return;
    const folder = this.settings.get('templatesFolder');
    const templates = this.vault.getMarkdownFiles().map((f) => f.path).filter((p) => !folder || p.startsWith(`${folder}/`));
    if (!templates.length) return notice(`Nenhum modelo encontrado em "${folder}".`);
    new FilePicker(this, templates, (path) => {
      const text = this.applyTemplateVars(this.vault.cachedRead(path), stem(view.file));
      if (view.mode === 'preview') view.toggleMode();
      view.editor.view.dispatch(view.editor.view.state.replaceSelection(text));
      view.editor.focus();
    }, 'Escolha um modelo…').open();
  }

  /** Renders a ![[note#section]] embed inside the editor's live preview. */
  renderEmbed(el, target, sourcePath) {
    const { path, subpath } = parseLinktext(target);
    const dest = this.metadata.getFirstLinkpathDest(path, sourcePath);
    if (dest) renderNoteEmbed(this, el, dest.path, subpath, 1);
  }

  // --- hover preview --------------------------------------------------------------------------------------

  async showHoverPreview(anchor, href, sourcePath) {
    const { path, subpath } = parseLinktext(href);
    const dest = this.metadata.getFirstLinkpathDest(path, sourcePath);
    if (!dest || !isMarkdown(dest.path)) return;
    this.hoverEl?.remove();
    const popover = el('div', { class: 'popover hover-popover' });
    const body = el('div', { class: 'markdown-rendered' });
    popover.appendChild(body);
    document.body.appendChild(popover);
    const rect = anchor.getBoundingClientRect();
    popover.style.left = `${Math.min(rect.left, window.innerWidth - 470)}px`;
    popover.style.top = `${rect.bottom + 6 + 400 > window.innerHeight ? Math.max(8, rect.top - 406) : rect.bottom + 6}px`;
    this.hoverEl = popover;
    await renderInto(this, body, this.vault.cachedRead(dest.path), dest.path, {}, 1);
    if (subpath) {
      const heading = subpath.replace(/^#/, '').toLowerCase();
      [...body.querySelectorAll('[data-heading]')].find((h) => h.dataset.heading.toLowerCase() === heading)?.scrollIntoView();
    }
    const close = (e) => {
      if (popover.contains(e.target) || anchor.contains(e.target)) return;
      popover.remove();
      document.removeEventListener('mouseover', close);
    };
    setTimeout(() => document.addEventListener('mouseover', close), 50);
  }

  // --- commands ---------------------------------------------------------------------------------------------

  registerCommands() {
    const c = this.commands;
    const activeMarkdown = () => {
      const v = this.workspace.activeLeaf?.view;
      return v?.type === 'markdown' && v.file ? v : null;
    };
    const activeMarkdownEditor = () => {
      const v = activeMarkdown();
      if (!v) return null;
      if (v.mode === 'preview') v.toggleMode();
      return v.editor;
    };
    const activeFile = () => this.workspace.getActiveFile();

    c.add({ id: 'file:new-note', name: 'Criar nova nota', hotkeys: ['Mod+N'], run: () => this.createNewNote() });
    c.add({ id: 'file:new-note-split', name: 'Criar nova nota à direita', run: async () => { await this.workspace.splitLeaf(); await this.createNewNote(); } });
    c.add({ id: 'file:new-folder', name: 'Criar nova pasta', run: () => this.createNewFolder(this.newNoteFolder()) });
    c.add({ id: 'canvas:new', name: 'Canvas: criar novo canvas', run: () => this.createNewCanvas() });
    c.add({ id: 'switcher:open', name: 'Troca rápida: abrir', hotkeys: ['Mod+O'], run: () => new QuickSwitcher(this).open() });
    c.add({ id: 'switcher:recent', name: 'Abrir arquivos recentes', run: () => new QuickSwitcher(this, { recentOnly: true }).open() });
    c.add({ id: 'command-palette:open', name: 'Paleta de comandos: abrir', hotkeys: ['Mod+P'], run: () => new CommandPalette(this).open() });
    c.add({ id: 'editor:toggle-mode', name: 'Alternar modo leitura/edição', hotkeys: ['Mod+E'], isAvailable: () => !!activeMarkdown(), run: () => activeMarkdown().toggleMode() });
    c.add({ id: 'editor:toggle-live-preview', name: 'Alternar live preview/código-fonte', run: () => this.settings.set({ livePreview: !this.settings.get('livePreview') }) });
    c.add({ id: 'editor:insert-template', name: 'Modelos: inserir modelo', isAvailable: () => !!activeMarkdown(), run: () => this.insertTemplate() });
    c.add({ id: 'editor:insert-date', name: 'Inserir data atual', isAvailable: () => !!activeMarkdown(), run: () => { const v = activeMarkdown(); v.editor.view.dispatch(v.editor.view.state.replaceSelection(formatDate(new Date(), 'YYYY-MM-DD'))); } });
    c.add({ id: 'editor:toggle-bold', name: 'Formatar: alternar negrito', hotkeys: ['Mod+B'], isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.toggleWrap('**'); ed.focus(); } } });
    c.add({ id: 'editor:toggle-italics', name: 'Formatar: alternar itálico', hotkeys: ['Mod+I'], isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.toggleWrap('*'); ed.focus(); } } });
    c.add({ id: 'editor:toggle-strikethrough', name: 'Formatar: alternar tachado', hotkeys: ['Mod+Shift+S'], isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.toggleWrap('~~'); ed.focus(); } } });
    c.add({ id: 'editor:toggle-highlight', name: 'Formatar: alternar destaque', hotkeys: ['Mod+Shift+H'], isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.toggleWrap('=='); ed.focus(); } } });
    c.add({ id: 'editor:toggle-inline-code', name: 'Formatar: alternar código inline', hotkeys: ['Mod+Shift+C'], isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.toggleWrap('`'); ed.focus(); } } });
    c.add({ id: 'editor:toggle-checklist', name: 'Formatar: alternar caixa de tarefa', hotkeys: ['Mod+L'], isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.toggleChecklist(); ed.focus(); } } });
    c.add({ id: 'editor:insert-link', name: 'Formatar: inserir link Markdown', hotkeys: ['Mod+K'], isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.insertMarkdownLink(); ed.focus(); } } });
    c.add({ id: 'editor:insert-wikilink', name: 'Formatar: inserir link interno', hotkeys: ['Mod+Shift+K'], isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.insertWikilink(); ed.focus(); } } });
    c.add({ id: 'editor:fold-all', name: 'Editor: dobrar tudo', isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.foldAll(); ed.focus(); } } });
    c.add({ id: 'editor:unfold-all', name: 'Editor: desdobrar tudo', isAvailable: () => !!activeMarkdown(), run: () => { const ed = activeMarkdownEditor(); if (ed) { ed.unfoldAll(); ed.focus(); } } });
    c.add({ id: 'file:copy-content', name: 'Copiar conteúdo da nota', isAvailable: () => !!activeMarkdown(), run: () => { const v = activeMarkdown(); if (v?.text != null) { navigator.clipboard.writeText(v.text); notice('Conteúdo da nota copiado.'); } } });
    c.add({ id: 'file:word-count', name: 'Estatísticas da nota', isAvailable: () => !!activeMarkdown(), run: () => { const v = activeMarkdown(); if (!v?.text) return; const { words, chars } = countWords(v.text); const charsWithSpaces = v.text.length; const lines = v.text.split('\n').length; const readingTime = Math.max(1, Math.ceil(words / 200)); notice(`${words.toLocaleString('pt-BR')} palavras\n${chars.toLocaleString('pt-BR')} caracteres (sem espaços)\n${charsWithSpaces.toLocaleString('pt-BR')} caracteres (com espaços)\n${lines.toLocaleString('pt-BR')} linhas\n~${readingTime} min de leitura`, 6000); } });
    c.add({ id: 'graph:open', name: 'Abrir visualização em grafo', hotkeys: ['Mod+G'], run: () => this.openGraph() });
    c.add({ id: 'search:open', name: 'Buscar em todos os arquivos', hotkeys: ['Mod+Shift+F'], run: () => { this.leftSidebar.show('search'); } });
    c.add({ id: 'workspace:close', name: 'Fechar aba atual', hotkeys: ['Mod+W'], run: () => this.workspace.closeLeaf(this.workspace.activeLeaf) });
    c.add({ id: 'workspace:new-tab', name: 'Nova aba', hotkeys: ['Mod+T'], run: () => this.workspace.newLeaf() });
    c.add({ id: 'workspace:split-right', name: 'Dividir à direita', hotkeys: ['Mod+\\'], run: () => this.workspace.splitLeaf() });
    c.add({ id: 'workspace:next-tab', name: 'Ir para a próxima aba', hotkeys: ['Mod+Tab'], run: () => this.workspace.cycleTab(1) });
    c.add({ id: 'workspace:prev-tab', name: 'Ir para a aba anterior', hotkeys: ['Mod+Shift+Tab'], run: () => this.workspace.cycleTab(-1) });
    c.add({ id: 'workspace:go-back', name: 'Navegar para trás', hotkeys: ['Mod+Alt+ArrowLeft'], run: () => this.workspace.activeLeaf?.goBack() });
    c.add({ id: 'workspace:go-forward', name: 'Navegar para frente', hotkeys: ['Mod+Alt+ArrowRight'], run: () => this.workspace.activeLeaf?.goForward() });
    c.add({ id: 'app:toggle-left-sidebar', name: 'Alternar barra lateral esquerda', run: () => this.leftSidebar.toggle() });
    c.add({ id: 'app:toggle-right-sidebar', name: 'Alternar barra lateral direita', run: () => this.rightSidebar.toggle() });
    c.add({ id: 'app:open-settings', name: 'Abrir configurações', hotkeys: ['Mod+,'], run: () => new SettingsModal(this).open() });
    c.add({ id: 'app:open-vault', name: 'Abrir outro cofre', run: () => window.basalto.vaults.starter() });
    c.add({ id: 'app:reload', name: 'Recarregar o aplicativo', run: async () => { await this.flushSaves(); location.reload(); } });
    c.add({ id: 'theme:toggle', name: 'Alternar tema claro/escuro', run: () => this.settings.set({ theme: document.body.classList.contains('theme-dark') ? 'light' : 'dark' }) });
    c.add({ id: 'daily-notes:open', name: 'Notas diárias: abrir nota de hoje', run: () => this.openDailyNote() });
    c.add({ id: 'file:rename', name: 'Renomear arquivo', hotkeys: ['F2'], isAvailable: () => !!activeFile(), run: () => this.promptRename(activeFile()) });
    c.add({ id: 'file:delete', name: 'Excluir arquivo atual', isAvailable: () => !!activeFile(), run: () => this.deleteFile(activeFile()) });
    c.add({ id: 'file:duplicate', name: 'Duplicar nota atual', isAvailable: () => !!activeMarkdown(), run: () => this.duplicateFile(activeFile()) });
    c.add({ id: 'file:export-pdf', name: 'Exportar para PDF', isAvailable: () => !!activeMarkdown(), run: () => this.exportPdf() });
    c.add({ id: 'file:open-random', name: 'Abrir nota aleatória', run: () => { const notes = this.vault.getMarkdownFiles(); if (notes.length) this.openFile(notes[Math.floor(Math.random() * notes.length)].path); } });
    c.add({ id: 'file:reveal', name: 'Revelar arquivo ativo no explorador', isAvailable: () => !!activeFile(), run: () => { this.leftSidebar.show('file-explorer'); this.explorer.revealActive(); } });
    c.add({ id: 'file:open-default-app', name: 'Abrir no aplicativo padrão', isAvailable: () => !!activeFile(), run: () => window.basalto.shell.openPath(activeFile()) });
    c.add({ id: 'file:copy-link', name: 'Copiar link para a nota atual', isAvailable: () => !!activeFile(), run: () => { navigator.clipboard.writeText(`[[${this.metadata.fileToLinktext(activeFile(), '')}]]`); notice('Link copiado.'); } });
    c.add({ id: 'panel:file-explorer', name: 'Mostrar explorador de arquivos', run: () => this.leftSidebar.show('file-explorer') });
    c.add({ id: 'panel:tags', name: 'Mostrar painel de tags', run: () => this.leftSidebar.show('tags') });
    c.add({ id: 'panel:bookmarks', name: 'Mostrar favoritos', run: () => this.leftSidebar.show('bookmarks') });
    c.add({ id: 'bookmarks:add-active', name: 'Favoritos: adicionar arquivo atual', isAvailable: () => !!activeFile(), run: () => this.addActiveBookmark() });
    c.add({ id: 'bookmarks:add-search', name: 'Favoritos: salvar busca atual', run: () => this.bookmarkSearch() });
    c.add({ id: 'bookmarks:new-group', name: 'Favoritos: criar grupo', run: () => this.bookmarksPanel.addGroup() });
    c.add({ id: 'panel:backlinks', name: 'Mostrar backlinks', run: () => this.rightSidebar.show('backlinks') });
    c.add({ id: 'panel:outgoing-links', name: 'Mostrar links de saída', run: () => this.rightSidebar.show('outgoing-links') });
    c.add({ id: 'panel:outline', name: 'Mostrar sumário', run: () => this.rightSidebar.show('outline') });
  }

  async exportPdf() {
    const view = this.workspace.activeLeaf?.view;
    if (view?.type !== 'markdown') return;
    // Print the rendered note only: switch to reading mode and hide the chrome while printing.
    const wasSource = view.mode === 'source';
    if (wasSource) view.toggleMode();
    await view.renderPreview();
    document.body.classList.add('is-printing');
    view.containerEl.classList.add('print-target');
    try {
      const saved = await window.basalto.window.printToPdf(view.file);
      if (saved) notice(`PDF exportado: ${saved}`);
    } finally {
      document.body.classList.remove('is-printing');
      view.containerEl.classList.remove('print-target');
      if (wasSource) view.toggleMode();
    }
  }
}

document.body.classList.add('is-loading');
const app = new App();
window.app = app;
app.start().catch((err) => {
  console.error(err);
  document.body.textContent = '';
  document.body.appendChild(el('div', { class: 'fatal-error' }, el('h2', { text: 'Não foi possível abrir o cofre' }), el('pre', { text: String(err?.stack || err) })));
});
