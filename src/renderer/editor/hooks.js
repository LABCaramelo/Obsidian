import { parseLinktext } from '../core/parse.js';

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Hooks that connect a Markdown editor to the vault: links, tags, images, embeds and pasted files.
 * `getSourcePath` returns the note (or canvas) the text belongs to, used to resolve relative links.
 * `extra` adds or overrides hooks such as onChange/onCursor.
 */
export function markdownEditorHooks(app, getSourcePath, extra = {}) {
  return {
    openLink: (href, newLeaf) => app.openLinkText(href, getSourcePath(), newLeaf),
    openTag: (tag) => app.openSearch(`tag:${tag}`),
    linkCompletions: (query) => app.linkSuggestions(query, getSourcePath()),
    tagCompletions: () => [...app.metadata.getAllTags().keys()].sort(),
    resolveImage: (path) => {
      if (/^https?:/i.test(path)) return path;
      const dest = app.metadata.getFirstLinkpathDest(decodeURIComponentSafe(path), getSourcePath());
      return dest ? app.vault.fileUrl(dest.path) : null;
    },
    isResolved: (path) => !path || !!app.metadata.getFirstLinkpathDest(path, getSourcePath()),
    pasteFiles: (files) => app.saveAttachments(files, getSourcePath()),
    isNoteEmbed: (target) => {
      const dest = app.metadata.getFirstLinkpathDest(parseLinktext(target).path, getSourcePath());
      return !!dest && dest.path.endsWith('.md');
    },
    renderEmbed: (el, target) => app.renderEmbed(el, target, getSourcePath()),
    ...extra,
  };
}
