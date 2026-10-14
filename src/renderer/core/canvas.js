// JSON Canvas (.canvas) data helpers. The format is the open JSON Canvas spec:
// { nodes: [{ id, type: text|file|link|group, x, y, width, height, color?, … }],
//   edges: [{ id, fromNode, fromSide?, fromEnd?, toNode, toSide?, toEnd?, color?, label? }] }
// Unknown keys are kept as-is so files written by other apps survive a round trip.

export const SIDES = ['top', 'right', 'bottom', 'left'];

/** Preset colors "1"–"6" of the spec: red, orange, yellow, green, cyan, purple. */
export const CANVAS_COLORS = [
  { id: '1', name: 'Vermelho', hex: '#e5484d' },
  { id: '2', name: 'Laranja', hex: '#f76b15' },
  { id: '3', name: 'Amarelo', hex: '#d6a700' },
  { id: '4', name: 'Verde', hex: '#30a46c' },
  { id: '5', name: 'Ciano', hex: '#12a594' },
  { id: '6', name: 'Roxo', hex: '#8e4ec6' },
];

export function colorToCss(color) {
  if (!color) return null;
  const preset = CANVAS_COLORS.find((c) => c.id === String(color));
  if (preset) return preset.hex;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : null;
}

export function newId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Parses canvas text; tolerates empty files and drops nodes/edges that cannot be drawn. */
export function parseCanvas(text) {
  let raw = {};
  if (text && text.trim()) {
    raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('O arquivo não é um canvas válido');
  }
  const { nodes = [], edges = [], ...extra } = raw;
  const seen = new Set();
  const outNodes = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) continue;
    const node = { ...n, id: String(n.id ?? newId()) || newId() };
    if (seen.has(node.id)) node.id = newId();
    seen.add(node.id);
    node.type = ['text', 'file', 'link', 'group'].includes(n.type) ? n.type : 'text';
    node.x = num(n.x, 0);
    node.y = num(n.y, 0);
    node.width = Math.max(20, num(n.width, 250));
    node.height = Math.max(20, num(n.height, 60));
    outNodes.push(node);
  }
  const nodeIds = new Set(seen);
  const outEdges = [];
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const fromNode = String(e.fromNode ?? '');
    const toNode = String(e.toNode ?? '');
    if (!nodeIds.has(fromNode) || !nodeIds.has(toNode)) continue;
    let id = String(e.id ?? newId()) || newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    outEdges.push({ ...e, id, fromNode, toNode });
  }
  return { nodes: outNodes, edges: outEdges, extra };
}

/** Serializes back to JSON (tab-indented, nodes before edges). */
export function serializeCanvas({ nodes, edges, extra = {} }) {
  return JSON.stringify({ ...extra, nodes, edges }, null, '\t');
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge for two open views of the same file. Independent fields and additions
 * survive. A local field change wins a conflict; a remotely deleted unchanged item stays
 * deleted, while a locally edited item survives a simultaneous remote deletion.
 */
export function mergeCanvas(base, local, remote) {
  const mergeRecord = (before = {}, ours = {}, theirs = {}) => {
    const merged = { ...theirs };
    for (const key of new Set([...Object.keys(before), ...Object.keys(ours)])) {
      if (same(before[key], ours[key])) continue;
      if (Object.hasOwn(ours, key)) merged[key] = ours[key];
      else delete merged[key];
    }
    return merged;
  };
  const mergeItems = (before, ours, theirs) => {
    const old = new Map(before.map((item) => [item.id, item]));
    const mine = new Map(ours.map((item) => [item.id, item]));
    const other = new Map(theirs.map((item) => [item.id, item]));
    const localOrderChanged = !same(before.map((item) => item.id), ours.map((item) => item.id));
    const order = new Set([...(localOrderChanged ? ours : theirs).map((item) => item.id), ...theirs.map((item) => item.id), ...ours.map((item) => item.id)]);
    const result = [];
    for (const id of order) {
      const previous = old.get(id);
      const localItem = mine.get(id);
      const remoteItem = other.get(id);
      if (!localItem) {
        if (!previous && remoteItem) result.push({ ...remoteItem });
      } else if (!remoteItem) {
        if (!previous || !same(previous, localItem)) result.push({ ...localItem });
      } else result.push(mergeRecord(previous, localItem, remoteItem));
    }
    return result;
  };
  const nodes = mergeItems(base.nodes, local.nodes, remote.nodes);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = mergeItems(base.edges, local.edges, remote.edges).filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode));
  return { nodes, edges, extra: mergeRecord(base.extra, local.extra, remote.extra) };
}

