import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { splitFrontmatter } from './parse.js';

/**
 * Markdown → HTML for the reading view, with the note-taking extensions:
 * [[wikilinks]], ![[embeds]], #tags, ==highlights==, $math$, callouts, task lists, %%comments%%.
 * Link resolution is delegated to `ctx.resolve(linkpath)` so the renderer stays vault-agnostic.
 */
export function createMarkdown() {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: true,
    typographer: false,
    highlight(code, lang) {
      if (lang === 'mermaid') return '';
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
          /* fall through */
        }
      }
      return '';
    },
  });
  md.use(footnote);
  md.use(wikilinkPlugin);
  md.use(tagPlugin);
  md.use(highlightPlugin);
  md.use(mathPlugin);
  md.use(taskPlugin);
  md.use(sourceLinePlugin);

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim() === 'mermaid') {
      // Encoded because the sanitizer drops attribute values containing "-->", common in diagrams.
      return `<div class="mermaid-block" data-source="${encodeURIComponent(token.content)}"></div>`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') || '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      token.attrJoin('class', 'external-link');
    } else if (!href.startsWith('#')) {
      let target = href;
      try {
        target = decodeURIComponent(href);
      } catch {
        /* keep raw */
      }
      const dest = env.ctx?.resolve(target.split('#')[0]);
      token.attrJoin('class', dest ? 'internal-link' : 'internal-link is-unresolved');
      token.attrSet('data-href', target);
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') || '';
    if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      let target = src;
      try {
        target = decodeURIComponent(src);
      } catch {
        /* keep raw */
      }
      const dest = env.ctx?.resolve(target);
      if (dest) token.attrSet('src', env.ctx.fileUrl(dest.path));
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  return {
    md,
    /** Renders a note to sanitized HTML. Returns { html, frontmatter }. */
    render(text, ctx) {
      const { data, body, end } = splitFrontmatter(text);
      const lineOffset = end ? text.slice(0, end).split('\n').length - 1 : 0;
      const cleaned = body.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, ''));
      const raw = md.render(cleaned, { ctx, lineOffset });
      const html = DOMPurify.sanitize(raw, {
        ADD_TAGS: ['iframe'],
        ADD_ATTR: ['target', 'data-href', 'data-line', 'data-source', 'data-src', 'data-subpath', 'data-task', 'data-heading'],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|vaultfile|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
      });
      return { html, frontmatter: data };
    },
  };
}

// --- [[wikilinks]] and ![[embeds]] -------------------------------------------

function wikilinkPlugin(md) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const start = state.pos;
    const src = state.src;
    const embed = src.charCodeAt(start) === 0x21; /* ! */
    const open = embed ? start + 1 : start;
    if (src.charCodeAt(open) !== 0x5b || src.charCodeAt(open + 1) !== 0x5b) return false;
    const close = src.indexOf(']]', open + 2);
    if (close === -1) return false;
    const inner = src.slice(open + 2, close);
    if (!inner || inner.includes('\n') || inner.includes('[')) return false;
    if (!silent) {
      const pipe = inner.search(/(?<!\\)\|/);
      const target = (pipe === -1 ? inner : inner.slice(0, pipe)).replace(/\\$/, '').trim();
      const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim();
      const token = state.push(embed ? 'wikiembed' : 'wikilink', '', 0);
      token.meta = { target, alias };
    }
    state.pos = close + 2;
    return true;
  });

  md.renderer.rules.wikilink = (tokens, idx, _options, env) => {
    const { target, alias } = tokens[idx].meta;
    const [path, ...rest] = target.split('#');
    const subpath = rest.length ? `#${rest.join('#')}` : '';
    const dest = path ? env.ctx?.resolve(path) : { path: env.ctx?.sourcePath };
    const display = alias || (path ? target.replace(/#\^?/g, ' > ').replace(/^ > /, '') : subpath.replace(/^#\^?/, ''));
    const cls = dest ? 'internal-link' : 'internal-link is-unresolved';
    return `<a class="${cls}" data-href="${md.utils.escapeHtml(target)}" href="#">${md.utils.escapeHtml(display)}</a>`;
  };

  md.renderer.rules.wikiembed = (tokens, idx, _options, env) => {
    const { target, alias } = tokens[idx].meta;
    const esc = md.utils.escapeHtml;
    const [path, ...rest] = target.split('#');
    const subpath = rest.length ? `#${rest.join('#')}` : '';
    const dest = env.ctx?.resolve(path);
    if (!dest) {
      return `<span class="internal-embed is-unresolved" data-src="${esc(target)}">${esc(target)}</span>`;
    }
    const ext = dest.path.split('.').pop().toLowerCase();
    const url = env.ctx.fileUrl(dest.path);
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif'].includes(ext)) {
      const size = alias && /^\d+(x\d+)?$/.test(alias) ? alias.split('x') : null;
      const dims = size ? ` width="${size[0]}"${size[1] ? ` height="${size[1]}"` : ''}` : '';
      const alt = alias && !size ? alias : dest.path.split('/').pop();
      return `<img class="internal-embed image-embed" src="${url}" alt="${esc(alt)}"${dims}>`;
    }
    if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return `<audio class="internal-embed" controls src="${url}"></audio>`;
    if (['mp4', 'webm', 'ogv', 'mov'].includes(ext)) return `<video class="internal-embed" controls src="${url}"></video>`;
    if (ext === 'pdf') return `<iframe class="internal-embed pdf-embed" src="${url}"></iframe>`;
    if (ext === 'md') {
      return `<div class="internal-embed markdown-embed" data-src="${esc(dest.path)}" data-subpath="${esc(subpath)}"></div>`;
    }
    return `<a class="internal-link" data-href="${esc(target)}" href="#">${esc(target)}</a>`;
  };
}

