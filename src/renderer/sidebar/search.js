import { Panel } from './sidebar.js';
import { el, debounce, stem } from '../core/util.js';
import { runSearch } from '../core/search.js';
import { icon } from '../ui/icons.js';

export class SearchPanel extends Panel {
  constructor(app) {
    super(app);
    this.containerEl.classList.add('search-panel');
    this.matchCase = false;
    this.inputEl = el('input', { type: 'search', class: 'search-input', placeholder: 'Buscar…  (tag:#x  path:  file:  "frase"  -excluir  /regex/)', spellcheck: 'false' });
    this.caseBtn = el('button', { class: 'clickable-icon search-case', title: 'Diferenciar maiúsculas/minúsculas', text: 'Aa' });
    this.caseBtn.addEventListener('click', () => {
      this.matchCase = !this.matchCase;
      this.caseBtn.classList.toggle('is-active', this.matchCase);
      this.run();
    });
    this.summaryEl = el('div', { class: 'search-summary' });
    const saveSearch = el('button', { class: 'clickable-icon', title: 'Salvar busca nos favoritos', 'aria-label': 'Salvar busca nos favoritos' }, icon('bookmark-plus', 14));
    saveSearch.addEventListener('click', () => app.commands.run('bookmarks:add-search'));
    this.resultsEl = el('div', { class: 'search-results' });
    this.containerEl.append(el('div', { class: 'search-row' }, el('span', { class: 'search-icon' }, icon('search', 14)), this.inputEl, this.caseBtn, saveSearch), this.summaryEl, this.resultsEl);
    this.inputEl.addEventListener('input', debounce(() => this.run(), 200));
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.run();
    });
    const rerun = debounce(() => this.inputEl.value && this.run(), 500);
    app.vault.on('modify', rerun);
    app.vault.on('create', rerun);
    app.vault.on('delete', rerun);
    app.vault.on('rename', rerun);
  }

  get id() {
    return 'search';
  }
  get title() {
    return 'Busca';
  }
  get icon() {
    return 'search';
  }

  setQuery(query) {
    this.inputEl.value = query;
    this.run();
  }

  onShow() {
    setTimeout(() => this.inputEl.focus());
  }

  run() {
    const query = this.inputEl.value.trim();
    this.resultsEl.textContent = '';
    this.summaryEl.textContent = '';
    if (!query) return;
    const { vault, metadata } = this.app;
    const files = vault.getMarkdownFiles().map((f) => f.path).sort();
    const results = runSearch(query, files, {
      read: (p) => vault.cachedRead(p),
      getTags: (p) => metadata.getFileTags(p),
      matchCase: this.matchCase,
    });
    const total = results.reduce((n, r) => n + r.matches.length, 0);
    this.summaryEl.textContent = `${results.length} arquivo(s)${total ? `, ${total} ocorrência(s)` : ''}`;
    for (const result of results.slice(0, 300)) this.resultsEl.appendChild(this.renderResult(result));
  }

  renderResult(result) {
    const header = el(
      'div',
      { class: 'search-result-file-title tree-item-self' },
      el('span', { class: 'tree-item-icon collapse-icon' }, icon('chevron-down', 14)),
      el('span', { class: 'tree-item-inner', text: stem(result.path) }),
      result.matches.length ? el('span', { class: 'tree-item-flair', text: String(result.matches.length) }) : null,
    );
    const matchesEl = el('div', { class: 'search-result-file-matches' });
    for (const match of result.matches.slice(0, 10)) {
      const row = el('div', { class: 'search-result-file-match' });
      renderSnippet(row, match);
      row.addEventListener('click', (e) => this.app.openFile(result.path, { line: match.line, newLeaf: e.ctrlKey || e.metaKey }));
      matchesEl.appendChild(row);
    }
    const wrapper = el('div', { class: 'search-result' }, header, matchesEl);
    header.addEventListener('click', (e) => {
      if (e.target.closest('.collapse-icon')) {
        wrapper.classList.toggle('is-collapsed');
        return;
      }
      this.app.openFile(result.path, { newLeaf: e.ctrlKey || e.metaKey });
    });
    return wrapper;
  }
}

function renderSnippet(row, match) {
  const { text, ranges } = match;
  const start = Math.max(0, ranges[0][0] - 40);
  const end = Math.min(text.length, ranges[ranges.length - 1][1] + 80);
  let pos = start;
  if (start > 0) row.appendChild(document.createTextNode('…'));
  for (const [a, b] of ranges) {
    if (a < pos || a > end) continue;
    row.appendChild(document.createTextNode(text.slice(pos, a)));
    row.appendChild(el('mark', { text: text.slice(a, b) }));
    pos = b;
  }
  row.appendChild(document.createTextNode(text.slice(pos, end) + (end < text.length ? '…' : '')));
}
