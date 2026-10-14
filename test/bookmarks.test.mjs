import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bookmarks, bookmarkTitle } from '../src/renderer/core/bookmarks.js';

const memoryStorage = (initial = null) => {
  let data = initial;
  return { readConfig: async () => structuredClone(data), writeConfig: async (_, value) => { data = structuredClone(value); } };
};

test('bookmarks persist nested groups, section links and search options in their own config', async () => {
  const storage = memoryStorage();
  const store = new Bookmarks(storage);
  await store.load();
  const group = store.add({ type: 'group', title: 'Pesquisa' });
  const note = store.add({ type: 'file', path: 'Ideias/Árvore.md', subpath: '#Raízes' }, group.id);
  store.add({ type: 'search', query: 'tag:#projeto -arquivo', matchCase: true, title: 'Projetos ativos' }, group.id);
  store.add({ type: 'folder', path: 'Ideias' });
  store.rename(note.id, 'Minha árvore');
  store.toggleGroup(group.id);
  await store.flush();
  const reopened = new Bookmarks(storage);
  await reopened.load();
  assert.deepEqual(reopened.items, store.items);
  assert.equal(reopened.find(note.id).subpath, '#Raízes');
  assert.equal(reopened.findTarget({ type: 'search', query: 'tag:#projeto -arquivo', matchCase: true }).title, 'Projetos ativos');
});

test('file bookmarks follow folder renames without rewriting unrelated paths or custom titles', async () => {
  const store = new Bookmarks(memoryStorage());
  const group = store.add({ type: 'group', title: 'Trabalho' });
  const file = store.add({ type: 'file', path: 'Notas/A.md', subpath: '#^bloco', title: 'Favorito' }, group.id);
  const folder = store.add({ type: 'folder', path: 'Notas' });
  const other = store.add({ type: 'file', path: 'Notas antigas/A.md' });
  assert.equal(store.remapPath('Notas', 'Arquivo'), true);
  assert.equal(file.path, 'Arquivo/A.md');
  assert.equal(folder.path, 'Arquivo');
  assert.equal(file.subpath, '#^bloco');
  assert.equal(bookmarkTitle(file), 'Favorito');
  assert.equal(other.path, 'Notas antigas/A.md');
  assert.equal(store.remapPath('Arquivo/A.md', 'Arquivo/B.md'), true);
  assert.equal(file.path, 'Arquivo/B.md');
  await store.flush();
});

test('moving favorites preserves order and rejects moving groups inside themselves or descendants', async () => {
  const store = new Bookmarks(memoryStorage());
  const a = store.add({ type: 'group', title: 'A' });
  const b = store.add({ type: 'group', title: 'B' }, a.id);
  const first = store.add({ type: 'file', path: 'A.md' });
  const second = store.add({ type: 'file', path: 'B.md' });
  assert.equal(store.move(a.id, a.id), false);
  assert.equal(store.move(a.id, b.id), false);
  assert.equal(store.move(first.id, a.id), true);
  assert.equal(store.move(second.id, a.id, first.id), true);
  assert.deepEqual(a.items.map((item) => item.id), [b.id, second.id, first.id]);
  assert.equal(store.move(first.id, a.id, 'not-an-item'), false);
  assert.equal(store.move(first.id), true);
  assert.equal(store.items.at(-1).id, first.id);
  assert.equal(store.remove(a.id), true);
  assert.equal(store.find(b.id), null);
  assert.equal(store.find(first.id), first);
  await store.flush();
});

test('bookmarks deduplicate targets across groups while allowing distinct headings and search modes', async () => {
  const store = new Bookmarks(memoryStorage());
  const group = store.add({ type: 'group', title: 'G' });
  const note = store.add({ type: 'file', path: 'A.md' });
  assert.equal(store.add({ type: 'file', path: 'A.md' }, group.id), note);
  assert.notEqual(store.add({ type: 'file', path: 'A.md', subpath: '#Seção' }).id, note.id);
  const search = store.add({ type: 'search', query: 'Abc' });
  assert.notEqual(store.add({ type: 'search', query: 'Abc', matchCase: true }).id, search.id);
  assert.throws(() => store.add({ type: 'file', path: '../private.md' }));
  assert.throws(() => store.add({ type: 'file', path: 'C:/private.md' }));
  await store.flush();
});

test('failed bookmark writes can be retried and preserve the in-memory tree', async () => {
  const storage = memoryStorage();
  const write = storage.writeConfig;
  let fail = true;
  storage.writeConfig = async (...args) => { if (fail) throw new Error('disk full'); return write(...args); };
  const store = new Bookmarks(storage);
  store.add({ type: 'file', path: 'A.md' });
  await assert.rejects(store.flush(), /disk full/);
  assert.equal(store.items.length, 1);
  assert.equal(store.savedRevision, 0);
  fail = false;
  await store.flush();
  assert.equal(store.savedRevision, store.revision);
  assert.equal((await storage.readConfig()).items[0].path, 'A.md');
});

test('overlapping flushes commit snapshots in order and await the latest revision', async () => {
  const writes = [];
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const store = new Bookmarks({ writeConfig: async (_, data) => {
    if (!writes.length) await barrier;
    writes.push(data.items.map((item) => item.path));
  } });
  store.add({ type: 'file', path: 'A.md' });
  const first = store.flush();
  await Promise.resolve();
  store.add({ type: 'file', path: 'B.md' });
  const second = store.flush();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [['A.md'], ['A.md', 'B.md']]);
  assert.equal(store.savedRevision, store.revision);
});

test('loading malformed bookmarks drops invalid entries, repairs duplicate ids and keeps missing files', async () => {
  const store = new Bookmarks(memoryStorage({ items: [
    null, { type: 'file', path: '../bad' }, { type: 'unknown' },
    { id: 'x', type: 'file', path: 'Missing.md' },
    { id: 'x', type: 'folder', path: 'Folder.md' },
    { type: 'group', items: 'invalid' },
  ] }));
  await store.load();
  assert.equal(store.items.length, 3);
  assert.equal(new Set([...store.walk()].map((item) => item.id)).size, 3);
  assert.equal(bookmarkTitle(store.items[0]), 'Missing');
  assert.equal(bookmarkTitle(store.items[1]), 'Folder.md');
  assert.deepEqual(store.items[2].items, []);
});
