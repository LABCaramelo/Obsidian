import { Events, el } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { Menu } from '../ui/menu.js';

let nextId = 1;
const uid = () => `leaf-${nextId++}`;

/** Base class for everything that can live in a tab. */
export class View {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf.workspace.app;
    this.containerEl = el('div', { class: 'view-content' });
  }
  get type() {
    return 'empty';
  }
  getDisplayText() {
    return 'Nova aba';
  }
  getIcon() {
    return 'file';
  }
  getState() {
    return {};
  }
  async setState() {}
  onOpen() {}
  onClose() {}
  onShow() {}
  focus() {}
}

/** A tab: holds one view and its navigation history. */
export class Leaf {
  constructor(workspace, pane) {
    this.workspace = workspace;
    this.pane = pane;
    this.id = uid();
    this.view = null;
    this.back = [];
    this.forward = [];
    this.tabEl = null;
  }

  getViewState() {
    return this.view ? { type: this.view.type, state: this.view.getState() } : { type: 'empty', state: {} };
  }

  enqueueNavigation(operation) {
    const pending = (this._navigation || Promise.resolve()).catch(() => {}).then(operation);
    this._navigation = pending;
    return pending;
  }

  setViewState(viewState, options = {}) {
    return this.enqueueNavigation(() => this.applyViewState(viewState, options));
  }

  async applyViewState(viewState, { history = true } = {}) {
    const previous = this.view ? this.getViewState() : null;
    if (!this.view || this.view.type !== viewState.type) {
      if (this.view) {
        await this.view.onClose();
        this.view.containerEl.remove();
      }
      this.view = this.workspace.createView(viewState.type, this);
      this.pane.contentEl.appendChild(this.view.containerEl);
      this.view.onOpen();
    }
    await this.view.setState(viewState.state || {});
    if (history && previous && previous.type !== 'empty' && JSON.stringify(previous) !== JSON.stringify(viewState)) {
      this.back.push(previous);
      if (this.back.length > 50) this.back.shift();
      this.forward = [];
    }
    this.pane.renderTabs();
    this.workspace.emit('leaf-updated', this);
    if (this.workspace.activeLeaf === this) this.workspace.emit('active-leaf-change', this);
    this.workspace.requestSave();
  }

  goBack() {
    return this.enqueueNavigation(async () => {
      const state = this.back.at(-1);
      if (!state) return;
      const previous = this.getViewState();
      await this.applyViewState(state, { history: false });
      this.back.pop();
      this.forward.push(previous);
    });
  }

  goForward() {
    return this.enqueueNavigation(async () => {
      const state = this.forward.at(-1);
      if (!state) return;
      const previous = this.getViewState();
      await this.applyViewState(state, { history: false });
      this.forward.pop();
      this.back.push(previous);
    });
  }

  updateHeader() {
    this.pane.renderTabs();
  }

  detach() {
    this.pane.removeLeaf(this);
  }
}

/** A column of tabs in the main area. */
export class Pane {
  constructor(workspace) {
    this.workspace = workspace;
    this.leaves = [];
    this.activeLeaf = null;
    this.el = el('div', { class: 'pane' });
    this.tabsEl = el('div', { class: 'tab-header' });
    this.tabListEl = el('div', { class: 'tab-list' });
    const newTab = el('button', { class: 'clickable-icon tab-new', 'aria-label': 'Nova aba' }, icon('plus', 15));
    newTab.addEventListener('click', () => workspace.newLeaf(this));
    this.tabsEl.append(this.tabListEl, newTab);
    this.contentEl = el('div', { class: 'pane-content' });
    this.el.append(this.tabsEl, this.contentEl);
    this.el.addEventListener('mousedown', () => {
      if (this.activeLeaf && workspace.activeLeaf !== this.activeLeaf) workspace.setActiveLeaf(this.activeLeaf);
    });
  }

  addLeaf(index = this.leaves.length) {
    const leaf = new Leaf(this.workspace, this);
    this.leaves.splice(index, 0, leaf);
    return leaf;
  }

  showLeaf(leaf) {
    this.activeLeaf = leaf;
    for (const l of this.leaves) l.view?.containerEl.classList.toggle('is-hidden', l !== leaf);
    leaf.view?.onShow();
    this.renderTabs();
  }

