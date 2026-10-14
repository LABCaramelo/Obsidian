import { View } from '../workspace/workspace.js';
import { createEditor } from '../editor/editor.js';
import { markdownEditorHooks } from '../editor/hooks.js';
import { el, debounce, stem, dirname, joinPath, sanitizeFileName } from '../core/util.js';
import { parseSubpath } from '../core/parse.js';
import { flushTextEdits } from '../core/persistence.js';
import { icon } from '../ui/icons.js';
import { Menu } from '../ui/menu.js';
import { notice } from '../ui/notice.js';
import { renderInto } from './reading.js';

export class MarkdownView extends View {
  constructor(leaf) {
    super(leaf);
    this.file = null;
    this.mode = this.app.settings.get('defaultViewMode');
    this.dirty = false;
    this.text = '';
    this.containerEl.classList.add('markdown-view');

    // Header: navigation, breadcrumb, actions
    this.backBtn = el('button', { class: 'clickable-icon', 'aria-label': 'Voltar' }, icon('arrow-left'));
    this.fwdBtn = el('button', { class: 'clickable-icon', 'aria-label': 'Avançar' }, icon('arrow-right'));
    this.backBtn.addEventListener('click', () => this.leaf.goBack());
    this.fwdBtn.addEventListener('click', () => this.leaf.goForward());
    this.breadcrumbEl = el('div', { class: 'view-header-title' });
    this.modeBtn = el('button', { class: 'clickable-icon' });
    this.modeBtn.addEventListener('click', () => this.toggleMode());
    const moreBtn = el('button', { class: 'clickable-icon', 'aria-label': 'Mais opções' }, icon('more'));
    moreBtn.addEventListener('click', (e) => this.showMoreMenu(e));
    this.headerEl = el(
      'div',
      { class: 'view-header' },
      el('div', { class: 'view-header-nav' }, this.backBtn, this.fwdBtn),
      this.breadcrumbEl,
      el('div', { class: 'view-actions' }, this.modeBtn, moreBtn),
    );

    // Body
    this.scrollerEl = el('div', { class: 'markdown-scroller' });
    this.inlineTitleEl = el('div', { class: 'inline-title', contenteditable: 'true', spellcheck: 'false' });
    this.inlineTitleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.inlineTitleEl.blur();
        this.editor?.focus();
      } else if (e.key === 'Escape') {
        this.inlineTitleEl.textContent = stem(this.file);
        this.inlineTitleEl.blur();
      }
    });
    this.inlineTitleEl.addEventListener('blur', () => this.commitInlineTitle());
    this.editorEl = el('div', { class: 'markdown-source-view' });
    this.previewEl = el('div', { class: 'markdown-reading-view markdown-rendered' });
    this.scrollerEl.append(el('div', { class: 'markdown-sizer' }, this.inlineTitleEl, this.editorEl, this.previewEl));
    this.containerEl.append(this.headerEl, this.scrollerEl);

    this.save = debounce(() => this.saveNow().catch(() => {}), 700);
    this.renderPreviewSoon = debounce(() => this.renderPreview(), 150);
  }

  get type() {
    return 'markdown';
  }

  getDisplayText() {
    return this.file ? stem(this.file) : 'Sem arquivo';
  }

  getIcon() {
    return 'file-text';
  }

  getState() {
    return { file: this.file, mode: this.mode };
  }

  async setState(state) {
    const file = state.file;
    if (file && !this.app.vault.getFile(file)) throw new Error(`Arquivo não encontrado: ${file}`);
    if (file !== this.file) {
      if (this.dirty) await this.saveNow();
      this.file = file;
      this.text = file ? await this.app.vault.read(file) : '';
      this.mountEditor();
      this.updateTitle();
    }
    if (state.mode && state.mode !== this.mode) this.mode = state.mode;
    this.applyMode();
    if (state.line != null) this.scrollToLine(state.line);
    else if (state.subpath) this.scrollToSubpath(state.subpath);
    this.app.workspace.emit('file-open', this.file, this.leaf);
  }

  mountEditor() {
    this.editor?.destroy();
    this.editorEl.textContent = '';
    const app = this.app;
    this.editor = createEditor(this.editorEl, {
      doc: this.text,
      settings: app.settings.data,
      hooks: markdownEditorHooks(app, () => this.file, {
        onChange: (text) => {
          this.text = text;
          if (this._settingValue) return;
          this.dirty = true;
          this.save();
          app.emit('editor-change', this);
        },
        onCursor: () => app.emit('editor-cursor', this),
      }),
    });
  }

  updateTitle() {
    this.inlineTitleEl.textContent = this.file ? stem(this.file) : '';
    this.breadcrumbEl.textContent = '';
    if (this.file) {
      const folder = dirname(this.file);
      if (folder) {
        for (const part of folder.split('/')) {
          this.breadcrumbEl.append(el('span', { class: 'view-header-breadcrumb', text: part }), el('span', { class: 'view-header-sep', text: '/' }));
        }
      }
      this.breadcrumbEl.append(el('span', { class: 'view-header-file', text: stem(this.file) }));
    }
    this.leaf.updateHeader();
    if (this.app.workspace.activeLeaf === this.leaf) this.app.updateWindowTitle();
  }

  async commitInlineTitle() {
    if (!this.file) return;
    const name = sanitizeFileName(this.inlineTitleEl.textContent || '');
    if (!name || name === stem(this.file)) {
      this.inlineTitleEl.textContent = stem(this.file);
      return;
    }
    const target = joinPath(dirname(this.file), `${name}.md`);
    try {
      await this.app.renameFile(this.file, target);
    } catch (err) {
      notice(err.message || String(err));
      this.inlineTitleEl.textContent = stem(this.file);
    }
  }

  applyMode() {
    const preview = this.mode === 'preview';
    this.containerEl.classList.toggle('is-reading', preview);
    this.editorEl.classList.toggle('is-hidden', preview);
    this.previewEl.classList.toggle('is-hidden', !preview);
    this.modeBtn.textContent = '';
    this.modeBtn.appendChild(icon(preview ? 'pencil' : 'book-open'));
    this.modeBtn.setAttribute('aria-label', preview ? 'Editar (Ctrl+E)' : 'Leitura (Ctrl+E)');
    this.inlineTitleEl.setAttribute('contenteditable', 'true');
    if (preview) this.renderPreview();
    this.app.emit('view-mode-change', this);
  }

  toggleMode() {
    const line = this.mode === 'source' ? this.editor?.topLine() : this.previewTopLine();
    this.mode = this.mode === 'preview' ? 'source' : 'preview';
    this.applyMode();
    if (line != null) this.scrollToLine(line, false);
    if (this.mode === 'source') this.editor?.focus();
    this.app.workspace.requestSave();
  }

  previewTopLine() {
    const top = this.scrollerEl.getBoundingClientRect().top;
    for (const node of this.previewEl.querySelectorAll('[data-line]')) {
      if (node.getBoundingClientRect().bottom > top) return Number(node.dataset.line);
    }
    return 0;
  }

  async renderPreview() {
    if (this.mode !== 'preview' || !this.file) return;
    const scroll = this.scrollerEl.scrollTop;
    await renderInto(this.app, this.previewEl, this.text, this.file, {
      onToggleTask: (line) => this.toggleTaskAt(line),
    });
    this.scrollerEl.scrollTop = scroll;
  }

  toggleTaskAt(line) {
    const lines = this.text.split('\n');
    if (!lines[line]) return;
    lines[line] = lines[line].replace(/\[([ xX])\]/, (_m, c) => (c === ' ' ? '[x]' : '[ ]'));
    this.editor.setValue(lines.join('\n'));
  }

  scrollToLine(line, select = true) {
    if (this.mode === 'preview') {
      const nodes = [...this.previewEl.querySelectorAll('[data-line]')];
      const target = nodes.filter((n) => Number(n.dataset.line) <= line).pop() || nodes[0];
      target?.scrollIntoView({ block: 'start' });
    } else {
      this.editor?.scrollToLine(line, select);
    }
  }

  scrollToSubpath(subpath) {
    const { heading, block } = parseSubpath(subpath);
    const cache = this.app.metadata.getCache(this.file);
    if (!cache) return;
    if (block) {
      const b = cache.blocks.find((x) => x.id === block);
      if (b) this.scrollToLine(b.position.start.line);
    } else if (heading) {
      const h = cache.headings.find((x) => x.heading.toLowerCase() === heading.toLowerCase());
      if (h) this.scrollToLine(h.position.start.line);
    }
  }

  async saveNow() {
    this.save.cancel();
    try {
      await flushTextEdits(this, (file, text) => this.app.vault.write(file, text));
    } catch (err) {
      notice(`Não foi possível salvar: ${err.message || err}`);
      throw err;
    }
  }

  /** Called by the app when the file changed on disk or was renamed. */
  onFileModified(text) {
    if (this.dirty) return;
    this.text = text;
    this._settingValue = true;
    try {
      this.editor.setValue(text);
    } finally {
      this._settingValue = false;
    }
    this.renderPreviewSoon();
  }

  onFileRenamed(newPath) {
    this.file = newPath;
    this.updateTitle();
    this.app.workspace.requestSave();
  }

  refresh() {
    this.editor?.refreshDecorations();
    this.renderPreviewSoon();
  }

  showMoreMenu(e) {
    const menu = new Menu();
    menu.addItem({ title: this.mode === 'preview' ? 'Editar' : 'Modo leitura', icon: this.mode === 'preview' ? 'pencil' : 'book-open', onClick: () => this.toggleMode() });
    menu.addItem({ title: 'Dividir à direita', icon: 'columns', onClick: () => this.app.workspace.splitLeaf(this.leaf) });
    menu.addSeparator();
    menu.addItem({ title: 'Renomear…', icon: 'edit', onClick: () => this.app.promptRename(this.file) });
    this.app.addBookmarkMenuItem(menu, this.file);
    menu.addItem({ title: 'Exportar como PDF…', icon: 'printer', onClick: () => this.app.commands.run('file:export-pdf') });
    menu.addItem({ title: 'Abrir no aplicativo padrão', icon: 'external-link', onClick: () => window.basalto.shell.openPath(this.file) });
    menu.addItem({ title: 'Mostrar no explorador do sistema', icon: 'folder-open', onClick: () => window.basalto.shell.reveal(this.file) });
    menu.addSeparator();
    menu.addItem({ title: 'Excluir arquivo', icon: 'trash', danger: true, onClick: () => this.app.deleteFile(this.file) });
    menu.showAtMouseEvent(e);
  }

  focus() {
    if (this.mode === 'source') setTimeout(() => this.editor?.focus());
  }

  onShow() {
    if (this.mode === 'preview') this.renderPreviewSoon();
  }

  async onClose() {
    await this.saveNow();
    this.editor?.destroy();
  }
}

