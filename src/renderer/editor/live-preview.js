import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import katex from 'katex';

// "Live preview": formatting marks are hidden and rich elements rendered everywhere
// except on the lines the cursor/selection touches, where the raw Markdown is shown.

class CheckboxWidget extends WidgetType {
  constructor(checked, markerFrom) {
    super();
    this.checked = checked;
    this.markerFrom = markerFrom;
  }
  eq(other) {
    return other.checked === this.checked && other.markerFrom === this.markerFrom;
  }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'task-checkbox cm-task-checkbox';
    box.checked = this.checked;
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      const from = this.markerFrom + 1;
      view.dispatch({ changes: { from, to: from + 1, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-list-bullet';
    span.textContent = '•';
    return span;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'cm-hr';
    return hr;
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt, width) {
    super();
    this.src = src;
    this.alt = alt;
    this.width = width;
  }
  eq(other) {
    return other.src === this.src && other.width === this.width;
  }
  toDOM() {
    const img = document.createElement('img');
    img.className = 'cm-image-embed';
    img.src = this.src;
    img.alt = this.alt;
    if (this.width) img.width = this.width;
    return img;
  }
}

class MathWidget extends WidgetType {
  constructor(tex) {
    super();
    this.tex = tex;
  }
  eq(other) {
    return other.tex === this.tex;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-math';
    try {
      katex.render(this.tex, span, { throwOnError: false });
    } catch {
      span.textContent = this.tex;
    }
    return span;
  }
}

class TextWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement('span');
    span.textContent = this.text;
    return span;
  }
}

const hide = Decoration.replace({});
const IMAGE_RE = /\.(png|jpe?g|gif|bmp|svg|webp|avif)$/i;