  removeLeaf(leaf) {
    if (leaf._closing) return leaf._closing;
    const remove = async () => {
      await leaf._navigation?.catch(() => {});
      const i = this.leaves.indexOf(leaf);
      if (i === -1) return;
      await leaf.view?.onClose();
      leaf.view?.containerEl.remove();
      this.leaves.splice(i, 1);
      this.workspace.onLeafRemoved(leaf, this, i);
    };
    leaf._closing = remove().finally(() => { leaf._closing = null; });
    return leaf._closing;
  }

  renderTabs() {
    this.tabListEl.textContent = '';
    for (const leaf of this.leaves) {
      const title = leaf.view?.getDisplayText() || 'Nova aba';
      const tab = el(
        'div',
        { class: `tab${leaf === this.activeLeaf ? ' is-active' : ''}`, title, draggable: 'true' },
        el('span', { class: 'tab-icon' }, icon(leaf.view?.getIcon() || 'file', 14)),
        el('span', { class: 'tab-title', text: title }),
      );
      const close = el('span', { class: 'tab-close clickable-icon', 'aria-label': 'Fechar' }, icon('x', 13));
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.workspace.closeLeaf(leaf);
      });
      tab.appendChild(close);
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          this.workspace.closeLeaf(leaf);
        } else if (e.button === 0) {
          this.workspace.setActiveLeaf(leaf);
        }
      });
      tab.addEventListener('contextmenu', (e) => {
        const menu = new Menu();
        menu.addItem({ title: 'Fechar', icon: 'x', onClick: () => this.workspace.closeLeaf(leaf) });
        menu.addItem({
          title: 'Fechar outras abas',
          onClick: () => this.leaves.filter((l) => l !== leaf).forEach((l) => this.workspace.closeLeaf(l)),
        });
        menu.addSeparator();
        menu.addItem({ title: 'Dividir à direita', icon: 'columns', onClick: () => this.workspace.splitLeaf(leaf) });
        menu.showAtMouseEvent(e);
      });
      // Reorder tabs by dragging.
      tab.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-basalto-tab', leaf.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      tab.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('application/x-basalto-tab')) e.preventDefault();
      });
      tab.addEventListener('drop', (e) => {
        const id = e.dataTransfer.getData('application/x-basalto-tab');
        const moving = this.leaves.find((l) => l.id === id);
        if (!moving || moving === leaf) return;
        e.preventDefault();
        this.leaves.splice(this.leaves.indexOf(moving), 1);
        this.leaves.splice(this.leaves.indexOf(leaf), 0, moving);
        this.renderTabs();
        this.workspace.requestSave();
      });
      leaf.tabEl = tab;
      this.tabListEl.appendChild(tab);
    }
  }
}

/** Main area: panes side by side, each with tabs. Emits active-leaf-change, leaf-updated, layout-change. */
export class Workspace extends Events {
  constructor(app, containerEl) {
    super();
    this.app = app;
    this.containerEl = containerEl;
    this.panes = [];
    this.activeLeaf = null;
    this.viewFactories = new Map();
    this._saveTimer = null;
    this.ready = false;
  }

  registerView(type, factory) {
    this.viewFactories.set(type, factory);
  }

  createView(type, leaf) {
    const factory = this.viewFactories.get(type) || this.viewFactories.get('empty');
    return factory(leaf);
  }

  addPane(index = this.panes.length) {
    const pane = new Pane(this);
    this.panes.splice(index, 0, pane);
    this.renderPanes();
    return pane;
  }

  renderPanes() {
    this.containerEl.textContent = '';
    this.panes.forEach((pane, i) => {
      if (i > 0) {
        const handle = el('div', { class: 'pane-resize-handle' });
        this.attachPaneResize(handle, i);
        this.containerEl.appendChild(handle);
      }
      pane.el.style.flex = pane.flex ? `${pane.flex} 1 0` : '1 1 0';
      this.containerEl.appendChild(pane.el);
    });
  }

  attachPaneResize(handle, index) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const left = this.panes[index - 1];
      const right = this.panes[index];
      const startX = e.clientX;
      const lw = left.el.getBoundingClientRect().width;
      const rw = right.el.getBoundingClientRect().width;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const nl = Math.max(200, lw + dx);
        const nr = Math.max(200, rw - dx);
        left.flex = nl;
        right.flex = nr;
        left.el.style.flex = `${nl} 1 0`;
        right.el.style.flex = `${nr} 1 0`;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.requestSave();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  get activePane() {
    return this.activeLeaf?.pane || this.panes[0];
  }

