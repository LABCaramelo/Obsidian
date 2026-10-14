import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldAll,
  unfoldAll,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { vim } from '@replit/codemirror-vim';
import { livePreview } from './live-preview.js';
import { frontmatterExtension } from './frontmatter.js';
import { blockWidgets } from './block-widgets.js';

const highlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-h cm-h1' },
  { tag: tags.heading2, class: 'cm-h cm-h2' },
  { tag: tags.heading3, class: 'cm-h cm-h3' },
  { tag: tags.heading4, class: 'cm-h cm-h4' },
  { tag: tags.heading5, class: 'cm-h cm-h5' },
  { tag: tags.heading6, class: 'cm-h cm-h6' },
  { tag: tags.emphasis, class: 'cm-em' },
  { tag: tags.strong, class: 'cm-strong' },
  { tag: tags.strikethrough, class: 'cm-strike' },
  { tag: tags.link, class: 'cm-link' },
  { tag: tags.url, class: 'cm-url' },
  { tag: tags.monospace, class: 'cm-inline-code' },
  { tag: tags.quote, class: 'cm-quote' },
  { tag: tags.list, class: 'cm-list' },
  { tag: tags.processingInstruction, class: 'cm-formatting' },
  { tag: tags.meta, class: 'cm-meta' },
  { tag: tags.contentSeparator, class: 'cm-hr-mark' },
  { tag: tags.comment, class: 'cm-comment' },
  { tag: tags.keyword, class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'tok-number' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'tok-function' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'tok-type' },
  { tag: [tags.propertyName, tags.attributeName], class: 'tok-property' },
  { tag: [tags.operator, tags.punctuation], class: 'tok-operator' },
  { tag: tags.tagName, class: 'tok-tag' },
  { tag: tags.variableName, class: 'tok-variable' },
]);

/** Wraps the selection (or the word at the cursor) with a Markdown marker such as ** or _. */
export function toggleWrap(marker) {
  return (view) => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const { state } = view;
        let { from, to } = range;
        if (from === to) {
          const word = state.wordAt(from);
          if (word) ({ from, to } = word);
        }
        const before = state.sliceDoc(from - marker.length, from);
        const after = state.sliceDoc(to, to + marker.length);
        if (before === marker && after === marker) {
          return {
            changes: [
              { from: from - marker.length, to: from },
              { from: to, to: to + marker.length },
            ],
            range: EditorSelection.range(from - marker.length, to - marker.length),
          };
        }
        return {
          changes: [
            { from, insert: marker },
            { from: to, insert: marker },
          ],
          range: EditorSelection.range(from + marker.length, to + marker.length),
        };
      }),
    );
    return true;
  };
}

export function toggleChecklist(view) {
  const { state } = view;
  const changes = [];
  const seen = new Set();
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (seen.has(line.number)) continue;
      seen.add(line.number);
      const m = /^(\s*)([-*+] |\d+[.)] )?(\[[ xX]\] )?/.exec(line.text);
      const indent = m[1].length;
      if (m[3]) {
        const markerPos = line.from + indent + (m[2]?.length || 0) + 1;
        const checked = m[3][1] !== ' ';
        changes.push({ from: markerPos, to: markerPos + 1, insert: checked ? ' ' : 'x' });
      } else if (m[2]) {
        changes.push({ from: line.from + indent + m[2].length, insert: '[ ] ' });
      } else {
        changes.push({ from: line.from + indent, insert: '- [ ] ' });
      }
    }
  }
  view.dispatch({ changes });
  return true;
}

export function insertMarkdownLink(view) {
  const range = view.state.selection.main;
  const text = view.state.sliceDoc(range.from, range.to);
  const insert = `[${text}]()`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + text.length + 3 },
  });
  return true;
}

export function insertWikilink(view) {
  const range = view.state.selection.main;
  const text = view.state.sliceDoc(range.from, range.to);
  const insert = `[[${text}]]`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + (text ? text.length + 4 : 2) },
  });
  return true;
}