function activeLines(state) {
  const lines = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

function inCode(tree, pos) {
  for (let node = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (/^(InlineCode|FencedCode|CodeBlock|CodeText|HTMLBlock|Comment|Frontmatter)$/.test(node.name)) return true;
  }
  return false;
}

function buildDecorations(view, options) {
  const { state } = view;
  const ranges = [];
  const tree = syntaxTree(state);
  const active = activeLines(state);
  const enabled = options.enabled();
  const isActive = (pos) => active.has(state.doc.lineAt(pos).number);

  for (const { from, to } of view.visibleRanges) {
    // [[wikilinks]] first: Lezer reads their inner "[name]" as a plain link, which must be ignored.
    const wikiRanges = [];
    for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
      const line = state.doc.line(n);
      for (const m of line.text.matchAll(/!?\[\[[^[\]\n]+?\]\]/g)) wikiRanges.push([line.from + m.index, line.from + m.index + m[0].length]);
    }
    const inWikilink = (a, b) => wikiRanges.some(([x, y]) => a < y && b > x);

    tree.iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        if (name === 'Frontmatter') {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            const edge = n === first || n === last ? ' cm-frontmatter-fence' : '';
            ranges.push(Decoration.line({ class: `cm-frontmatter-line${edge}` }).range(state.doc.line(n).from));
          }
          return false;
        }
        if ((name === 'Link' || name === 'Image') && inWikilink(node.from, node.to)) return false;
        const heading = /^ATXHeading(\d)$/.exec(name) || /^SetextHeading(\d)$/.exec(name);
        if (heading) {
          ranges.push(Decoration.line({ class: `cm-heading-line cm-heading-${heading[1]}` }).range(state.doc.lineAt(node.from).from));
        }
        if (name === 'Blockquote') {
          // "> [!tip] Título" opens a callout: color the block by its type.
          const callout = /^\s*>\s*\[!([\w-]+)\]/.exec(state.doc.lineAt(node.from).text);
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            const title = callout && line.from === state.doc.lineAt(node.from).from ? ' cm-callout-title-line' : '';
            ranges.push(Decoration.line({ class: `cm-blockquote-line${callout ? ' cm-callout-line' : ''}${title}`, attributes: callout ? { 'data-callout': callout[1].toLowerCase() } : undefined }).range(line.from));
            pos = line.to + 1;
          }
          // Off the cursor line, show the callout title instead of its "[!type]" marker.
          const first = state.doc.lineAt(node.from);
          const marker = callout && /\[![\w-]+\][+-]?[ \t]*/.exec(first.text);
          if (marker && enabled && !active.has(first.number)) {
            const from = first.from + marker.index;
            const to = from + marker[0].length;
            const hasTitle = first.text.slice(marker.index + marker[0].length).trim() !== '';
            const type = callout[1].charAt(0).toUpperCase() + callout[1].slice(1).toLowerCase();
            ranges.push(hasTitle ? hide.range(from, to) : Decoration.replace({ widget: new TextWidget(type) }).range(from, to));
          }
        }
        // The "[!tip]" marker of a callout is not a link.
        if (name === 'Link' && state.doc.sliceString(node.from, node.from + 2) === '[!') return false;
        if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            const cls = name === 'FencedCode' && (n === first || n === last) ? 'cm-codeblock-line cm-codeblock-fence' : 'cm-codeblock-line';
            ranges.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
          }
          return false;
        }
        if (!enabled || isActive(node.from)) return undefined;

        switch (name) {
          case 'HeaderMark': {
            const next = state.doc.sliceString(node.to, node.to + 1);
            if (node.to > node.from && /^ATXHeading/.test(node.node.parent?.name || '')) {
              ranges.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to));
            }
            break;
          }
          case 'EmphasisMark':
          case 'StrikethroughMark':
            ranges.push(hide.range(node.from, node.to));
            break;
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode') ranges.push(hide.range(node.from, node.to));
            break;
          case 'QuoteMark': {
            const next = state.doc.sliceString(node.to, node.to + 1);
            ranges.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to));
            break;
          }
          case 'HorizontalRule':
            ranges.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
            break;
          case 'ListMark': {
            const item = node.node.parent;
            const task = item?.getChild('Task');
            const marker = task?.getChild('TaskMarker');
            if (marker) {
              const checked = /\[[^ ]\]/.test(state.doc.sliceString(marker.from, marker.to));
              ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked, marker.from) }).range(node.from, marker.to));
            } else if (/^[-*+]$/.test(state.doc.sliceString(node.from, node.to))) {
              ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            }
            break;
          }
          case 'Image': {
            const text = state.doc.sliceString(node.from, node.to);
            const m = /^!\[([^\]]*)\]\(<?([^)>\s]+)>?[^)]*\)$/.exec(text);
            if (m) {
              const src = options.resolveImage(m[2]);
              if (src) ranges.push(Decoration.replace({ widget: new ImageWidget(src, m[1], null) }).range(node.from, node.to));
            }
            return false;
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            if (marks.length >= 2 && state.doc.sliceString(marks[0].from, marks[0].to) === '[') {
              const href = url ? state.doc.sliceString(url.from, url.to) : '';
              ranges.push(hide.range(marks[0].from, marks[0].to));
              ranges.push(hide.range(marks[1].from, node.to));
              if (marks[0].to < marks[1].from) {
                ranges.push(
                  Decoration.mark({ class: 'cm-link-rendered', attributes: { 'data-href': href } }).range(marks[0].to, marks[1].from),
                );
              }
            }
            return false;
          }
          default:
            break;
        }
        return undefined;
      },
    });

    // Constructs Lezer doesn't know: [[wikilinks]], #tags, ==highlights==, $math$.
    const startLine = state.doc.lineAt(from).number;
    const endLine = state.doc.lineAt(to).number;
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n);
      const text = line.text;
      const lineActive = !enabled || active.has(n);

      for (const m of text.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)) {
        const start = line.from + m.index;
        const end = start + m[0].length;
        if (inCode(tree, start)) continue;
        const inner = m[2];
        const pipe = inner.search(/(?<!\\)\|/);
        const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
        const alias = pipe === -1 ? null : inner.slice(pipe + 1);
        if (!lineActive && m[1] && IMAGE_RE.test(target.split('#')[0])) {
          const src = options.resolveImage(target.split('#')[0]);
          if (src) {
            const width = alias && /^\d+$/.test(alias) ? Number(alias) : null;
            ranges.push(Decoration.replace({ widget: new ImageWidget(src, target, width) }).range(start, end));
            continue;
          }
        }
        const resolved = options.isResolved(target.split('#')[0]);
        const cls = `cm-wikilink${resolved ? '' : ' is-unresolved'}`;
        if (lineActive) {
          ranges.push(Decoration.mark({ class: cls }).range(start, end));
        } else {
          const textFrom = pipe === -1 ? start + m[1].length + 2 : start + m[1].length + 2 + pipe + 1;
          ranges.push(hide.range(start, textFrom));
          ranges.push(Decoration.mark({ class: `${cls} cm-link-rendered`, attributes: { 'data-href': target } }).range(textFrom, end - 2));
          ranges.push(hide.range(end - 2, end));
        }
      }

      for (const m of text.matchAll(/(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
        const start = line.from + m.index + m[1].length;
        if (inCode(tree, start)) continue;
        // Skip "#" that belongs to a heading mark.
        if (m.index === 0 && /^#{1,6}\s/.test(text)) continue;
        ranges.push(Decoration.mark({ class: 'cm-tag', attributes: { 'data-href': `#${m[2]}` } }).range(start, start + m[2].length + 1));
      }

      for (const m of text.matchAll(/==([^=\n]+)==/g)) {
        const start = line.from + m.index;
        const end = start + m[0].length;
        if (inCode(tree, start)) continue;
        if (!lineActive) ranges.push(hide.range(start, start + 2));
        ranges.push(Decoration.mark({ class: 'cm-highlight' }).range(start + 2, end - 2));
        if (!lineActive) ranges.push(hide.range(end - 2, end));
      }

      if (!lineActive) {
        for (const m of text.matchAll(/(?<![$\\])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![$\d])/g)) {
          const start = line.from + m.index;
          if (inCode(tree, start)) continue;
          ranges.push(Decoration.replace({ widget: new MathWidget(m[1]) }).range(start, start + m[0].length));
        }
      }
    }
  }
  return Decoration.set(dedupe(ranges), true);
}

/** Drops replace ranges that overlap an earlier replace range (CodeMirror rejects those). */
function dedupe(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const out = [];
  let lastReplaceEnd = -1;
  for (const r of sorted) {
    // Line decorations are zero-length points too; only real replacements can collide.
    const isReplace = r.value.point && r.to > r.from;
    if (isReplace) {
      if (r.from < lastReplaceEnd) continue;
      lastReplaceEnd = Math.max(lastReplaceEnd, r.to);
    }
    out.push(r);
  }
  return out;
}

export function livePreview(options) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view, options);
      }
      update(update) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.transactions.some((t) => t.reconfigured)
        ) {
          this.decorations = buildDecorations(update.view, options);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
