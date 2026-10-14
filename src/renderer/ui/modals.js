import { SuggestModal, Modal } from './modal.js';
import { el, fuzzyMatch, highlightMatches, stem, dirname, isMarkdown, basename } from '../core/util.js';
import { formatHotkey } from '../core/commands.js';

/** Ctrl+O: jump to any file (or alias); Shift+Enter creates a note with the typed name. */
export class QuickSwitcher extends SuggestModal {
  constructor(app, { recentOnly = false } = {}) {
    super({
      placeholder: 'Digite para buscar arquivos…',
      instructions: [
        ['↑↓', 'navegar'],
        ['↵', 'abrir'],
        ['Ctrl ↵', 'nova aba'],
        ['Shift ↵', 'criar'],
        ['Esc', 'fechar'],
      ],
    });
    this.app = app;
    this.recentOnly = recentOnly;
    this.emptyText = 'Nenhum arquivo encontrado. Shift+Enter para criar.';
  }

  getSuggestions(query) {
    const { app } = this;
    if (!query.trim()) {
      const recent = app.recentFiles.filter((p) => app.vault.getFile(p));
      const rest = this.recentOnly ? [] : app.vault.getFiles().map((f) => f.path).filter((p) => !recent.includes(p)).sort((a, b) => (app.vault.getFile(b).mtime || 0) - (app.vault.getFile(a).mtime || 0));
      return [...recent, ...rest].map((path) => ({ path, alias: null, match: null }));
    }
    const results = [];
    for (const { file, alias } of app.metadata.getLinkSuggestions()) {
      const label = alias || (isMarkdown(file) ? file.replace(/\.md$/i, '') : file);
      const match = fuzzyMatch(query, label);
      if (match) results.push({ path: file, alias, match, label });
    }
    return results.sort((a, b) => b.match.score - a.match.score);
  }

  renderSuggestion(item, row) {
    const label = item.label || item.alias || (isMarkdown(item.path) ? stem(item.path) : basename(item.path));
    const title = el('div', { class: 'suggestion-title' });
    if (item.match) highlightMatches(title, label, item.match.matches);
    else title.textContent = label;
    row.append(title);
    // Fuzzy results already show the folder in the label; recent files only show their name.
    const note = item.alias ? `→ ${item.path}` : item.label ? '' : dirname(item.path);
    if (note) row.append(el('div', { class: 'suggestion-note', text: note }));
  }

  onChoose(item, evt) {
    if (evt?.shiftKey) return this.createFromQuery(evt);
    this.app.openFile(item.path, { newLeaf: evt?.ctrlKey || evt?.metaKey });
  }

  onEmptyEnter(value, evt) {
    this.close();
    this.createFromQuery(evt, value);
  }

  onInputKey(e) {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      this.close();
      this.createFromQuery(e);
      return;
    }
    super.onInputKey(e);
  }

  async createFromQuery(evt, value = this.inputEl.value) {
    const name = value.trim();
    if (!name) return;
    const path = name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
    const existing = this.app.vault.getFile(path);
    if (existing) return this.app.openFile(existing.path, { newLeaf: evt?.ctrlKey || evt?.metaKey });
    const file = await this.app.vault.create(path, '');
    this.app.openFile(file.path, { newLeaf: evt?.ctrlKey || evt?.metaKey, mode: 'source' });
  }
}

/** Ctrl+P: run any command. */
export class CommandPalette extends SuggestModal {
  constructor(app) {
    super({ placeholder: 'Digite um comando…', instructions: [['↑↓', 'navegar'], ['↵', 'executar'], ['Esc', 'fechar']] });
    this.app = app;
  }

  getSuggestions(query) {
    const commands = this.app.commands.list();
    if (!query.trim()) {
      const recent = this.app.commands.recent.map((id) => commands.find((c) => c.id === id)).filter(Boolean);
      const rest = commands.filter((c) => !recent.includes(c)).sort((a, b) => a.name.localeCompare(b.name));
      return [...recent, ...rest].map((command) => ({ command, match: null }));
    }
    return commands
      .map((command) => ({ command, match: fuzzyMatch(query, command.name) }))
      .filter((x) => x.match)
      .sort((a, b) => b.match.score - a.match.score);
  }