// --- #tags ---------------------------------------------------------------------

function tagPlugin(md) {
  const re = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u;
  md.inline.ruler.after('wikilink', 'tag', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x23 /* # */) return false;
    const prev = state.pos > 0 ? state.src[state.pos - 1] : ' ';
    if (!/[\s(]/.test(prev)) return false;
    const m = re.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      const token = state.push('tag', '', 0);
      token.content = m[1];
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.tag = (tokens, idx) => {
    const tag = md.utils.escapeHtml(tokens[idx].content);
    return `<a class="tag" href="#" data-href="#${tag}">#${tag}</a>`;
  };
}

// --- ==highlight== ---------------------------------------------------------------

function highlightPlugin(md) {
  md.inline.ruler.before('emphasis', 'mark', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
    const end = src.indexOf('==', start + 2);
    if (end === -1 || end === start + 2) return false;
    if (!silent) {
      state.push('mark_open', 'mark', 1);
      const oldMax = state.posMax;
      state.pos = start + 2;
      state.posMax = end;
      state.md.inline.tokenize(state);
      state.posMax = oldMax;
      state.push('mark_close', 'mark', -1);
    }
    state.pos = end + 2;
    return true;
  });
}

// --- $math$ and $$math$$ ------------------------------------------------------------

function renderMath(tex, displayMode) {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: 'html' });
  } catch (err) {
    return `<span class="math-error">${String(err.message || err)}</span>`;
  }
}

function mathPlugin(md) {
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.src.slice(pos, pos + 2) !== '$$') return false;
    const firstLine = state.src.slice(pos + 2, max);
    let content;
    let line = startLine;
    if (firstLine.trim().endsWith('$$') && firstLine.trim().length > 2) {
      content = firstLine.trim().slice(0, -2);
    } else {
      const lines = [firstLine];
      let found = false;
      while (++line < endLine) {
        const s = state.bMarks[line] + state.tShift[line];
        const text = state.src.slice(s, state.eMarks[line]);
        if (text.trim().endsWith('$$')) {
          lines.push(text.trim().slice(0, -2));
          found = true;
          break;
        }
        lines.push(text);
      }
      if (!found) return false;
      content = lines.join('\n');
    }
    if (silent) return true;
    const token = state.push('math_block', 'div', 0);
    token.content = content;
    token.map = [startLine, line + 1];
    state.line = line + 1;
    return true;
  });
  md.renderer.rules.math_block = (tokens, idx) => `<div class="math math-block">${renderMath(tokens[idx].content, true)}</div>`;

  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src[start] !== '$' || src[start + 1] === '$' || /\s/.test(src[start + 1] || ' ')) return false;
    let end = start + 1;
    while ((end = src.indexOf('$', end)) !== -1) {
      if (src[end - 1] !== '\\') break;
      end++;
    }
    if (end === -1 || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] || '')) return false;
    if (!silent) {
      const token = state.push('math_inline', 'span', 0);
      token.content = src.slice(start + 1, end);
    }
    state.pos = end + 1;
    return true;
  });
  md.renderer.rules.math_inline = (tokens, idx) => `<span class="math math-inline">${renderMath(tokens[idx].content, false)}</span>`;
}

// --- - [ ] task lists -----------------------------------------------------------------

function taskPlugin(md) {
  md.core.ruler.after('inline', 'tasks', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX\-/>!?])\][ \t]/.exec(inline.content);
      if (!m) continue;
      const first = inline.children[0];
      if (!first || first.type !== 'text') continue;
      first.content = first.content.replace(/^\[[^\]]\][ \t]/, '');
      const checked = m[1] !== ' ';
      const line = (tokens[i - 2].map?.[0] ?? 0) + (state.env.lineOffset || 0);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" class="task-checkbox" data-task="${line}"${checked ? ' checked' : ''}>`;
      inline.children.unshift(box);
      tokens[i - 2].attrJoin('class', `task-list-item${checked ? ' is-checked' : ''}`);
      tokens[i - 2].attrSet('data-task', m[1]);
    }
  });
}

// --- data-line attributes (for scroll sync and outline navigation) ----------------------

function sourceLinePlugin(md) {
  md.core.ruler.push('source_lines', (state) => {
    const offset = state.env.lineOffset || 0;
    for (const token of state.tokens) {
      if (token.map && token.nesting === 1) token.attrSet('data-line', String(token.map[0] + offset));
      if (token.type === 'heading_open') {
        const inline = state.tokens[state.tokens.indexOf(token) + 1];
        token.attrSet('data-heading', inline?.content || '');
      }
    }
  });
}
