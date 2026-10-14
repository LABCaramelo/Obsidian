import { el, stem } from '../core/util.js';
import { splitFrontmatter } from '../core/parse.js';
import { parseSubpath } from '../core/parse.js';

const wired = new WeakSet();

const CALLOUT_ICONS = {
  note: '✎', abstract: '☰', summary: '☰', tldr: '☰', info: 'ℹ', todo: '☑', tip: '🔥', hint: '🔥', important: '🔥',
  success: '✔', check: '✔', done: '✔', question: '?', help: '?', faq: '?', warning: '⚠', caution: '⚠', attention: '⚠',
  failure: '✖', fail: '✖', missing: '✖', danger: '⚡', error: '⚡', bug: '🐞', example: '☷', quote: '❝', cite: '❝',
};
const CALLOUT_ALIASES = {
  summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', check: 'success', done: 'success',
  help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure',
  error: 'danger', cite: 'quote',
};

let mermaidPromise = null;
let mermaidCounter = 0;

/** Renders a note into `container` and wires up links, tasks, embeds, callouts and diagrams. */
export async function renderInto(app, container, text, sourcePath, opts = {}, depth = 0) {
  const ctx = {
    sourcePath,
    resolve: (linkpath) => app.metadata.getFirstLinkpathDest(linkpath, sourcePath),
    fileUrl: (path) => app.vault.fileUrl(path),
  };
  const { html, frontmatter } = app.markdown.render(text, ctx);
  container.innerHTML = html;
  if (frontmatter && depth === 0) container.prepend(renderProperties(app, frontmatter));

  processCallouts(container);
  hideBlockIds(container);
  wireLinks(app, container, sourcePath);
  if (opts.onToggleTask) {
    for (const box of container.querySelectorAll('input.task-checkbox')) {
      box.addEventListener('click', (e) => {
        e.preventDefault();
        opts.onToggleTask(Number(box.dataset.task));
      });
    }
  } else {
    container.querySelectorAll('input.task-checkbox').forEach((b) => b.setAttribute('disabled', ''));
  }
  await renderEmbeds(app, container, depth);
  renderMermaid(container);
}

function renderProperties(app, data) {
  const table = el('div', { class: 'metadata-container' }, el('div', { class: 'metadata-title', text: 'Propriedades' }));
  for (const [key, value] of Object.entries(data)) {
    const valueEl = el('div', { class: 'metadata-value' });
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
      if (key === 'tags' || key === 'tag') {
        const tag = el('a', { class: 'tag', href: '#', 'data-href': `#${s.replace(/^#/, '')}`, text: `#${s.replace(/^#/, '')}` });
        valueEl.appendChild(tag);
      } else {
        const link = /^\[\[([^\]]+)\]\]$/.exec(s);
        if (link) valueEl.appendChild(el('a', { class: 'internal-link', href: '#', 'data-href': link[1].split('|')[0], text: link[1].split('|').pop() }));
        else valueEl.appendChild(el('span', { class: 'metadata-pill', text: s }));
      }
    }
    table.appendChild(el('div', { class: 'metadata-row' }, el('div', { class: 'metadata-key', text: key }), valueEl));
  }
  return table;
}

function processCallouts(container) {
  for (const quote of container.querySelectorAll('blockquote')) {
    const first = quote.firstElementChild;
    if (!first || first.tagName !== 'P') continue;
    const textNode = first.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/.exec(textNode.textContent);
    if (!m) continue;
    const rawType = m[1].toLowerCase();
    const type = CALLOUT_ALIASES[rawType] || rawType;
    const foldable = m[2] !== '';
    const collapsed = m[2] === '-';

    // Title = rest of the first line; everything after the first <br> stays in the body.
    textNode.textContent = textNode.textContent.slice(m[0].length - m[3].length);
    const titleEl = el('div', { class: 'callout-title-inner' });
    let node = first.firstChild;
    while (node && node.nodeName !== 'BR') {
      const next = node.nextSibling;
      titleEl.appendChild(node);
      node = next;
    }
    if (node?.nodeName === 'BR') node.remove();
    if (!titleEl.textContent.trim()) titleEl.textContent = rawType.charAt(0).toUpperCase() + rawType.slice(1);
    if (!first.textContent.trim() && !first.querySelector('img')) first.remove();

    const callout = el('div', { class: `callout${foldable ? ' is-collapsible' : ''}${collapsed ? ' is-collapsed' : ''}`, 'data-callout': type });
    const title = el(
      'div',
      { class: 'callout-title' },
      el('span', { class: 'callout-icon', text: CALLOUT_ICONS[rawType] || CALLOUT_ICONS[type] || '✎' }),
      titleEl,
      foldable ? el('span', { class: 'callout-fold', text: '▾' }) : null,
    );
    const content = el('div', { class: 'callout-content' });
    while (quote.firstChild) content.appendChild(quote.firstChild);
    callout.append(title, content);
    if (foldable) title.addEventListener('click', () => callout.classList.toggle('is-collapsed'));
    if (quote.dataset.line) callout.dataset.line = quote.dataset.line;
    quote.replaceWith(callout);
  }
}