// --- geometry ---------------------------------------------------------------------------

export function anchorPoint(node, side) {
  const { x, y, width: w, height: h } = node;
  switch (side) {
    case 'top':
      return { x: x + w / 2, y };
    case 'bottom':
      return { x: x + w / 2, y: y + h };
    case 'left':
      return { x, y: y + h / 2 };
    default:
      return { x: x + w, y: y + h / 2 };
  }
}

const NORMALS = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

/** Picks the pair of sides that gives the shortest connection between two nodes. */
export function bestSides(from, to) {
  let best = null;
  for (const a of SIDES) {
    for (const b of SIDES) {
      const p = anchorPoint(from, a);
      const q = anchorPoint(to, b);
      // Penalize sides facing away from the other node.
      const [nx, ny] = NORMALS[a];
      const [mx, my] = NORMALS[b];
      const away = Math.max(0, -((q.x - p.x) * nx + (q.y - p.y) * ny)) + Math.max(0, -((p.x - q.x) * mx + (p.y - q.y) * my));
      const d = Math.hypot(q.x - p.x, q.y - p.y) + away * 2;
      if (!best || d < best.d) best = { d, fromSide: a, toSide: b };
    }
  }
  return { fromSide: best.fromSide, toSide: best.toSide };
}

/** The side of `node` closest to point `p`. */
export function nearestSide(node, p) {
  let best = 'right';
  let bestD = Infinity;
  for (const side of SIDES) {
    const a = anchorPoint(node, side);
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = side;
    }
  }
  return best;
}

/** Cubic Bézier for an edge: start/end points plus two control points. */
export function edgeCurve(fromNode, fromSide, toNode, toSide) {
  const p0 = anchorPoint(fromNode, fromSide);
  const p3 = anchorPoint(toNode, toSide);
  const dist = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const k = Math.min(150, Math.max(40, dist / 2));
  const [ax, ay] = NORMALS[fromSide];
  const [bx, by] = NORMALS[toSide];
  return {
    p0,
    p1: { x: p0.x + ax * k, y: p0.y + ay * k },
    p2: { x: p3.x + bx * k, y: p3.y + by * k },
    p3,
  };
}

/** Same curve when the edge end follows the pointer (while connecting). */
export function edgeCurveToPoint(fromNode, fromSide, point) {
  const p0 = anchorPoint(fromNode, fromSide);
  const dist = Math.hypot(point.x - p0.x, point.y - p0.y);
  const k = Math.min(150, Math.max(30, dist / 2));
  const [ax, ay] = NORMALS[fromSide];
  return { p0, p1: { x: p0.x + ax * k, y: p0.y + ay * k }, p2: point, p3: point };
}

export function curvePath({ p0, p1, p2, p3 }) {
  return `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;
}

export function curvePoint({ p0, p1, p2, p3 }, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Arrowhead triangle at `tip`, pointing along the direction from `from` to `tip`. */
export function arrowPath(tip, from, size = 12) {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const a = { x: tip.x - size * Math.cos(angle - 0.45), y: tip.y - size * Math.sin(angle - 0.45) };
  const b = { x: tip.x - size * Math.cos(angle + 0.45), y: tip.y - size * Math.sin(angle + 0.45) };
  return `M${tip.x},${tip.y} L${a.x},${a.y} L${b.x},${b.y} Z`;
}

export function bounds(nodes) {
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

export function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Nodes that lie completely inside a group (and so move with it). */
export function nodesInGroup(group, nodes) {
  return nodes.filter((n) => n !== group && contains(group, n));
}

/** Rewrites file references after a rename; returns true when something changed. */
export function remapFilePaths(data, mapPath) {
  let changed = false;
  for (const node of data.nodes) {
    if (node.type === 'file' && typeof node.file === 'string') {
      const next = mapPath(node.file);
      if (next && next !== node.file) {
        node.file = next;
        changed = true;
      }
    }
    if (node.type === 'group' && typeof node.background === 'string') {
      const next = mapPath(node.background);
      if (next && next !== node.background) {
        node.background = next;
        changed = true;
      }
    }
  }
  return changed;
}

/** Snaps a value to the grid. */
export function snap(v, grid = 20) {
  return Math.round(v / grid) * grid;
}