  renderSuggestion({ command, match }, row) {
    const title = el('span', { class: 'suggestion-title' });
    if (match) highlightMatches(title, command.name, match.matches);
    else title.textContent = command.name;
    row.classList.add('mod-complex');
    row.append(title);
    const hotkeys = this.app.commands.getHotkeys(command.id);
    if (hotkeys.length) row.append(el('span', { class: 'suggestion-hotkey', text: hotkeys.map(formatHotkey).join(' / ') }));
  }

  onChoose({ command }) {
    this.app.commands.run(command.id);
  }
}

/** Generic file picker. */
export class FilePicker extends SuggestModal {
  constructor(app, files, onPick, placeholder = 'Escolha um arquivo…') {
    super({ placeholder });
    this.app = app;
    this.files = files;
    this.onPick = onPick;
  }
  getSuggestions(query) {
    if (!query) return this.files.map((path) => ({ path, match: null }));
    return this.files
      .map((path) => ({ path, match: fuzzyMatch(query, path) }))
      .filter((x) => x.match)
      .sort((a, b) => b.match.score - a.match.score);
  }
  renderSuggestion({ path, match }, row) {
    const title = el('div', { class: 'suggestion-title' });
    if (match) highlightMatches(title, path, match.matches);
    else title.textContent = path;
    row.append(title);
  }
  onChoose({ path }) {
    this.onPick(path);
  }
}

/** Settings dialog, organized by sections. */
export class SettingsModal extends Modal {
  constructor(app) {
    super({ className: 'settings-modal' });
    this.app = app;
    this.navEl = el('div', { class: 'settings-nav' });
    this.bodyEl = el('div', { class: 'settings-body' });
    this.contentEl.append(this.navEl, this.bodyEl);
    this.sections = [
      ['Editor', () => this.editorSection()],
      ['Arquivos e links', () => this.filesSection()],
      ['Aparência', () => this.appearanceSection()],
      ['Notas diárias', () => this.dailySection()],
      ['Modelos', () => this.templatesSection()],
      ['Atalhos', () => this.hotkeysSection()],
      ['Sobre', () => this.aboutSection()],
    ];
    this.sections.forEach(([name, render], i) => {
      const item = el('div', { class: 'settings-nav-item', text: name });
      item.addEventListener('click', () => this.show(i));
      this.navEl.appendChild(item);
    });
  }

  onOpen() {
    this.show(0);
  }

  show(i) {
    this.stopHotkeyCapture();
    this._offHotkeys?.();
    this._offHotkeys = null;
    [...this.navEl.children].forEach((n, idx) => n.classList.toggle('is-active', idx === i));
    this.bodyEl.textContent = '';
    this.bodyEl.appendChild(el('h2', { text: this.sections[i][0] }));
    this.sections[i][1]();
  }

  setting(name, desc, control) {
    this.bodyEl.appendChild(el('div', { class: 'setting-item' }, el('div', { class: 'setting-item-info' }, el('div', { class: 'setting-item-name', text: name }), desc ? el('div', { class: 'setting-item-description', text: desc }) : null), el('div', { class: 'setting-item-control' }, control)));
  }

  toggle(key) {
    const input = el('input', { type: 'checkbox', class: 'toggle' });
    input.checked = !!this.app.settings.get(key);
    input.addEventListener('change', () => this.app.settings.set({ [key]: input.checked }));
    return input;
  }

  text(key, placeholder = '') {
    const input = el('input', { type: 'text', class: 'text-input', placeholder });
    input.value = this.app.settings.get(key) ?? '';
    input.addEventListener('change', () => this.app.settings.set({ [key]: input.value.trim() }));
    return input;
  }

  select(key, options) {
    const select = el('select', { class: 'dropdown' }, options.map(([value, label]) => el('option', { value, text: label })));
    select.value = String(this.app.settings.get(key));
    select.addEventListener('change', () => this.app.settings.set({ [key]: isNaN(Number(select.value)) || select.value === '' ? select.value : Number(select.value) }));
    return select;
  }

