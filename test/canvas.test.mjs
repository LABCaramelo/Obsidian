import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as canvas from '../src/renderer/core/canvas.js';

const { parseCanvas, serializeCanvas, mergeCanvas } = canvas;
const clone = (value) => JSON.parse(JSON.stringify(value));
const card = (id, text = id, x = 0) => ({ id, type: 'text', text, x, y: 0, width: 250, height: 60 });
const documentOf = (...nodes) => ({ nodes, edges: [], extra: {} });

// Exercise the actual view methods without starting Electron or a DOM. Its constructor
// builds the browser UI; these tests supply only the persistence/editor boundaries.
const source = (await readFile(new URL('../src/renderer/views/canvas-view.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace('export class CanvasView', 'class CanvasView');
const notices = [];
const dependencies = { View: class {}, ...canvas, notice: (message) => notices.push(message) };
const CanvasView = new Function(...Object.keys(dependencies), `${source}\nreturn CanvasView;`)(...Object.values(dependencies));

function viewOf(data = documentOf(card('a'))) {
  const writes = [];
  let disk = serializeCanvas(data);
  const save = () => {};
  save.cancel = () => {};
  const classes = { add() {}, remove() {}, toggle() {} };
  const view = Object.assign(Object.create(CanvasView.prototype), {
    file: 'board.canvas', data: clone(data), lastSaved: disk,
    pendingExternalText: null, pendingSave: null, queuedText: null, pendingWrites: new Set(),
    history: [], future: [], selection: new Set(), nodeEls: new Map(),
    editing: null, drag: null, save, render() {}, renderNodes() {}, renderEdges() {}, renderToolbar() {},
    renderSelection() {}, wrapperEl: { classList: classes, releasePointerCapture() {} },
    boxEl: { classList: classes }, resizeObserver: { disconnect() {} }, offs: [],
  });
  view.app = { vault: {
    getFile: (path) => path === 'board.canvas' ? { path } : null,
    cachedRead: () => disk,
    async write(path, text) { writes.push({ path, text }); disk = text; view.onExternalChange(); },
  } };
  return { view, writes, setDisk(text) { disk = text; }, disk: () => disk };
}

test('JSON Canvas round trip preserves extension properties and all node types', () => {
  const raw = {
    custom: { version: 1 },
    nodes: [card('a'), { ...card('b'), type: 'file', file: 'Notes/a.md', subpath: '#Part', custom: true },
      { ...card('c'), type: 'link', url: 'https://example.com' },
      { ...card('d'), type: 'group', label: 'Group', background: 'image.png', backgroundStyle: 'repeat' }],
    edges: [{ id: 'edge', fromNode: 'a', toNode: 'b', fromSide: 'bottom', toSide: 'top', label: 'Related', custom: 7 }],
  };
  assert.deepEqual(JSON.parse(serializeCanvas(parseCanvas(JSON.stringify(raw)))), raw);
  assert.deepEqual(parseCanvas(''), documentOf());
  assert.throws(() => parseCanvas('{'));
  assert.throws(() => parseCanvas('[]'));
});

test('parser normalizes geometry, numeric ids, duplicate ids and dangling edges', () => {
  const parsed = parseCanvas(JSON.stringify({
    nodes: [card(0), { ...card('a'), width: -2, height: '80', x: 'bad' }, card('a'), null, []],
    edges: [{ id: 'a', fromNode: 0, toNode: 'a' }, { id: 'edge', fromNode: 'a', toNode: 'missing' },
      { id: 'a', fromNode: 'a', toNode: 0 }],
  }));
  assert.equal(parsed.nodes.length, 3);
  assert.equal(parsed.nodes[0].id, '0');
  assert.equal(parsed.nodes[1].width, 20);
  assert.equal(parsed.nodes[1].height, 80);
  assert.equal(parsed.nodes[1].x, 0);
  assert.equal(parsed.edges.length, 2);
  assert.equal(parsed.edges[0].fromNode, '0');
  const ids = [...parsed.nodes, ...parsed.edges].map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(canvas.colorToCss('#abcde'), null);
  assert.equal(canvas.colorToCss('#12345678'), '#12345678');
  assert.equal(canvas.colorToCss('4'), '#30a46c');
});

test('geometry anchors, grouping, curves and file remapping follow their records', () => {
  const group = { ...card('group'), type: 'group', x: -20, y: -20, width: 400, height: 200 };
  const inside = card('inside');
  const outside = card('outside', '', 600);
  assert.deepEqual(canvas.nodesInGroup(group, [group, inside, outside]), [inside]);
  const sides = canvas.bestSides(inside, outside);
  assert.deepEqual(sides, { fromSide: 'right', toSide: 'left' });
  const curve = canvas.edgeCurve(inside, sides.fromSide, outside, sides.toSide);
  assert.deepEqual(canvas.curvePoint(curve, 0), canvas.anchorPoint(inside, 'right'));
  assert.deepEqual(canvas.curvePoint(curve, 1), canvas.anchorPoint(outside, 'left'));
  assert.ok(!canvas.curvePath(curve).includes('NaN'));
  const data = documentOf({ ...inside, type: 'file', file: 'old/a.md' }, { ...group, background: 'old/bg.png' });
  assert.equal(canvas.remapFilePaths(data, (path) => path.replace('old/', 'new/')), true);
  assert.equal(data.nodes[0].file, 'new/a.md');
  assert.equal(data.nodes[1].background, 'new/bg.png');
});

test('file renames also update undo/redo snapshots and obey automatic-link settings', () => {
  const data = documentOf({ ...card('file'), type: 'file', file: 'Old.md' });
  const { view } = viewOf(data);
  view.history = [view.lastSaved];
  view.future = [view.lastSaved];
  view.onVaultRename({ path: 'New.md' }, 'Old.md');
  assert.equal(view.data.nodes[0].file, 'New.md');
  assert.equal(parseCanvas(view.history[0]).nodes[0].file, 'New.md');
  assert.equal(parseCanvas(view.future[0]).nodes[0].file, 'New.md');
  view.app.settings = { get: () => false };
  view.onVaultRename({ path: 'Other.md' }, 'New.md');
  assert.equal(view.data.nodes[0].file, 'New.md');
});

test('a converted text card receives file-card styling', () => {
  const { view } = viewOf();
  const activeClasses = new Set(['canvas-node-text']);
  const entry = {
    el: { classList: { toggle(name, active) { if (active) activeClasses.add(name); else activeClasses.delete(name); } },
      style: { setProperty() {}, removeProperty() {} } },
    signature: 'before',
  };
  view.renderNodeContent = () => {};
  view.app.vault.getFile = () => ({ mtime: 1 });
  view.updateNodeEl({ ...card('a'), type: 'file', file: 'New.md' }, entry, false);
  assert.equal(activeClasses.has('canvas-node-file'), true);
  assert.equal(activeClasses.has('canvas-node-text'), false);
});

test('merge preserves independent fields, additions, unknown data and local conflicts', () => {
  const base = documentOf(card('a'));
  base.extra = { original: true, title: 'Before' };
  const local = clone(base);
  local.nodes[0].text = 'Local';
  local.nodes.push(card('local'));
  delete local.extra.original;
  const remote = clone(base);
  remote.nodes[0].x = 400;
  remote.nodes[0].text = 'Remote';
  remote.nodes.push(card('remote'));
  remote.extra.title = 'Remote title';
  const result = mergeCanvas(base, local, remote);
  assert.deepEqual(result.nodes.map((node) => node.id), ['a', 'local', 'remote']);
  assert.equal(result.nodes[0].text, 'Local');
  assert.equal(result.nodes[0].x, 400);
  assert.deepEqual(result.extra, { title: 'Remote title' });
});

test('merge respects deletes, retains edited nodes and removes dangling connections', () => {
  const base = documentOf(card('a'), card('b'), card('c'));
  base.edges = [{ id: 'ab', fromNode: 'a', toNode: 'b' }, { id: 'ac', fromNode: 'a', toNode: 'c' }];
  const local = clone(base);
  local.nodes[0].text = 'Edited';
  local.nodes = local.nodes.filter((node) => node.id !== 'b');
  const remote = clone(base);
  remote.nodes = remote.nodes.filter((node) => node.id === 'b');
  const result = mergeCanvas(base, local, remote);
  assert.deepEqual(result.nodes.map((node) => node.id), ['a']);
  assert.equal(result.nodes[0].text, 'Edited');
  assert.deepEqual(result.edges, []);
});

test('an unchanged loaded canvas is not rewritten just because JSON formatting differs', async () => {
  const { view, writes } = viewOf();
  view.app.vault.read = async () => JSON.stringify({ nodes: [card('a')], edges: [] });
  await view.load();
  await view.saveNow();
  assert.equal(writes.length, 0);
});

test('save waits for disk, serializes writes and ignores its own modify echoes', async () => {
  const { view, writes } = viewOf();
  let finishFirst;
  view.app.vault.write = async (path, text) => {
    writes.push({ path, text });
    if (writes.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
  };
  view.data.nodes[0].text = 'First';
  const first = view.saveNow();
  await Promise.resolve();
  await Promise.resolve();
  view.data.nodes[0].text = 'Second';
  const second = view.saveNow();
  assert.equal(writes.length, 1);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(writes.map((write) => parseCanvas(write.text).nodes[0].text), ['First', 'Second']);
  assert.equal(parseCanvas(view.lastSaved).nodes[0].text, 'Second');
  assert.equal(view.pendingSave, null);
  const normal = viewOf();
  normal.view.data.nodes[0].text = 'Saved';
  normal.view.history.push(normal.view.lastSaved);
  await normal.view.saveNow();
  assert.equal(normal.view.history.length, 1);
  assert.equal(normal.view.pendingExternalText, null);
});

test('failed saves reject and retain the changed document for retry', async () => {
  const { view, writes } = viewOf();
  view.data.nodes[0].text = 'Unsaved';
  const original = view.lastSaved;
  view.app.vault.write = async () => { throw new Error('Disk full'); };
  await assert.rejects(view.saveNow(), /Disk full/);
  assert.equal(view.lastSaved, original);
  assert.equal(view.data.nodes[0].text, 'Unsaved');
  view.app.vault.write = async (path, text) => writes.push({ path, text });
  await view.saveNow();
  assert.equal(parseCanvas(writes[0].text).nodes[0].text, 'Unsaved');
});

test('simultaneous pane flushes persist the combined state before they resolve', async () => {
  const first = viewOf();
  const second = viewOf();
  const views = [first.view, second.view];
  let disk = first.disk();
  let queue = Promise.resolve();
  for (const view of views) view.app.vault = {
    getFile: () => ({ path: 'board.canvas' }), cachedRead: () => disk,
    write(path, text) {
      const operation = queue.then(async () => {
        await Promise.resolve();
        disk = text;
        for (const pane of views) pane.onExternalChange();
      });
      queue = operation;
      return operation;
    },
  };
  first.view.data.nodes[0].text = 'First pane';
  second.view.data.nodes[0].x = 400;
  await Promise.all(views.map((view) => view.saveNow()));
  assert.equal(parseCanvas(disk).nodes[0].text, 'First pane');
  assert.equal(parseCanvas(disk).nodes[0].x, 400);
  for (const view of views) assert.equal(view.serialize(), serializeCanvas(parseCanvas(disk)));
});

test('changes from another pane merge with local unsaved edits and reset stale undo', () => {
  const { view, setDisk } = viewOf();
  view.data.nodes[0].text = 'Local';
  view.history.push(view.lastSaved);
  const remote = documentOf({ ...card('a'), x: 300 }, card('remote'));
  setDisk(serializeCanvas(remote));
  view.onExternalChange();
  assert.equal(view.data.nodes[0].text, 'Local');
  assert.equal(view.data.nodes[0].x, 300);
  assert.equal(view.data.nodes.length, 2);
  assert.equal(view.history.length, 0);
});

test('external updates wait for card editing, and undo preserves the remote addition', async () => {
  const { view, setDisk, writes } = viewOf();
  const before = view.lastSaved;
  let destroyed = false;
  view.editing = { id: 'a', before, editor: { destroy() { destroyed = true; } } };
  view.data.nodes[0].text = 'Local edit';
  setDisk(serializeCanvas(documentOf(card('a'), card('remote'))));
  view.onExternalChange();
  assert.equal(writes.length, 0);
  assert.equal(view.data.nodes.length, 1);
  view.stopEditing();
  assert.equal(destroyed, true);
  assert.equal(view.data.nodes.length, 2);
  assert.equal(view.data.nodes[0].text, 'Local edit');
  view.undo();
  assert.deepEqual(view.data.nodes.map((node) => node.id), ['a', 'remote']);
  assert.equal(view.data.nodes[0].text, 'a');
  view.redo();
  assert.equal(view.data.nodes[0].text, 'Local edit');
  await view.saveNow();
  assert.equal(parseCanvas(writes[0].text).nodes.length, 2);
});

test('an explicit flush finalizes editing and writes both local and deferred external changes', async () => {
  const { view, setDisk, writes } = viewOf();
  view.editing = { id: 'a', before: view.lastSaved, editor: { destroy() {} } };
  view.data.nodes[0].text = 'Pending typing';
  setDisk(serializeCanvas(documentOf(card('a'), card('remote'))));
  view.onExternalChange();
  await view.saveNow();
  assert.equal(view.editing, null);
  const saved = parseCanvas(writes.at(-1).text);
  assert.equal(saved.nodes.length, 2);
  assert.equal(saved.nodes[0].text, 'Pending typing');
  assert.equal(view.serialize(), view.lastSaved);
});

test('an explicit flush ends an active move and saves the remote addition with its coordinates', async () => {
  const { view, setDisk, writes } = viewOf();
  view.drag = { type: 'move', before: view.lastSaved, moved: true, pointerId: 1 };
  view.data.nodes[0].x = 500;
  setDisk(serializeCanvas(documentOf(card('a'), card('remote'))));
  view.onExternalChange();
  await view.saveNow();
  assert.equal(view.drag, null);
  const saved = parseCanvas(writes.at(-1).text);
  assert.equal(saved.nodes.length, 2);
  assert.equal(saved.nodes[0].x, 500);
  assert.equal(view.serialize(), view.lastSaved);
});

test('undo commits the first active edit; redo after a new edit keeps the canvas', () => {
  const { view } = viewOf();
  view.editing = { id: 'a', before: view.lastSaved, editor: { destroy() {} } };
  view.data.nodes[0].text = 'First edit';
  view.undo();
  assert.equal(view.data.nodes[0].text, 'a');
  assert.equal(view.future.length, 1);
  view.editing = { id: 'a', before: view.serialize(), editor: { destroy() {} } };
  view.data.nodes[0].text = 'New branch';
  view.redo();
  assert.equal(view.data.nodes.length, 1);
  assert.equal(view.data.nodes[0].text, 'New branch');
  assert.equal(view.future.length, 0);
});

test('ending a pan applies deferred external data; canceling a connection adds no card', () => {
  const { view, setDisk } = viewOf();
  view.drag = { type: 'pan', pointerId: 1 };
  setDisk(serializeCanvas(documentOf(card('a'), card('remote'))));
  view.onExternalChange();
  view.onPointerUp({});
  assert.equal(view.data.nodes.length, 2);
  view.drag = { type: 'connect', from: view.data.nodes[0], side: 'right', moved: true, pointerId: 1 };
  view.onPointerUp({}, true);
  assert.equal(view.data.nodes.length, 2);
  assert.equal(view.data.edges.length, 0);
});

test('invalid external JSON preserves local content and blocks overwriting it', async () => {
  const { view, setDisk, writes } = viewOf();
  view.data.nodes[0].text = 'Local edit';
  setDisk('{broken');
  view.onExternalChange();
  await assert.rejects(view.saveNow(), /JSON inválido/);
  assert.equal(writes.length, 0);
  assert.equal(view.data.nodes[0].text, 'Local edit');
  setDisk(serializeCanvas(documentOf(card('a'), card('remote'))));
  view.onExternalChange();
  await view.saveNow();
  assert.equal(view.data.nodes[0].text, 'Local edit');
  assert.equal(view.data.nodes.length, 2);
});

test('closing waits for persistence and leaves the view mounted on write failure', async () => {
  const { view } = viewOf();
  let disconnected = false;
  view.resizeObserver.disconnect = () => { disconnected = true; };
  view.data.nodes[0].text = 'Unsaved';
  view.app.vault.write = async () => { throw new Error('Offline'); };
  await assert.rejects(view.onClose(), /Offline/);
  assert.equal(disconnected, false);
  view.app.vault.write = async () => {};
  await view.onClose();
  assert.equal(disconnected, true);
});