export { foldAll, unfoldAll };

/** Finds the link-like token (wikilink, markdown link, URL or tag) under `pos`. */
export function linkAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  const patterns = [
    [/!?\[\[([^[\]\n]+?)\]\]/g, (m) => ({ kind: 'link', value: m[1].split(/(?<!\\)\|/)[0].trim() })],
    [/!?\[[^\]\n]*\]\(<?([^)>\s]+)>?[^)]*\)/g, (m) => ({ kind: 'link', value: m[1] })],
    [/https?:\/\/[^\s)>\]]+/g, (m) => ({ kind: 'link', value: m[0] })],
    [/(?<=^|[\s(])#[\p{L}\p{N}_\-/]+/gu, (m) => ({ kind: 'tag', value: m[0] })],
  ];
  for (const [re, pick] of patterns) {
    for (const m of line.text.matchAll(re)) {
      if (col >= m.index && col <= m.index + m[0].length) return pick(m);
    }
  }
  return null;
}

/**
 * Creates a Markdown editor.
 * hooks: onChange(text), openLink(href, newLeaf), linkCompletions(), tagCompletions(),
 *        resolveImage(path) -> url|null, isResolved(path) -> bool, pasteFiles(files) -> Promise<string|null>,
 *        isNoteEmbed(target) -> bool, renderEmbed(el, target)
 */
