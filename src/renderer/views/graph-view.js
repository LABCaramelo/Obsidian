import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from 'd3-force';
import { View } from '../workspace/workspace.js';
import { el, debounce, stem, basename, isMarkdown } from '../core/util.js';
import { icon } from '../ui/icons.js';

/**
 * Force-directed graph of notes and their links.
 * Settings keys mirror the original graph.json (search, showTags, hideUnresolved, repelStrength…).
 */
export class GraphView extends View {
  constructor(leaf) {
    super(leaf);
    this.containerEl.classList.add('graph-view');
    this.canvas = el('canvas', { class: 'graph-canvas' });
    this.ctx = this.canvas.getContext('2d');
    this.controlsEl = el('div', { class: 'graph-controls is-collapsed' });
    this.containerEl.append(this.canvas, this.controlsEl);

    this.transform = { x: 0, y: 0, k: 1 };
    this.nodes = [];
    this.links = [];
    this.nodeById = new Map();
    this.hover = null;
    this.drag = null;
    this.colors = {};
    this.needsDraw = true;

    this.refreshData = debounce(() => this.buildData(), 300);
    this.buildControls();
    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
  }

  get type() {
    return 'graph';
  }

  getDisplayText() {
    return 'Visualização em grafo';
  }

  getIcon() {
    return 'graph';
  }

  get settings() {
    return this.app.graphSettings;
  }

