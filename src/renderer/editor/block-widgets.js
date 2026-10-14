import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import katex from 'katex';

// Multi-line live-preview widgets ($$ math $$, ```mermaid, ![[note]] embeds). Decorations that
// replace line breaks must come from a state field, not a view plugin, hence this separate module.

let mermaidLoader = null;
let mermaidId = 0;

class MathBlockWidget extends WidgetType {
  constructor(tex) {
    super();
    this.tex = tex;
  }
  eq(other) {
    return other.tex === this.tex;
  }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-block-widget cm-math-block';
    try {
      katex.render(this.tex, div, { displayMode: true, throwOnError: false });
    } catch {
      div.textContent = this.tex;
    }
    return div;
  }
}

class MermaidWidget extends WidgetType {
  constructor(source) {
    super();
    this.source = source;
  }
  eq(other) {
    return other.source === this.source;
  }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-block-widget mermaid-block';
    mermaidLoader ||= import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: document.body.classList.contains('theme-dark') ? 'dark' : 'default', securityLevel: 'strict' });
      return mermaid;
    });
    mermaidLoader
      .then((mermaid) => mermaid.render(`cm-mermaid-${++mermaidId}`, this.source))
      .then(({ svg }) => (div.innerHTML = svg))
      .catch((err) => {
        div.textContent = `Erro no diagrama: ${err.message || err}`;
        div.classList.add('is-error');
      });
    return div;
  }
}

class EmbedWidget extends WidgetType {
  constructor(target, render) {
    super();
    this.target = target;
    this.render = render;
  }
  eq(other) {
    return other.target === this.target;
  }
  toDOM() {
    const div = document.createElement('div');
    div.className = 'cm-block-widget markdown-embed';
    this.render(div, this.target);
    return div;
  }
}

function selectionTouches(state, from, to) {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function build(state, options) {
  if (!options.enabled()) return Decoration.none;
  const ranges = [];
  const doc = state.doc;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return undefined;
      const info = node.node.getChild('CodeInfo');
      if (!info || doc.sliceString(info.from, info.to).trim() !== 'mermaid') return false;
      const text = node.node.getChild('CodeText');
      const from = doc.lineAt(node.from).from;
      const to = doc.lineAt(node.to).to;
      if (!selectionTouches(state, from, to) && text) {
        ranges.push(Decoration.replace({ widget: new MermaidWidget(doc.sliceString(text.from, text.to)), block: true }).range(from, to));
      }
      return false;
    },
  });

  // $$ … $$ blocks and lines that are just ![[note]] embeds.
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (/^\s*\$\$/.test(line.text)) {
      let end = null;
      const rest = line.text.trim().slice(2);
      if (rest.endsWith('$$') && rest.length > 2) end = line;
      else {
        for (let m = n + 1; m <= doc.lines; m++) {
          if (doc.line(m).text.trim().endsWith('$$')) {
            end = doc.line(m);
            break;
          }
        }
      }
      if (!end) continue;
      if (!inCode(state, line.from) && !selectionTouches(state, line.from, end.to)) {
        const tex = doc.sliceString(line.from, end.to).trim().replace(/^\$\$/, '').replace(/\$\$$/, '');
        ranges.push(Decoration.replace({ widget: new MathBlockWidget(tex), block: true }).range(line.from, end.to));
      }
      n = end.number;
      continue;
    }
    const embed = /^\s*!\[\[([^[\]\n|]+?)(?:\|[^\]]*)?\]\]\s*$/.exec(line.text);
    if (embed && options.isNoteEmbed(embed[1]) && !inCode(state, line.from) && !selectionTouches(state, line.from, line.to)) {
      ranges.push(Decoration.replace({ widget: new EmbedWidget(embed[1], options.renderEmbed), block: true }).range(line.from, line.to));
    }
  }
  return Decoration.set(ranges, true);
}

function inCode(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (/^(FencedCode|CodeBlock|Frontmatter)$/.test(node.name)) return true;
  }
  return false;
}

/** options: enabled(), isNoteEmbed(target), renderEmbed(el, target) */
export function blockWidgets(options) {
  return StateField.define({
    create: (state) => build(state, options),
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.reconfigured || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        return build(tr.state, options);
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