  editorSection() {
    this.setting('Visualização padrão para novas abas', 'Modo em que as notas abrem.', this.select('defaultViewMode', [['source', 'Edição'], ['preview', 'Leitura']]));
    this.setting('Live preview', 'Oculta a marcação Markdown fora da linha em edição.', this.toggle('livePreview'));
    this.setting('Largura de linha legível', 'Limita a largura do texto.', this.toggle('readableLineLength'));
    this.setting('Quebras de linha estritas', 'No modo leitura, uma quebra simples não gera nova linha.', this.toggle('strictLineBreaks'));
    this.setting('Mostrar números de linha', null, this.toggle('showLineNumbers'));
    this.setting('Dobrar títulos', 'Permite recolher seções pelo título.', this.toggle('foldHeadings'));
    this.setting('Modo Vim', 'Atalhos de teclado do Vim no editor.', this.toggle('vimMode'));
    this.setting('Verificação ortográfica', null, this.toggle('spellcheck'));
  }

  filesSection() {
    this.setting('Confirmar exclusão de arquivos', null, this.toggle('confirmDelete'));
    this.setting('Local padrão para novas notas', null, this.select('newFileLocation', [['root', 'Raiz do cofre'], ['current', 'Mesma pasta do arquivo atual'], ['folder', 'Pasta especificada abaixo']]));
    this.setting('Pasta para novas notas', null, this.text('newFileFolder', 'Ex.: Notas'));
    this.setting('Atualizar links internos automaticamente', 'Ao renomear ou mover, reescreve os links que apontam para o arquivo.', this.toggle('autoUpdateLinks'));
    this.setting('Pasta de anexos', 'Onde salvar imagens coladas. Vazio = raiz; "./" = pasta da nota.', this.text('attachmentFolder', 'Ex.: Anexos'));
  }

  appearanceSection() {
    this.setting('Tema', null, this.select('theme', [['dark', 'Escuro'], ['light', 'Claro'], ['system', 'Seguir o sistema']]));
    const color = el('input', { type: 'color' });
    color.value = this.app.settings.get('accentColor');
    color.addEventListener('input', () => this.app.settings.set({ accentColor: color.value }));
    this.setting('Cor de destaque', null, color);
    const size = el('input', { type: 'range', min: 10, max: 30, step: 1 });
    size.value = this.app.settings.get('fontSize');
    size.addEventListener('input', () => this.app.settings.set({ fontSize: Number(size.value) }));
    this.setting('Tamanho da fonte', null, size);
  }

  dailySection() {
    this.setting('Formato da data', 'Tokens: YYYY, MM, DD, dddd, MMMM…', this.text('dailyNoteFormat', 'YYYY-MM-DD'));
    this.setting('Pasta das notas diárias', null, this.text('dailyNotesFolder', 'Ex.: Diário'));
    this.setting('Modelo', 'Caminho de uma nota usada como modelo.', this.text('dailyNoteTemplate', 'Ex.: Templates/Diário.md'));
  }

  templatesSection() {
    this.setting('Pasta de modelos', 'Variáveis: {{title}}, {{date}}, {{time}}.', this.text('templatesFolder', 'Templates'));
  }

