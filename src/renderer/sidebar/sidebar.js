import { el } from '../core/util.js';
import { icon } from '../ui/icons.js';

/** Base class for a panel shown in a sidebar. */
export class Panel {
  constructor(app) {
    this.app = app;
    this.containerEl = el('div', { class: 'sidebar-panel' });
  }
  get id() {
    return 'panel';
  }
  get title() {
    return '';
  }
  get icon() {
    return 'file';
  }
  onShow() {}
}

/** Collapsible, resizable sidebar holding several panels behind icon tabs. */
export class Sidebar {
  constructor(app, side) {
    this.app = app;
    this.side = side;
    this.panels = new Map();
    this.activeId = null;
    this.collapsed = false;
    this.width = 280;
    this.el = el('div', { class: `sidebar sidebar-${side}` });
    this.tabsEl = el('div', { class: 'sidebar-tabs' });
    this.titleEl = el('div', { class: 'sidebar-title' });
    this.contentEl = el('div', { class: 'sidebar-content' });
    this.el.append(this.tabsEl, this.contentEl);
    this.handleEl = el('div', { class: `sidebar-resize-handle sidebar-resize-${side}` });
    this.attachResize();
  }

  addPanel(panel) {
    this.panels.set(panel.id, panel);
    panel.containerEl.classList.add('is-hidden');
    this.contentEl.appendChild(panel.containerEl);
    const tab = el('button', { class: 'sidebar-tab clickable-icon', 'aria-label': panel.title, title: panel.title }, icon(panel.icon, 16));
    tab.dataset.panel = panel.id;
    tab.addEventListener('click', () => this.show(panel.id));
    this.tabsEl.appendChild(tab);
    if (!this.activeId) this.show(panel.id);
  }

  show(id, { reveal = true } = {}) {
    if (!this.panels.has(id)) return;
    this.activeId = id;
    for (const [pid, panel] of this.panels) panel.containerEl.classList.toggle('is-hidden', pid !== id);
    for (const tab of this.tabsEl.children) tab.classList.toggle('is-active', tab.dataset.panel === id);
    if (reveal && this.collapsed) this.setCollapsed(false);
    this.panels.get(id).onShow();
    this.app.workspace?.requestSave();
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.el.classList.toggle('is-collapsed', collapsed);
    this.handleEl.classList.toggle('is-hidden', collapsed);
    this.applyWidth();
    if (!collapsed && this.activeId) this.panels.get(this.activeId).onShow();
    this.app.workspace?.requestSave();
  }

  toggle() {
    this.setCollapsed(!this.collapsed);
  }

  applyWidth() {
    this.el.style.width = this.collapsed ? '' : `${this.width}px`;
  }

  attachResize() {
    this.handleEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.width;
      document.body.classList.add('is-resizing');
      const move = (ev) => {
        const dx = this.side === 'left' ? ev.clientX - startX : startX - ev.clientX;
        this.width = Math.max(180, Math.min(700, startW + dx));
        this.applyWidth();
      };
      const up = () => {
        document.body.classList.remove('is-resizing');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.app.workspace?.requestSave();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  serialize() {
    return { active: this.activeId, collapsed: this.collapsed, width: this.width };
  }

  restore(data) {
    if (!data) return;
    this.width = data.width || this.width;
    if (data.active) this.show(data.active, { reveal: false });
    this.setCollapsed(!!data.collapsed);
  }
}