  setActiveLeaf(leaf, { focus = true } = {}) {
    if (!leaf) return;
    const changed = this.activeLeaf !== leaf;
    this.activeLeaf = leaf;
    leaf.pane.showLeaf(leaf);
    for (const p of this.panes) p.el.classList.toggle('is-active', p === leaf.pane);
    if (focus) leaf.view?.focus();
    if (changed) {
      this.emit('active-leaf-change', leaf);
      this.requestSave();
    }
  }

  async newLeaf(pane = this.activePane, viewState = { type: 'empty', state: {} }) {
    const index = pane.activeLeaf ? pane.leaves.indexOf(pane.activeLeaf) + 1 : pane.leaves.length;
    const leaf = pane.addLeaf(index);
    await leaf.setViewState(viewState, { history: false });
    this.setActiveLeaf(leaf);
    return leaf;
  }

  /** Leaf to reuse when opening something: the active one unless asked for a new tab. */
  async getLeaf(newLeaf = false) {
    if (newLeaf || !this.activeLeaf) return this.newLeaf();
    return this.activeLeaf;
  }

  async splitLeaf(leaf = this.activeLeaf) {
    const index = leaf ? this.panes.indexOf(leaf.pane) + 1 : this.panes.length;
    const pane = this.addPane(index);
    return this.newLeaf(pane, leaf ? leaf.getViewState() : undefined);
  }

  closeLeaf(leaf) {
    if (!leaf) return;
    return leaf.pane.removeLeaf(leaf).catch((err) => {
      console.error('Não foi possível fechar a aba sem salvar', err);
      return false;
    });
  }

  onLeafRemoved(leaf, pane, index) {
    if (pane.leaves.length === 0) {
      if (this.panes.length > 1) {
        this.panes.splice(this.panes.indexOf(pane), 1);
        this.renderPanes();
        const next = this.panes[Math.max(0, index - 1)] || this.panes[0];
        if (this.activeLeaf === leaf) this.setActiveLeaf(next.activeLeaf || next.leaves[0]);
      } else {
        // Keep at least one (empty) tab around.
        this.newLeaf(pane);
      }
    } else if (pane.activeLeaf === leaf) {
      const next = pane.leaves[Math.min(index, pane.leaves.length - 1)];
      if (this.activeLeaf === leaf) this.setActiveLeaf(next);
      else pane.showLeaf(next);
    } else {
      pane.renderTabs();
    }
    this.emit('layout-change');
    this.requestSave();
  }

  getLeaves() {
    return this.panes.flatMap((p) => p.leaves);
  }

  getLeavesOfType(type) {
    return this.getLeaves().filter((l) => l.view?.type === type);
  }

  getActiveFile() {
    const view = this.activeLeaf?.view;
    return view?.file || null;
  }

  /** Cycles tabs in the active pane. */
  cycleTab(delta) {
    const pane = this.activePane;
    if (!pane?.leaves.length) return;
    const i = pane.leaves.indexOf(pane.activeLeaf);
    this.setActiveLeaf(pane.leaves[(i + delta + pane.leaves.length) % pane.leaves.length]);
  }

  // --- persistence ---

  serialize() {
    return {
      panes: this.panes.map((p) => ({
        flex: p.flex || null,
        active: Math.max(0, p.leaves.indexOf(p.activeLeaf)),
        leaves: p.leaves.map((l) => l.getViewState()),
      })),
      activePane: Math.max(0, this.panes.indexOf(this.activePane)),
    };
  }

  async restore(data) {
    this.panes = [];
    const panes = data?.panes?.length ? data.panes : [{ leaves: [{ type: 'empty', state: {} }], active: 0 }];
    for (const p of panes) {
      const pane = this.addPane();
      pane.flex = p.flex || null;
      for (const vs of p.leaves.length ? p.leaves : [{ type: 'empty', state: {} }]) {
        const leaf = pane.addLeaf();
        try {
          await leaf.setViewState(vs, { history: false });
        } catch (err) {
          console.warn('Falha ao restaurar aba', vs, err);
          await leaf.setViewState({ type: 'empty', state: {} }, { history: false });
        }
      }
      pane.showLeaf(pane.leaves[Math.min(p.active || 0, pane.leaves.length - 1)]);
    }
    this.renderPanes();
    const activePane = this.panes[Math.min(data?.activePane || 0, this.panes.length - 1)];
    this.setActiveLeaf(activePane.activeLeaf, { focus: false });
    this.ready = true;
  }

  requestSave() {
    if (!this.ready) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.app.saveWorkspace(), 500);
  }
}
