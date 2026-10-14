import { load as loadYaml } from 'js-yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits YAML frontmatter from the body. `end` is the body's offset in the original text. */
export function splitFrontmatter(text) {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { yaml: null, data: null, body: text, end: 0 };
  let data = null;
  try {
    const parsed = loadYaml(m[1]);
    data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    data = null;
  }
  return { yaml: m[1], data, body: text.slice(m[0].length), end: m[0].length };
}

/**
 * Replaces code (fenced blocks, inline code), comments (%%…%%) and math with spaces,
 * keeping offsets and line numbers intact so later regexes only see prose.
 */
export function maskNonProse(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return text
    // Fenced blocks run to their closing fence, or to the end of the note when unclosed.
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n[ \t]*\2[`~]*[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm, blank)
    .replace(/%%[\s\S]*?%%/g, blank)
    .replace(/\$\$[\s\S]*?\$\$/g, blank)
    .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, blank);
}

function splitUnescapedPipe(s) {
  const i = s.search(/(?<!\\)\|/);
  return i === -1 ? [s, null] : [s.slice(0, i).replace(/\\$/, ''), s.slice(i + 1)];
}

/** Separates "Nota#Título" / "Nota#^bloco" into path and subpath. */
export function parseLinktext(linktext) {
  const i = linktext.indexOf('#');
  if (i === -1) return { path: linktext.trim(), subpath: '' };
  return { path: linktext.slice(0, i).trim(), subpath: linktext.slice(i).trim() };
}

/** "#Título#Sub" → { heading: "Sub" }, "#^id" → { block: "id" }. */
export function parseSubpath(subpath) {
  const s = (subpath || '').replace(/^#/, '');
  if (s.startsWith('^')) return { heading: null, block: s.slice(1) };
  const parts = s.split('#').filter(Boolean);
  return { heading: parts[parts.length - 1] || null, block: null };
}

/**
 * Normalizes a frontmatter value to a list of strings. A plain string is split on commas
 * (and on whitespace too when `splitSpaces`, which suits tags but not aliases).
 */
function toList(value, splitSpaces) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((v) => (v == null ? [] : [String(v).trim()])).filter(Boolean);
  return String(value)
    .split(splitSpaces ? /[,\s]+/ : /,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

function lineCol(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - lineStarts[lo], offset };
}

/** Extracts links, embeds, tags, headings, block ids and frontmatter from a Markdown note. */
export function parseNote(text) {
  const { data: frontmatter, end: fmEnd } = splitFrontmatter(text);
  const masked = text.slice(0, fmEnd).replace(/[^\n]/g, ' ') + maskNonProse(text.slice(fmEnd));
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const pos = (offset) => lineCol(lineStarts, offset);

  const links = [];
  const embeds = [];
  const tags = [];
  const headings = [];
  const blocks = [];

  // [[wikilinks]] and ![[embeds]]
  for (const m of masked.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)) {
    const [target, alias] = splitUnescapedPipe(m[2]);
    const item = {
      link: target.trim(),
      original: text.slice(m.index, m.index + m[0].length),
      displayText: (alias ?? target).trim(),
      position: { start: pos(m.index), end: pos(m.index + m[0].length) },
    };
    (m[1] ? embeds : links).push(item);
  }

  // [markdown](links.md) pointing inside the vault
  for (const m of masked.matchAll(/(!?)\[([^\]\n]*)\]\(<?([^)<>\n]+?)>?(?:\s+"[^"]*")?\)/g)) {
    const url = m[3].trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#')) continue;
    let target;
    try {
      target = decodeURIComponent(url);
    } catch {
      target = url;
    }
    const item = {
      link: target,
      original: text.slice(m.index, m.index + m[0].length),
      displayText: m[2],
      position: { start: pos(m.index), end: pos(m.index + m[0].length) },
      markdown: true,
    };
    (m[1] ? embeds : links).push(item);
  }

  for (const m of masked.matchAll(TAG_RE)) {
    const start = m.index + m[1].length;
    tags.push({ tag: `#${m[2]}`, position: { start: pos(start), end: pos(start + m[2].length + 1) } });
  }

  for (const m of masked.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    headings.push({ heading: m[2].trim(), level: m[1].length, position: { start: pos(m.index) } });
  }

  for (const m of masked.matchAll(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/gm)) {
    blocks.push({ id: m[1], position: { start: pos(m.index) } });
  }

  const fmTags = frontmatter ? toList(frontmatter.tags ?? frontmatter.tag, true).map((t) => (t.startsWith('#') ? t : `#${t}`)) : [];
  const aliases = frontmatter ? toList(frontmatter.aliases ?? frontmatter.alias, false) : [];
  return { links, embeds, tags, headings, blocks, frontmatter, frontmatterTags: fmTags, aliases };
}
