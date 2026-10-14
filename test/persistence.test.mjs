import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { flushTextEdits } from '../src/renderer/core/persistence.js';
import { MarkdownView } from '../src/renderer/views/markdown-view.js';
import { Leaf, Pane } from '../src/renderer/workspace/workspace.js';

const require = createRequire(import.meta.url);
const { atomicWrite, SerialQueue } = require('../src/main/persistence.js');
const { CloseBarrier } = require('../src/main/close-barrier.js');
const { VaultFs } = require('../src/main/vault-fs.js');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('flush waits for an existing save and persists edits typed during it', async () => {
  const firstWrite = deferred();
  const writes = [];
  const view = { file: 'Nota.md', text: 'primeira edição', dirty: true };
  const write = async (file, text) => {
    writes.push([file, text]);
    if (writes.length === 1) await firstWrite.promise;
  };
  const first = flushTextEdits(view, write);
  view.text = 'segunda edição';
  const second = flushTextEdits(view, write);
  assert.equal(first, second);
  assert.equal(view.dirty, true);
  firstWrite.resolve();
  await second;
  assert.deepEqual(writes, [['Nota.md', 'primeira edição'], ['Nota.md', 'segunda edição']]);
  assert.equal(view.dirty, false);
});

test('failed saves retain unsaved text and can be retried', async () => {
  const view = { file: 'Nota.md', text: 'conteúdo que não pode ser perdido', dirty: true };
  await assert.rejects(flushTextEdits(view, async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(view.dirty, true);
  assert.equal(view.text, 'conteúdo que não pode ser perdido');
  let saved;
  await flushTextEdits(view, async (_file, text) => { saved = text; });
  assert.equal(saved, view.text);
  assert.equal(view.dirty, false);
});

test('Markdown navigation preserves the current editor if saving fails', async () => {
  let mounted = false;
  const view = {
    file: 'Atual.md', text: 'rascunho ainda não salvo', dirty: true,
    app: { vault: { getFile: () => ({ type: 'file' }) } },
    saveNow: async () => { throw new Error('read only'); },
    mountEditor: () => { mounted = true; },
  };
  await assert.rejects(MarkdownView.prototype.setState.call(view, { file: 'Outra.md' }), /read only/);
  assert.equal(view.file, 'Atual.md');
  assert.equal(view.text, 'rascunho ainda não salvo');
  assert.equal(view.dirty, true);
  assert.equal(mounted, false);
});

function fakeLeaf(view) {
  const pane = { renderTabs() {}, contentEl: { appendChild() {} } };
  const workspace = { emit() {}, requestSave() {} };
  const leaf = new Leaf(workspace, pane);
  leaf.view = view;
  return leaf;
}

test('rapid navigation is applied in order and records completed history', async () => {
  const gate = deferred();
  let current = 'Inicial.md';
  const view = {
    type: 'markdown', getState: () => ({ file: current }),
    async setState(state) {
      if (state.file === 'A.md') await gate.promise;
      current = state.file;
    },
  };
  const leaf = fakeLeaf(view);
  const first = leaf.setViewState({ type: 'markdown', state: { file: 'A.md' } });
  const second = leaf.setViewState({ type: 'markdown', state: { file: 'B.md' } });
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(current, 'B.md');
  assert.deepEqual(leaf.back.map((state) => state.state.file), ['Inicial.md', 'A.md']);
});

test('failed navigation does not discard a view or change its history', async () => {
  let removed = false;
  const view = {
    type: 'markdown', getState: () => ({ file: 'Atual.md' }),
    onClose: async () => { throw new Error('save failed'); },
    containerEl: { remove() { removed = true; } },
  };
  const leaf = fakeLeaf(view);
  await assert.rejects(leaf.setViewState({ type: 'empty', state: {} }), /save failed/);
  assert.equal(leaf.view, view);
  assert.equal(removed, false);
  assert.deepEqual(leaf.back, []);
});

test('closing a tab waits for saving and retains it on failure', async () => {
  const view = { onClose: async () => { throw new Error('save failed'); } };
  const leaf = { view };
  const pane = { leaves: [leaf] };
  await assert.rejects(Pane.prototype.removeLeaf.call(pane, leaf), /save failed/);
  assert.deepEqual(pane.leaves, [leaf]);
});

test('window close requires a successful flush and allows retry after failure', () => {
  const requests = [];
  const errors = [];
  let closed = 0;
  let prevented = 0;
  const barrier = new CloseBarrier({ request: (id) => requests.push(id), close: () => closed++, failed: (error) => errors.push(error) });
  const event = { preventDefault() { prevented++; } };
  assert.equal(barrier.onClose(event), false);
  assert.equal(barrier.onClose(event), false);
  assert.deepEqual(requests, [1]);
  assert.equal(barrier.complete(999, null), false);
  assert.equal(closed, 0);
  barrier.complete(1, 'disk full');
  assert.deepEqual(errors, ['disk full']);
  barrier.onClose(event);
  assert.deepEqual(requests, [1, 2]);
  barrier.complete(2, null);
  assert.equal(closed, 1);
  assert.equal(barrier.onClose(event), true);
  assert.equal(prevented, 3);
});

test('vault mutations stay ordered after a failed operation', async () => {
  const queue = new SerialQueue();
  const gate = deferred();
  const order = [];
  const first = queue.run(async () => { await gate.promise; order.push('write'); });
  const failed = queue.run(async () => { order.push('failed'); throw new Error('failure'); });
  const last = queue.run(async () => { order.push('rename'); });
  const rejection = assert.rejects(failed, /failure/);
  gate.resolve();
  await Promise.all([first, rejection, last]);
  assert.deepEqual(order, ['write', 'failed', 'rename']);
});

async function withTempDirectory(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'basalto-persistence-'));
  try {
    return await run(dir);
  } finally {
    // Only remove files from this exact throwaway directory; never recurse through a vault.
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const file of await fs.readdir(item)) await fs.unlink(path.join(item, file));
        await fs.rmdir(item);
      } else await fs.unlink(item);
    }
    await fs.rmdir(dir);
  }
}

test('an interrupted atomic replacement leaves the original note intact', async () => {
  await withTempDirectory(async (dir) => {
    const file = path.join(dir, 'Nota.md');
    await fs.writeFile(file, 'versão anterior');
    const failingFs = { ...fs, rename: async () => { throw new Error('replacement failed'); } };
    await assert.rejects(atomicWrite(file, 'versão nova', failingFs), /replacement failed/);
    assert.equal(await fs.readFile(file, 'utf8'), 'versão anterior');
    assert.deepEqual(await fs.readdir(dir), ['Nota.md']);
  });
});

test('concurrent config snapshots and a note write followed by rename stay intact', async () => {
  await withTempDirectory(async (dir) => {
    const vault = new VaultFs(dir);
    const snapshots = Array.from({ length: 12 }, (_, index) => ({ index, text: 'x'.repeat(1000 + index) }));
    await Promise.all(snapshots.map((snapshot) => vault.writeConfig('workspace.json', snapshot)));
    assert.deepEqual(await vault.readConfig('workspace.json'), snapshots.at(-1));
    const write = vault.write('Antes.md', 'edição mais recente');
    const rename = vault.rename('Antes.md', 'Depois.md');
    await Promise.all([write, rename]);
    assert.equal(await vault.read('Depois.md'), 'edição mais recente');
    assert.equal(vault.exists('Antes.md'), false);
    assert.deepEqual((await fs.readdir(path.join(dir, '.basalto'))), ['workspace.json']);
  });
});
