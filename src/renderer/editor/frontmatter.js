import { tags } from '@lezer/highlight';

/**
 * Lezer Markdown extension: a YAML block delimited by `---` on the very first line becomes a
 * single `Frontmatter` node, so it isn't misread as a horizontal rule plus a setext heading.
 */
export const frontmatterExtension = {
  defineNodes: [{ name: 'Frontmatter', block: true, style: tags.meta }],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
        const from = cx.lineStart;
        let to = null;
        while (cx.nextLine()) {
          if (/^(---|\.\.\.)[ \t]*$/.test(line.text)) {
            to = cx.lineStart + line.text.length;
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', from, to ?? cx.prevLineEnd()));
        return true;
      },
    },
  ],
};
