import { el } from '../core/util.js';
import { icon } from './icons.js';

/** Base modal with a backdrop; closes on Escape or backdrop click. */
export class Modal {
  constructor({ className = '', title = '' } = {}) {
    this.backdrop = el('div', { class: 'modal-backdrop' });
    this.modalEl = el('div', { class: `modal ${className}`, role: 'dialog' });
    if (title) this.modalEl.appendChild(el('div', { class: 'modal-title', text: title }));
    const close = el('button', { class: 'modal-close clickable-icon', 'aria-label': 'Fechar' }, icon('x'));
    close.addEventListener('click', () => this.close());
    this.modalEl.appendChild(close);
    this.contentEl = el('div', { class: 'modal-content' });
    this.modalEl.appendChild(this.contentEl);
    this.backdrop.addEventListener('mousedown', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    this.onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
  }

  open() {
    this.previousFocus = document.activeElement;
    this.backdrop.appendChild(this.modalEl);
    document.body.appendChild(this.backdrop);
    document.addEventListener('keydown', this.onKey, true);
    this.onOpen();
    return this;
  }

  close() {
    document.removeEventListener('keydown', this.onKey, true);
    this.backdrop.remove();
    this.onClose();
    this.previousFocus?.focus?.();
  }

  onOpen() {}
  onClose() {}
}

/**
 * Searchable list modal (quick switcher, command palette…).
 * Subclasses implement getSuggestions(query), renderSuggestion(item, el) and onChoose(item, evt).
 */
export class SuggestModal extends Modal {
  constructor({ placeholder = '', instructions = [], limit = 100 } = {}) {
    super({ className: 'prompt' });
    this.limit = limit;
    this.inputEl = el('input', { class: 'prompt-input', type: 'text', placeholder, spellcheck: 'false' });
    this.resultsEl = el('div', { class: 'prompt-results' });
    this.contentEl.append(this.inputEl, this.resultsEl);
    if (instructions.length) {
      this.contentEl.appendChild(
        el(
          'div',
          { class: 'prompt-instructions' },
          instructions.map(([k, label]) => el('span', { class: 'prompt-instruction' }, el('kbd', { text: k }), ` ${label}`)),
        ),
      );
    }
    this.items = [];
    this.selected = 0;
    this.inputEl.addEventListener('input', () => this.update());
    this.inputEl.addEventListener('keydown', (e) => this.onInputKey(e));
  }

  onOpen() {
    this.inputEl.focus();
    this.update();
  }

  update() {
    this.items = this.getSuggestions(this.inputEl.value).slice(0, this.limit);
    this.selected = 0;
    this.resultsEl.textContent = '';
    if (!this.items.length) {
      this.resultsEl.appendChild(el('div', { class: 'suggestion-empty', text: this.emptyText || 'Nenhum resultado.' }));
      return;
    }
    this.items.forEach((item, i) => {
      const row = el('div', { class: 'suggestion-item' });
      this.renderSuggestion(item, row);
      row.addEventListener('mousemove', () => this.select(i));
      row.addEventListener('click', (e) => this.choose(i, e));
      this.resultsEl.appendChild(row);
    });
    this.select(0);
  }

  select(i) {
    const rows = this.resultsEl.querySelectorAll('.suggestion-item');
    if (!rows.length) return;
    this.selected = (i + rows.length) % rows.length;
    rows.forEach((r, idx) => r.classList.toggle('is-selected', idx === this.selected));
    rows[this.selected].scrollIntoView({ block: 'nearest' });
  }

  choose(i, evt) {
    const item = this.items[i];
    this.close();
    this.onChoose(item, evt);
  }

  onInputKey(e) {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      this.select(this.selected + 1);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      this.select(this.selected - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.items.length) this.choose(this.selected, e);
      else this.onEmptyEnter?.(this.inputEl.value, e);
    }
  }

  getSuggestions() {
    return [];
  }

  renderSuggestion(item, row) {
    row.textContent = String(item);
  }

  onChoose() {}
}

/** Single text-field prompt; resolves with the value or null. */
export function promptText({ title, value = '', placeholder = '', submitText = 'Salvar', selectStem = false }) {
  return new Promise((resolve) => {
    const modal = new Modal({ title, className: 'prompt-text-modal' });
    const input = el('input', { type: 'text', class: 'text-input', value, placeholder, spellcheck: 'false' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    const buttons = el(
      'div',
      { class: 'modal-buttons' },
      el('button', { class: 'mod-cta', text: submitText, onclick: () => finish(input.value.trim()) }),
      el('button', { text: 'Cancelar', onclick: () => finish(null) }),
    );
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value.trim());
      }
    });
    modal.contentEl.append(input, buttons);
    modal.onClose = () => {
      if (!done) {
        done = true;
        resolve(null);
      }
    };
    modal.open();
    input.focus();
    const dot = value.lastIndexOf('.');
    if (selectStem && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}

/** Yes/no confirmation; resolves true/false. */
export function confirmAction({ title, message, confirmText = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    const modal = new Modal({ title, className: 'confirm-modal' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    const ok = el('button', { class: danger ? 'mod-warning' : 'mod-cta', text: confirmText, onclick: () => finish(true) });
    modal.contentEl.append(
      el('p', { text: message }),
      el('div', { class: 'modal-buttons' }, ok, el('button', { text: 'Cancelar', onclick: () => finish(false) })),
    );
    modal.onClose = () => {
      if (!done) {
        done = true;
        resolve(false);
      }
    };
    modal.open();
    ok.focus();
  });
}