  onOpen() {
    this.resizeObserver.observe(this.containerEl);
    this.offs = [
      this.app.metadata.on('resolved', () => this.refreshData()),
      this.app.vault.on('create', () => this.refreshData()),
      this.app.vault.on('delete', () => this.refreshData()),
      this.app.vault.on('rename', () => this.refreshData()),
      this.app.workspace.on('file-open', () => (this.needsDraw = true)),
      this.app.on('theme-change', () => this.readColors()),
    ];
    this.readColors();
    this.buildData();
    const loop = () => {
      if (this.needsDraw) this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  onClose() {
    cancelAnimationFrame(this.raf);
    this.simulation?.stop();
    this.resizeObserver.disconnect();
    this.offs?.forEach((off) => off());
  }

  onShow() {
    this.resize();
  }

  readColors() {
    const style = getComputedStyle(document.body);
    const v = (name) => style.getPropertyValue(name).trim();
    this.colors = {
      node: v('--graph-node'),
      unresolved: v('--graph-node-unresolved'),
      tag: v('--graph-node-tag'),
      attachment: v('--graph-node-attachment'),
      focused: v('--interactive-accent'),
      line: v('--graph-line'),
      lineHighlight: v('--interactive-accent'),
      text: v('--text-normal'),
      bg: v('--background-primary'),
      font: v('--font-interface') || 'sans-serif',
    };
    this.needsDraw = true;
  }

  resize() {
    const rect = this.containerEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    if (!this.centered) {
      this.transform.x = rect.width / 2;
      this.transform.y = rect.height / 2;
      this.transform.k = this.settings.get('scale') || 1;
      this.centered = true;
    }
    this.needsDraw = true;
  }

  // --- data ---------------------------------------------------------------------

  buildData() {
    const s = this.settings.data;
    const { vault, metadata } = this.app;
    const previous = this.nodeById;
    const nodes = new Map();
    const links = [];
    const add = (id, type, label) => {
      if (nodes.has(id)) return nodes.get(id);
      const old = previous.get(id);
      const node = { id, type, label, degree: 0, x: old?.x ?? (Math.random() - 0.5) * 400, y: old?.y ?? (Math.random() - 0.5) * 400, vx: old?.vx ?? 0, vy: old?.vy ?? 0 };
      nodes.set(id, node);
      return node;
    };

    const query = (s.search || '').trim().toLowerCase();
    const matches = (path) => {
      if (!query) return true;
      if (query.startsWith('tag:')) return metadata.getFileTags(path).some((t) => t.toLowerCase() === query.slice(4).trim().replace(/^#?/, '#'));
      return path.toLowerCase().includes(query);
    };

    for (const file of vault.getMarkdownFiles()) if (matches(file.path)) add(file.path, 'note', stem(file.path));
    if (s.showAttachments) {
      for (const file of vault.getFiles()) if (!isMarkdown(file.path) && matches(file.path)) add(file.path, 'attachment', basename(file.path));
    }

    for (const [source, dests] of Object.entries(metadata.resolvedLinks)) {
      if (!nodes.has(source)) continue;
      for (const dest of Object.keys(dests)) {
        if (!nodes.has(dest) || dest === source) continue;
        links.push({ source, target: dest });
      }
    }
    if (!s.hideUnresolved) {
      for (const [source, dests] of Object.entries(metadata.unresolvedLinks)) {
        if (!nodes.has(source)) continue;
        for (const name of Object.keys(dests)) {
          add(`unresolved:${name}`, 'unresolved', name);
          links.push({ source, target: `unresolved:${name}` });
        }
      }
    }
    if (s.showTags) {
      for (const node of [...nodes.values()]) {
        if (node.type !== 'note') continue;
        for (const tag of metadata.getFileTags(node.id)) {
          add(`tag:${tag}`, 'tag', tag);
          links.push({ source: node.id, target: `tag:${tag}` });
        }
      }
    }

    for (const l of links) {
      nodes.get(l.source).degree++;
      nodes.get(l.target).degree++;
    }
    let list = [...nodes.values()];
    if (!s.showOrphans) list = list.filter((n) => n.degree > 0);
    const kept = new Set(list.map((n) => n.id));

    this.nodes = list;
    this.links = links.filter((l) => kept.has(l.source) && kept.has(l.target));
    this.nodeById = new Map(list.map((n) => [n.id, n]));
    this.neighbors = new Map(list.map((n) => [n.id, new Set()]));
    for (const l of this.links) {
      this.neighbors.get(l.source).add(l.target);
      this.neighbors.get(l.target).add(l.source);
    }
    this.restartSimulation(previous.size === 0 ? 1 : 0.3);
  }

  restartSimulation(alpha = 0.3) {
    const s = this.settings.data;
    this.simulation?.stop();
    this.simulation = forceSimulation(this.nodes)
      .force(
        'link',
        forceLink(this.links.map((l) => ({ ...l })))
          .id((d) => d.id)
          .distance(s.linkDistance * 0.4)
          .strength(Math.min(1, s.linkStrength * 0.5)),
      )
      .force('charge', forceManyBody().strength(-s.repelStrength * 25).distanceMax(800))
      .force('x', forceX(0).strength(s.centerStrength * 0.08))
      .force('y', forceY(0).strength(s.centerStrength * 0.08))
      .force('collide', forceCollide((d) => this.radius(d) + 3))
      .alpha(alpha)
      .alphaDecay(0.03)
      .on('tick', () => (this.needsDraw = true));
    this.simLinks = this.simulation.force('link').links();
  }

  radius(node) {
    return (3 + Math.sqrt(node.degree) * 1.6) * this.settings.data.nodeSizeMultiplier;
  }

  // --- rendering ----------------------------------------------------------------------

  draw() {
    this.needsDraw = false;
    const { ctx, transform: t } = this;
    const dpr = window.devicePixelRatio || 1;
    if (!this.width) return;
    const s = this.settings.data;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const focus = this.hover;
    const neighbors = focus ? this.neighbors.get(focus.id) : null;
    const active = this.app.workspace.getActiveFile();

    // Links
    ctx.lineWidth = (s.lineSizeMultiplier * 1) / Math.max(0.5, t.k);
    for (const link of this.simLinks || []) {
      const a = link.source;
      const b = link.target;
      const highlighted = focus && (a.id === focus.id || b.id === focus.id);
      ctx.globalAlpha = focus && !highlighted ? 0.15 : 0.6;
      ctx.strokeStyle = highlighted ? this.colors.lineHighlight : this.colors.line;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (s.showArrow) this.drawArrow(a, b);
    }

    // Nodes
    for (const node of this.nodes) {
      const dim = focus && node !== focus && !neighbors?.has(node.id);
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.fillStyle =
        node.id === active || node === focus
          ? this.colors.focused
          : { note: this.colors.node, unresolved: this.colors.unresolved, tag: this.colors.tag, attachment: this.colors.attachment }[node.type];
      ctx.beginPath();
      ctx.arc(node.x, node.y, this.radius(node), 0, Math.PI * 2);
      ctx.fill();
    }

    // Labels fade in with zoom.
    const base = Math.max(0, Math.min(1, (t.k - 0.6 + s.textFadeMultiplier * 0.15) * 1.5));
    ctx.font = `${12 / Math.max(t.k, 0.6)}px ${this.colors.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = this.colors.text;
    for (const node of this.nodes) {
      const emphasized = focus && (node === focus || neighbors?.has(node.id));
      const alpha = emphasized ? 1 : focus ? base * 0.3 : base;
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = alpha;
      ctx.fillText(node.label, node.x, node.y + this.radius(node) + 3);
    }
    ctx.globalAlpha = 1;
  }

  drawArrow(a, b) {
    const { ctx } = this;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const r = this.radius(b) + 2;
    const x = b.x - Math.cos(angle) * r;
    const y = b.y - Math.sin(angle) * r;
    const size = 5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(angle - 0.4), y - size * Math.sin(angle - 0.4));
    ctx.lineTo(x - size * Math.cos(angle + 0.4), y - size * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  // --- interaction ------------------------------------------------------------------------

  toGraph(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - this.transform.x) / this.transform.k, y: (clientY - rect.top - this.transform.y) / this.transform.k };
  }

  nodeAt(clientX, clientY) {
    const p = this.toGraph(clientX, clientY);
    let best = null;
    let bestDist = Infinity;
    for (const node of this.nodes) {
      const d = Math.hypot(node.x - p.x, node.y - p.y);
      if (d < this.radius(node) + 4 / this.transform.k && d < bestDist) {
        best = node;
        bestDist = d;
      }
    }
    return best;
  }

  bindPointer() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const t = this.transform;
      const k = Math.min(8, Math.max(0.05, t.k * Math.exp(-e.deltaY * 0.0015)));
      t.x = mx - ((mx - t.x) * k) / t.k;
      t.y = my - ((my - t.y) * k) / t.k;
      t.k = k;
      this.needsDraw = true;
      this.saveScale();
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const node = this.nodeAt(e.clientX, e.clientY);
      this.drag = { node, startX: e.clientX, startY: e.clientY, x: this.transform.x, y: this.transform.y, moved: false };
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
        this.simulation.alphaTarget(0.2).restart();
      }
    });

    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) {
        const node = this.nodeAt(e.clientX, e.clientY);
        if (node !== this.hover) {
          this.hover = node;
          c.style.cursor = node ? 'pointer' : 'default';
          this.needsDraw = true;
        }
        return;
      }
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 3) d.moved = true;
      if (d.node) {
        const p = this.toGraph(e.clientX, e.clientY);
        d.node.fx = p.x;
        d.node.fy = p.y;
      } else {
        this.transform.x = d.x + (e.clientX - d.startX);
        this.transform.y = d.y + (e.clientY - d.startY);
      }
      this.needsDraw = true;
    });

    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.node) {
        d.node.fx = null;
        d.node.fy = null;
        this.simulation.alphaTarget(0);
        if (!d.moved) this.openNode(d.node, e.ctrlKey || e.metaKey);
      }
    });

    c.addEventListener('pointerleave', () => {
      if (!this.drag && this.hover) {
        this.hover = null;
        this.needsDraw = true;
      }
    });
  }

  openNode(node, newLeaf) {
    if (node.type === 'tag') {
      this.app.openSearch(`tag:${node.label}`);
    } else if (node.type === 'unresolved') {
      this.app.openLinkText(node.label, '', newLeaf);
    } else {
      this.app.openFile(node.id, { newLeaf });
    }
  }

  saveScale = debounce(() => this.settings.set({ scale: Math.round(this.transform.k * 1000) / 1000 }), 500);

  // --- controls -----------------------------------------------------------------------------

  buildControls() {
    const s = () => this.settings.data;
    const toggle = el('button', { class: 'clickable-icon graph-controls-toggle', 'aria-label': 'Configurações do grafo' }, icon('settings'));
    toggle.addEventListener('click', () => this.controlsEl.classList.toggle('is-collapsed'));
    const body = el('div', { class: 'graph-controls-body' });
    this.controlsEl.append(toggle, body);

    const section = (title) => {
      const sec = el('div', { class: 'graph-control-section' }, el('div', { class: 'graph-control-section-title', text: title }));
      body.appendChild(sec);
      return sec;
    };
    const update = (patch, rebuild = true) => {
      this.settings.set(patch);
      if (rebuild) this.buildData();
      else this.restartSimulation(0.5);
      this.needsDraw = true;
    };
    const checkbox = (parent, label, key) => {
      const input = el('input', { type: 'checkbox' });
      input.checked = !!s()[key];
      input.addEventListener('change', () => update({ [key]: input.checked }));
      parent.appendChild(el('label', { class: 'graph-control-row' }, el('span', { text: label }), input));
    };
    const slider = (parent, label, key, min, max, step, rebuild = false) => {
      const input = el('input', { type: 'range', min, max, step });
      input.value = s()[key];
      input.addEventListener('input', () => {
        this.settings.set({ [key]: Number(input.value) });
        if (rebuild) this.restartSimulation(0.5);
        this.needsDraw = true;
      });
      parent.appendChild(el('label', { class: 'graph-control-row is-slider' }, el('span', { text: label }), input));
    };

    const filters = section('Filtros');
    const search = el('input', { type: 'search', class: 'graph-search', placeholder: 'Buscar arquivos… (ou tag:#x)' });
    search.value = s().search || '';
    search.addEventListener('input', debounce(() => update({ search: search.value }), 250));
    filters.appendChild(search);
    checkbox(filters, 'Tags', 'showTags');
    checkbox(filters, 'Anexos', 'showAttachments');
    checkbox(filters, 'Somente arquivos existentes', 'hideUnresolved');
    checkbox(filters, 'Órfãos', 'showOrphans');

    const display = section('Exibição');
    checkbox(display, 'Setas', 'showArrow');
    slider(display, 'Limite de esmaecimento do texto', 'textFadeMultiplier', -3, 3, 0.1);
    slider(display, 'Tamanho dos nós', 'nodeSizeMultiplier', 0.1, 5, 0.1);
    slider(display, 'Espessura das linhas', 'lineSizeMultiplier', 0.1, 5, 0.1);

    const forces = section('Forças');
    slider(forces, 'Força de centralização', 'centerStrength', 0, 1, 0.01, true);
    slider(forces, 'Força de repulsão', 'repelStrength', 0, 20, 0.5, true);
    slider(forces, 'Força dos links', 'linkStrength', 0, 1, 0.01, true);
    slider(forces, 'Distância dos links', 'linkDistance', 30, 500, 1, true);

    const reset = el('button', { class: 'graph-reset', text: 'Centralizar' });
    reset.addEventListener('click', () => {
      this.transform = { x: this.width / 2, y: this.height / 2, k: 1 };
      this.needsDraw = true;
      this.restartSimulation(0.6);
    });
    body.appendChild(reset);
  }
}