export function createEditor(parent, { doc, settings, hooks }) {
  const lineNumbersComp = new Compartment();
  const vimComp = new Compartment();
  const livePreviewComp = new Compartment();
  const spellComp = new Compartment();
  const foldComp = new Compartment();
  let livePreviewEnabled = settings.livePreview;

  const previewExtensions = () => [
    livePreview({ enabled: () => livePreviewEnabled, resolveImage: hooks.resolveImage, isResolved: hooks.isResolved }),
    blockWidgets({ enabled: () => livePreviewEnabled, isNoteEmbed: hooks.isNoteEmbed, renderEmbed: hooks.renderEmbed }),
  ];

  const completionSource = (context) => {
    const link = context.matchBefore(/\[\[[^\]\n]*$/);
    if (link) {
      const query = link.text.slice(2);
      const closing = context.state.sliceDoc(context.pos, context.pos + 2) === ']]';
      return {
        from: link.from + 2,
        to: context.pos,
        options: hooks.linkCompletions(query).map((s) => ({
          label: s.alias ? `${s.alias}` : s.linktext,
          detail: s.alias ? `→ ${s.linktext}` : s.folder,
          type: s.alias ? 'alias' : 'file',
          apply: (view, _c, from, to) => {
            const text = s.alias ? `${s.linktext}|${s.alias}` : s.linktext;
            const insert = closing ? text : `${text}]]`;
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + text.length + 2 },
            });
          },
        })),
        filter: true,
      };
    }
    const tag = context.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_\-/]*$/u);
    if (tag && (context.explicit || tag.text.trim().length > 1)) {
      const hashAt = tag.from + tag.text.indexOf('#');
      return {
        from: hashAt,
        options: hooks.tagCompletions().map((t) => ({ label: t, type: 'tag' })),
        validFor: /^#[\p{L}\p{N}_\-/]*$/u,
      };
    }
    return null;
  };

  const state = EditorState.create({
    doc,
    extensions: [
      vimComp.of(settings.vimMode ? vim() : []),
      lineNumbersComp.of(settings.showLineNumbers ? lineNumbers() : []),
      foldComp.of(settings.foldHeadings ? foldGutter({ openText: '▾', closedText: '▸' }) : []),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(highlightStyle),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ override: [completionSource], icons: false, activateOnTyping: true }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.lineWrapping,
      placeholder('Comece a escrever…'),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true, extensions: [frontmatterExtension] }),
      livePreviewComp.of(previewExtensions()),
      spellComp.of(EditorView.contentAttributes.of({ spellcheck: String(!!settings.spellcheck), lang: 'pt-BR' })),
      keymap.of([
        { key: 'Mod-b', run: toggleWrap('**') },
        { key: 'Mod-i', run: toggleWrap('*') },
        { key: 'Mod-k', run: insertMarkdownLink },
        { key: 'Mod-l', run: toggleChecklist },
        { key: 'Mod-Shift-h', run: toggleWrap('==') },
        { key: 'Mod-Shift-s', run: toggleWrap('~~') },
        { key: 'Mod-Shift-c', run: toggleWrap('`') },
        { key: 'Mod-Shift-k', run: insertWikilink },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) hooks.onChange(update.state.doc.toString(), update);
        if (update.selectionSet || update.docChanged) hooks.onCursor?.(update.state);
      }),
      EditorView.domEventHandlers({
        mousedown(event, view) {
          if (event.button !== 0) return false;
          const target = event.target instanceof Element ? event.target : null;
          const rendered = target?.closest('.cm-link-rendered, .cm-tag');
          const mod = event.ctrlKey || event.metaKey;
          if (rendered && (rendered.classList.contains('cm-link-rendered') || mod)) {
            const href = rendered.getAttribute('data-href');
            if (href) {
              event.preventDefault();
              if (rendered.classList.contains('cm-tag')) hooks.openTag(href);
              else hooks.openLink(href, mod);
              return true;
            }
          }
          if (mod) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            const found = pos != null ? linkAt(view.state, pos) : null;
            if (found) {
              event.preventDefault();
              if (found.kind === 'tag') hooks.openTag(found.value);
              else hooks.openLink(found.value, true);
              return true;
            }
          }
          return false;
        },
        paste(event) {
          const files = [...(event.clipboardData?.files || [])];
          if (!files.length || !hooks.pasteFiles) return false;
          event.preventDefault();
          insertFiles(files);
          return true;
        },
        drop(event, view) {
          const files = [...(event.dataTransfer?.files || [])];
          if (!files.length || !hooks.pasteFiles) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos != null) view.dispatch({ selection: { anchor: pos } });
          insertFiles(files);
          return true;
        },
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  async function insertFiles(files) {
    const text = await hooks.pasteFiles(files);
    if (text) view.dispatch(view.state.replaceSelection(text));
  }

  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      if (text === view.state.doc.toString()) return;
      const sel = view.state.selection.main;
      const anchor = Math.min(sel.anchor, text.length);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor } });
    },
    focus: () => view.focus(),
    scrollToLine(line, select = true) {
      const n = Math.max(1, Math.min(line + 1, view.state.doc.lines));
      const pos = view.state.doc.line(n).from;
      view.dispatch({
        selection: select ? { anchor: pos } : undefined,
        effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }),
      });
    },
    topLine() {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      return view.state.doc.lineAt(block.from).number - 1;
    },
    replaceRange(from, to, insert) {
      view.dispatch({ changes: { from, to, insert } });
    },
    reconfigure(next) {
      livePreviewEnabled = next.livePreview;
      view.dispatch({
        effects: [
          vimComp.reconfigure(next.vimMode ? vim() : []),
          lineNumbersComp.reconfigure(next.showLineNumbers ? lineNumbers() : []),
          foldComp.reconfigure(next.foldHeadings ? foldGutter({ openText: '▾', closedText: '▸' }) : []),
          spellComp.reconfigure(EditorView.contentAttributes.of({ spellcheck: String(!!next.spellcheck), lang: 'pt-BR' })),
          livePreviewComp.reconfigure(previewExtensions()),
        ],
      });
    },
    refreshDecorations() {
      view.dispatch({ effects: livePreviewComp.reconfigure(previewExtensions()) });
    },
    toggleWrap: (marker) => toggleWrap(marker)(view),
    toggleChecklist: () => toggleChecklist(view),
    insertMarkdownLink: () => insertMarkdownLink(view),
    insertWikilink: () => insertWikilink(view),
    foldAll: () => foldAll(view),
    unfoldAll: () => unfoldAll(view),
    destroy: () => view.destroy(),
  };
}