/** Removes trailing " ^block-id" markers from the text, keeping them as element ids for linking. */
function hideBlockIds(container) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement.closest('code, pre') && /\s\^[A-Za-z0-9-]+\s*$/.test(node.nodeValue)) hits.push(node);
  }
  for (const node of hits) {
    const m = /\s\^([A-Za-z0-9-]+)\s*$/.exec(node.nodeValue);
    node.nodeValue = node.nodeValue.slice(0, m.index);
    node.parentElement.closest('p, li, blockquote, div')?.setAttribute('data-block-id', m[1]);
  }
}

function wireLinks(app, container, sourcePath) {
  // The same container is re-rendered many times: attach listeners once, read the source path lazily.
  container.dataset.source = sourcePath;
  if (wired.has(container)) return;
  wired.add(container);
  container.addEventListener('click', (e) => {
    const sourcePath = container.dataset.source;
    const a = e.target.closest?.('a');
    if (!a) return;
    if (a.classList.contains('tag')) {
      e.preventDefault();
      app.openSearch(`tag:${a.dataset.href}`);
      return;
    }
    if (a.classList.contains('internal-link')) {
      e.preventDefault();
      app.openLinkText(a.dataset.href, sourcePath, e.ctrlKey || e.metaKey || e.button === 1);
      return;
    }
    const href = a.getAttribute('href') || '';
    if (/^(https?|mailto):/i.test(href)) {
      e.preventDefault();
      window.basalto.shell.openExternal(href);
    } else if (href.startsWith('#') && href.length > 1) {
      e.preventDefault();
      container.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView();
    }
  });
  // Hover preview of internal links.
  container.addEventListener('mouseover', (e) => {
    const a = e.target.closest?.('a.internal-link');
    if (a && (e.ctrlKey || e.metaKey)) app.showHoverPreview(a, a.dataset.href, container.dataset.source);
  });
}

async function renderEmbeds(app, container, depth) {
  for (const embed of container.querySelectorAll('.markdown-embed')) {
    await renderNoteEmbed(app, embed, embed.dataset.src, embed.dataset.subpath, depth);
  }
}

/** Fills `embed` with a title and the rendered note (or one section/block of it). */
export async function renderNoteEmbed(app, embed, path, subpath, depth = 0, { title: showTitle = true } = {}) {
  if (showTitle) {
    const title = el('div', { class: 'markdown-embed-title' }, el('a', { class: 'internal-link', href: '#', 'data-href': path, text: stem(path) }));
    title.querySelector('a').addEventListener('click', (e) => {
      e.preventDefault();
      app.openLinkText(path, '', e.ctrlKey || e.metaKey);
    });
    embed.append(title);
  }
  if (depth >= 3) return;
  const text = sliceSubpath(app, path, await app.vault.read(path).catch(() => ''), subpath);
  const body = el('div', { class: 'markdown-embed-content markdown-rendered' });
  embed.append(body);
  await renderInto(app, body, text, path, {}, depth + 1);
}

/** Keeps only the heading section or block referenced by a subpath. */
function sliceSubpath(app, path, text, subpath) {
  if (!subpath) return splitFrontmatter(text).body;
  const cache = app.metadata.getCache(path);
  if (!cache) return text;
  const lines = text.split('\n');
  const { heading, block } = parseSubpath(subpath);
  if (block) {
    const b = cache.blocks.find((x) => x.id === block);
    if (!b) return '';
    let start = b.position.start.line;
    while (start > 0 && lines[start - 1].trim() !== '') start--;
    return lines.slice(start, b.position.start.line + 1).join('\n').replace(/\s\^[A-Za-z0-9-]+\s*$/, '');
  }
  const idx = cache.headings.findIndex((h) => h.heading.toLowerCase() === (heading || '').toLowerCase());
  if (idx === -1) return '';
  const h = cache.headings[idx];
  const next = cache.headings.slice(idx + 1).find((x) => x.level <= h.level);
  return lines.slice(h.position.start.line, next ? next.position.start.line : lines.length).join('\n');
}

function renderMermaid(container) {
  const blocks = container.querySelectorAll('.mermaid-block');
  if (!blocks.length) return;
  mermaidPromise ||= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: document.body.classList.contains('theme-dark') ? 'dark' : 'default', securityLevel: 'strict' });
    return mermaid;
  });
  mermaidPromise.then(async (mermaid) => {
    for (const block of blocks) {
      try {
        const { svg } = await mermaid.render(`mermaid-${++mermaidCounter}`, decodeURIComponent(block.dataset.source || ''));
        block.innerHTML = svg;
      } catch (err) {
        block.textContent = `Erro no diagrama: ${err.message || err}`;
        block.classList.add('is-error');
      }
    }
  });
}
