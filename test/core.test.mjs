import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote, splitFrontmatter, parseLinktext, parseSubpath, maskNonProse } from '../src/renderer/core/parse.js';
import { MetadataCache } from '../src/renderer/core/metadata.js';
import { parseQuery, runSearch } from '../src/renderer/core/search.js';
import { formatDate, fuzzyMatch, stem, dirname, joinPath, countWords } from '../src/renderer/core/util.js';
import { EditorState } from '@codemirror/state';
import { toggleWrap, toggleChecklist, insertMarkdownLink, insertWikilink } from '../src/renderer/editor/editor.js';

test('parseNote extracts wikilinks, aliases, embeds and markdown links', () => {
  const note = parseNote('Veja [[Nota A]] e [[pasta/Nota B|apelido]].\n![[imagem.png]]\n[texto](Outra%20Nota.md) e [site](https://x.com)');
  assert.deepEqual(note.links.map((l) => l.link), ['Nota A', 'pasta/Nota B', 'Outra Nota.md']);
  assert.equal(note.links[1].displayText, 'apelido');
  assert.deepEqual(note.embeds.map((e) => e.link), ['imagem.png']);
  assert.equal(note.links[0].position.start.line, 0);
  assert.equal(note.embeds[0].position.start.line, 1);
});

test('links, tags and headings inside code are ignored', () => {
  const text = '# Título\n```js\n[[nao]] #nao\n```\nTexto `[[nao]]` #sim\n## Sub #tag2';
  const note = parseNote(text);
  assert.deepEqual(note.links, []);
  assert.deepEqual(note.tags.map((t) => t.tag), ['#sim', '#tag2']);
  assert.deepEqual(note.headings.map((h) => [h.level, h.heading]), [[1, 'Título'], [2, 'Sub #tag2']]);
});

test('unclosed fence masks until the end of the note', () => {
  const masked = maskNonProse('antes [[a]]\n```\n[[b]]\nainda código');
  assert.ok(masked.includes('[[a]]'));
  assert.ok(!masked.includes('[[b]]'));
});

test('numbers-only hashes are not tags; nested tags are', () => {
  const note = parseNote('Issue #123 e #projeto/ativo e #2024ano');
  assert.deepEqual(note.tags.map((t) => t.tag), ['#projeto/ativo', '#2024ano']);
});

test('frontmatter tags and aliases', () => {
  const text = '---\ntags: [ideia, "projeto/x"]\naliases:\n  - Meu Apelido\n---\nCorpo';
  const { data, body } = splitFrontmatter(text);
  assert.equal(body, 'Corpo');
  assert.deepEqual(data.tags, ['ideia', 'projeto/x']);
  const note = parseNote(text);
  assert.deepEqual(note.frontmatterTags, ['#ideia', '#projeto/x']);
  assert.deepEqual(note.aliases, ['Meu Apelido']);
});

test('the heading immediately after frontmatter remains indexed at its original position', () => {
  const text = '---\r\ntitle: Exemplo\r\n---\r\n# Primeira seção\r\nVeja [[Outra]].\r\n## Segunda seção';
  const note = parseNote(text);
  assert.deepEqual(note.headings.map((heading) => [heading.heading, heading.position.start.line]), [
    ['Primeira seção', 3], ['Segunda seção', 5],
  ]);
  assert.equal(note.headings[0].position.start.offset, text.indexOf('# Primeira'));
  assert.equal(note.links[0].position.start.line, 4);
  assert.equal(note.links[0].position.start.offset, text.indexOf('[[Outra]]'));
});

test('linktext and subpath parsing', () => {
  assert.deepEqual(parseLinktext('Nota#Seção'), { path: 'Nota', subpath: '#Seção' });
  assert.deepEqual(parseSubpath('#^abc123'), { heading: null, block: 'abc123' });
  assert.deepEqual(parseSubpath('#A#B'), { heading: 'B', block: null });
});

function fakeVault(files) {
  const entries = new Map(Object.keys(files).map((p) => [p, { path: p, type: 'file' }]));
  const handlers = {};
  return {
    getFiles: () => [...entries.values()],
    getMarkdownFiles: () => [...entries.values()].filter((e) => e.path.endsWith('.md')),
    getFile: (p) => entries.get(p) || null,
    cachedRead: (p) => files[p] ?? '',
    on: (name, fn) => (handlers[name] = fn),
  };
}

