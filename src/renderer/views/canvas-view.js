import { View } from '../workspace/workspace.js';
import { el, debounce, basename, stem, extname, dirname, isMarkdown, sanitizeFileName, IMAGE_EXT, AUDIO_EXT, VIDEO_EXT } from '../core/util.js';
import {
  parseCanvas, serializeCanvas, mergeCanvas, newId, colorToCss, CANVAS_COLORS, SIDES, bestSides, nearestSide, edgeCurve, edgeCurveToPoint,
  curvePath, curvePoint, arrowPath, bounds, intersects, nodesInGroup, remapFilePaths, snap,
} from '../core/canvas.js';
import { parseLinktext } from '../core/parse.js';
import { renderInto, renderNoteEmbed } from './reading.js';
import { createEditor } from '../editor/editor.js';
import { markdownEditorHooks } from '../editor/hooks.js';
import { icon } from '../ui/icons.js';
import { Menu } from '../ui/menu.js';
import { notice } from '../ui/notice.js';
import { promptText } from '../ui/modal.js';
import { FilePicker } from '../ui/modals.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const GRID = 20;
const PATH_DRAG = 'application/x-basalto-path';
const CLIPBOARD_MARK = 'basalto/canvas';

const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  return node;
};

const isMedia = (path) => {
  const ext = extname(path);
  return IMAGE_EXT.has(ext) || AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext) || ext === 'pdf';
};