  hotkeysSection() {
    const { commands } = this.app;
    this.bodyEl.appendChild(el('p', { class: 'setting-item-description', text: 'Personalize os atalhos deste cofre. As alterações são salvas automaticamente. Combinações em conflito ficam desativadas enquanto mais de um comando disponível as utiliza.' }));
    const search = el('input', { type: 'search', class: 'text-input hotkey-search', placeholder: 'Buscar comando…', 'aria-label': 'Buscar comando' });
    const status = el('div', { class: 'hotkey-status', role: 'status', 'aria-live': 'polite' });
    const list = el('div', { class: 'hotkey-list' });
    this.bodyEl.append(search, status, list);

    const focusAdd = (id) => [...list.querySelectorAll('.hotkey-add')].find((button) => button.dataset.commandId === id)?.focus();
    const render = () => {
      list.textContent = '';
      const matches = [...commands.commands.values()]
        .filter((command) => !search.value.trim() || fuzzyMatch(search.value, `${command.name} ${command.id}`))
        .sort((a, b) => a.name.localeCompare(b.name));
      status.textContent = this._captureCommand ? 'Pressione o novo atalho. Esc cancela a captura.' : `${matches.length} comando${matches.length === 1 ? '' : 's'}`;
      if (!matches.length) list.appendChild(el('p', { class: 'hotkey-empty', text: 'Nenhum comando encontrado.' }));
      for (const command of matches) {
        const hotkeys = commands.getHotkeys(command.id);
        const info = el('div', { class: 'setting-item-info' }, el('div', { class: 'setting-item-name', text: command.name }));
        if (commands.isCustomized(command.id)) info.appendChild(el('div', { class: 'setting-item-description', text: 'Personalizado' }));
        const control = el('div', { class: 'setting-item-control hotkey-controls' });
        const conflicts = new Set();
        for (const hotkey of hotkeys) {
          const collisions = commands.conflictsFor(command.id, hotkey);
          collisions.forEach((other) => conflicts.add(other.name));
          const remove = el('button', { class: 'hotkey-remove', text: '×', title: 'Remover atalho', 'aria-label': `Remover ${formatHotkey(hotkey)} de ${command.name}` });
          remove.addEventListener('click', () => {
            this.stopHotkeyCapture();
            commands.removeHotkey(command.id, hotkey);
            focusAdd(command.id);
          });
          control.appendChild(el('span', { class: `hotkey-binding${collisions.length ? ' has-conflict' : ''}`, title: collisions.length ? `Conflito com: ${collisions.map((other) => other.name).join(', ')}` : '' }, el('kbd', { text: formatHotkey(hotkey) }), remove));
        }
        if (!hotkeys.length) control.appendChild(el('span', { class: 'hotkey-unassigned', text: 'Sem atalho' }));
        const add = el('button', { class: 'hotkey-add', text: '+', title: 'Adicionar atalho', 'aria-label': `Adicionar atalho para ${command.name}`, dataset: { commandId: command.id } });
        add.addEventListener('click', () => {
          this.stopHotkeyCapture();
          this._captureCommand = command.id;
          this._cancelCapture = commands.captureHotkey((hotkey) => {
            this.stopHotkeyCapture();
            if (hotkey) commands.addHotkey(command.id, hotkey);
            else render();
            focusAdd(command.id);
          });
          render();
          list.querySelector('.hotkey-cancel')?.focus();
        });
        const reset = el('button', { class: 'hotkey-reset', text: 'Restaurar', disabled: !commands.isCustomized(command.id), title: 'Restaurar atalhos padrão', 'aria-label': `Restaurar atalhos padrão de ${command.name}` });
        reset.addEventListener('click', () => {
          this.stopHotkeyCapture();
          commands.resetHotkeys(command.id);
          focusAdd(command.id);
        });
        control.append(add, reset);
        const row = el('div', { class: 'setting-item hotkey-row' }, info, control);
        if (conflicts.size) row.appendChild(el('div', { class: 'hotkey-conflict', text: `Conflito com: ${[...conflicts].join('; ')}` }));
        if (this._captureCommand === command.id) {
          const cancel = el('button', { class: 'hotkey-cancel', text: 'Cancelar' });
          cancel.addEventListener('click', () => {
            this.stopHotkeyCapture();
            render();
            focusAdd(command.id);
          });
          row.appendChild(el('div', { class: 'hotkey-capture' }, el('span', { text: 'Pressione o atalho…' }), cancel));
        }
        list.appendChild(row);
      }
    };
    search.addEventListener('input', () => {
      this.stopHotkeyCapture();
      render();
    });
    this._offHotkeys = commands.on('hotkeys-change', render);
    render();
  }

  stopHotkeyCapture() {
    this._cancelCapture?.();
    this._cancelCapture = null;
    this._captureCommand = null;
  }

  onClose() {
    this.stopHotkeyCapture();
    this._offHotkeys?.();
    this._offHotkeys = null;
  }

  aboutSection() {
    this.bodyEl.append(
      el('p', { text: `Basalto ${this.app.appInfo?.version || ''}` }),
      el('p', { text: `Cofre: ${this.app.vault.info.path}` }),
      el('p', { text: 'Reimplementação independente de um editor de notas Markdown baseado em cofres locais. Suas notas são arquivos .md comuns.' }),
    );
    const btn = el('button', { text: 'Abrir outro cofre…' });
    btn.addEventListener('click', () => window.basalto.vaults.starter());
    this.bodyEl.appendChild(btn);
  }
}