test('link resolution: exact path, same folder, then shortest path', () => {
  const vault = fakeVault({
    'Inicio.md': '[[Ideias]] [[b/Ideias]] [[Inexistente]] ![[foto.png]]',
    'a/Ideias.md': '',
    'b/Ideias.md': '',
    'a/x/Ideias.md': '',
    'a/Projeto.md': '[[Ideias]]',
    'midia/foto.png': '',
  });
  const cache = new MetadataCache(vault);
  cache.init();
  assert.equal(cache.getFirstLinkpathDest('b/Ideias', 'Inicio.md').path, 'b/Ideias.md');
  assert.equal(cache.getFirstLinkpathDest('Ideias', 'a/Projeto.md').path, 'a/Ideias.md');
  assert.equal(cache.getFirstLinkpathDest('Ideias', 'Inicio.md').path, 'a/Ideias.md');
  assert.equal(cache.getFirstLinkpathDest('foto.png', 'Inicio.md').path, 'midia/foto.png');
  assert.deepEqual(cache.unresolvedLinks['Inicio.md'], { Inexistente: 1 });
  assert.equal(cache.getBacklinks('a/Ideias.md').length, 2);
  // Ambiguous names need the full path, unique names don't.
  assert.equal(cache.fileToLinktext('b/Ideias.md'), 'b/Ideias');
  assert.equal(cache.fileToLinktext('a/Projeto.md'), 'Projeto');
});

test('search query language', () => {
  assert.deepEqual(
    parseQuery('café "duas palavras" -lixo tag:#ideia path:"Pasta X" /re+gex/').map((t) => [t.op, t.value, t.negate]),
    [
      ['content', 'café', false],
      ['content', 'duas palavras', false],
      ['content', 'lixo', true],
      ['tag', '#ideia', false],
      ['path', 'Pasta X', false],
      ['content', 're+gex', false],
    ],
  );
  const files = { 'a.md': 'Café da manhã\noutra linha', 'b.md': 'café com lixo', 'Pasta X/c.md': 'nada' };
  const opts = { read: (p) => files[p], getTags: (p) => (p === 'a.md' ? ['#ideia'] : []) };
  assert.deepEqual(runSearch('café -lixo', Object.keys(files), opts).map((r) => r.path), ['a.md']);
  assert.deepEqual(runSearch('tag:#ideia', Object.keys(files), opts).map((r) => r.path), ['a.md']);
  assert.deepEqual(runSearch('path:"Pasta X"', Object.keys(files), opts).map((r) => r.path), ['Pasta X/c.md']);
  const [hit] = runSearch('manhã', Object.keys(files), opts);
  assert.deepEqual(hit.matches[0].ranges, [[8, 13]]);
});

test('utilities', () => {
  const d = new Date(2026, 9, 14, 9, 5, 7);
  assert.equal(formatDate(d, 'YYYY-MM-DD'), '2026-10-14');
  assert.equal(formatDate(d, 'dddd, D [de] MMMM'), 'quarta-feira, 14 de outubro');
  assert.equal(formatDate(d, 'YYYYMMDDHHmmss'), '20261014090507');
  assert.ok(fuzzyMatch('ntid', 'Nota de ideias'));
  assert.equal(fuzzyMatch('xyz', 'Nota'), null);
  assert.equal(stem('a/b/Minha nota.md'), 'Minha nota');
  assert.equal(dirname('a/b/c.md'), 'a/b');
  assert.equal(joinPath('', 'a', 'b.md'), 'a/b.md');
  assert.deepEqual(countWords('---\nx: 1\n---\nOlá mundo, tudo bem?'), { words: 4, chars: 17 });
});

test('editor formatting helpers toggle markers, checklists and links', () => {
  let s = EditorState.create({ doc: 'hello world', selection: { anchor: 0, head: 5 } });
  const view = { get state() { return s; }, dispatch(tr) { s = s.update(tr).state; } };
  toggleWrap('**')(view);
  assert.equal(s.doc.toString(), '**hello** world');
  toggleWrap('**')(view);
  assert.equal(s.doc.toString(), 'hello world');

  toggleWrap('~~')(view);
  assert.equal(s.doc.toString(), '~~hello~~ world');
  toggleWrap('~~')(view);
  assert.equal(s.doc.toString(), 'hello world');

  s = EditorState.create({ doc: 'Tarefa pendente', selection: { anchor: 0 } });
  toggleChecklist(view);
  assert.equal(s.doc.toString(), '- [ ] Tarefa pendente');
  toggleChecklist(view);
  assert.equal(s.doc.toString(), '- [x] Tarefa pendente');
  toggleChecklist(view);
  assert.equal(s.doc.toString(), '- [ ] Tarefa pendente');

  s = EditorState.create({ doc: 'Meu link', selection: { anchor: 0, head: 8 } });
  insertMarkdownLink(view);
  assert.equal(s.doc.toString(), '[Meu link]()');

  s = EditorState.create({ doc: 'Nota Referenciada', selection: { anchor: 0, head: 17 } });
  insertWikilink(view);
  assert.equal(s.doc.toString(), '[[Nota Referenciada]]');
});