/** Infinite canvas for .canvas files (JSON Canvas): cards, notes, media, links, groups and arrows. */
export class CanvasView extends View {
  constructor(leaf) {
    super(leaf);
    this.file = null;
    this.data = { nodes: [], edges: [], extra: {} };
    this.selection = new Set();
    this.viewport = { x: 0, y: 0, zoom: 1 };
    this.nodeEls = new Map();
    this.history = [];
    this.future = [];
    this.lastSaved = null;
    this.pendingExternalText = null;
    this.pendingSave = null;
    this.queuedText = null;
    this.pendingWrites = new Set();
    this.editing = null;
    this.drag = null;
    this.spaceDown = false;
    this.needsFit = false;
    this.pointer = { x: 0, y: 0 };
    this.containerEl.classList.add('canvas-view');

    // Header
    const back = el('button', { class: 'clickable-icon', 'aria-label': 'Voltar' }, icon('arrow-left'));
    const fwd = el('button', { class: 'clickable-icon', 'aria-label': 'Avançar' }, icon('arrow-right'));
    back.addEventListener('click', () => this.leaf.goBack());
    fwd.addEventListener('click', () => this.leaf.goForward());
    this.titleEl = el('div', { class: 'view-header-title' });
    const more = el('button', { class: 'clickable-icon', 'aria-label': 'Mais opções' }, icon('more'));
    more.addEventListener('click', (e) => this.showMoreMenu(e));
    this.headerEl = el('div', { class: 'view-header' }, el('div', { class: 'view-header-nav' }, back, fwd), this.titleEl, el('div', { class: 'view-actions' }, more));

    // Board
    this.wrapperEl = el('div', { class: 'canvas-wrapper', tabindex: '0' });
    this.worldEl = el('div', { class: 'canvas-world' });
    this.groupsEl = el('div', { class: 'canvas-layer canvas-groups' });
    this.edgesSvg = svg('svg', { class: 'canvas-edges', width: 1, height: 1 });
    this.nodesEl = el('div', { class: 'canvas-layer canvas-nodes' });
    this.labelsEl = el('div', { class: 'canvas-layer canvas-edge-labels' });
    this.worldEl.append(this.groupsEl, this.edgesSvg, this.nodesEl, this.labelsEl);
    this.boxEl = el('div', { class: 'canvas-selection-box is-hidden' });
    this.toolbarEl = el('div', { class: 'canvas-menu is-hidden' });
    this.emptyEl = el('div', { class: 'canvas-empty-hint', text: 'Dê um duplo clique para criar um cartão, ou arraste notas do explorador para cá.' });
    this.wrapperEl.append(this.worldEl, this.boxEl, this.toolbarEl, this.emptyEl, this.buildControls(), this.buildCardMenu());
    this.containerEl.append(this.headerEl, this.wrapperEl);

    this.save = debounce(() => {
      // Keep the active editor's node reference until the user finishes this interaction.
      // Explicit flushes use saveNow() directly and finalize it before awaiting disk.
      if (this.pendingExternalText != null && (this.editing || this.drag)) return;
      this.saveNow().catch(() => {});
    }, 500);
    this.refreshFiles = debounce(() => this.renderNodes(true), 200);
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.needsFit && this.wrapperEl.clientWidth) {
        this.needsFit = false;
        this.zoomToFit(false);
      }
      this.renderToolbar();
    });
  }

  get type() {
    return 'canvas';
  }

  getDisplayText() {
    return this.file ? stem(this.file) : 'Canvas';
  }

  getIcon() {
    return 'canvas';
  }

  getState() {
    return { file: this.file, viewport: { ...this.viewport } };
  }

  async setState(state) {
    const file = state.file;
    if (file && !this.app.vault.getFile(file)) throw new Error(`Arquivo não encontrado: ${file}`);
    if (file !== this.file) {
      this.stopEditing();
      await this.saveNow();
      this.file = file;
      await this.load();
      this.history = [];
      this.future = [];
      this.selection.clear();
      this.updateTitle();
      const v = state.viewport;
      if (v && [v.x, v.y, v.zoom].every(Number.isFinite) && v.zoom > 0) {
        this.viewport = { x: v.x, y: v.y, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom)) };
        this.needsFit = false;
        this.applyViewport();
      } else if (this.wrapperEl.clientWidth) this.zoomToFit(false);
      else this.needsFit = true;
    }
    this.app.workspace.emit('file-open', this.file, this.leaf);
  }

  async load() {
    const text = this.file ? await this.app.vault.read(this.file) : '';
    try {
      this.data = parseCanvas(text);
      this.loadError = null;
      this.lastSaved = this.serialize();
    } catch (err) {
      this.data = { nodes: [], edges: [], extra: {} };
      this.loadError = err;
      this.lastSaved = this.serialize();
      notice(`Não foi possível ler o canvas: ${err.message}`);
    }
    this.pendingExternalText = null;
    this.render();
  }

  onOpen() {
    this.resizeObserver.observe(this.wrapperEl);
    const { vault } = this.app;
    this.offs = [
      vault.on('rename', (file, oldPath) => this.onVaultRename(file, oldPath)),
      vault.on('modify', (file, info) => {
        if (file.path === this.file) this.onExternalChange();
        else if (this.references(file.path)) this.refreshFiles();
      }),
      vault.on('create', (file) => this.references(file.path) && this.refreshFiles()),
      vault.on('delete', (file) => this.references(file.path) && this.refreshFiles()),
      this.app.on('theme-change', () => this.renderNodes(true)),
    ];
  }

  async onClose() {
    this.stopEditing();
    await this.saveNow();
    this.resizeObserver.disconnect();
    this.refreshFiles?.cancel();
    this.offs?.forEach((off) => off());
  }

  focus() {
    if (!this.editing) setTimeout(() => this.wrapperEl.focus({ preventScroll: true }));
  }

  updateTitle() {
    this.titleEl.textContent = '';
    if (this.file) {
      const folder = dirname(this.file);
      if (folder) {
        for (const part of folder.split('/')) this.titleEl.append(el('span', { class: 'view-header-breadcrumb', text: part }), el('span', { class: 'view-header-sep', text: '/' }));
      }
      this.titleEl.append(el('span', { class: 'view-header-file', text: stem(this.file) }));
    }
    this.leaf.updateHeader();
    if (this.app.workspace.activeLeaf === this.leaf) this.app.updateWindowTitle();
  }

  onFileRenamed(newPath) {
    this.file = newPath;
    this.updateTitle();
    this.renderNodes(true); // text cards resolve links relative to the canvas folder
    this.app.workspace.requestSave();
  }

  references(path) {
    return this.data.nodes.some((n) => (n.type === 'file' && n.file === path) || (n.type === 'group' && n.background === path));
  }

  onVaultRename(file, oldPath) {
    if (oldPath === this.file) return; // handled by onFileRenamed
    if (this.app.settings?.get('autoUpdateLinks') === false) return;
    const mapPath = (p) => (p === oldPath ? file.path : p);
    const rewrite = (text) => {
      const data = parseCanvas(text);
      return remapFilePaths(data, mapPath) ? serializeCanvas(data) : text;
    };
    this.history = this.history.map(rewrite);
    this.future = this.future.map(rewrite);
    if (this.pendingExternalText != null) this.pendingExternalText = rewrite(this.pendingExternalText);
    const changed = remapFilePaths(this.data, mapPath);
    if (changed) {
      this.renderNodes(true);
      this.save();
    }
  }

  onExternalChange() {
    const text = this.app.vault.cachedRead(this.file);
    let normalized;
    try {
      normalized = serializeCanvas(parseCanvas(text));
    } catch (err) {
      this.loadError = err;
      notice(`Não foi possível ler o canvas: ${err.message}`);
      return;
    }
    this.loadError = null;
    if (normalized === this.lastSaved || this.pendingWrites.has(normalized)) return;
    this.pendingExternalText = normalized;
    if (this.editing || this.drag) return;
    this.acceptExternalChange();
    this.render();
    if (this.serialize() !== this.lastSaved) this.save();
  }

  /** Applies deferred changes once the editor/gesture has released its node references. */
  acceptExternalChange(before = null) {
    if (this.pendingExternalText == null || this.editing || this.drag) return before;
    const remoteText = this.pendingExternalText;
    const base = parseCanvas(this.lastSaved || '');
    const remote = parseCanvas(remoteText);
    if (before != null) before = serializeCanvas(mergeCanvas(base, parseCanvas(before), remote));
    this.data = mergeCanvas(base, this.data, remote);
    this.pendingExternalText = null;
    this.lastSaved = remoteText;
    // Old document snapshots must not undo edits made in another pane or application.
    this.history = [];
    this.future = [];
    for (const id of [...this.selection]) if (!this.findNode(id) && !this.findEdge(id)) this.selection.delete(id);
    return before;
  }

  // --- persistence & history ---------------------------------------------------------------

  serialize() {
    return serializeCanvas(this.data);
  }

  async saveNow() {
    this.save.cancel();
    // Never resurrect a canvas that was deleted or renamed away under us.
    if (!this.file || !this.app.vault.getFile(this.file)) return;
    if (this.pendingExternalText != null && (this.editing || this.drag)) {
      this.stopEditing();
      if (this.drag) this.onPointerUp({}, true);
      this.save.cancel();
    }
    this.acceptExternalChange();
    const text = this.serialize();
    if (text === (this.queuedText ?? this.lastSaved)) return this.pendingSave;
    if (this.loadError) throw new Error('O canvas foi alterado para um JSON inválido. Corrija o arquivo antes de salvar.');
    const file = this.file;
    this.queuedText = text;
    this.pendingWrites.add(text);
    const writing = (this.pendingSave || Promise.resolve()).catch(() => {}).then(() => this.app.vault.write(file, text));
    this.pendingSave = writing;
    try {
      await writing;
      if (this.file === file) this.lastSaved = text;
    } catch (err) {
      notice(`Não foi possível salvar o canvas: ${err.message || err}`);
      throw err;
    } finally {
      this.pendingWrites.delete(text);
      if (this.pendingSave === writing) {
        this.pendingSave = null;
        this.queuedText = null;
      }
    }
    // Another pane may have changed the document while this write was in flight.
    // A flush is complete only after that merged state also reaches the disk.
    if (this.file === file && (this.pendingExternalText != null || this.serialize() !== this.lastSaved)) await this.saveNow();
  }

  /** Records the state before a change; call commit() afterwards. */
  checkpoint() {
    return this.serialize();
  }

  commit(before) {
    before = this.acceptExternalChange(before);
    if (before != null && before !== this.serialize()) {
      this.history.push(before);
      if (this.history.length > 100) this.history.shift();
      this.future = [];
    }
    this.render();
    this.save();
  }

  /** Runs `fn` as one undoable change. */
  change(fn) {
    const before = this.checkpoint();
    fn();
    this.commit(before);
  }

  restore(text) {
    this.data = parseCanvas(text);
    for (const id of [...this.selection]) if (!this.findNode(id) && !this.findEdge(id)) this.selection.delete(id);
    this.render();
    this.save();
  }

  undo() {
    this.stopEditing();
    if (!this.history.length) return;
    this.future.push(this.serialize());
    this.restore(this.history.pop());
  }

  redo() {
    this.stopEditing();
    if (!this.future.length) return;
    this.history.push(this.serialize());
    this.restore(this.future.pop());
  }

  // --- lookup & coordinates -----------------------------------------------------------------

  findNode(id) {
    return this.data.nodes.find((n) => n.id === id) || null;
  }

  findEdge(id) {
    return this.data.edges.find((e) => e.id === id) || null;
  }

  selectedNodes() {
    return this.data.nodes.filter((n) => this.selection.has(n.id));
  }

  selectedEdges() {
    return this.data.edges.filter((e) => this.selection.has(e.id));
  }

  toWorld(clientX, clientY) {
    const rect = this.wrapperEl.getBoundingClientRect();
    const { x, y, zoom } = this.viewport;
    return { x: (clientX - rect.left - x) / zoom, y: (clientY - rect.top - y) / zoom };
  }

  toScreen(p) {
    const { x, y, zoom } = this.viewport;
    return { x: p.x * zoom + x, y: p.y * zoom + y };
  }

  viewCenter() {
    return this.toWorld(this.wrapperEl.getBoundingClientRect().left + this.wrapperEl.clientWidth / 2, this.wrapperEl.getBoundingClientRect().top + this.wrapperEl.clientHeight / 2);
  }

  // --- rendering ---------------------------------------------------------------------------------

  render() {
    this.renderNodes();
    this.renderEdges();
    this.applyViewport();
    this.emptyEl.classList.toggle('is-hidden', this.data.nodes.length > 0);
  }

  applyViewport() {
    const { x, y, zoom } = this.viewport;
    this.worldEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    const size = GRID * zoom;
    this.wrapperEl.style.backgroundSize = `${size}px ${size}px`;
    this.wrapperEl.style.backgroundPosition = `${x}px ${y}px`;
    this.wrapperEl.classList.toggle('is-zoomed-out', zoom < 0.45);
    this.renderToolbar();
    if (this.app?.workspace?.activeLeaf?.view === this) this.app.updateStatusBar?.();
  }

  /** Reconciles node elements with the data; `force` re-renders every node's content. */
  renderNodes(force = false) {
    const keep = new Set();
    const groups = this.data.nodes.filter((n) => n.type === 'group').sort((a, b) => b.width * b.height - a.width * a.height);
    const others = this.data.nodes.filter((n) => n.type !== 'group');
    const place = (layer, list) => {
      list.forEach((node, i) => {
        keep.add(node.id);
        let entry = this.nodeEls.get(node.id);
        if (!entry) {
          entry = this.createNodeEl(node);
          this.nodeEls.set(node.id, entry);
        }
        // Only move elements that are out of order: moving an iframe or video reloads it.
        if (layer.children[i] !== entry.el) layer.insertBefore(entry.el, layer.children[i] || null);
        this.updateNodeEl(node, entry, force);
      });
    };
    place(this.groupsEl, groups);
    place(this.nodesEl, others);
    for (const [id, entry] of this.nodeEls) {
      if (!keep.has(id)) {
        entry.el.remove();
        this.nodeEls.delete(id);
      }
    }
    this.emptyEl.classList.toggle('is-hidden', this.data.nodes.length > 0);
  }

  createNodeEl(node) {
    const contentEl = el('div', { class: 'canvas-node-content' });
    const labelEl = el('div', { class: 'canvas-node-label' });
    const container = el('div', { class: 'canvas-node-container' }, contentEl);
    const nodeEl = el('div', { class: `canvas-node canvas-node-${node.type}`, 'data-id': node.id }, labelEl, container, el('div', { class: 'canvas-node-resizer', title: 'Redimensionar' }));
    for (const side of SIDES) nodeEl.appendChild(el('div', { class: `canvas-node-connection-point side-${side}`, 'data-side': side, title: 'Arraste para conectar' }));
    return { el: nodeEl, contentEl, labelEl, signature: null };
  }

  updateNodeEl(node, entry, force) {
    for (const type of ['text', 'file', 'link', 'group']) entry.el.classList.toggle(`canvas-node-${type}`, node.type === type);
    const s = entry.el.style;
    s.left = `${node.x}px`;
    s.top = `${node.y}px`;
    s.width = `${node.width}px`;
    s.height = `${node.height}px`;
    const color = colorToCss(node.color);
    if (color) s.setProperty('--canvas-color', color);
    else s.removeProperty('--canvas-color');
    entry.el.classList.toggle('is-colored', !!color);
    entry.el.classList.toggle('is-selected', this.selection.has(node.id));
    entry.el.classList.toggle('is-editing', this.editing?.id === node.id);
    if (this.editing?.id === node.id) return;
    const signature = this.contentSignature(node);
    if (!force && signature === entry.signature) return;
    entry.signature = signature;
    this.renderNodeContent(node, entry);
  }

  contentSignature(node) {
    switch (node.type) {
      case 'text':
        return `text:${node.text ?? ''}`;
      case 'file': {
        const f = this.app.vault.getFile(node.file || '');
        return `file:${node.file}:${node.subpath || ''}:${f ? f.mtime : 'missing'}`;
      }
      case 'link':
        return `link:${node.url}`;
      default:
        return `group:${node.label ?? ''}:${node.background ?? ''}:${node.backgroundStyle ?? ''}`;
    }
  }

  renderNodeContent(node, { el: nodeEl, contentEl, labelEl }) {
    contentEl.textContent = '';
    contentEl.className = 'canvas-node-content';
    labelEl.textContent = '';
    nodeEl.style.removeProperty('--canvas-bg');
    const app = this.app;
    if (node.type === 'text') {
      contentEl.classList.add('markdown-rendered');
      renderInto(app, contentEl, node.text || '', this.file, {}, 1);
    } else if (node.type === 'file') {
      const path = node.file || '';
      const file = app.vault.getFile(path);
      labelEl.textContent = file ? (isMarkdown(path) ? stem(path) : basename(path)) + (node.subpath || '') : basename(path);
      if (!file) {
        contentEl.append(el('div', { class: 'canvas-node-missing', text: `Arquivo não encontrado: ${path}` }));
      } else if (isMarkdown(path)) {
        contentEl.classList.add('markdown-rendered');
        renderNoteEmbed(app, contentEl, path, node.subpath, 0, { title: false });
      } else {
        const ext = extname(path);
        const url = app.vault.fileUrl(path);
        if (IMAGE_EXT.has(ext)) contentEl.append(el('img', { class: 'canvas-media', src: url, alt: basename(path), draggable: 'false' }));
        else if (ext === 'pdf') contentEl.append(el('iframe', { class: 'canvas-media', src: url }));
        else if (AUDIO_EXT.has(ext)) contentEl.append(el('audio', { src: url, controls: true }));
        else if (VIDEO_EXT.has(ext)) contentEl.append(el('video', { class: 'canvas-media', src: url, controls: true }));
        else contentEl.append(el('div', { class: 'canvas-node-file-card' }, icon(ext === 'canvas' ? 'canvas' : 'file', 28), el('div', { text: basename(path) })));
      }
    } else if (node.type === 'link') {
      let host = node.url || '';
      try {
        host = new URL(node.url).hostname;
      } catch {
        /* not a URL */
      }
      const open = el('button', { class: 'mod-small', text: 'Abrir no navegador' });
      open.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openLink(node);
      });
      labelEl.textContent = host;
      contentEl.append(el('div', { class: 'canvas-link-card' }, icon('globe', 26), el('div', { class: 'canvas-link-host', text: host }), el('div', { class: 'canvas-link-url', text: node.url || '' }), open));
    } else {
      labelEl.textContent = node.label || '';
      if (node.background) {
        const file = app.vault.getFile(node.background);
        if (file) {
          nodeEl.style.setProperty('--canvas-bg', `url("${app.vault.fileUrl(node.background)}")`);
          nodeEl.dataset.bgStyle = node.backgroundStyle || 'cover';
        }
      }
    }
  }

  renderEdges(temp = null) {
    this.edgesSvg.textContent = '';
    this.labelsEl.textContent = '';
    const byId = new Map(this.data.nodes.map((n) => [n.id, n]));
    for (const edge of this.data.edges) {
      const from = byId.get(edge.fromNode);
      const to = byId.get(edge.toNode);
      if (!from || !to) continue;
      const auto = bestSides(from, to);
      const curve = edgeCurve(from, SIDES.includes(edge.fromSide) ? edge.fromSide : auto.fromSide, to, SIDES.includes(edge.toSide) ? edge.toSide : auto.toSide);
      const color = colorToCss(edge.color);
      const g = svg('g', { class: `canvas-edge${this.selection.has(edge.id) ? ' is-selected' : ''}`, 'data-id': edge.id });
      if (color) g.style.setProperty('--canvas-color', color);
      const d = curvePath(curve);
      g.append(svg('path', { class: 'canvas-edge-hit', d }), svg('path', { class: 'canvas-edge-line', d }));
      if ((edge.toEnd ?? 'arrow') === 'arrow') g.append(svg('path', { class: 'canvas-edge-arrow', d: arrowPath(curve.p3, curve.p2) }));
      if (edge.fromEnd === 'arrow') g.append(svg('path', { class: 'canvas-edge-arrow', d: arrowPath(curve.p0, curve.p1) }));
      this.edgesSvg.appendChild(g);
      if (edge.label) {
        const mid = curvePoint(curve, 0.5);
        const label = el('div', { class: `canvas-edge-label${this.selection.has(edge.id) ? ' is-selected' : ''}`, 'data-id': edge.id, text: edge.label });
        label.style.left = `${mid.x}px`;
        label.style.top = `${mid.y}px`;
        this.labelsEl.appendChild(label);
      }
    }
    if (temp) {
      const g = svg('g', { class: 'canvas-edge is-temporary' });
      g.append(svg('path', { class: 'canvas-edge-line', d: curvePath(temp) }), svg('path', { class: 'canvas-edge-arrow', d: arrowPath(temp.p3, temp.p1) }));
      this.edgesSvg.appendChild(g);
    }
  }

  /** Floating menu above the selection. */
  renderToolbar() {
    const bar = this.toolbarEl;
    const nodes = this.selectedNodes();
    const edges = this.selectedEdges();
    if ((!nodes.length && !edges.length) || this.drag || this.editing) {
      bar.classList.add('is-hidden');
      return;
    }
    bar.textContent = '';
    const button = (name, label, onClick) => {
      const b = el('button', { class: 'clickable-icon', 'aria-label': label, title: label }, icon(name, 16));
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(e);
      });
      bar.appendChild(b);
      return b;
    };
    button('trash', 'Excluir', () => this.deleteSelection());
    button('palette', 'Cor', (e) => this.showColorPicker(e.currentTarget));
    if (nodes.length) button('scan', 'Ampliar para a seleção', () => this.zoomToNodes(nodes));
    if (nodes.length === 1 && nodes[0].type === 'text') button('pencil', 'Editar', () => this.startEditing(nodes[0].id));
    if (nodes.length === 1 && nodes[0].type === 'file') button('external-link', 'Abrir em nova aba', () => this.openFileNode(nodes[0]));
    if (nodes.length === 1 && nodes[0].type === 'link') button('external-link', 'Abrir no navegador', () => this.openLink(nodes[0]));
    if (nodes.length === 1 && nodes[0].type === 'group') button('edit', 'Renomear grupo', () => this.editGroupLabel(nodes[0]));
    if (nodes.some((n) => n.type !== 'group')) button('group', 'Agrupar seleção', () => this.groupSelection());
    if (edges.length && !nodes.length) {
      button('arrow-left-right', 'Direção da seta', () => this.cycleEdgeDirection(edges));
      if (edges.length === 1) button('edit', 'Editar rótulo', () => this.editEdgeLabel(edges[0]));
    }

    // Position above the selection's bounding box.
    let box = bounds(nodes);
    if (!box) {
      const pts = [];
      for (const edge of edges) {
        const a = this.findNode(edge.fromNode);
        const b = this.findNode(edge.toNode);
        if (a && b) pts.push(a, b);
      }
      box = bounds(pts);
    }
    if (!box) {
      bar.classList.add('is-hidden');
      return;
    }
    bar.classList.remove('is-hidden');
    const topLeft = this.toScreen({ x: box.x, y: box.y });
    const right = this.toScreen({ x: box.x + box.width, y: box.y });
    const w = bar.offsetWidth;
    const x = Math.max(8, Math.min(this.wrapperEl.clientWidth - w - 8, (topLeft.x + right.x) / 2 - w / 2));
    const y = Math.max(8, topLeft.y - bar.offsetHeight - 14);
    bar.style.left = `${x}px`;
    bar.style.top = `${y}px`;
  }

  showColorPicker(anchor) {
    document.querySelector('.canvas-color-picker')?.remove();
    const picker = el('div', { class: 'canvas-color-picker' });
    const apply = (color) => {
      this.change(() => {
        for (const n of this.selectedNodes()) {
          if (color) n.color = color;
          else delete n.color;
        }
        for (const e of this.selectedEdges()) {
          if (color) e.color = color;
          else delete e.color;
        }
      });
      picker.remove();
    };
    const swatch = (color, title, css) => {
      const b = el('button', { class: `canvas-color-swatch${color ? '' : ' is-none'}`, title, 'aria-label': title });
      if (css) b.style.background = css;
      b.addEventListener('click', () => apply(color));
      picker.appendChild(b);
    };
    swatch(null, 'Sem cor');
    for (const c of CANVAS_COLORS) swatch(c.id, c.name, c.hex);
    const custom = el('input', { type: 'color', title: 'Cor personalizada' });
    custom.addEventListener('change', () => apply(custom.value));
    picker.appendChild(custom);
    const rect = anchor.getBoundingClientRect();
    const host = this.wrapperEl.getBoundingClientRect();
    picker.style.left = `${rect.left - host.left}px`;
    picker.style.top = `${rect.bottom - host.top + 6}px`;
    this.wrapperEl.appendChild(picker);
    const close = (e) => {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('pointerdown', close, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  buildControls() {
    const controls = el('div', { class: 'canvas-controls' });
    const group = (...buttons) => controls.appendChild(el('div', { class: 'canvas-control-group' }, buttons));
    const button = (name, label, onClick) => {
      const b = el('button', { class: 'clickable-icon', 'aria-label': label, title: label }, icon(name, 16));
      b.addEventListener('click', onClick);
      return b;
    };
    group(
      button('zoom-in', 'Aumentar zoom', () => this.zoomBy(1.25)),
      button('maximize', 'Ajustar à tela (Shift+1)', () => this.zoomToFit()),
      button('zoom-reset', 'Zoom 100%', () => this.setZoom(1)),
      button('zoom-out', 'Diminuir zoom', () => this.zoomBy(0.8)),
    );
    group(button('undo', 'Desfazer (Ctrl+Z)', () => this.undo()), button('redo', 'Refazer (Ctrl+Shift+Z)', () => this.redo()));
    for (const e of ['pointerdown', 'dblclick']) controls.addEventListener(e, (ev) => ev.stopPropagation());
    return controls;
  }

  buildCardMenu() {
    const menu = el('div', { class: 'canvas-card-menu' });
    const item = (name, label, onClick) => {
      const b = el('button', { class: 'canvas-card-menu-item', title: label, 'aria-label': label }, icon(name, 18));
      b.addEventListener('click', () => onClick(this.viewCenter()));
      menu.appendChild(b);
    };
    item('sticky-note', 'Adicionar cartão', (at) => this.addTextNode(at, true));
    item('file-text', 'Adicionar nota do cofre', (at) => this.pickFile(at, 'notes'));
    item('image', 'Adicionar mídia do cofre', (at) => this.pickFile(at, 'media'));
    item('globe', 'Adicionar página da web', (at) => this.addLinkNode(at));
    item('group', 'Adicionar grupo', (at) => this.addGroup(at));
    for (const e of ['pointerdown', 'dblclick']) menu.addEventListener(e, (ev) => ev.stopPropagation());
    return menu;
  }

  // --- viewport ------------------------------------------------------------------------------------

  setZoom(zoom, around = null) {
    const w = this.wrapperEl.clientWidth;
    const h = this.wrapperEl.clientHeight;
    const p = around || { x: w / 2, y: h / 2 };
    const v = this.viewport;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    v.x = p.x - ((p.x - v.x) * z) / v.zoom;
    v.y = p.y - ((p.y - v.y) * z) / v.zoom;
    v.zoom = z;
    this.applyViewport();
  }

  zoomBy(factor) {
    this.setZoom(this.viewport.zoom * factor);
  }

  zoomToFit(limit = true) {
    if (this.data.nodes.length) this.zoomToNodes(this.data.nodes, limit);
    else {
      this.viewport = { x: this.wrapperEl.clientWidth / 2, y: this.wrapperEl.clientHeight / 2, zoom: 1 };
      this.applyViewport();
    }
  }

  zoomToNodes(nodes, limit = true) {
    const box = bounds(nodes);
    const w = this.wrapperEl.clientWidth;
    const h = this.wrapperEl.clientHeight;
    if (!box || !w || !h) return;
    const pad = 60;
    let zoom = Math.min((w - pad * 2) / Math.max(box.width, 1), (h - pad * 2) / Math.max(box.height, 1));
    zoom = Math.min(limit ? 2 : 1, Math.max(MIN_ZOOM, zoom));
    this.viewport = { zoom, x: w / 2 - (box.x + box.width / 2) * zoom, y: h / 2 - (box.y + box.height / 2) * zoom };
    this.applyViewport();
  }

  // --- creating things ---------------------------------------------------------------------------------

  addNode(partial, at) {
    const node = { id: newId(), x: 0, y: 0, width: 250, height: 60, ...partial };
    node.x = snap(at.x - node.width / 2, GRID);
    node.y = snap(at.y - node.height / 2, GRID);
    this.data.nodes.push(node);
    return node;
  }

  addTextNode(at, edit = false, text = '') {
    let node;
    this.change(() => {
      node = this.addNode({ type: 'text', text }, at);
      this.selection = new Set([node.id]);
    });
    if (edit) this.startEditing(node.id);
    return node;
  }

  addFileNodes(paths, at) {
    this.change(() => {
      this.selection.clear();
      paths.forEach((path, i) => {
        const media = isMedia(path);
        const size = isMarkdown(path) ? { width: 400, height: 400 } : media && IMAGE_EXT.has(extname(path)) ? { width: 400, height: 300 } : media ? { width: 400, height: 240 } : { width: 300, height: 120 };
        const node = this.addNode({ type: 'file', file: path, ...size }, { x: at.x + i * 40, y: at.y + i * 40 });
        this.selection.add(node.id);
      });
    });
  }

  async addLinkNode(at) {
    const url = await promptText({ title: 'Adicionar página da web', placeholder: 'https://…', submitText: 'Adicionar' });
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return notice('Informe um endereço começando com http:// ou https://');
    this.change(() => {
      const node = this.addNode({ type: 'link', url, width: 400, height: 200 }, at);
      this.selection = new Set([node.id]);
    });
  }

  async addGroup(at) {
    this.change(() => {
      const node = this.addNode({ type: 'group', label: 'Grupo', width: 500, height: 400 }, at);
      this.selection = new Set([node.id]);
    });
  }

  groupSelection() {
    const nodes = this.selectedNodes().filter((n) => n.type !== 'group');
    const box = bounds(nodes);
    if (!box) return;
    this.change(() => {
      const pad = 40;
      const group = { id: newId(), type: 'group', label: 'Grupo', x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
      this.data.nodes.unshift(group);
      this.selection = new Set([group.id]);
    });
  }

  pickFile(at, kind) {
    const files = this.app.vault
      .getFiles()
      .map((f) => f.path)
      .filter((p) => p !== this.file && (kind === 'notes' ? isMarkdown(p) : isMedia(p)))
      .sort();
    if (!files.length) return notice(kind === 'notes' ? 'Nenhuma nota no cofre.' : 'Nenhuma imagem, PDF, áudio ou vídeo no cofre.');
    new FilePicker(this.app, files, (path) => this.addFileNodes([path], at), kind === 'notes' ? 'Escolha uma nota…' : 'Escolha um arquivo de mídia…').open();
  }

  // --- editing ------------------------------------------------------------------------------------------

  startEditing(id) {
    const node = this.findNode(id);
    if (!node || node.type !== 'text') return;
    this.stopEditing();
    const entry = this.nodeEls.get(id);
    if (!entry) return;
    const before = this.checkpoint();
    entry.contentEl.textContent = '';
    entry.contentEl.className = 'canvas-node-content is-editing';
    entry.el.classList.add('is-editing');
    const editor = createEditor(entry.contentEl, {
      doc: node.text || '',
      settings: { ...this.app.settings.data, showLineNumbers: false, foldHeadings: false },
      hooks: markdownEditorHooks(this.app, () => this.file, {
        onChange: (text) => {
          node.text = text;
          this.save();
        },
      }),
    });
    this.editing = { id, editor, before };
    this.selection = new Set([id]);
    this.renderToolbar();
    const end = editor.view.state.doc.length;
    editor.view.dispatch({ selection: { anchor: end } });
    editor.focus();
  }

  stopEditing() {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    editing.editor.destroy();
    const entry = this.nodeEls.get(editing.id);
    if (entry) {
      entry.el.classList.remove('is-editing');
      entry.signature = null;
    }
    this.commit(editing.before);
  }

  async editGroupLabel(node) {
    const value = await promptText({ title: 'Nome do grupo', value: node.label || '' });
    if (value == null) return;
    this.change(() => {
      if (value) node.label = value;
      else delete node.label;
    });
  }

  async editEdgeLabel(edge) {
    const value = await promptText({ title: 'Rótulo da conexão', value: edge.label || '' });
    if (value == null) return;
    this.change(() => {
      if (value) edge.label = value;
      else delete edge.label;
    });
  }

  cycleEdgeDirection(edges) {
    // one-way → both ways → no arrows → one-way
    this.change(() => {
      for (const e of edges) {
        const to = (e.toEnd ?? 'arrow') === 'arrow';
        const from = e.fromEnd === 'arrow';
        if (to && !from) {
          e.fromEnd = 'arrow';
        } else if (to && from) {
          e.fromEnd = 'none';
          e.toEnd = 'none';
        } else {
          delete e.fromEnd;
          delete e.toEnd;
        }
      }
    });
  }

  deleteSelection() {
    if (!this.selection.size) return;
    this.change(() => {
      const gone = new Set(this.selection);
      this.data.nodes = this.data.nodes.filter((n) => !gone.has(n.id));
      this.data.edges = this.data.edges.filter((e) => !gone.has(e.id) && !gone.has(e.fromNode) && !gone.has(e.toNode));
      this.selection.clear();
    });
  }

  duplicateSelection(offset = GRID * 2) {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    this.pasteItems({ nodes, edges: this.data.edges.filter((e) => this.selection.has(e.fromNode) && this.selection.has(e.toNode)) }, { dx: offset, dy: offset });
  }

  /** Inserts copies of nodes/edges with fresh ids, either shifted or centered on `at`. */
  pasteItems({ nodes, edges }, { dx = 0, dy = 0, at = null } = {}) {
    if (!nodes.length) return;
    if (at) {
      const box = bounds(nodes);
      dx = snap(at.x - (box.x + box.width / 2), GRID);
      dy = snap(at.y - (box.y + box.height / 2), GRID);
    }
    this.change(() => {
      const ids = new Map();
      this.selection.clear();
      for (const n of nodes) {
        const copy = { ...JSON.parse(JSON.stringify(n)), id: newId(), x: n.x + dx, y: n.y + dy };
        ids.set(n.id, copy.id);
        if (copy.type === 'group') this.data.nodes.unshift(copy);
        else this.data.nodes.push(copy);
        this.selection.add(copy.id);
      }
      for (const e of edges || []) {
        if (!ids.has(e.fromNode) || !ids.has(e.toNode)) continue;
        this.data.edges.push({ ...JSON.parse(JSON.stringify(e)), id: newId(), fromNode: ids.get(e.fromNode), toNode: ids.get(e.toNode) });
      }
    });
  }

  async copySelection(cut = false) {
    const nodes = this.selectedNodes();
    if (!nodes.length) return;
    const ids = new Set(nodes.map((n) => n.id));
    const edges = this.data.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
    await navigator.clipboard.writeText(JSON.stringify({ type: CLIPBOARD_MARK, nodes, edges }));
    if (cut) this.deleteSelection();
  }

  async paste() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    const at = this.pointerInside ? this.toWorld(this.pointer.x, this.pointer.y) : this.viewCenter();
    try {
      const data = JSON.parse(text);
      if (data?.type === CLIPBOARD_MARK && Array.isArray(data.nodes)) {
        const parsed = parseCanvas(JSON.stringify({ nodes: data.nodes, edges: data.edges || [] }));
        return this.pasteItems(parsed, { at });
      }
    } catch {
      /* plain text */
    }
    if (/^https?:\/\/\S+$/i.test(text.trim())) {
      this.change(() => {
        const node = this.addNode({ type: 'link', url: text.trim(), width: 400, height: 200 }, at);
        this.selection = new Set([node.id]);
      });
      return;
    }
    const wikilink = /^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(text.trim());
    const dest = wikilink && this.app.metadata.getFirstLinkpathDest(parseLinktext(wikilink[1]).path, this.file);
    if (dest) return this.addFileNodes([dest.path], at);
    this.addTextNode(at, false, text);
  }

  async convertToFile(node) {
    const first = (node.text || '').split('\n').find((l) => l.trim()) || 'Sem título';
    const name = await promptText({ title: 'Converter cartão em nota', value: sanitizeFileName(first.replace(/^#+\s*/, '')).slice(0, 80) || 'Sem título', submitText: 'Converter' });
    if (!name) return;
    const clean = sanitizeFileName(name);
    if (!clean) return notice('Nome inválido.');
    const path = this.app.vault.getAvailablePath(dirname(this.file), clean, 'md');
    await this.app.vault.create(path, node.text || '');
    this.change(() => {
      node.type = 'file';
      node.file = path;
      delete node.text;
    });
    notice(`Nota criada: ${stem(path)}`);
  }

  openFileNode(node) {
    if (!node.file || !this.app.vault.getFile(node.file)) return notice('Arquivo não encontrado.');
    this.app.openFile(node.file, { newLeaf: true, subpath: node.subpath });
  }

  openLink(node) {
    if (/^https?:\/\//i.test(node.url || '')) window.basalto.shell.openExternal(node.url);
  }

  // --- events -----------------------------------------------------------------------------------------------

  bindEvents() {
    const w = this.wrapperEl;
    w.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    w.addEventListener('pointermove', (e) => this.onPointerMove(e));
    w.addEventListener('pointerup', (e) => this.onPointerUp(e));
    w.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    w.addEventListener('pointerenter', () => (this.pointerInside = true));
    w.addEventListener('pointerleave', () => (this.pointerInside = false));
    w.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    w.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    w.addEventListener('keydown', (e) => this.onKeyDown(e));
    w.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        w.classList.remove('is-panning-ready');
      }
    });
    w.addEventListener('blur', () => {
      this.spaceDown = false;
      w.classList.remove('is-panning-ready');
    });
    w.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    w.addEventListener('dragover', (e) => {
      const types = e.dataTransfer.types;
      if (types.includes(PATH_DRAG) || types.includes('Files') || types.includes('text/uri-list')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    w.addEventListener('drop', (e) => this.onDrop(e));
  }

  hit(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return {};
    const nodeEl = t.closest('.canvas-node');
    return {
      nodeEl,
      node: nodeEl ? this.findNode(nodeEl.dataset.id) : null,
      connector: t.closest('.canvas-node-connection-point'),
      resizer: t.closest('.canvas-node-resizer'),
      edgeEl: t.closest('.canvas-edge, .canvas-edge-label'),
      ui: t.closest('.canvas-menu, .canvas-controls, .canvas-card-menu, .canvas-color-picker'),
    };
  }

  onPointerDown(e) {
    this.pointer = { x: e.clientX, y: e.clientY };
    const h = this.hit(e);
    if (h.ui) return;
    if (this.editing) {
      if (h.node?.id === this.editing.id && !h.connector && !h.resizer) return; // typing / selecting text
      this.stopEditing();
    }
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      e.preventDefault();
      return this.beginDrag(e, { type: 'pan', start: { ...this.viewport } });
    }
    if (e.button !== 0) return;
    if (!h.node || !h.nodeEl.contains(document.activeElement)) this.wrapperEl.focus({ preventScroll: true });

    if (h.connector && h.node) {
      e.preventDefault();
      return this.beginDrag(e, { type: 'connect', from: h.node, side: h.connector.dataset.side });
    }
    if (h.resizer && h.node) {
      e.preventDefault();
      this.selection = new Set([h.node.id]);
      return this.beginDrag(e, { type: 'resize', node: h.node, start: { width: h.node.width, height: h.node.height }, before: this.checkpoint() });
    }
    if (h.node) {
      // Let media controls (video/audio) and links inside cards work, but still allow dragging from them.
      if (e.shiftKey) {
        if (this.selection.has(h.node.id)) this.selection.delete(h.node.id);
        else this.selection.add(h.node.id);
      } else if (!this.selection.has(h.node.id)) {
        this.selection = new Set([h.node.id]);
      }
      this.renderSelection();
      const moving = new Map();
      for (const n of this.selectedNodes()) {
        moving.set(n.id, n);
        if (n.type === 'group') for (const inner of nodesInGroup(n, this.data.nodes)) moving.set(inner.id, inner);
      }
      const starts = new Map([...moving.values()].map((n) => [n.id, { x: n.x, y: n.y }]));
      return this.beginDrag(e, { type: 'move', nodes: [...moving.values()], starts, before: this.checkpoint(), clickedId: h.node.id });
    }
    if (h.edgeEl) {
      const id = h.edgeEl.dataset.id;
      if (e.shiftKey) {
        if (this.selection.has(id)) this.selection.delete(id);
        else this.selection.add(id);
      } else {
        this.selection = new Set([id]);
      }
      this.renderSelection();
      return;
    }
    // Empty space: rubber-band selection.
    if (!e.shiftKey) this.selection.clear();
    this.renderSelection();
    const start = this.toWorld(e.clientX, e.clientY);
    this.beginDrag(e, { type: 'box', start, base: new Set(this.selection) });
  }

  beginDrag(e, drag) {
    this.drag = { ...drag, startX: e.clientX, startY: e.clientY, moved: false, pointerId: e.pointerId };
    // Moving a card captures the pointer only once it really moves, so plain clicks still reach
    // links, checkboxes and media controls inside the card.
    if (drag.type !== 'move') this.capturePointer();
    if (drag.type === 'pan') this.wrapperEl.classList.add('is-panning');
    this.renderToolbar();
  }

  capturePointer() {
    try {
      this.wrapperEl.setPointerCapture(this.drag.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  onPointerMove(e) {
    this.pointer = { x: e.clientX, y: e.clientY };
    const d = this.drag;
    if (!d) return;
    const dxScreen = e.clientX - d.startX;
    const dyScreen = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dxScreen, dyScreen) < 3) return;
    if (!d.moved && d.type === 'move') {
      this.capturePointer();
      this.renderToolbar();
    }
    d.moved = true;
    const zoom = this.viewport.zoom;
    const dx = dxScreen / zoom;
    const dy = dyScreen / zoom;
    const snapIt = (v) => (e.altKey ? Math.round(v) : snap(v, GRID));

    if (d.type === 'pan') {
      this.viewport.x = d.start.x + dxScreen;
      this.viewport.y = d.start.y + dyScreen;
      this.applyViewport();
    } else if (d.type === 'move') {
      for (const n of d.nodes) {
        const s = d.starts.get(n.id);
        n.x = snapIt(s.x + dx);
        n.y = snapIt(s.y + dy);
        const entry = this.nodeEls.get(n.id);
        if (entry) {
          entry.el.style.left = `${n.x}px`;
          entry.el.style.top = `${n.y}px`;
        }
      }
      this.renderEdges();
    } else if (d.type === 'resize') {
      const n = d.node;
      n.width = Math.max(60, snapIt(d.start.width + dx));
      n.height = Math.max(40, snapIt(d.start.height + dy));
      const entry = this.nodeEls.get(n.id);
      if (entry) {
        entry.el.style.width = `${n.width}px`;
        entry.el.style.height = `${n.height}px`;
      }
      this.renderEdges();
    } else if (d.type === 'connect') {
      const p = this.toWorld(e.clientX, e.clientY);
      const target = this.nodeAtPoint(p, d.from.id);
      for (const entry of this.nodeEls.values()) entry.el.classList.toggle('is-connect-target', entry.el.dataset.id === target?.id);
      const end = target ? edgeCurve(d.from, d.side, target, nearestSide(target, p)) : edgeCurveToPoint(d.from, d.side, p);
      this.renderEdges(end);
    } else if (d.type === 'box') {
      const p = this.toWorld(e.clientX, e.clientY);
      const rect = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), width: Math.abs(p.x - d.start.x), height: Math.abs(p.y - d.start.y) };
      const a = this.toScreen(rect);
      Object.assign(this.boxEl.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${rect.width * zoom}px`, height: `${rect.height * zoom}px` });
      this.boxEl.classList.remove('is-hidden');
      this.selection = new Set(d.base);
      for (const n of this.data.nodes) if (intersects(rect, n)) this.selection.add(n.id);
      this.renderSelection(false);
    }
  }

  onPointerUp(e, canceled = false) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.wrapperEl.classList.remove('is-panning');
    this.boxEl.classList.add('is-hidden');
    try {
      this.wrapperEl.releasePointerCapture(d.pointerId);
    } catch {
      /* not captured */
    }
    if (this.pendingExternalText != null) {
      d.before = this.acceptExternalChange(d.before ?? null);
      this.render();
      if (this.serialize() !== this.lastSaved) this.save();
    }
    if (d.type === 'move') {
      if (d.moved) this.commit(d.before);
      else if (!e.shiftKey && this.selection.size > 1) {
        this.selection = new Set([d.clickedId]);
        this.renderSelection();
      }
    } else if (d.type === 'resize') {
      if (d.moved) this.commit(d.before);
    } else if (d.type === 'connect') {
      for (const entry of this.nodeEls.values()) entry.el.classList.remove('is-connect-target');
      if (canceled || !d.moved || !this.findNode(d.from.id)) return this.renderEdges();
      const p = this.toWorld(e.clientX, e.clientY);
      const target = this.nodeAtPoint(p, d.from.id);
      if (target) {
        this.change(() => {
          const edge = { id: newId(), fromNode: d.from.id, fromSide: d.side, toNode: target.id, toSide: nearestSide(target, p) };
          this.data.edges.push(edge);
          this.selection = new Set([edge.id]);
        });
      } else {
        // Dropping on empty space creates a connected card there.
        let node;
        this.change(() => {
          node = this.addNode({ type: 'text', text: '' }, p);
          const toSide = nearestSide(node, this.findNode(d.from.id) ? { x: d.from.x + d.from.width / 2, y: d.from.y + d.from.height / 2 } : p);
          this.data.edges.push({ id: newId(), fromNode: d.from.id, fromSide: d.side, toNode: node.id, toSide });
          this.selection = new Set([node.id]);
        });
        this.startEditing(node.id);
      }
    } else if (d.type === 'pan') {
      this.renderToolbar();
    } else {
      this.renderToolbar();
    }
  }

  /** Topmost node under a world point (cards before groups). */
  nodeAtPoint(p, excludeId) {
    const hits = this.data.nodes.filter((n) => n.id !== excludeId && p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height);
    return hits.filter((n) => n.type !== 'group').pop() || hits.sort((a, b) => a.width * a.height - b.width * b.height)[0] || null;
  }

  renderSelection(toolbar = true) {
    for (const [id, entry] of this.nodeEls) entry.el.classList.toggle('is-selected', this.selection.has(id));
    for (const g of this.edgesSvg.querySelectorAll('.canvas-edge[data-id]')) g.classList.toggle('is-selected', this.selection.has(g.dataset.id));
    for (const l of this.labelsEl.children) l.classList.toggle('is-selected', this.selection.has(l.dataset.id));
    if (toolbar) this.renderToolbar();
    if (this.app?.workspace?.activeLeaf?.view === this) this.app.updateStatusBar?.();
  }

  onDoubleClick(e) {
    const h = this.hit(e);
    if (h.ui) return;
    if (h.node) {
      if (this.editing?.id === h.node.id) return;
      if (h.node.type === 'text') this.startEditing(h.node.id);
      else if (h.node.type === 'file') this.openFileNode(h.node);
      else if (h.node.type === 'link') this.openLink(h.node);
      else if (h.node.type === 'group' && e.target.closest('.canvas-node-label')) this.editGroupLabel(h.node);
      else if (h.node.type === 'group') this.addTextNode(this.toWorld(e.clientX, e.clientY), true);
      return;
    }
    if (h.edgeEl) {
      const edge = this.findEdge(h.edgeEl.dataset.id);
      if (edge) this.editEdgeLabel(edge);
      return;
    }
    this.addTextNode(this.toWorld(e.clientX, e.clientY), true);
  }

  onWheel(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('.canvas-controls, .canvas-card-menu, .canvas-menu')) return;
    // Scroll inside a selected/edited card when its content overflows.
    const content = t?.closest('.canvas-node.is-selected .canvas-node-content, .canvas-node.is-editing .canvas-node-content, .canvas-node.is-editing .cm-scroller');
    if (content && !e.ctrlKey) {
      const scroller = content.classList.contains('cm-scroller') ? content : content.querySelector('.cm-scroller') || content;
      const canScroll = e.deltaY < 0 ? scroller.scrollTop > 0 : scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
      if (canScroll) return;
    }
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = this.wrapperEl.getBoundingClientRect();
      this.setZoom(this.viewport.zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.viewport.x -= dx;
      this.viewport.y -= dy;
      this.applyViewport();
    }
  }

  onKeyDown(e) {
    if (this.editing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.stopEditing();
        this.wrapperEl.focus({ preventScroll: true });
      }
      return;
    }
    if (e.target !== this.wrapperEl && e.target.closest('input, textarea, [contenteditable="true"]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.code === 'Space' && !mod) {
      e.preventDefault();
      this.spaceDown = true;
      this.wrapperEl.classList.add('is-panning-ready');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteSelection();
    } else if (e.key === 'Escape') {
      this.selection.clear();
      this.renderSelection();
    } else if (e.key === 'Enter') {
      const nodes = this.selectedNodes();
      if (nodes.length === 1 && nodes[0].type === 'text') {
        e.preventDefault();
        this.startEditing(nodes[0].id);
      }
    } else if (mod && key === 'a') {
      e.preventDefault();
      this.selection = new Set(this.data.nodes.map((n) => n.id));
      this.renderSelection();
    } else if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod && key === 'c') {
      e.preventDefault();
      this.copySelection();
    } else if (mod && key === 'x') {
      e.preventDefault();
      this.copySelection(true);
    } else if (mod && key === 'v') {
      e.preventDefault();
      this.paste();
    } else if (mod && key === 'd') {
      e.preventDefault();
      this.duplicateSelection();
    } else if (e.shiftKey && e.code === 'Digit1') {
      e.preventDefault();
      this.zoomToFit();
    } else if (e.shiftKey && e.code === 'Digit2') {
      e.preventDefault();
      const nodes = this.selectedNodes();
      if (nodes.length) this.zoomToNodes(nodes);
    } else if (e.key.startsWith('Arrow') && this.selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? GRID * 5 : GRID;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      this.change(() => {
        const moving = new Map();
        for (const n of this.selectedNodes()) {
          moving.set(n.id, n);
          if (n.type === 'group') for (const inner of nodesInGroup(n, this.data.nodes)) moving.set(inner.id, inner);
        }
        for (const n of moving.values()) {
          n.x += dx;
          n.y += dy;
        }
      });
    }
  }

  onContextMenu(e) {
    const h = this.hit(e);
    if (h.ui || this.editing) return;
    e.preventDefault();
    const at = this.toWorld(e.clientX, e.clientY);
    const menu = new Menu();
    if (h.node) {
      if (!this.selection.has(h.node.id)) {
        this.selection = new Set([h.node.id]);
        this.renderSelection();
      }
      const n = h.node;
      if (n.type === 'text') {
        menu.addItem({ title: 'Editar', icon: 'pencil', onClick: () => this.startEditing(n.id) });
        menu.addItem({ title: 'Converter em nota', icon: 'file-plus', onClick: () => this.convertToFile(n) });
      }
      if (n.type === 'file') menu.addItem({ title: 'Abrir em nova aba', icon: 'external-link', onClick: () => this.openFileNode(n) });
      if (n.type === 'link') menu.addItem({ title: 'Abrir no navegador', icon: 'external-link', onClick: () => this.openLink(n) });
      if (n.type === 'group') menu.addItem({ title: 'Renomear grupo', icon: 'edit', onClick: () => this.editGroupLabel(n) });
      menu.addSeparator();
      menu.addItem({ title: 'Copiar', icon: 'copy', onClick: () => this.copySelection() });
      menu.addItem({ title: 'Duplicar', icon: 'copy', onClick: () => this.duplicateSelection() });
      menu.addItem({ title: 'Trazer para a frente', onClick: () => this.reorder(1) });
      menu.addItem({ title: 'Enviar para trás', onClick: () => this.reorder(-1) });
      menu.addSeparator();
      menu.addItem({ title: 'Excluir', icon: 'trash', danger: true, onClick: () => this.deleteSelection() });
    } else if (h.edgeEl) {
      const edge = this.findEdge(h.edgeEl.dataset.id);
      if (!edge) return;
      this.selection = new Set([edge.id]);
      this.renderSelection();
      menu.addItem({ title: 'Editar rótulo', icon: 'edit', onClick: () => this.editEdgeLabel(edge) });
      menu.addItem({ title: 'Alterar direção', icon: 'arrow-left-right', onClick: () => this.cycleEdgeDirection([edge]) });
      menu.addItem({ title: 'Ir para a origem', onClick: () => this.zoomToNodes([this.findNode(edge.fromNode)].filter(Boolean)) });
      menu.addItem({ title: 'Ir para o destino', onClick: () => this.zoomToNodes([this.findNode(edge.toNode)].filter(Boolean)) });
      menu.addSeparator();
      menu.addItem({ title: 'Excluir', icon: 'trash', danger: true, onClick: () => this.deleteSelection() });
    } else {
      menu.addItem({ title: 'Adicionar cartão', icon: 'sticky-note', onClick: () => this.addTextNode(at, true) });
      menu.addItem({ title: 'Adicionar nota do cofre', icon: 'file-text', onClick: () => this.pickFile(at, 'notes') });
      menu.addItem({ title: 'Adicionar mídia do cofre', icon: 'image', onClick: () => this.pickFile(at, 'media') });
      menu.addItem({ title: 'Adicionar página da web', icon: 'globe', onClick: () => this.addLinkNode(at) });
      menu.addItem({ title: 'Adicionar grupo', icon: 'group', onClick: () => this.addGroup(at) });
      menu.addSeparator();
      menu.addItem({ title: 'Colar', icon: 'copy', onClick: () => this.paste() });
      menu.addItem({ title: 'Selecionar tudo', onClick: () => { this.selection = new Set(this.data.nodes.map((n) => n.id)); this.renderSelection(); } });
      menu.addItem({ title: 'Ajustar à tela', icon: 'maximize', onClick: () => this.zoomToFit() });
    }
    menu.showAtMouseEvent(e);
  }

  /** Moves the selected nodes to the end (front) or start (back) of the list. */
  reorder(direction) {
    this.change(() => {
      const picked = this.data.nodes.filter((n) => this.selection.has(n.id));
      const rest = this.data.nodes.filter((n) => !this.selection.has(n.id));
      this.data.nodes = direction > 0 ? [...rest, ...picked] : [...picked, ...rest];
    });
  }

  async onDrop(e) {
    e.preventDefault();
    const at = this.toWorld(e.clientX, e.clientY);
    const path = e.dataTransfer.getData(PATH_DRAG);
    if (path) {
      const entry = this.app.vault.entries.get(path);
      if (entry?.type === 'folder') {
        const files = this.app.vault.getFiles().filter((f) => dirname(f.path) === path).map((f) => f.path);
        return this.addFileNodes(files.slice(0, 30), at);
      }
      if (path !== this.file) this.addFileNodes([path], at);
      return;
    }
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) {
      const paths = await this.app.saveAttachmentFiles(files, this.file);
      return this.addFileNodes(paths, at);
    }
    const url = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => /^https?:/i.test(l));
    if (url) {
      this.change(() => {
        const node = this.addNode({ type: 'link', url: url.trim(), width: 400, height: 200 }, at);
        this.selection = new Set([node.id]);
      });
    }
  }

  showMoreMenu(e) {
    const menu = new Menu();
    this.app.addBookmarkMenuItem(menu, this.file);
    menu.addItem({ title: 'Ajustar à tela', icon: 'maximize', onClick: () => this.zoomToFit() });
    menu.addItem({ title: 'Dividir à direita', icon: 'columns', onClick: () => this.app.workspace.splitLeaf(this.leaf) });
    menu.addSeparator();
    menu.addItem({ title: 'Renomear…', icon: 'edit', onClick: () => this.app.promptRename(this.file) });
    menu.addItem({ title: 'Abrir no aplicativo padrão', icon: 'external-link', onClick: () => window.basalto.shell.openPath(this.file) });
    menu.addItem({ title: 'Mostrar no explorador do sistema', icon: 'folder-open', onClick: () => window.basalto.shell.reveal(this.file) });
    menu.addSeparator();
    menu.addItem({ title: 'Excluir arquivo', icon: 'trash', danger: true, onClick: () => this.app.deleteFile(this.file) });
    menu.showAtMouseEvent(e);
  }
}
